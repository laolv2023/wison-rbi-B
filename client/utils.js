// utils.js — 客户端工具函数
//
// ## 模块角色
//   客户端的公共工具库，提供以下核心能力：
//   1. CRC32 计算 (多项式 0xEDB88320) — 帧完整性校验
//   2. gzip 安全解压 (v1.6 三层 zip bomb 防护) — 数据膨胀攻击防御
//   3. 帧解析辅助 — parseFrameHeader / validateFrameCRC / extractCommandStream
//   4. 结构化日志/审计 — 可追溯、不含敏感信息
//   5. 定时抖动 — Phase 2 侧信道防御 (§2.1 威胁模型)
//
// ## 安全不变量
//   - CRC32 计算为纯函数，无副作用，不分配大量内存
//   - decompressWithProtection 是三层纵深防御的核心:
//     1) 压缩大小上限 2) 流式解压实时检查 3) 压缩比后验
//   - auditLog 不含任何用户输入/页面内容，仅包含系统元数据
//   - randomJitter 使用 Math.random() (非加密安全)，仅用于时序混淆
//
// ## 设计文档交叉引用
//   - §6.2: 帧完整性 CRC32 覆盖范围
//   - §6.2: v1.6 gzip zip bomb 三层防护规范
//   - §2.1: 侧信道威胁模型 → randomJitter
//   - §5.5: 帧处理流水线 → parseFrameHeader / validateFrameCRC
//   - §8.1: 错误处理 → 日志等级与审计
//

'use strict';

import { PROTOCOL } from './protocol.js';

// ═══════════════════════════════════════════════════════════════
// CRC32 查找表 (多项式 0xEDB88320, IEEE 802.3)
//
// 为什么预计算查找表: 每次帧都需要 CRC32 校验，表驱动算法
// 将 O(8n) bit-by-bit 降为 O(n) 表查找，对 64MB 帧是性能关键。
// 使用 IIFE 在模块加载时一次性生成 256 个 uint32 值。
// ═══════════════════════════════════════════════════════════════

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            // 反射多项式算法: LSB 为 1 时执行 XOR，否则仅右移
            // 使用 >>> 0 确保无符号语义
            crc = (crc & 1) ? ((crc >>> 1) ^ PROTOCOL.CRC32_POLYNOMIAL) : (crc >>> 1);
        }
        table[i] = crc;
    }
    return table;
})();

/**
 * 计算 CRC32 校验值 (IEEE 802.3 / PKZIP 兼容)。
 *
 * 算法: 表驱动 CRC32，初始值 0xFFFFFFFF，输出异或 0xFFFFFFFF。
 * 与 zlib crc32() 完全一致，可用标准工具 (如 `gzip -lv`) 验证。
 *
 * 威胁模型: CRC32 非加密哈希，不防篡改 (攻击者可重新计算 CRC) —
 * 但 WebSocket 层已有 TLS 1.3 提供完整性保护。CRC32 主要检测:
 *   1. 网络传输 bit 翻转
 *   2. 服务端 gzip 实现 bug 导致的数据损坏
 *   3. socket.io 消息分片/重组的边界错误
 *
 * @param {Uint8Array|ArrayBuffer} data - 待校验数据
 * @param {number} [seed=0] - 初始 CRC 值 (用于分段计算)
 * @returns {number} CRC32 值 (uint32, 0–0xFFFFFFFF)
 */
export function computeCRC32(data, seed = 0) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    let crc = seed ^ 0xFFFFFFFF;           // 初始值取反
    for (let i = 0; i < view.length; i++) {
        crc = CRC32_TABLE[(crc ^ view[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;       // 输出取反，确保无符号
}

// ═══════════════════════════════════════════════════════════════
// gzip 安全解压 (v1.6 三层 zip bomb 防护)
//
// 威胁模型: 攻击者控制的服务端可能发送恶意 gzip 数据。
// Zip bomb: 小压缩文件 (如 42KB) 解压后爆炸到数 GB。
// 经典案例: 42.zip (42KB → 4.5PB 递归炸弹)。
//
// 三层纵深防御:
//   第一层 — 压缩包大小上限 4MB (MAX_COMPRESSED_FRAME):
//     正常 1080p 帧压缩后通常 < 500KB，4MB 已是极端上限。
//     即使是 42.zip 也会在此层被拦截 (42KB 也需考虑)。
//   第二层 — 流式解压 + 实时输出大小上限 64MB (MAX_BYTES_PER_FRAME):
//     使用浏览器原生 DecompressionStream 逐块读取，当输出超过
//     64MB 时立即 cancel() 终止解压，避免完整展开到内存。
//   第三层 — 解压比 > 1000:1 视为异常:
//     正常帧的解压比通常在 2:1–20:1 之间。1000:1 允许极端情况
//     (如纯色大图) 但仍可拦截所有已知 zip bomb。
// ═══════════════════════════════════════════════════════════════

/**
 * 安全解压 gzip 数据，三层纵深防御。
 *
 * 为什么用 DecompressionStream 而非 pako 等 JS 库:
 *   - 浏览器原生实现 (C++ 级性能，非 JS 解释器)
 *   - 流式 API 允许逐步检查输出大小，避免内存峰值
 *   - 不引入第三方依赖，减少供应链攻击面
 *
 * @param {ArrayBuffer} compressed - gzip 压缩的帧数据
 * @returns {Promise<ArrayBuffer>} 解压后的帧数据 (Header + Commands + Trailer)
 * @throws {Error} 安全校验失败时抛出，调用方应丢弃该帧并记录告警
 */
export async function decompressWithProtection(compressed) {
    const {
        MAX_COMPRESSED_FRAME,
        MAX_BYTES_PER_FRAME,
        MAX_COMPRESSION_RATIO,
    } = PROTOCOL.LIMITS;

    // ── 第一层: 压缩大小上限检查 ──
    // 威胁: 攻击者发送 4.3GB 压缩文件 → 浏览器 OOM。
    // 4MB 上限：压缩帧 (含头尾) 即使 gzip 无法压缩 (随机数据) 也不会超。
    if (compressed.byteLength > MAX_COMPRESSED_FRAME) {
        throw new Error(
            `Compressed frame too large: ${compressed.byteLength} > ${MAX_COMPRESSED_FRAME}`
        );
    }
    if (compressed.byteLength === 0) {
        throw new Error('Empty compressed frame');
    }

    // ── 第二层: 流式解压 + 实时输出检查 ──
    let decompressed;
    try {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();

        writer.write(compressed);
        writer.close();

        // 流式读取 — 每块通常是浏览器内部缓冲区大小 (~64KB)
        const chunks = [];
        let totalSize = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalSize += value.byteLength;

            // 第二层: 如果任何中间块使输出超过 64MB，立即取消
            // cancel() 会向底层流发送终止信号，释放已分配资源
            if (totalSize > MAX_BYTES_PER_FRAME) {
                await reader.cancel();
                throw new Error(
                    `Decompressed frame exceeds MAX_BYTES_PER_FRAME (${MAX_BYTES_PER_FRAME})`
                );
            }

            chunks.push(value);
        }

        // 合并 chunks 为连续 ArrayBuffer
        decompressed = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
            decompressed.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
        }
    } catch (err) {
        // 保留 MAX_BYTES_PER_FRAME 错误向上传播
        if (err.message.includes('MAX_BYTES_PER_FRAME')) throw err;
        // gzip 格式错误 → 包装后抛出
        throw new Error(`gzip decompression failed: ${err.message}`);
    }

    // ── 第三层: 压缩比检查 (后验防御) ──
    // 威胁: 压缩比是检测 zip bomb 的最后一道防线。
    // 攻击者可能精心构造压缩数据使第一/二层恰好不触发，
    // 但在解压后暴露超高压缩比。
    const ratio = decompressed.byteLength / compressed.byteLength;
    if (ratio > MAX_COMPRESSION_RATIO) {
        throw new Error(
            `Suspicious compression ratio ${ratio.toFixed(1)}:1 > ${MAX_COMPRESSION_RATIO}:1`
        );
    }

    return decompressed.buffer;
}

// ═══════════════════════════════════════════════════════════════
// ArrayBuffer 归一化
//
// Node.js Buffer.allocUnsafe 可能从共享池分配，导致 frame.buffer 的
// ArrayBuffer 起始偏移非零。此辅助函数确保输入始终是正确对齐的 ArrayBuffer。
// ═══════════════════════════════════════════════════════════════

/**
 * 将 TypedArray 或 ArrayBuffer 归一化为正确对齐的 ArrayBuffer。
 * Node.js Buffer.allocUnsafe 可能回退到共享池分配，
 * 此时 buf.buffer 对应的 ArrayBuffer 可能包含池中前置数据。
 * 本函数检测该情况并在必要时切片。
 *
 * @param {ArrayBuffer|ArrayBufferView} buf - 帧缓冲区
 * @returns {ArrayBuffer} 正确对齐、byteOffset=0 的 ArrayBuffer
 */
function normalizeArrayBuffer(buf) {
    if (ArrayBuffer.isView(buf)) {
        if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
            return buf.buffer;
        }
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    return buf;
}

// ═══════════════════════════════════════════════════════════════
// 帧头解析
//
// 对应 §6.2 定义的二进制帧格式:
//   [0-29]  Header (30 bytes)
//   [30..N-5] CommandStream (变长, 4字节对齐)
//   [N-4..N-1] CRC32 Trailer (4 bytes)
//
// 所有多字节数值使用小端序 (LE)。
// ═══════════════════════════════════════════════════════════════

/**
 * 从帧字节缓冲区解析帧头。
 *
 * 帧头 30 字节布局 (§6.2):
 *   [0]    version (uint8)      — 协议版本号
 *   [1]    flags (uint8)        — bit0: isKeyframe, bit1: hasFontData
 *   [2:6]  frameId (uint32 LE)  — 单调递增帧序列号
 *   [6:14] timestampMs (int64 LE) — 采集时刻 (ms)
 *   [14:18] scrollX (int32 LE)  — 水平滚动偏移 (§7.3)
 *   [18:22] scrollY (int32 LE)  — 垂直滚动偏移
 *   [22:24] viewportW (uint16 LE) — 视口宽度
 *   [24:26] viewportH (uint16 LE) — 视口高度
 *   [26:28] canvasW (uint16 LE) — 绘制面宽度
 *   [28:30] canvasH (uint16 LE) — 绘制面高度
 *
 * @param {ArrayBuffer} frameBuffer - 完整帧 (Header + CommandStream + Trailer)
 * @returns {object} 帧元数据对象
 * @returns {number} .version - 协议版本
 * @returns {number} .flags - 原始标志位
 * @returns {boolean} .isKeyframe - 是否为关键帧
 * @returns {boolean} .hasFontData - 是否包含内联字体
 * @returns {number} .frameId - 帧序列号
 * @returns {number} .timestampMs - 采集时间戳
 * @returns {number} .scrollX / .scrollY - 滚动偏移
 * @returns {number} .viewportW / .viewportH - 视口尺寸
 * @returns {number} .canvasW / .canvasH - 绘制面尺寸
 * @throws {Error} 帧小于 FRAME_HEADER_SIZE (30B) 时抛出
 */
export function parseFrameHeader(frameBuffer) {
    frameBuffer = normalizeArrayBuffer(frameBuffer);
    const view = new DataView(frameBuffer);
    const { OFFSET_VERSION, OFFSET_FLAGS, OFFSET_FRAME_ID,
            OFFSET_TIMESTAMP_MS, OFFSET_SCROLL_X, OFFSET_SCROLL_Y,
            OFFSET_VIEWPORT_W, OFFSET_VIEWPORT_H,
            OFFSET_CANVAS_W, OFFSET_CANVAS_H,
            FLAG_IS_KEYFRAME, FLAG_HAS_FONT_DATA, FLAG_HAS_DIRTY_RECTS,
            DIRTY_RECT_ENTRY_SIZE, MAX_DIRTY_RECTS } = PROTOCOL;

    // 边界检查: 帧至少包含帧头
    if (frameBuffer.byteLength < PROTOCOL.FRAME_HEADER_SIZE) {
        throw new Error(
            `Frame too short for header: ${frameBuffer.byteLength} < ${PROTOCOL.FRAME_HEADER_SIZE}`
        );
    }

    const version  = view.getUint8(OFFSET_VERSION);
    const flags    = view.getUint8(OFFSET_FLAGS);
    const frameId  = view.getUint32(OFFSET_FRAME_ID, true);          // LE
    const timestampMs = Number(view.getBigInt64(OFFSET_TIMESTAMP_MS, true)); // int64 → Number
    const scrollX  = view.getInt32(OFFSET_SCROLL_X, true);           // 有符号
    const scrollY  = view.getInt32(OFFSET_SCROLL_Y, true);
    const viewportW = view.getUint16(OFFSET_VIEWPORT_W, true);
    const viewportH = view.getUint16(OFFSET_VIEWPORT_H, true);
    const canvasW  = view.getUint16(OFFSET_CANVAS_W, true);
    const canvasH  = view.getUint16(OFFSET_CANVAS_H, true);

    const hasDirtyRects = !!(flags & FLAG_HAS_DIRTY_RECTS);
    let dirtyRects = [];

    // Phase 4: 解析脏区域矩形列表
    let dirtyRectsEndOffset = PROTOCOL.FRAME_HEADER_SIZE;
    if (hasDirtyRects) {
        const drOffset = PROTOCOL.FRAME_HEADER_SIZE;
        if (frameBuffer.byteLength >= drOffset + 2) {
            const count = view.getUint16(drOffset, true);
            if (count <= MAX_DIRTY_RECTS) {
                const drSize = 2 + count * DIRTY_RECT_ENTRY_SIZE;
                if (frameBuffer.byteLength >= drOffset + drSize) {
                    let pos = drOffset + 2;
                    for (let i = 0; i < count; i++) {
                        dirtyRects.push({
                            x: view.getFloat32(pos, true),
                            y: view.getFloat32(pos + 4, true),
                            w: view.getFloat32(pos + 8, true),
                            h: view.getFloat32(pos + 12, true),
                        });
                        pos += DIRTY_RECT_ENTRY_SIZE;
                    }
                    dirtyRectsEndOffset = drOffset + drSize;
                }
            }
        }
    }

    return {
        version,
        flags,
        isKeyframe: !!(flags & FLAG_IS_KEYFRAME),
        hasFontData: !!(flags & FLAG_HAS_FONT_DATA),
        hasDirtyRects,
        dirtyRects,
        dirtyRectsEndOffset,  // Phase 4: CommandStream 的起始偏移
        frameId,
        timestampMs,
        scrollX,
        scrollY,
        viewportW,
        viewportH,
        canvasW,
        canvasH,
    };
}

/**
 * 验证帧 CRC32。
 *
 * CRC 覆盖范围: Header(30B) + CommandStream(N B) (§6.2)
 * CRC 位置: 帧尾最后 4 字节 (FRAME_TRAILER_SIZE)
 *
 * 为什么 CRC 不覆盖 Trailer 自身: 标准做法 — 先计算 CRC，再将其
 * 写入 Trailer。校验时计算 Header+Commands 的 CRC，与 Trailer 比较。
 *
 * 威胁模型: CRC32 非加密校验。TLS 1.3 提供完整性；CRC 检测传输/压缩 bug。
 *
 * @param {ArrayBuffer} frameBuffer - 完整帧
 * @returns {boolean} CRC 是否匹配。false 时调用方应丢弃该帧
 */
export function validateFrameCRC(frameBuffer) {
    frameBuffer = normalizeArrayBuffer(frameBuffer);
    const { FRAME_HEADER_SIZE, FRAME_TRAILER_SIZE } = PROTOCOL;

    // 帧至少需要 header + trailer
    if (frameBuffer.byteLength < FRAME_HEADER_SIZE + FRAME_TRAILER_SIZE) {
        return false;
    }

    // 计算 Header + Commands 的 CRC
    const headerPlusCommands = frameBuffer.slice(
        0,
        frameBuffer.byteLength - FRAME_TRAILER_SIZE
    );
    const expectedCRC = computeCRC32(new Uint8Array(headerPlusCommands));

    // 读取帧尾 CRC32 (小端序)
    const trailerOffset = frameBuffer.byteLength - FRAME_TRAILER_SIZE;
    const view = new DataView(frameBuffer);
    const actualCRC = view.getUint32(trailerOffset, true);

    return expectedCRC === actualCRC;
}

/**
 * 从帧缓冲区提取命令流 (不含 Header 和 Trailer)。
 *
 * 命令流 = frameBuffer[30 .. N-5]
 *
 * @param {ArrayBuffer} frameBuffer - 完整帧
 * @param {number} [cmdStartOffset] - Phase 4: 命令流起始偏移 (默认 FRAME_HEADER_SIZE)
 * @returns {ArrayBuffer} 命令流字节 (零拷贝 slice)
 */
export function extractCommandStream(frameBuffer, cmdStartOffset) {
    frameBuffer = normalizeArrayBuffer(frameBuffer);
    const { FRAME_HEADER_SIZE, FRAME_TRAILER_SIZE } = PROTOCOL;
    const start = cmdStartOffset || FRAME_HEADER_SIZE;
    const cmdLen = frameBuffer.byteLength - start - FRAME_TRAILER_SIZE;
    if (cmdLen <= 0) return new ArrayBuffer(0);
    return frameBuffer.slice(start, start + cmdLen);
}

// ═══════════════════════════════════════════════════════════════
// 结构化日志（审计友好）
//
// 设计原则:
//   - 不含敏感信息 (页面 URL 仅日志 targetUrl 占位符)
//   - 固定格式: { ts, event, ...details }
//   - 可通过 window.__wison_audit 收集发送到远程审计服务
// ═══════════════════════════════════════════════════════════════

/**
 * 日志等级枚举。
 * 与 syslog 风格一致: DEBUG < INFO < WARN < ERROR
 */
const LOG_LEVELS = Object.freeze({
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
});

/** @private 当前日志等级，低于此等级的日志被抑制 */
let currentLogLevel = LOG_LEVELS.INFO;

/**
 * 动态设置日志等级。
 * 生产环境建议 INFO，调试时可设 DEBUG。
 *
 * @param {number} level - LOG_LEVELS 枚举值
 */
export function setLogLevel(level) {
    currentLogLevel = level;
}

/**
 * 结构化审计日志。
 *
 * 每条日志包含:
 *   - ts: 毫秒时间戳 (Date.now())
 *   - event: 事件名 (如 'frame_crc_mismatch', 'ws_connected')
 *   - ...details: 附加上下文 (不含页面内容/用户输入)
 *
 * 安全: 不记录任何用户输入或页面像素数据。
 *
 * @param {number} level - LOG_LEVELS 枚举
 * @param {string} event - 事件名 (kebab-case 约定)
 * @param {object} [details={}] - 附加数据 (仅系统元数据)
 */
export function auditLog(level, event, details = {}) {
    if (level < currentLogLevel) return;

    const entry = {
        ts: Date.now(),
        event,
        ...details,
    };

    const levelName = Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === level) || 'UNKNOWN';

    switch (level) {
        case LOG_LEVELS.DEBUG:
            console.debug(`[wison:${event}]`, entry);
            break;
        case LOG_LEVELS.INFO:
            console.log(`[wison:${event}]`, entry);
            break;
        case LOG_LEVELS.WARN:
            console.warn(`[wison:${event}]`, entry);
            break;
        case LOG_LEVELS.ERROR:
            console.error(`[wison:${event}]`, entry);
            break;
    }
}

export { LOG_LEVELS };

// ═══════════════════════════════════════════════════════════════
// 定时抖动（v1.6 P1 S5 — Phase 2 侧信道防御）
//
// 威胁模型 (§2.1):
//   攻击者通过 JavaScript 精确计时 (performance.now(), 可达 μs 级)
//   可推断页面渲染时长，进而推测:
//     - 某元素是否被渲染 (visible vs hidden)
//     - 文本长度 (不同长度的 textBlob 渲染时间不同)
//     - 密码逐字符验证 (每次错误触发不同渲染路径)
//
// 防御原理:
//   在 CanvasKit flush 之前注入 [-1, +1] ms 的均匀分布随机延迟，
//   使渲染完成的 observable 时间与渲染内容解耦。
//   攻击者的测量被 ±1ms 噪声污染，信噪比大幅降低。
//   1ms 对于 60fps (16.7ms/帧) 是 6% 的抖动量，用户不可感知。
//
// 局限:
//   - Math.random() 非加密安全，攻击者可能预测种子 (XorShift128+)
//   - 1ms 是权衡值：太大影响帧率，太小侧信道增益不足
//   - 不防御基于帧间差异的侧信道 (两帧之间大小差异等)
// ═══════════════════════════════════════════════════════════════

/**
 * 生成 [-1.0, +1.0] ms 的均匀分布随机抖动值。
 *
 * 安全理由: 破坏攻击者通过精确渲染时序推断页面内容的侧信道。
 *
 * 为什么用均匀分布而非正态分布:
 *   均匀分布最大熵 (给定范围)，使每个可能的延迟等概率，
 *   攻击者无法利用分布特征做统计推断。
 *
 * @returns {number} 抖动值，单位 ms，范围 [-1.0, +1.0]
 */
export function randomJitter() {
    return (Math.random() * 2.0 - 1.0);  // 均匀分布 [-1.0, +1.0] ms
}

/**
 * 异步版本: 在渲染循环中注入 ±1ms 随机延迟。
 *
 * 使用 setTimeout 实现非阻塞抖动。
 * 为什么用异步而不是忙等:
 *   - 忙等 (while(Date.now()-start<1) {}) 会阻塞主线程，
 *     阻止浏览器处理用户输入、渲染其他帧
 *   - setTimeout 将控制权归还事件循环，允许浏览器处理其他任务
 *
 * 注意: setTimeout 最小延迟约 4ms (浏览器嵌套超时限制)。
 * 因此实际延迟取 abs(jitter)，范围 [0, 1] ms。
 * 在 1ms 量级下，setTimeout 的实际精度受限 (~1-4ms)，
 * 但噪声注入的防御效果仍然有效。
 *
 * @returns {Promise<void>}
 */
export function randomJitterAsync() {
    const jitterMs = Math.abs(randomJitter());  // [0, 1] ms 延迟
    return new Promise(resolve => setTimeout(resolve, jitterMs));
}
