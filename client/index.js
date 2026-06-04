// index.js — Wison-RBI 客户端主控制器
//
// ## 模块角色 (§5.5 客户端设计 — 核心逻辑)
//   客户端唯一的 JavaScript 入口，协调所有子系统完成以下职责:
//   1. CanvasKit WASM 初始化 (Skia 图形引擎的浏览器版本)
//   2. WebSocket 连接管理 (socket.io, 自动重连, 背压处理)
//   3. 帧接收流水线: 解压 → CRC校验 → 版本检查 → 命令白名单校验 → CanvasKit 重放
//   4. HID 事件捕获 (鼠标坐标/按钮、键盘键码/修饰键、滚轮增量)
//   5. 视口管理 (resize 防抖, 150ms)
//   6. 错误恢复 (连续拒绝 → request_keyframe, 服务端重启检测)
//
// ## 安全不变量 (客户端侧 §2.2)
//   - 所有命令经过 CommandValidator 白名单扫描后才执行 (不变量 1)
//   - CRC32 校验失败 → 丢弃帧 (传输错误/篡改检测)
//   - 协议版本不匹配 → 发送 version_error 并丢弃帧
//   - readPixels 始终被禁止 (CanvasKit API 层面不可用) — 防止侧信道像素窃取
//   - 仅发送原始 HID 事件, 不含任何页面语义信息 (不变量 2)
//   - 浏览器敏感快捷键 (Ctrl+T/W/N/Q/R 等) 被拦截, 不发往服务端
//
// ## 性能设计
//   - handleFrame 使用 socket.io 的单线程消息处理模型 (简化并发控制)
//   - 最新帧策略: 如果上一帧正在渲染 (renderScheduled=true), 新帧覆盖 pendingFrameId
//   - 渲染循环在 requestAnimationFrame 中执行 (同步到浏览器刷新率)
//   - ±1ms 渲染抖动已启用 (Phase 2 侧信道防御, CONFIG.JITTER_ENABLED)
//   - Canvas 尺寸上限 65535px (GPU 纹理限制, CanvasKit 内部强制)
//
// ## 架构: IIFE 模式
//   所有状态封装在模块级闭包中，不暴露到 window 全局作用域。
//   避免与其他扩展/脚本的状态冲突，也使攻击者更难通过 JS 注入篡改状态。
//
// ## 设计文档交叉引用
//   - §3.1: 客户端架构 (Frame Receiver → Validator → CanvasKit → HID)
//   - §5.5: index.js 核心状态管理与帧处理流水线
//   - §6.2: 帧消息二进制格式
//   - §7.3: 坐标转换公式 (scroll 锚定)
//   - §7.4: 帧历史管理 (pruneFrameMetadata)
//   - §8.1: 网络异常处理 (重连、request_keyframe)
//   - §8.3: 客户端边界 (resize、快捷键过滤、Canvas 尺寸限制)
//
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
    randomJitterAsync,
} from './utils.js';

(async () => {
    'use strict';

    // ═══════════════════════════════════════════════════════════
    // 配置
    //
    // 所有可调参数集中管理，使用 Object.freeze() 防止运行时修改。
    // 修改后需要重新加载页面才能生效。
    // ═══════════════════════════════════════════════════════════

    const CONFIG = Object.freeze({
        /** WebSocket 服务器地址 (生产环境应使用 wss://) */
        SERVER_URL: 'wss://localhost:3000',
        /** DOM 中 Canvas 元素的 id 属性值 */
        CANVAS_ID: 'main',
        /** 重连初始延迟 (ms) — socket.io 指数退避的基准值 */
        RECONNECT_DELAY_MS: 1000,
        /** 重连最大延迟 (ms) — 上限 30 秒 */
        MAX_RECONNECT_DELAY_MS: 30000,
        /** 帧元数据最大保留时间 (3s) — 超时的帧元数据在 pruneFrameMetadata 中清理 */
        FRAME_HISTORY_MAX_AGE_MS: PROTOCOL.LIMITS.FRAME_HISTORY_MAX_AGE_MS,
        /** 视口 resize 防抖延迟 (ms) — 避免快速拖动窗口时发送大量 viewport 消息 */
        VIEWPORT_RESIZE_DEBOUNCE_MS: 150,
        /** Phase 2 侧信道防御: 在 CanvasKit flush 前注入 ±1ms 随机延迟 (§2.1) */
        JITTER_ENABLED: true,   // Phase 2: ±1ms 侧信道防御抖动
    });

    // ═══════════════════════════════════════════════════════════
    // 全局状态
    //
    // 所有可变状态集中管理，便于调试和审计。
    // 注意: socket.io 的事件处理是单线程的 (基于 EventEmitter)，
    // 所以不需要显式的互斥锁。
    // ═══════════════════════════════════════════════════════════

    /** CanvasKit WASM 实例 — 全局单例 */
    let canvasKit = null;         // CanvasKit WASM 实例
    /** CanvasKit Surface — 对应 DOM Canvas 元素的 SkSurface */
    let surface = null;           // CanvasKit Surface
    /** CanvasKit SkCanvas — 所有绘制命令的目标 */
    let skCanvas = null;          // CanvasKit SkCanvas
    /** 命令白名单校验器 — 每帧调用 validate() (§8.4) */
    let validator = null;         // CommandValidator
    /** 字体注册表 — 管理 CanvasKit Typeface 缓存 */
    let fontRegistry = null;      // FontRegistry
    /** 图像 LRU 缓存 — hash-ref 模式下的图像复用 (§4.1.4) */
    let imageCache = null;        // ImageCache

    /** WebSocket 连接实例 (socket.io) */
    let socket = null;            // WebSocket (socket.io)
    /** 当前最新渲染帧 ID — 用于单调性检测和输入同步 */
    let currentFrameId = 0;      // 当前渲染帧 ID
    /**
     * 帧元数据映射: frameId → {scrollX, scrollY, viewportW, viewportH, ...}
     * 用于输入事件坐标转换时的 scroll 锚定 (§7.3)
     */
    let frameMetadata = new Map();  // frameId → {scrollX, scrollY, ...}

    /** 正在处理中的帧 ID — 最新帧策略的核心状态 */
    let pendingFrameId = null;   // 正在处理中的帧 ID（最新帧策略）
    /** 是否已调度 requestAnimationFrame 回调 — 防止重复调度 */
    let renderScheduled = false; // 是否已调度渲染

    /** 当前重连尝试次数 (由 socket.io 回调更新) */
    let reconnectAttempt = 0;

    // ═══════════════════════════════════════════════════════════
    // 初始化
    //
    // 初始化顺序 (§5.5):
    //   1. 解析 URL 参数获取目标页面
    //   2. 设置 Canvas 初始尺寸 (± devicePixelRatio)
    //   3. 加载 CanvasKit WASM (异步, 可能耗时数秒)
    //   4. 创建 Surface + 获取 SkCanvas
    //   5. 初始化 CommandValidator (安全门禁)
    //   6. 初始化 FontRegistry (回退字体 font_id=0)
    //   7. 初始化 ImageCache (LRU, 64MB)
    //   8. 建立 WebSocket 连接
    //   9. 注册 HID 事件捕获器
    //   10. 注册视口 resize 监听
    //   11. 启动渲染循环 (requestAnimationFrame)
    //
    // 任何步骤失败 → showFatalError() → 显示错误页面，
    // 用户可点击 Reload 按钮重试。
    // ═══════════════════════════════════════════════════════════

    async function init() {
        try {
            // 步骤 1: 从 URL query string 获取目标 URL
            // ?url=https://example.com → targetUrl = 'https://example.com'
            const urlParams = new URLSearchParams(location.search);
            const targetUrl = urlParams.get('url') || 'about:blank';
            auditLog(LOG_LEVELS.INFO, 'init', { targetUrl });

            // 步骤 2: 设置 Canvas 初始尺寸
            // devicePixelRatio: 高 DPI 屏幕 (如 Retina) 需要 2x/3x 像素。
            // 上限 65535: GPU 纹理最大尺寸限制 (OpenGL ES 2.0 spec)。
            const canvas = document.getElementById(CONFIG.CANVAS_ID);
            if (!canvas) {
                throw new Error(`Canvas element #${CONFIG.CANVAS_ID} not found`);
            }
            canvas.width = Math.min(window.innerWidth * window.devicePixelRatio, 65535);
            canvas.height = Math.min(window.innerHeight * window.devicePixelRatio, 65535);

            // 步骤 3: 加载 CanvasKit WASM
            // CanvasKitInit 由 canvaskit-wasm npm 包提供，加载 wasm 二进制
            canvasKit = await loadCanvasKit();
            auditLog(LOG_LEVELS.INFO, 'canvaskit_loaded');

            // 步骤 4: 创建 Surface (GPU 加速渲染目标)
            surface = canvasKit.MakeCanvasSurface(CONFIG.CANVAS_ID);
            if (!surface) {
                throw new Error('Failed to create CanvasKit surface');
            }
            skCanvas = surface.getCanvas();

            // 步骤 5-7: 初始化安全/缓存子系统
            validator = new CommandValidator();
            fontRegistry = new FontRegistry(canvasKit);
            imageCache = new ImageCache();

            // 步骤 8: 建立 WebSocket 连接 (传递目标 URL)
            connect(targetUrl);

            // 步骤 9-10: 注册输入事件监听器
            registerHIDEvents();
            registerViewportEvents();

            // 步骤 11: 启动渲染循环
            // 初始帧：CanvasKit 自动呈现空白画布
            requestAnimationFrame(renderLoop);

            auditLog(LOG_LEVELS.INFO, 'init_complete');

        } catch (err) {
            auditLog(LOG_LEVELS.ERROR, 'init_failed', { error: err.message });
            showFatalError(`Initialization failed: ${err.message}`);
        }
    }

    /**
     * 加载 CanvasKit WASM 模块。
     *
     * locateFile 回调用于定位 wasm 二进制文件。
     * CanvasKit 是 Skia 的 WASM 编译产物，由 Google 官方维护。
     *
     * @returns {Promise<object>} CanvasKit API 对象
     * @throws {Error} 加载失败 (网络问题、wasm 不兼容等)
     */
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
    // WebSocket 连接 (§6.1 协议总览)
    //
    // 使用 socket.io 库 (WebSocket 上层封装)。
    // 传输层: 强制仅使用 WebSocket (upgrade: false)，不降级到 HTTP 轮询。
    // 重连: 指数退避，从 1s 到 30s (socket.io 内置)。
    //
    // 事件流:
    //   connect → 发送 viewport + ready → 接收 frame 流
    //   断开 → 显示覆盖层 → 自动重连
    //   重连失败 → 显示手动刷新提示
    //
    // 安全: socket.io 连接应通过 TLS 1.3 (wss://)，本文不涉及 TLS 配置。
    // ═══════════════════════════════════════════════════════════

    /**
     * 建立 WebSocket 连接并注册事件处理器。
     *
     * 副作用: 创建全局 socket 实例，注册 on('frame'), on('disconnect') 等回调。
     *
     * @param {string} targetUrl - 服务端应导航到的目标 URL
     */
    function connect(targetUrl) {
        // 先断开旧连接 (重连场景)
        if (socket) {
            socket.disconnect();
        }

        // 创建 socket.io 连接，强制 WebSocket 传输
        socket = io(CONFIG.SERVER_URL, {
            transports: ['websocket'],
            upgrade: false,           // 只用 WebSocket，不降级到长轮询
            reconnection: true,
            reconnectionDelay: CONFIG.RECONNECT_DELAY_MS,
            reconnectionDelayMax: CONFIG.MAX_RECONNECT_DELAY_MS,
        });

        // ── 连接成功 ──
        socket.on('connect', () => {
            reconnectAttempt = 0;
            auditLog(LOG_LEVELS.INFO, 'ws_connected');

            // 上报当前视口尺寸，服务端据此设置 Chromium 窗口大小 (§6.3)
            socket.emit('viewport', {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio,
            });

            // 发送 ready 事件，携带目标 URL, 触发服务端导航 (§6.1)
            socket.emit('ready', { url: targetUrl });
        });

        // ── 帧到达 (核心数据通道) ──
        // frameData 是二进制 ArrayBuffer (gzip 压缩的帧)
        socket.on('frame', handleFrame);

        // ── 服务端错误 ──
        socket.on('error', (data) => {
            auditLog(LOG_LEVELS.ERROR, 'server_error', data);
        });

        // ── 断开连接 ──
        socket.on('disconnect', (reason) => {
            auditLog(LOG_LEVELS.WARN, 'ws_disconnected', { reason });
            // 在 Canvas 上显示断线覆盖层 (§8.1)
            showDisconnectedOverlay(`Disconnected — reconnecting... (${reason})`);
        });

        // ── 重连尝试计数 ──
        socket.on('reconnect_attempt', (attempt) => {
            reconnectAttempt = attempt;
        });

        // ── 重连彻底失败 ──
        socket.on('reconnect_failed', () => {
            auditLog(LOG_LEVELS.ERROR, 'ws_reconnect_failed');
            // 最终失败 → 提示用户手动刷新
            showDisconnectedOverlay('Connection failed. Please reload the page.');
        });

        // ── 协议版本不匹配 ──
        // 服务端检测到客户端版本不兼容时发送 (§6.5)
        socket.on('version_error', (data) => {
            auditLog(LOG_LEVELS.ERROR, 'protocol_version_mismatch', data);
            showFatalError(
                `Protocol version mismatch. Server: ${PROTOCOL.VERSION}. ` +
                `Please update your client.`
            );
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 帧处理流水线 (§5.5 / §6.2)
    //
    // 这是客户端性能和安全的关键路径。每一帧经过 11 个步骤:
    //
    //   Step 1: 类型检查 + 解压 (gzip → 原始字节)
    //   Step 2: CRC32 校验 (完整性验证)
    //   Step 3: 帧头解析 (版本、frame_id、scroll、viewport、canvas)
    //   Step 4: 协议版本检查 (不匹配 → version_error)
    //   Step 5: frame_id 单调性检查 (倒退/跳变 → request_keyframe)
    //   Step 6: 命令流提取 + CommandValidator 白名单校验 (安全门禁)
    //   Step 7: 视口适配 (Canvas 尺寸变化 → 重建)
    //   Step 8: 帧元数据记录 (scroll 锚定, §7.3)
    //   Step 9: 剪枝旧帧元数据 (超过 3s)
    //   Step 10: 设置 pendingFrameId + 调度渲染
    //   Step 11: CanvasKit 重放 (命令 → SkCanvas API)
    //
    // 最新帧策略: 如果 renderScheduled=true (上一帧还在处理)，
    // 只需更新 pendingFrameId。渲染循环会自动处理最新的 pending 帧。
    // socket.io 保证单线程消息处理，renderScheduled 无需原子操作。
    //
    // 连续拒绝检测: 任何步骤失败 → validator.consecutiveRejects++。
    // 达到 CONSECTIVE_REJECT_THRESHOLD (3) → request_keyframe。
    // ═══════════════════════════════════════════════════════════

    /**
     * 帧处理主入口 (socket.io 'frame' 事件回调)。
     *
     * 此函数在 socket.io 的消息处理线程中同步执行。
     * 解压 (decompressWithProtection) 是唯一的异步操作，
     * 但 socket.io 保证单消息串行处理。
     *
     * @param {ArrayBuffer|Uint8Array} frameData - 服务端发送的压缩帧数据
     * @returns {Promise<void>}
     */
    async function handleFrame(frameData) {
        try {
            // ── 最新帧策略 ──
            // 如果正在处理上一帧，当前函数仍会执行流水线，
            // 最终通过 pendingFrameId 机制在渲染时选择最新帧。

            let frame;
            let frameBuffer;

            // ── Step 1: 类型检查 + gzip 安全解压 (§6.2) ──
            // 三层 zip bomb 防护在 decompressWithProtection 内部执行
            if (frameData instanceof ArrayBuffer) {
                frameBuffer = await decompressWithProtection(frameData);
            } else if (frameData instanceof Uint8Array) {
                frameBuffer = await decompressWithProtection(frameData.buffer);
            } else {
                auditLog(LOG_LEVELS.ERROR, 'frame_invalid_type', { type: typeof frameData });
                return;
            }

            // ── Step 2: CRC32 完整性校验 (§6.2) ──
            // CRC 覆盖 Header + CommandStream。CRC 失败意味着:
            //   (a) 传输层 bit 翻转 (即使 TLS 也有极低概率)
            //   (b) 服务端 gzip 实现 bug
            //   (c) 主动篡改 (TLS 应已防止，但纵深防御)
            if (!validateFrameCRC(frameBuffer)) {
                auditLog(LOG_LEVELS.WARN, 'frame_crc_mismatch');
                validator.consecutiveRejects++;
                if (validator.consecutiveRejects >= PROTOCOL.LIMITS.CONSECUTIVE_REJECT_THRESHOLD) {
                    socket.emit('request_keyframe');
                    auditLog(LOG_LEVELS.WARN, 'request_keyframe_crc');
                }
                return;
            }

            // ── Step 3: 帧头解析 ──
            const header = parseFrameHeader(frameBuffer);

            // ── Step 4: 协议版本检查 (§6.2, version 字段) ──
            // 客户端和服务端的 PROTOCOL.VERSION 必须完全一致。
            // 主版本号变更 = 不兼容的协议变更。
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

            // ── Step 5: frame_id 单调性检查 (§7.4) ──
            // 情况 A: frame_id 倒退 → 服务端可能重启了 (frame_id 归零)。
            //   清空所有客户端缓存状态 (帧元数据、图像、字体)，
            //   请求关键帧以重建完整状态。
            if (header.frameId < currentFrameId) {
                auditLog(LOG_LEVELS.WARN, 'frame_id_reset_detected', {
                    previous: currentFrameId,
                    received: header.frameId,
                });
                frameMetadata.clear();
                imageCache.clear();
                fontRegistry.clear();
                socket.emit('request_keyframe');
            }

            // 情况 B: frame_id 跳跃超过阈值 (FRAME_ID_JUMP_THRESHOLD=1000)
            //   可能是大量帧丢失或服务端时钟异常。
            //   请求关键帧跳过中间丢失的增量帧。
            if (header.frameId - currentFrameId > PROTOCOL.LIMITS.FRAME_ID_JUMP_THRESHOLD) {
                auditLog(LOG_LEVELS.WARN, 'frame_id_jump', {
                    from: currentFrameId,
                    to: header.frameId,
                });
                socket.emit('request_keyframe');
            }

            currentFrameId = header.frameId;

            // ── Step 6: 命令流提取 + CommandValidator 白名单校验 ──
            // 这是安全不变量 1 的执行点 (§2.2)。
            // 所有命令在此通过 9 层校验后才允许进入 CanvasKit 渲染。
            // Phase 4: 若有脏区域，从脏区域末尾开始提取命令流
            const commandStream = extractCommandStream(
                frameBuffer, header.dirtyRectsEndOffset
            );
            let validation;
            try {
                validation = validator.validate(commandStream);
            } catch (err) {
                // validate() 理论上不应抛出异常 (所有错误应通过
                // _reject() 返回)，但作为纵深防御捕获意外异常。
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
                return;  // 丢弃帧 — 不部分渲染
            }

            // ── Step 7: 视口适配 ──
            // Canvas 尺寸可能需要根据帧中的 canvasW/canvasH 调整。
            // 上限 65535: GPU 纹理最大尺寸。
            const newWidth = Math.min(header.canvasW, 65535);
            const newHeight = Math.min(header.canvasH, 65535);
            const canvas = document.getElementById(CONFIG.CANVAS_ID);

            if (canvas.width !== newWidth || canvas.height !== newHeight) {
                canvas.width = newWidth;
                canvas.height = newHeight;
                // CanvasKit surface 可能需要重建
                // Phase 1: 尺寸不变时不重建
            }

            // ── Step 8: 记录帧元数据 (用于输入坐标转换的 scroll 锚定 §7.3) ──
            frameMetadata.set(header.frameId, {
                scrollX: header.scrollX,
                scrollY: header.scrollY,
                viewportW: header.viewportW,
                viewportH: header.viewportH,
                canvasW: header.canvasW,
                canvasH: header.canvasH,
                timestampMs: header.timestampMs,
            });

            // ── Step 9: 清理过期帧元数据 (§7.4 帧历史管理) ──
            // 超过 FRAME_HISTORY_MAX_AGE_MS (3s) 的帧元数据不再需要
            // (输入事件早已被服务端处理完毕)
            pruneFrameMetadata(header.timestampMs);

            // ── Step 10: 设置 pending 帧 ID (最新帧策略) ──
            pendingFrameId = header.frameId;

            // ── Step 11: 调度渲染 (如果尚未调度) ──
            if (!renderScheduled) {
                renderScheduled = true;
                await renderFrame(commandStream, header.isKeyframe, header.dirtyRects);
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
    //
    // 此函数接收已通过 CommandValidator 校验的命令流，
    // 逐条派发到 CanvasKit SkCanvas API 进行实际绘制。
    //
    // 安全前提: 所有命令已通过 validator.validate() 的 9 层校验。
    // 因此此处不需要再检查 opcode 合法性、边界条件等 —
    // 仅执行纯粹的 Skia API 调用。
    //
    // 关键帧 vs 增量帧:
    //   - 关键帧 (isKeyframe=true): renderFrame 先清空画布再重放
    //   - 增量帧 (isKeyframe=false): 在已有内容上叠加绘制
    // ═══════════════════════════════════════════════════════════

    /**
     * 将命令流重放到 CanvasKit SkCanvas。
     *
     * Phase 4 R-tree 增量帧: 若提供了 dirtyRects，每个脏区域独立渲染一遍命令流，
     * 使用 clipRect 限制绘制范围。这利用了 CanvasKit 的 GPU 裁剪实现增量更新。
     * 对于非增量帧（dirtyRects 为空），直接全帧渲染。
     *
     * @param {ArrayBuffer} commandStream - 已校验的命令流 (§6.2)
     * @param {boolean} isKeyframe - 是否为关键帧 (决定是否清空画布)
     * @param {Array<{x:number,y:number,w:number,h:number}>} [dirtyRects] - 脏区域 (Phase 4)
     * @returns {Promise<void>}
     */
    async function renderFrame(commandStream, isKeyframe, dirtyRects) {
        try {
            const view = new DataView(commandStream);
            const OP = PROTOCOL.OPCODE;

            // 仅关键帧清空画布 (透明背景)；增量帧在已有内容上叠加
            if (isKeyframe) {
                skCanvas.clear(canvasKit.TRANSPARENT);
            }

            // Phase 4: 如果有脏区域，使用 clipRect 限制渲染范围
            const useDirtyRects = dirtyRects && dirtyRects.length > 0 && !isKeyframe;

            if (useDirtyRects) {
                // 对每个脏区域独立重放命令流（裁剪到脏矩形范围内）
                for (const dr of dirtyRects) {
                    skCanvas.save();
                    skCanvas.clipRect(
                        canvasKit.XYWHRect(dr.x, dr.y, dr.w, dr.h),
                        canvasKit.ClipOp.Intersect, true
                    );
                    replayCommands(view, OP, commandStream);
                    skCanvas.restore();
                }
            } else {
                replayCommands(view, OP, commandStream);
            }

            // Phase 2 侧信道防御: flush 前注入 ±1ms 随机抖动
            if (CONFIG.JITTER_ENABLED) {
                await randomJitterAsync();
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
     * 重放命令流到 SkCanvas (Phase 4 提取, 支持脏区域裁剪)。
     *
     * 从原始内联循环提取为独立函数，使 renderFrame 可以：
     *   - 全帧渲染: 调用 replayCommands 一次
     *   - 增量渲染: 对每个脏区域调用 replayCommands（配合 save/clipRect/restore）
     *
     * @param {DataView} view - 命令流 DataView
     * @param {object} OP - PROTOCOL.OPCODE 别名
     * @param {ArrayBuffer} commandStream - 原始命令流 (用于 payload 切片)
     */
    function replayCommands(view, OP, commandStream) {
        let offset = 0;
        while (offset < commandStream.byteLength) {
            if (offset + PROTOCOL.COMMAND_HEADER_SIZE > commandStream.byteLength) break;

            const opcode = view.getUint8(offset);
            const payLen = (view.getUint8(offset + 1) |
                           (view.getUint8(offset + 2) << 8) |
                           (view.getUint8(offset + 3) << 16));

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
    }

    /**
     * 分发 opcode 到对应的 CanvasKit SkCanvas 操作。
     *
     * 每个 case 对应一种 opcode，调用的 SkCanvas 方法
     * 与 C++ RecordingCanvas 的序列化方法一一对应。
     *
     * 安全: 所有参数已在 CommandValidator 中校验，此处仅执行。
     *
     * @param {number} opcode - 命令操作码
     * @param {DataView} payload - 命令 payload
     * @param {number} payLen - payload 字节数
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
                    const verbCount = payload.getUint32(0, true);
                    const pointCount = payload.getUint32(4, true);
                    const path = readPath(payload, 0);
                    // Paint 位于 path 动词 + 点数据之后
                    const paintOffset = 8 + verbCount + pointCount * 8;
                    const paint = readPaint(payload, paintOffset);
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
    //
    // 这些函数将二进制 payload 转换为 CanvasKit 对象:
    //   - readRect: 4×f32 → SkRect
    //   - readRRect: 12×f32+1B → SkRRect
    //   - readPath: verbCount+pointCount+verbs+points → SkPath
    //   - readPaint: 18B固定头 + 变长Shader/MaskFilter/... → SkPaint
    //   - readShader: shader_type + 几何参数 + colorTable → SkShader
    //
    // 安全: 所有输入已在 CommandValidator._validatePayloadSubstructure
    // 中校验过 (count ≤ 硬上限, minSize ≤ payLen)。
    // ═══════════════════════════════════════════════════════════

    /**
     * 反序列化 SkPaint 对象。
     *
     * Paint 二进制格式 (§6.2 / readShader):
     *   [0:4]   color RGBA uint32 LE
     *   [4:8]   stroke_width float32 LE
     *   [8]     style (0=Fill, 1=Stroke, 2=StrokeAndFill)
     *   [9]     cap (SkStrokeCap)
     *   [10]    join (SkStrokeJoin)
     *   [11]    _pad (对齐)
     *   [12:16] miter_limit float32 LE
     *   [16]    blend_mode (SkBlendMode枚举, 0-29)
     *   [17]    anti_alias (bool)
     *   [18]    has_shader (bool)
     *   [19+]   shader variant (if has_shader)
     *   [...]    has_mask_filter + mask_filter variant
     *   [...]    has_color_filter + color_filter variant
     *   [...]    has_image_filter + image_filter variant
     *
     * @param {DataView} payload - 包含 Paint 的 DataView
     * @param {number} offset - Paint 数据在 payload 中的起始偏移
     * @returns {object} CanvasKit Paint 对象
     */
    function readPaint(payload, offset) {
        const paint = new canvasKit.Paint();

        // ── Color: uint32 RGBA 解包为 [r,g,b,a] 0-1 浮点数组 ──
        const rgba = payload.getUint32(offset, true);
        paint.setColor([
            ((rgba >> 0)  & 0xFF) / 255,
            ((rgba >> 8)  & 0xFF) / 255,
            ((rgba >> 16) & 0xFF) / 255,
            ((rgba >> 24) & 0xFF) / 255,
        ]);

        // Stroke
        paint.setStrokeWidth(payload.getFloat32(offset + 4, true));

        // Style: 映射到 CanvasKit PaintStyle 枚举
        const styleVal = payload.getUint8(offset + 8);
        paint.setStyle(
            styleVal === 1 ? canvasKit.PaintStyle.Stroke :
            styleVal === 2 ? canvasKit.PaintStyle.StrokeAndFill :
            canvasKit.PaintStyle.Fill
        );

        // Stroke properties (cap, join, miter)
        paint.setStrokeCap(payload.getUint8(offset + 9));
        paint.setStrokeJoin(payload.getUint8(offset + 10));
        // offset+11 = _pad (skip)
        paint.setStrokeMiter(payload.getFloat32(offset + 12, true));

        // BlendMode: SkBlendMode 枚举值与 CanvasKit 一致，直接传入
        // 合法范围 0-29，超出范围的值已在 validator 边界检查中拒绝
        const blendVal = payload.getUint8(offset + 16);
        if (blendVal > 0 && blendVal <= 29) {
            paint.setBlendMode(blendVal);
        }

        // AntiAlias
        paint.setAntiAlias(payload.getUint8(offset + 17) !== 0);

        let bytesRead = 18;

        // ── Shader (Phase 2: 变长渐变解析) ──
        const hasShader = payload.getUint8(offset + bytesRead);
        bytesRead += 1;
        if (hasShader) {
            const shaderResult = readShader(payload, offset + bytesRead);
            if (shaderResult.shader) {
                paint.setShader(shaderResult.shader);
            }
            bytesRead += shaderResult.bytesRead;
        }

        // ── MaskFilter (Phase 3: placeholder skip) ──
        // 实现后: 根据 maskType 反序列化具体 MaskFilter (如 Blur)
        const hasMask = payload.getUint8(offset + bytesRead);
        bytesRead += 1;
        if (hasMask) bytesRead += 8;  // BlurMaskFilter: style(4B) + sigma(4B)

        // ── ColorFilter (Phase 3: placeholder skip) ──
        const hasColorFilter = payload.getUint8(offset + bytesRead);
        bytesRead += 1;
        if (hasColorFilter) bytesRead += 16;  // matrix[20] placeholder

        // ── ImageFilter (Phase 3: placeholder skip) ──
        const hasImageFilter = payload.getUint8(offset + bytesRead);
        bytesRead += 1;
        if (hasImageFilter) bytesRead += 16;  // placeholder

        return paint;
    }

    /**
     * 反序列化 Shader variant (Phase 2)。
     *
     * Shader 二进制格式:
     *   [1B] shader_type (SHADER_TYPE 枚举)
     *   [header] 渐变几何参数 (类型相关, 见 SHADER_HEADER_SIZE)
     *   [1B] tile_mode
     *   [1B] color_count
     *   [2B] _pad (reserved)
     *   [color_count × 8B] color_stops (RGBA u32 + position f32)
     *
     * @param {DataView} payload
     * @param {number} offset - Shader 数据起始偏移
     * @returns {{ shader: SkShader|null, bytesRead: number }}
     */
    function readShader(payload, offset) {
        const ST = PROTOCOL.SHADER_TYPE;
        const shaderType = payload.getUint8(offset);

        if (shaderType === ST.NONE) {
            return { shader: null, bytesRead: 1 };
        }

        const HEADER_SIZES = PROTOCOL.SHADER_HEADER_SIZE;
        const headerSize = HEADER_SIZES[shaderType];
        if (!headerSize) {
            auditLog(LOG_LEVELS.WARN, 'unknown_shader_type', { shaderType });
            return { shader: null, bytesRead: 1 };
        }

        // 读取 tileMode 和 colorCount (在 header 末尾前)
        const tileMode = payload.getUint8(offset + headerSize - 3);
        const colorCount = payload.getUint8(offset + headerSize - 2);

        // 读取颜色停止点
        const colors = [];
        const positions = [];
        let pos = offset + headerSize;
        for (let i = 0; i < colorCount; i++) {
            const crgba = payload.getUint32(pos, true);
            const r = ((crgba >> 0)  & 0xFF) / 255;
            const g = ((crgba >> 8)  & 0xFF) / 255;
            const b = ((crgba >> 16) & 0xFF) / 255;
            const a = ((crgba >> 24) & 0xFF) / 255;
            colors.push(r, g, b, a);
            positions.push(payload.getFloat32(pos + 4, true));
            pos += 8;
        }

        let shader;
        switch (shaderType) {
            case ST.LINEAR_GRADIENT: {
                const sx = payload.getFloat32(offset + 1, true);
                const sy = payload.getFloat32(offset + 5, true);
                const ex = payload.getFloat32(offset + 9, true);
                const ey = payload.getFloat32(offset + 13, true);
                shader = canvasKit.Shader.MakeLinearGradient(
                    [sx, sy], [ex, ey], colors, positions, tileMode
                );
                break;
            }
            case ST.RADIAL_GRADIENT: {
                const cx = payload.getFloat32(offset + 1, true);
                const cy = payload.getFloat32(offset + 5, true);
                const r = payload.getFloat32(offset + 9, true);
                shader = canvasKit.Shader.MakeRadialGradient(
                    [cx, cy], r, colors, positions, tileMode
                );
                break;
            }
            case ST.SWEEP_GRADIENT: {
                const cx = payload.getFloat32(offset + 1, true);
                const cy = payload.getFloat32(offset + 5, true);
                const sa = payload.getFloat32(offset + 9, true);
                const ea = payload.getFloat32(offset + 13, true);
                shader = canvasKit.Shader.MakeSweepGradient(
                    cx, cy, colors, positions, tileMode,
                    sa, ea
                );
                break;
            }
            case ST.CONICAL_GRADIENT: {
                const sx = payload.getFloat32(offset + 1, true);
                const sy = payload.getFloat32(offset + 5, true);
                const sr = payload.getFloat32(offset + 9, true);
                const ex = payload.getFloat32(offset + 13, true);
                const ey = payload.getFloat32(offset + 17, true);
                const er = payload.getFloat32(offset + 21, true);
                shader = canvasKit.Shader.MakeTwoPointConicalGradient(
                    [sx, sy], sr, [ex, ey], er, colors, positions, tileMode
                );
                break;
            }
            default:
                auditLog(LOG_LEVELS.WARN, 'unhandled_shader_type', { shaderType });
                break;
        }

        const totalBytes = headerSize + colorCount * 8;
        return { shader: shader || null, bytesRead: totalBytes };
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
    //
    // 使用 requestAnimationFrame 保持与浏览器刷新率同步。
    // rAF 在浏览器空闲且准备好下一帧时回调，通常为 60Hz (16.67ms)。
    //
    // 抖动模式: 在 rAF 之间插入 setTimeout 延迟 [0,2] ms。
    // 这使渲染的 observable 时间戳产生 ±1ms 噪声，破坏侧信道
    // 攻击者通过测量渲染间隔推断页面内容的能力 (§2.1 v1.6 P1 S5)。
    //
    // 注意: 渲染循环不直接绘制 — 绘制由 handleFrame → renderFrame 触发。
    // renderLoop 仅作为心跳保持 CanvasKit 上下文活跃。
    // ═══════════════════════════════════════════════════════════

    /**
     * 浏览器渲染回调 (requestAnimationFrame)。
     *
     * @param {number} timestamp - DOMHighResTimeStamp (rAF 提供)
     */
    function renderLoop(timestamp) {
        // Phase 2 侧信道防御: ±1ms 随机抖动
        if (CONFIG.JITTER_ENABLED) {
            const jitterMs = randomJitter();             // [-1.0, +1.0] ms
            const delayMs = Math.max(0, jitterMs + 1.0); // [0, 2] ms
            // 在 rAF 之间插入延迟 → 渲染间隔不再精确恒定
            setTimeout(() => requestAnimationFrame(renderLoop), delayMs);
            return;
        }

        // 标准路径: 直接在下一帧回调
        requestAnimationFrame(renderLoop);
    }

    // ═══════════════════════════════════════════════════════════
    // HID 事件捕获 (§5.5 / §6.4)
    //
    // 仅捕获原始输入事件:
    //   - 鼠标: mousemove/mousedown/mouseup (坐标+按钮)
    //   - 滚轮: wheel (增量)
    //   - 键盘: keydown/keyup (键码+修饰键+code)
    //
    // 所有事件携带 frameId 用于服务端坐标转换 (§7.3 方案 B)。
    //
    // 安全: 不发送页面元素引用、不发送 DOM 事件目标、不发送
    // 任何页面语义信息 (§2.2 不变量 2)。
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

        // 禁止右键菜单 (转发为 mousedown button=2)
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
    // 敏感快捷键过滤 (Phase 3 增强: 平台感知)
    // ═══════════════════════════════════════════════════════════

    /**
     * 检测是否为浏览器/操作系统敏感快捷键，拦截后不发往服务端。
     *
     * Phase 3 增强:
     *   - macOS (Cmd) vs 其他平台 (Ctrl) 区分
     *   - 补充遗漏快捷键 (Ctrl+P/U/L/0/+/- Esc 等)
     *   - 使用 code 辅助识别，避免键盘布局差异
     */
    function isBrowserShortcut(e) {
        const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
        const mod = isMac ? e.metaKey : e.ctrlKey;  // macOS=Cmd, 其他=Ctrl
        const modOrCtrl = e.ctrlKey || e.metaKey;   // 任意平台修饰键
        const { key, code, altKey, shiftKey, metaKey, ctrlKey } = e;

        // ── 全局浏览器控制 ──
        // 新建标签页
        if (modOrCtrl && ['t', 'T'].includes(key)) return true;
        if (modOrCtrl && shiftKey && ['T'].includes(key)) return true;
        // 关闭标签页
        if (modOrCtrl && ['w', 'W'].includes(key)) return true;
        // 退出浏览器
        if (modOrCtrl && ['q', 'Q'].includes(key)) return true;
        if (altKey && key === 'F4') return true;
        // 新建窗口
        if (modOrCtrl && ['n', 'N'].includes(key)) return true;
        if (modOrCtrl && shiftKey && ['N'].includes(key)) return true;
        // 切换标签页
        if (modOrCtrl && /^[1-9]$/.test(key)) return true;
        if (modOrCtrl && key === 'Tab') return true;
        if (modOrCtrl && shiftKey && key === 'Tab') return true;
        if (modOrCtrl && ['PageUp', 'PageDown'].includes(key)) return true;

        // ── 导航 ──
        if (altKey && ['ArrowLeft', 'ArrowRight'].includes(key)) return true;
        if (modOrCtrl && ['[', ']'].includes(key)) return true;

        // ── 页面操作 ──
        if (modOrCtrl && ['r', 'R'].includes(key)) return true;   // 刷新
        if (key === 'F5') return true;
        if (modOrCtrl && shiftKey && ['r', 'R'].includes(key)) return true; // 强制刷新
        if (modOrCtrl && ['s', 'S'].includes(key)) return true;   // 保存
        if (modOrCtrl && ['p', 'P'].includes(key)) return true;   // 打印
        if (modOrCtrl && shiftKey && ['p', 'P'].includes(key)) return true; // 系统打印
        if (modOrCtrl && ['u', 'U'].includes(key)) return true;   // 查看源码
        if (modOrCtrl && ['d', 'D'].includes(key)) return true;   // 添加书签
        if (modOrCtrl && ['l', 'L'].includes(key)) return true;   // 聚焦地址栏
        if (modOrCtrl && ['e', 'E'].includes(key)) return true;   // 搜索
        if (modOrCtrl && ['k', 'K'].includes(key)) return true;   // 搜索 (Firefox)
        if (modOrCtrl && ['h', 'H'].includes(key)) return true;   // 历史
        if (modOrCtrl && ['j', 'J'].includes(key)) return true;   // 下载

        // ── 缩放 ──
        if (modOrCtrl && ['=', '+', '-', '_'].includes(key)) return true;
        if (modOrCtrl && ['0'].includes(key)) return true;  // 重置缩放

        // ── 开发者工具 ──
        if (modOrCtrl && shiftKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(key)) return true;
        if (key === 'F12') return true;

        // ── 全屏/窗口 ──
        if (key === 'F11') return true;
        if (key === 'Escape') return true;  // 停止加载/退出全屏
        if (modOrCtrl && key === 'f') return true;  // 查找
        if (modOrCtrl && ['g', 'G'].includes(key)) return true; // 查找下一个

        // ── macOS 特有 ──
        if (isMac) {
            if (metaKey && ['h', 'H'].includes(key)) return true;  // 隐藏
            if (metaKey && ['m', 'M'].includes(key)) return true;  // 最小化
            if (metaKey && key === '`') return true;  // 切换窗口
            if (metaKey && key === ',') return true;   // 偏好设置
        }

        // ── code 辅助 (键盘布局无关) ──
        if (modOrCtrl && ['KeyL', 'KeyT', 'KeyW', 'KeyN', 'KeyR',
                          'KeyS', 'KeyD', 'KeyF', 'KeyH', 'KeyJ',
                          'KeyP', 'KeyU', 'KeyE', 'KeyK'].includes(code)) return true;

        return false;
    }

    // ═══════════════════════════════════════════════════════════
    // 视口管理 (§6.3)
    //
    // 当浏览器窗口尺寸变化时，通过防抖 (debounce) 延迟发送
    // viewport 消息给服务端。防抖避免拖拽窗口时发送数十条消息。
    //
    // 防抖延迟: 150ms (CONFIG.VIEWPORT_RESIZE_DEBOUNCE_MS)。
    // 服务端收到 viewport 消息后通过 CDP 同步 Chromium 窗口大小。
    // ═══════════════════════════════════════════════════════════

    /**
     * 注册视口 resize 事件处理器 (防抖)。
     */
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
    // 帧元数据管理 (§7.4 帧历史管理)
    //
    // 帧元数据 (frameMetadata Map) 存储每个 frameId 对应的
    // scroll 偏移和 viewport 尺寸，用于服务端输入坐标转换。
    //
    // pruneFrameMetadata 定期清理超过 FRAME_HISTORY_MAX_AGE_MS (3s)
    // 的条目，防止未限制的 Map 增长导致内存泄漏。
    // ═══════════════════════════════════════════════════════════

    /**
     * 清理过期的帧元数据条目。
     *
     * 使用时间戳 (timestampMs) 而非 frameId 作为淘汰依据 —
     * 避免 frame_id uint32 回绕导致的误淘汰 (§7.4)。
     *
     * @param {number} currentTimeMs - 当前帧的时间戳 (ms)
     */
    function pruneFrameMetadata(currentTimeMs) {
        const cutoff = currentTimeMs - CONFIG.FRAME_HISTORY_MAX_AGE_MS;
        for (const [id, meta] of frameMetadata) {
            if (meta.timestampMs < cutoff) {
                frameMetadata.delete(id);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // UI 反馈 (§8.1 网络异常 / §8.3 客户端边界)
    //
    // 两种错误展示模式:
    //   - showDisconnectedOverlay: Canvas 上渲染错误文本 (连接断开)
    //     用户仍可见最后渲染的画面，仅叠加警告文字
    //   - showFatalError: 替换整个 body 为错误页面 (致命错误)
    //     提供 Reload 按钮供用户手动重试
    // ═══════════════════════════════════════════════════════════

    /**
     * 在 Canvas 上显示断线覆盖层。
     *
     * 使用 CanvasKit 直接在 <canvas> 上绘制红色提示文字。
     * 不修改 DOM 结构，用户最后可见的页面内容仍然在 canvas 上。
     *
     * @param {string} message - 提示消息
     */
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
            // 忽略渲染错误 — CanvasKit 可能处于不一致状态
        }
    }

    /**
     * 显示致命错误页面并替换整个 DOM。
     *
     * 使用场景: CanvasKit 加载失败、协议版本不匹配等无法恢复的错误。
     * 用户唯一的操作是点击 Reload 按钮重新加载整个页面。
     *
     * @param {string} message - 错误描述
     */
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

    /**
     * HTML 转义，防止 XSS 在错误页面中执行。
     *
     * @param {string} str - 用户可控/错误消息字符串
     * @returns {string} HTML 转义后的安全字符串
     */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;  // textContent 自动转义 HTML 实体
        return div.innerHTML;
    }

    // ═══════════════════════════════════════════════════════════
    // 辅助函数
    // ═══════════════════════════════════════════════════════════

    /**
     * 将 Uint8Array 转换为十六进制字符串。
     * 用于 SHA-256 哈希的显示和日志。
     *
     * @param {Uint8Array} bytes
     * @returns {string} 十六进制字符串 (小写)
     */
    function bytesToHex(bytes) {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // ═══════════════════════════════════════════════════════════
    // 启动
    //
    // 等待 DOM 就绪后调用 init()。
    // 如果 DOM 已就绪 (script 位于 </body> 之前)，直接启动。
    // ═══════════════════════════════════════════════════════════

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
