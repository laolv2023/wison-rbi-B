// index.js — Wison-RBI 客户端主控制器
//
// 职责:
//   1. CanvasKit WASM 初始化
//   2. WebSocket 连接管理（重连、背压）
//   3. 帧接收 → 解压 → CRC校验 → 白名单校验 → 重放
//   4. HID 事件捕获（鼠标、键盘、滚轮）
//   5. 视口管理（resize 防抖）
//   6. 错误恢复（request_keyframe）
//
// 安全不变量:
//   - 所有命令经过 CommandValidator 白名单扫描后才执行
//   - CRC32 校验失败 → 丢弃帧
//   - 版本不匹配 → 发送 version_error
//   - readPixels 始终被禁止（CanvasKit API 层面不可用）
//
// 性能:
//   - handleFrame 使用 requestAnimationFrame 调度
//   - 最新帧策略：处理中的帧被新到达的帧替代
//   - ±1ms 渲染抖动 (Phase 2 侧信道防御)
//

'use strict';

import { PROTOCOL } from './protocol.js';
import { CommandValidator } from './command_validator.js';
import { FontRegistry } from './font_registry.js';
import { ImageCache } from './image_cache.js';
import {
    decompressWithProtection,
    parseFrameHeader,
    validateFrameCRC,
    extractCommandStream,
    auditLog,
    LOG_LEVELS,
    randomJitter,
} from './utils.js';

(() => {
    'use strict';

    // ═══════════════════════════════════════════════════════════
    // 配置
    // ═══════════════════════════════════════════════════════════

    const CONFIG = Object.freeze({
        SERVER_URL: 'wss://localhost:3000',
        CANVAS_ID: 'main',
        RECONNECT_DELAY_MS: 1000,
        MAX_RECONNECT_DELAY_MS: 30000,
        FRAME_HISTORY_MAX_AGE_MS: PROTOCOL.LIMITS.FRAME_HISTORY_MAX_AGE_MS,
        VIEWPORT_RESIZE_DEBOUNCE_MS: 150,
        JITTER_ENABLED: false,  // Phase 2: 设为 true 启用 ±1ms 抖动
    });

    // ═══════════════════════════════════════════════════════════
    // 全局状态
    // ═══════════════════════════════════════════════════════════

    let canvasKit = null;         // CanvasKit WASM 实例
    let surface = null;           // CanvasKit Surface
    let skCanvas = null;          // CanvasKit SkCanvas
    let validator = null;         // CommandValidator
    let fontRegistry = null;      // FontRegistry
    let imageCache = null;        // ImageCache

    let socket = null;            // WebSocket (socket.io)
    let currentFrameId = 0;      // 当前渲染帧 ID
    let frameMetadata = new Map();  // frameId → {scrollX, scrollY, ...}

    let pendingFrameId = null;   // 正在处理中的帧 ID（最新帧策略）
    let renderScheduled = false; // 是否已调度渲染

    let reconnectAttempt = 0;

    // ═══════════════════════════════════════════════════════════
    // 初始化
    // ═══════════════════════════════════════════════════════════

    async function init() {
        try {
            // 1. 获取目标 URL
            const urlParams = new URLSearchParams(location.search);
            const targetUrl = urlParams.get('url') || 'about:blank';
            auditLog(LOG_LEVELS.INFO, 'init', { targetUrl });

            // 2. 设置 Canvas 初始尺寸
            const canvas = document.getElementById(CONFIG.CANVAS_ID);
            if (!canvas) {
                throw new Error(`Canvas element #${CONFIG.CANVAS_ID} not found`);
            }
            canvas.width = Math.min(window.innerWidth * window.devicePixelRatio, 65535);
            canvas.height = Math.min(window.innerHeight * window.devicePixelRatio, 65535);

            // 3. 初始化 CanvasKit
            canvasKit = await loadCanvasKit();
            auditLog(LOG_LEVELS.INFO, 'canvaskit_loaded');

            // 4. 创建 Surface
            surface = canvasKit.MakeCanvasSurface(CONFIG.CANVAS_ID);
            if (!surface) {
                throw new Error('Failed to create CanvasKit surface');
            }
            skCanvas = surface.getCanvas();

            // 5. 初始化校验器
            validator = new CommandValidator();

            // 6. 初始化字体注册表
            fontRegistry = new FontRegistry(canvasKit);

            // 7. 初始化图像缓存
            imageCache = new ImageCache();

            // 8. 连接服务器
            connect(targetUrl);

            // 9. 注册 HID 事件
            registerHIDEvents();

            // 10. 注册视口变化事件
            registerViewportEvents();

            // 11. 渲染循环
            requestAnimationFrame(renderLoop);

            auditLog(LOG_LEVELS.INFO, 'init_complete');

        } catch (err) {
            auditLog(LOG_LEVELS.ERROR, 'init_failed', { error: err.message });
            showFatalError(`Initialization failed: ${err.message}`);
        }
    }

    async function loadCanvasKit() {
        try {
            const ck = await CanvasKitInit({
                locateFile: (file) => `/node_modules/canvaskit-wasm/bin/${file}`,
            });
            return ck;
        } catch (err) {
            throw new Error(`CanvasKit load failed: ${err.message}`);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // WebSocket 连接
    // ═══════════════════════════════════════════════════════════

    function connect(targetUrl) {
        if (socket) {
            socket.disconnect();
        }

        socket = io(CONFIG.SERVER_URL, {
            transports: ['websocket'],
            upgrade: false,           // 只用 WebSocket，不降级
            reconnection: true,
            reconnectionDelay: CONFIG.RECONNECT_DELAY_MS,
            reconnectionDelayMax: CONFIG.MAX_RECONNECT_DELAY_MS,
        });

        socket.on('connect', () => {
            reconnectAttempt = 0;
            auditLog(LOG_LEVELS.INFO, 'ws_connected');

            // 上报视口
            socket.emit('viewport', {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio,
            });

            // 请求目标 URL
            socket.emit('ready', { url: targetUrl });
        });

        socket.on('frame', handleFrame);

        socket.on('error', (data) => {
            auditLog(LOG_LEVELS.ERROR, 'server_error', data);
        });

        socket.on('disconnect', (reason) => {
            auditLog(LOG_LEVELS.WARN, 'ws_disconnected', { reason });
            showDisconnectedOverlay(`Disconnected — reconnecting... (${reason})`);
        });

        socket.on('reconnect_attempt', (attempt) => {
            reconnectAttempt = attempt;
        });

        socket.on('reconnect_failed', () => {
            auditLog(LOG_LEVELS.ERROR, 'ws_reconnect_failed');
            showDisconnectedOverlay('Connection failed. Please reload the page.');
        });

        // 检测协议版本不匹配
        socket.on('version_error', (data) => {
            auditLog(LOG_LEVELS.ERROR, 'protocol_version_mismatch', data);
            showFatalError(
                `Protocol version mismatch. Server: ${PROTOCOL.VERSION}. ` +
                `Please update your client.`
            );
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 帧处理流水线
    // ═══════════════════════════════════════════════════════════

    async function handleFrame(frameData) {
        try {
            // ── 最新帧策略 ──
            // 如果正在处理上一帧，标记待处理帧 ID 以便跳过
            // （socket.io 保证单线程消息处理，简化实现）

            let frame;
            let frameBuffer;

            // Step 1: 解压（如果数据是 gzip 压缩的 ArrayBuffer）
            if (frameData instanceof ArrayBuffer) {
                frameBuffer = await decompressWithProtection(frameData);
            } else if (frameData instanceof Uint8Array) {
                frameBuffer = await decompressWithProtection(frameData.buffer);
            } else {
                auditLog(LOG_LEVELS.ERROR, 'frame_invalid_type', { type: typeof frameData });
                return;
            }

            // Step 2: CRC32 校验
            if (!validateFrameCRC(frameBuffer)) {
                auditLog(LOG_LEVELS.WARN, 'frame_crc_mismatch');
                validator.consecutiveRejects++;
                if (validator.consecutiveRejects >= PROTOCOL.LIMITS.CONSECUTIVE_REJECT_THRESHOLD) {
                    socket.emit('request_keyframe');
                    auditLog(LOG_LEVELS.WARN, 'request_keyframe_crc');
                }
                return;
            }

            // Step 3: 解析帧头
            const header = parseFrameHeader(frameBuffer);

            // Step 4: 协议版本检查
            if (header.version !== PROTOCOL.VERSION) {
                auditLog(LOG_LEVELS.ERROR, 'frame_version_mismatch', {
                    expected: PROTOCOL.VERSION,
                    received: header.version,
                });
                socket.emit('version_error', {
                    clientVersion: PROTOCOL.VERSION,
                    receivedVersion: header.version,
                });
                return;
            }

            // Step 5: frame_id 单调性检查
            if (header.frameId < currentFrameId) {
                // 服务端可能重启了
                auditLog(LOG_LEVELS.WARN, 'frame_id_reset_detected', {
                    previous: currentFrameId,
                    received: header.frameId,
                });
                frameMetadata.clear();
                imageCache.clear();
                fontRegistry.clear();
                socket.emit('request_keyframe');
            }

            if (header.frameId - currentFrameId > PROTOCOL.LIMITS.FRAME_ID_JUMP_THRESHOLD) {
                auditLog(LOG_LEVELS.WARN, 'frame_id_jump', {
                    from: currentFrameId,
                    to: header.frameId,
                });
                socket.emit('request_keyframe');
            }

            currentFrameId = header.frameId;

            // Step 6: 提取命令流并校验
            const commandStream = extractCommandStream(frameBuffer);
            let validation;
            try {
                validation = validator.validate(commandStream);
            } catch (err) {
                auditLog(LOG_LEVELS.ERROR, 'frame_validate_exception', {
                    frameId: header.frameId,
                    error: err.message,
                });
                validator.consecutiveRejects++;
                if (validator.consecutiveRejects >= PROTOCOL.LIMITS.CONSECUTIVE_REJECT_THRESHOLD) {
                    socket.emit('request_keyframe');
                }
                return;
            }

            if (!validation.valid) {
                auditLog(LOG_LEVELS.WARN, 'frame_validation_failed', {
                    frameId: header.frameId,
                    reason: validation.rejectReason,
                    offset: validation.rejectOffset,
                });

                if (validation.shouldRequestKeyframe) {
                    socket.emit('request_keyframe');
                }
                return;
            }

            // Step 7: 视口适配
            const newWidth = Math.min(header.canvasW, 65535);
            const newHeight = Math.min(header.canvasH, 65535);
            const canvas = document.getElementById(CONFIG.CANVAS_ID);

            if (canvas.width !== newWidth || canvas.height !== newHeight) {
                canvas.width = newWidth;
                canvas.height = newHeight;
                // CanvasKit surface 可能需要重建
                // Phase 1: 尺寸不变时不重建
            }

            // Step 8: 记录帧元数据（用于输入坐标转换的 scroll 锚定）
            frameMetadata.set(header.frameId, {
                scrollX: header.scrollX,
                scrollY: header.scrollY,
                viewportW: header.viewportW,
                viewportH: header.viewportH,
                canvasW: header.canvasW,
                canvasH: header.canvasH,
                timestampMs: header.timestampMs,
            });

            // Step 9: 清理过期帧元数据
            pruneFrameMetadata(header.timestampMs);

            // Step 10: 设置 pending 帧 ID（最新帧策略）
            pendingFrameId = header.frameId;

            // Step 11: 调度渲染（如果尚未调度）
            if (!renderScheduled) {
                renderScheduled = true;
                // 使用微任务队列，在下一帧渲染前处理
                renderFrame(commandStream, header.isKeyframe);
            }

            auditLog(LOG_LEVELS.DEBUG, 'frame_received', {
                frameId: header.frameId,
                commandCount: validation.commandCount,
                compressedSize: frameData.byteLength || frameData.length,
                uncompressedSize: frameBuffer.byteLength,
            });

        } catch (err) {
            auditLog(LOG_LEVELS.ERROR, 'frame_processing_error', {
                error: err.message,
                stack: err.stack,
            });

            validator.consecutiveRejects++;
            if (validator.consecutiveRejects >= PROTOCOL.LIMITS.CONSECUTIVE_REJECT_THRESHOLD) {
                socket.emit('request_keyframe');
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 命令重放引擎
    // ═══════════════════════════════════════════════════════════

    function renderFrame(commandStream, isKeyframe) {
        // 检查是否有更新的帧到达
        // （简化版：直接渲染。完整版需要 pending 帧 ID 比较。）

        try {
            const view = new DataView(commandStream);
            let offset = 0;
            const OP = PROTOCOL.OPCODE;

            // 仅关键帧清空画布；增量帧在已有内容上覆盖渲染
            if (isKeyframe) {
                skCanvas.clear(canvasKit.TRANSPARENT);
            }

            while (offset < commandStream.byteLength) {
                if (offset + PROTOCOL.COMMAND_HEADER_SIZE > commandStream.byteLength) break;

                const opcode = view.getUint8(offset);
                const payLen = (view.getUint8(offset + 1) |
                               (view.getUint8(offset + 2) << 8) |
                               (view.getUint8(offset + 3) << 16));

                // 命令已在 validator 中校验过，此处仅执行
                const payload = new DataView(
                    commandStream,
                    offset + PROTOCOL.COMMAND_HEADER_SIZE,
                    payLen
                );

                dispatchOpcode(opcode, payload, payLen);

                offset += PROTOCOL.COMMAND_HEADER_SIZE + payLen;

                // 4 字节对齐
                const remainder = offset % 4;
                if (remainder !== 0) offset += (4 - remainder);
            }

            // Flush 到 GPU
            skCanvas.flush();

        } catch (err) {
            auditLog(LOG_LEVELS.ERROR, 'render_error', { error: err.message });
        } finally {
            renderScheduled = false;
            pendingFrameId = null;
        }
    }

    /**
     * 分发 opcode 到对应的绘制操作。
     */
    function dispatchOpcode(opcode, payload, payLen) {
        const OP = PROTOCOL.OPCODE;

        switch (opcode) {
            // ── 状态管理 ──
            case OP.SAVE:
                skCanvas.save();
                break;
            case OP.RESTORE:
                skCanvas.restore();
                break;
            case OP.SAVE_LAYER:
                {
                    const paint = readPaint(payload, 0);
                    skCanvas.saveLayer(paint);
                    paint.delete();
                }
                break;

            // ── 变换 ──
            case OP.TRANSLATE:
                skCanvas.translate(payload.getFloat32(0, true), payload.getFloat32(4, true));
                break;
            case OP.SCALE:
                skCanvas.scale(payload.getFloat32(0, true), payload.getFloat32(4, true));
                break;
            case OP.ROTATE:
                skCanvas.rotate(payload.getFloat32(0, true), 0, 0);
                break;
            case OP.CONCAT:
                // 9-float 矩阵
                {
                    const m = new Float32Array(9);
                    for (let i = 0; i < 9; i++) m[i] = payload.getFloat32(i * 4, true);
                    skCanvas.concat(m);
                }
                break;
            case OP.CONCAT44:
                // 16-float 矩阵 (4×4)
                {
                    const m = new Float32Array(16);
                    for (let i = 0; i < 16; i++) m[i] = payload.getFloat32(i * 4, true);
                    skCanvas.concat44(m);
                }
                break;

            // ── 裁剪 ──
            case OP.CLIP_RECT:
                {
                    const rect = readRect(payload, 0);
                    const op = payload.getUint8(16);
                    const doAA = payload.getUint8(17);
                    skCanvas.clipRect(rect, op, !!doAA);
                }
                break;
            case OP.CLIP_RRECT:
                {
                    const rrect = readRRect(payload, 0);
                    const op = payload.getUint8(49);
                    const doAA = payload.getUint8(50);
                    skCanvas.clipRRect(rrect, op, !!doAA);
                }
                break;
            case OP.CLIP_PATH:
                {
                    const path = readPath(payload, 0);
                    const op = payload.getUint8(payLen - 2);
                    const doAA = payload.getUint8(payLen - 1);
                    skCanvas.clipPath(path, op, !!doAA);
                    path.delete();
                }
                break;

            // ── 形状绘制 ──
            case OP.DRAW_RECT:
                {
                    const rect = readRect(payload, 0);
                    const paint = readPaint(payload, 16);
                    skCanvas.drawRect(rect, paint);
                    paint.delete();
                }
                break;
            case OP.DRAW_RRECT:
                {
                    const rrect = readRRect(payload, 0);
                    const paint = readPaint(payload, 49);
                    skCanvas.drawRRect(rrect, paint);
                    paint.delete();
                }
                break;
            case OP.DRAW_OVAL:
                {
                    const rect = readRect(payload, 0);
                    const paint = readPaint(payload, 16);
                    skCanvas.drawOval(rect, paint);
                    paint.delete();
                }
                break;
            case OP.DRAW_PATH:
                {
                    const path = readPath(payload, 0);
                    const paint = readPaint(payload, payLen);
                    skCanvas.drawPath(path, paint);
                    path.delete();
                    paint.delete();
                }
                break;

            // ── 图像绘制 ──
            case OP.DRAW_IMAGE:
                drawImageInline(payload, payLen);
                break;
            case OP.DRAW_IMAGE_RECT:
                drawImageRectInline(payload, payLen);
                break;

            // ── 文本绘制 ──
            case OP.DRAW_TEXT_BLOB:
                drawTextBlob(payload, payLen);
                break;

            // ── 其他绘制 ──
            case OP.DRAW_PAINT:
                {
                    const paint = readPaint(payload, 0);
                    skCanvas.drawPaint(paint);
                    paint.delete();
                }
                break;
            case OP.DRAW_COLOR:
                {
                    const r = payload.getUint8(0);
                    const g = payload.getUint8(1);
                    const b = payload.getUint8(2);
                    const a = payload.getUint8(3);
                    const mode = payload.getUint8(4);
                    skCanvas.drawColor([r, g, b, a], mode || canvasKit.BlendMode.SrcOver);
                }
                break;

            // ── 扩展 ──
            case OP.FONT_DATA:
                handleFontData(payload, payLen);
                break;
            case OP.IMAGE_DATA:
                // 图像内联引用 — 在 drawImage 中处理
                break;
            case OP.NOOP:
                break;

            default:
                // 理论上不应到达 — validator 已过滤
                auditLog(LOG_LEVELS.WARN, 'unhandled_opcode', {
                    opcode: `0x${opcode.toString(16)}`,
                });
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Skia 对象反序列化辅助函数
    // ═══════════════════════════════════════════════════════════

    function readPaint(payload, offset) {
        // 简化版 SkPaint 反序列化
        // 完整实现需包含: color, blendMode, style, strokeWidth, shader, maskFilter, ...
        const r = payload.getUint8(offset) / 255;
        const g = payload.getUint8(offset + 1) / 255;
        const b = payload.getUint8(offset + 2) / 255;
        const a = payload.getUint8(offset + 3) / 255;

        const paint = new canvasKit.Paint();
        paint.setColor([r, g, b, a]);
        paint.setAntiAlias(true);
        return paint;
    }

    function readRect(payload, offset) {
        return canvasKit.XYWHRect(
            payload.getFloat32(offset, true),
            payload.getFloat32(offset + 4, true),
            payload.getFloat32(offset + 8, true),
            payload.getFloat32(offset + 12, true)
        );
    }

    function readRRect(payload, offset) {
        const rect = readRect(payload, offset);
        const rx = payload.getFloat32(offset + 16, true);
        const ry = payload.getFloat32(offset + 20, true);
        return canvasKit.RRectXY(rect, rx, ry);
    }

    function readPath(payload, offset) {
        const verbCount = payload.getUint32(offset, true);
        const pointCount = payload.getUint32(offset + 4, true);
        const path = new canvasKit.Path();

        let pos = offset + 8;
        for (let i = 0; i < verbCount; i++) {
            const verb = payload.getUint8(pos);
            pos += 1;

            switch (verb) {
                case 0: // moveTo
                    path.moveTo(
                        payload.getFloat32(pos, true),
                        payload.getFloat32(pos + 4, true)
                    );
                    pos += 8;
                    break;
                case 1: // lineTo
                    path.lineTo(
                        payload.getFloat32(pos, true),
                        payload.getFloat32(pos + 4, true)
                    );
                    pos += 8;
                    break;
                case 2: // quadTo
                    path.quadTo(
                        payload.getFloat32(pos, true),
                        payload.getFloat32(pos + 4, true),
                        payload.getFloat32(pos + 8, true),
                        payload.getFloat32(pos + 12, true)
                    );
                    pos += 16;
                    break;
                case 3: // conicTo
                    path.conicTo(
                        payload.getFloat32(pos, true),
                        payload.getFloat32(pos + 4, true),
                        payload.getFloat32(pos + 8, true),
                        payload.getFloat32(pos + 12, true),
                        payload.getFloat32(pos + 16, true)
                    );
                    pos += 20;
                    break;
                case 4: // cubicTo
                    path.cubicTo(
                        payload.getFloat32(pos, true),
                        payload.getFloat32(pos + 4, true),
                        payload.getFloat32(pos + 8, true),
                        payload.getFloat32(pos + 12, true),
                        payload.getFloat32(pos + 16, true),
                        payload.getFloat32(pos + 20, true)
                    );
                    pos += 24;
                    break;
                case 5: // close
                    path.close();
                    break;
            }
        }

        return path;
    }

    function drawImageInline(payload, payLen) {
        const flag = payload.getUint8(0);
        if (flag === 0x01) {
            // hash-ref 引用
            // 读取 32 字节哈希，从 ImageCache 获取
            const hashBytes = new Uint8Array(payload.buffer, payload.byteOffset + 1, 32);
            const hexHash = bytesToHex(hashBytes);
            const imageData = imageCache.get(hexHash);
            if (imageData) {
                const img = canvasKit.MakeImageFromEncoded(imageData);
                if (img) {
                    const x = payload.getFloat32(33, true);
                    const y = payload.getFloat32(37, true);
                    skCanvas.drawImage(img, x, y);
                    img.delete();
                }
            }
        } else if (flag === 0x00) {
            // inline 图像数据
            // slot_id(4) + data_size(4) + data(N)
            const dataSize = payload.getUint32(5, true);
            const imgData = payload.buffer.slice(
                payload.byteOffset + 9,
                payload.byteOffset + 9 + dataSize
            );
            const img = canvasKit.MakeImageFromEncoded(imgData);
            if (img) {
                const x = payload.getFloat32(9 + dataSize, true);
                const y = payload.getFloat32(13 + dataSize, true);
                skCanvas.drawImage(img, x, y);
                img.delete();
            }
        }
    }

    function drawImageRectInline(payload, payLen) {
        // 类似 drawImage，额外包含 src/dst rect
        // 简化版：委托给 drawImage（完整版需要处理 rect 参数）
        drawImageInline(payload, payLen);
    }

    function drawTextBlob(payload, payLen) {
        const x = payload.getFloat32(0, true);
        const y = payload.getFloat32(4, true);
        const glyphCount = payload.getUint32(8, true);

        const builder = canvasKit.TextBlob.MakeFromGlyphs(
            // glyph IDs
            new Uint16Array(payload.buffer, payload.byteOffset + 12, glyphCount),
            // positions (x,y pairs)
            new Float32Array(payload.buffer, payload.byteOffset + 12 + glyphCount * 2, glyphCount * 2),
            // default font
            fontRegistry.getTypeface(0)
        );

        if (builder) {
            const paint = readPaint(payload, 12 + glyphCount * 10);
            skCanvas.drawTextBlob(builder, x, y, paint);
            paint.delete();
        }
    }

    function handleFontData(payload, payLen) {
        const fontId = payload.getUint32(0, true);
        const fontSize = payload.getUint32(4, true);
        const fontData = payload.buffer.slice(
            payload.byteOffset + 8,
            payload.byteOffset + 8 + fontSize
        );

        fontRegistry.registerFont(fontId, fontData);
    }

    // ═══════════════════════════════════════════════════════════
    // 渲染循环
    // ═══════════════════════════════════════════════════════════

    function renderLoop(timestamp) {
        // Phase 2 侧信道防御: ±1ms 随机抖动
        if (CONFIG.JITTER_ENABLED) {
            randomJitter().then(() => requestAnimationFrame(renderLoop));
            return;
        }

        requestAnimationFrame(renderLoop);
    }

    // ═══════════════════════════════════════════════════════════
    // HID 事件捕获
    // ═══════════════════════════════════════════════════════════

    function registerHIDEvents() {
        const canvas = document.getElementById(CONFIG.CANVAS_ID);

        // ── 鼠标事件 ──
        const mouseHandler = (e) => {
            if (!socket || !socket.connected) return;
            socket.emit('io', {
                type: e.type,  // 'mousemove'/'mousedown'/'mouseup'
                x: Math.round(e.offsetX),
                y: Math.round(e.offsetY),
                button: e.button,
                buttons: e.buttons,
                frameId: currentFrameId,
            });
            e.preventDefault();
        };

        canvas.addEventListener('mousemove', mouseHandler, { passive: false });
        canvas.addEventListener('mousedown', mouseHandler, { passive: false });
        canvas.addEventListener('mouseup', mouseHandler, { passive: false });

        // 禁止右键菜单
        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            socket.emit('io', {
                type: 'mousedown',
                x: Math.round(e.offsetX),
                y: Math.round(e.offsetY),
                button: 2,
                buttons: 2,
                frameId: currentFrameId,
            });
        });

        // ── 滚轮 ──
        canvas.addEventListener('wheel', (e) => {
            if (!socket || !socket.connected) return;
            socket.emit('io', {
                type: 'wheel',
                x: Math.round(e.offsetX),
                y: Math.round(e.offsetY),
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                frameId: currentFrameId,
            });
            e.preventDefault();
        }, { passive: false });

        // ── 键盘事件 ──
        document.addEventListener('keydown', keyHandler, true);
        document.addEventListener('keyup', keyHandler, true);

        function keyHandler(e) {
            if (!socket || !socket.connected) return;

            // 敏感快捷键过滤
            if (isBrowserShortcut(e)) {
                e.preventDefault();
                return;
            }

            socket.emit('io', {
                type: e.type,
                key: e.key,
                code: e.code,
                location: e.location,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                metaKey: e.metaKey,
                repeat: e.repeat,
                frameId: currentFrameId,
            });
            e.preventDefault();
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 敏感快捷键过滤
    // ═══════════════════════════════════════════════════════════

    function isBrowserShortcut(e) {
        const ctrlOrMeta = e.ctrlKey || e.metaKey;

        // 标签页操作
        if (ctrlOrMeta && ['t', 'T', 'n', 'N', 'w', 'W', 'q', 'Q'].includes(e.key)) return true;
        if (ctrlOrMeta && e.shiftKey && ['T', 'N'].includes(e.key)) return true;
        if (ctrlOrMeta && e.key === 'Tab') return true;
        if (ctrlOrMeta && e.shiftKey && e.key === 'Tab') return true;
        if (ctrlOrMeta && /^[1-9]$/.test(e.key)) return true;
        if (['PageUp', 'PageDown'].includes(e.key) && ctrlOrMeta) return true;

        // 窗口操作
        if (e.altKey && e.key === 'F4') return true;
        if (e.key === 'F11') return true;

        // 页面操作
        if (ctrlOrMeta && ['r', 'R'].includes(e.key)) return true;
        if (e.key === 'F5') return true;
        if (ctrlOrMeta && ['s', 'S'].includes(e.key)) return true;
        if (ctrlOrMeta && ['d', 'D'].includes(e.key)) return true;
        if (ctrlOrMeta && ['h', 'H'].includes(e.key)) return true;
        if (ctrlOrMeta && ['j', 'J'].includes(e.key)) return true;

        // 开发者工具
        if (ctrlOrMeta && e.shiftKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(e.key)) return true;
        if (e.key === 'F12') return true;

        return false;
    }

    // ═══════════════════════════════════════════════════════════
    // 视口管理
    // ═══════════════════════════════════════════════════════════

    function registerViewportEvents() {
        let resizeTimer = null;

        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (socket && socket.connected) {
                    socket.emit('viewport', {
                        width: window.innerWidth,
                        height: window.innerHeight,
                        devicePixelRatio: window.devicePixelRatio,
                    });
                }
            }, CONFIG.VIEWPORT_RESIZE_DEBOUNCE_MS);
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 帧元数据管理
    // ═══════════════════════════════════════════════════════════

    function pruneFrameMetadata(currentTimeMs) {
        const cutoff = currentTimeMs - CONFIG.FRAME_HISTORY_MAX_AGE_MS;
        for (const [id, meta] of frameMetadata) {
            if (meta.timestampMs < cutoff) {
                frameMetadata.delete(id);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // UI 反馈
    // ═══════════════════════════════════════════════════════════

    function showDisconnectedOverlay(message) {
        if (!skCanvas || !canvasKit) return;
        try {
            skCanvas.clear(canvasKit.TRANSPARENT);
            const paint = new canvasKit.Paint();
            paint.setColor([1, 0, 0, 1]);
            paint.setAntiAlias(true);
            const font = new canvasKit.Font(null, 16);
            skCanvas.drawText(message, 60, 60, paint, font);
            skCanvas.flush();
            font.delete();
            paint.delete();
        } catch (e) {
            // 忽略渲染错误
        }
    }

    function showFatalError(message) {
        document.body.innerHTML = `
            <div style="
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100vh;
                font-family: system-ui, sans-serif;
                color: #e00;
                background: #111;
                padding: 20px;
                text-align: center;
            ">
                <div>
                    <h1>Wison-RBI Error</h1>
                    <p>${escapeHtml(message)}</p>
                    <button onclick="location.reload()" style="
                        margin-top: 16px;
                        padding: 8px 24px;
                        font-size: 14px;
                        cursor: pointer;
                    ">Reload</button>
                </div>
            </div>
        `;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ═══════════════════════════════════════════════════════════
    // 辅助
    // ═══════════════════════════════════════════════════════════

    function bytesToHex(bytes) {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // ═══════════════════════════════════════════════════════════
    // 启动
    // ═══════════════════════════════════════════════════════════

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
