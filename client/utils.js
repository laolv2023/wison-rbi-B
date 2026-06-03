// utils.js — 客户端工具函数
//
// 包含:
//   1. CRC32 计算 (多项式 0xEDB88320)
//   2. gzip 安全解压 (v1.6 三层 zip bomb 防护)
//   3. 帧解析辅助
//   4. 日志/审计结构
//

'use strict';

import { PROTOCOL } from './protocol.js';

// ═══════════════════════════════════════════════════════════════
// CRC32 查找表 (多项式 0xEDB88320, IEEE 802.3)
// ═══════════════════════════════════════════════════════════════

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? ((crc >>> 1) ^ PROTOCOL.CRC32_POLYNOMIAL) : (crc >>> 1);
        }
        table[i] = crc;
    }
    return table;
})();

/**
 * 计算 CRC32。
 * @param {Uint8Array|ArrayBuffer} data
 * @param {number} [seed=0] - 初始 CRC 值
 * @returns {number} CRC32 值 (uint32)
 */
export function computeCRC32(data, seed = 0) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    let crc = seed ^ 0xFFFFFFFF;
    for (let i = 0; i < view.length; i++) {
        crc = CRC32_TABLE[(crc ^ view[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ═══════════════════════════════════════════════════════════════
// gzip 安全解压 (v1.6 三层 zip bomb 防护)
// ═══════════════════════════════════════════════════════════════

/**
 * 安全解压 gzip 数据。
 *
 * 三层防护:
 *   1. 压缩数据大小 ≤ MAX_COMPRESSED_FRAME (4MB)
 *   2. 流式解压，实时检查输出大小 ≤ MAX_BYTES_PER_FRAME (64MB)
 *   3. 解压后/压缩 > MAX_COMPRESSION_RATIO (1000:1) → 拒绝
 *
 * @param {ArrayBuffer} compressed - gzip 压缩的数据
 * @returns {Promise<ArrayBuffer>} 解压后的数据
 * @throws {Error} 安全校验失败时抛出
 */
export async function decompressWithProtection(compressed) {
    const {
        MAX_COMPRESSED_FRAME,
        MAX_BYTES_PER_FRAME,
        MAX_COMPRESSION_RATIO,
    } = PROTOCOL.LIMITS;

    // 第一层: 压缩大小检查
    if (compressed.byteLength > MAX_COMPRESSED_FRAME) {
        throw new Error(
            `Compressed frame too large: ${compressed.byteLength} > ${MAX_COMPRESSED_FRAME}`
        );
    }
    if (compressed.byteLength === 0) {
        throw new Error('Empty compressed frame');
    }

    // 使用 DecompressionStream API (浏览器原生, 流式解压)
    let decompressed;
    try {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();

        writer.write(compressed);
        writer.close();

        // 流式读取，逐步检查大小
        const chunks = [];
        let totalSize = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalSize += value.byteLength;

            // 第二层: 逐步检查输出大小
            if (totalSize > MAX_BYTES_PER_FRAME) {
                await reader.cancel();
                throw new Error(
                    `Decompressed frame exceeds MAX_BYTES_PER_FRAME (${MAX_BYTES_PER_FRAME})`
                );
            }

            chunks.push(value);
        }

        // 合并 chunks
        decompressed = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
            decompressed.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
        }
    } catch (err) {
        if (err.message.includes('MAX_BYTES_PER_FRAME')) throw err;
        throw new Error(`gzip decompression failed: ${err.message}`);
    }

    // 第三层: 压缩比检查（防止 zip bomb）
    const ratio = decompressed.byteLength / compressed.byteLength;
    if (ratio > MAX_COMPRESSION_RATIO) {
        throw new Error(
            `Suspicious compression ratio ${ratio.toFixed(1)}:1 > ${MAX_COMPRESSION_RATIO}:1`
        );
    }

    return decompressed.buffer;
}

// ═══════════════════════════════════════════════════════════════
// 帧头解析
// ═══════════════════════════════════════════════════════════════

/**
 * 从帧字节缓冲区解析帧头。
 * @param {ArrayBuffer} frameBuffer - 完整帧（Header + CommandStream + Trailer）
 * @returns {object} 解析后的帧元数据
 */
export function parseFrameHeader(frameBuffer) {
    const view = new DataView(frameBuffer);
    const { OFFSET_VERSION, OFFSET_FLAGS, OFFSET_FRAME_ID,
            OFFSET_TIMESTAMP_MS, OFFSET_SCROLL_X, OFFSET_SCROLL_Y,
            OFFSET_VIEWPORT_W, OFFSET_VIEWPORT_H,
            OFFSET_CANVAS_W, OFFSET_CANVAS_H,
            FLAG_IS_KEYFRAME, FLAG_HAS_FONT_DATA } = PROTOCOL;

    if (frameBuffer.byteLength < PROTOCOL.FRAME_HEADER_SIZE) {
        throw new Error(
            `Frame too short for header: ${frameBuffer.byteLength} < ${PROTOCOL.FRAME_HEADER_SIZE}`
        );
    }

    const version  = view.getUint8(OFFSET_VERSION);
    const flags    = view.getUint8(OFFSET_FLAGS);
    const frameId  = view.getUint32(OFFSET_FRAME_ID, true);
    const timestampMs = Number(view.getBigInt64(OFFSET_TIMESTAMP_MS, true));
    const scrollX  = view.getInt32(OFFSET_SCROLL_X, true);
    const scrollY  = view.getInt32(OFFSET_SCROLL_Y, true);
    const viewportW = view.getUint16(OFFSET_VIEWPORT_W, true);
    const viewportH = view.getUint16(OFFSET_VIEWPORT_H, true);
    const canvasW  = view.getUint16(OFFSET_CANVAS_W, true);
    const canvasH  = view.getUint16(OFFSET_CANVAS_H, true);

    return {
        version,
        flags,
        isKeyframe: !!(flags & FLAG_IS_KEYFRAME),
        hasFontData: !!(flags & FLAG_HAS_FONT_DATA),
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
 * CRC 覆盖范围: Header(30B) + CommandStream(N B)
 * CRC 位置: 帧尾最后 4 字节
 *
 * @param {ArrayBuffer} frameBuffer
 * @returns {boolean}
 */
export function validateFrameCRC(frameBuffer) {
    const { FRAME_HEADER_SIZE, FRAME_TRAILER_SIZE } = PROTOCOL;

    if (frameBuffer.byteLength < FRAME_HEADER_SIZE + FRAME_TRAILER_SIZE) {
        return false;
    }

    const headerPlusCommands = frameBuffer.slice(
        0,
        frameBuffer.byteLength - FRAME_TRAILER_SIZE
    );
    const expectedCRC = computeCRC32(new Uint8Array(headerPlusCommands));

    // 读取帧尾 CRC32
    const trailerOffset = frameBuffer.byteLength - FRAME_TRAILER_SIZE;
    const view = new DataView(frameBuffer);
    const actualCRC = view.getUint32(trailerOffset, true);

    return expectedCRC === actualCRC;
}

/**
 * 从帧缓冲区提取命令流（不含 Header 和 Trailer）。
 * @param {ArrayBuffer} frameBuffer
 * @returns {ArrayBuffer}
 */
export function extractCommandStream(frameBuffer) {
    const { FRAME_HEADER_SIZE, FRAME_TRAILER_SIZE } = PROTOCOL;
    const cmdLen = frameBuffer.byteLength - FRAME_HEADER_SIZE - FRAME_TRAILER_SIZE;
    return frameBuffer.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + cmdLen);
}

// ═══════════════════════════════════════════════════════════════
// 结构化日志（审计友好）
// ═══════════════════════════════════════════════════════════════

const LOG_LEVELS = Object.freeze({
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
});

let currentLogLevel = LOG_LEVELS.INFO;

export function setLogLevel(level) {
    currentLogLevel = level;
}

/**
 * 结构化日志（不含敏感信息）。
 * @param {number} level - LOG_LEVELS 枚举
 * @param {string} event - 事件名
 * @param {object} [details={}] - 附加数据
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
// ═══════════════════════════════════════════════════════════════

/**
 * 在渲染循环中注入 ±1ms 的随机抖动。
 * 安全理由: 破坏攻击者通过精确渲染时序推断页面内容的侧信道。
 *
 * @returns {Promise<void>} 随机延迟后 resolve
 */
export function randomJitter() {
    const jitterMs = (Math.random() * 2 - 1);  // [-1, +1] ms
    return new Promise(resolve => setTimeout(resolve, Math.abs(jitterMs)));
}
