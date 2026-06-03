// frame_builder.js — 服务端帧构建器
//
// 负责:
// 1. 帧头序列化 (30 字节二进制)
// 2. CRC32 计算 (多项式 0xEDB88320)
// 3. gzip 压缩
// 4. 完整帧组装 (Header + CommandStream + Trailer)
//
// 字节序: 全部 Little Endian
//

'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const gzipAsync = promisify(zlib.gzip);
const {
    PROTOCOL_VERSION,
    FRAME_HEADER_SIZE,
    FRAME_TRAILER_SIZE,
    MAX_BYTES_PER_FRAME,
    MAX_COMPRESSED_FRAME,
    MAX_COMPRESSION_RATIO,
    CRC32_POLYNOMIAL,
    FLAG_IS_KEYFRAME,
    FLAG_HAS_FONT_DATA,
} = require('./config');

// ═══════════════════════════════════════════════════════════════
// CRC32 查找表 (多项式 0xEDB88320, IEEE 802.3)
// ═══════════════════════════════════════════════════════════════

const CRC32_TABLE = new Uint32Array(256);
(function initCRC32Table() {
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? ((crc >>> 1) ^ CRC32_POLYNOMIAL) : (crc >>> 1);
        }
        CRC32_TABLE[i] = crc;
    }
})();

/**
 * 计算 CRC32。
 * @param {Buffer} buf - 输入数据
 * @param {number} [seed=0] - 初始 CRC 值（用于增量计算）
 * @returns {number} CRC32 值
 */
function computeCRC32(buf, seed = 0) {
    let crc = seed ^ 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ═══════════════════════════════════════════════════════════════
// 帧头序列化
// ═══════════════════════════════════════════════════════════════

/**
 * 序列化帧头为 30 字节 Buffer。
 *
 * 字节布局 (Little Endian):
 *   [0:1]   version       uint8
 *   [1:2]   flags         uint8
 *   [2:6]   frame_id      uint32
 *   [6:14]  timestamp_ms  int64
 *   [14:18] scroll_x      int32
 *   [18:22] scroll_y      int32
 *   [22:24] viewport_w    uint16
 *   [24:26] viewport_h    uint16
 *   [26:28] canvas_w      uint16
 *   [28:30] canvas_h      uint16
 *
 * @param {object} meta - 帧元数据
 * @returns {Buffer} 30 字节帧头
 */
function serializeFrameHeader(meta) {
    const buf = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
    let offset = 0;

    // Byte 0: version
    buf.writeUInt8(meta.version || PROTOCOL_VERSION, offset);
    offset += 1;

    // Byte 1: flags
    let flags = 0;
    if (meta.isKeyframe) flags |= FLAG_IS_KEYFRAME;
    if (meta.hasFontData) flags |= FLAG_HAS_FONT_DATA;
    buf.writeUInt8(flags, offset);
    offset += 1;

    // Byte 2-5: frame_id (uint32 LE)
    buf.writeUInt32LE(meta.frameId, offset);
    offset += 4;

    // Byte 6-13: timestamp_ms (int64 LE)
    // Node.js Buffer 支持 BigInt 写入
    buf.writeBigInt64LE(BigInt(meta.timestampMs), offset);
    offset += 8;

    // Byte 14-17: scroll_x (int32 LE)
    buf.writeInt32LE(meta.scrollX, offset);
    offset += 4;

    // Byte 18-21: scroll_y (int32 LE)
    buf.writeInt32LE(meta.scrollY, offset);
    offset += 4;

    // Byte 22-23: viewport_w (uint16 LE)
    // 安全检查: 防止大于 65535 的 viewport（uint16 上限）
    const vpW = Math.min(meta.viewportW, 65535);
    buf.writeUInt16LE(vpW, offset);
    offset += 2;

    // Byte 24-25: viewport_h (uint16 LE)
    const vpH = Math.min(meta.viewportH, 65535);
    buf.writeUInt16LE(vpH, offset);
    offset += 2;

    // Byte 26-27: canvas_w (uint16 LE)
    const cW = Math.min(meta.canvasW, 65535);
    buf.writeUInt16LE(cW, offset);
    offset += 2;

    // Byte 28-29: canvas_h (uint16 LE)
    const cH = Math.min(meta.canvasH, 65535);
    buf.writeUInt16LE(cH, offset);
    offset += 2;

    return buf;
}

/**
 * 反序列化帧头（服务端通常不需要，但在调试/审计时有价值）
 * @param {Buffer} buf - 30 字节 Buffer
 * @returns {object} 帧元数据
 */
function deserializeFrameHeader(buf) {
    if (buf.length < FRAME_HEADER_SIZE) {
        throw new Error(`Frame header too short: ${buf.length} < ${FRAME_HEADER_SIZE}`);
    }
    let offset = 0;

    const version = buf.readUInt8(offset); offset += 1;
    const flags = buf.readUInt8(offset); offset += 1;
    const frameId = buf.readUInt32LE(offset); offset += 4;
    const timestampMs = Number(buf.readBigInt64LE(offset)); offset += 8;
    const scrollX = buf.readInt32LE(offset); offset += 4;
    const scrollY = buf.readInt32LE(offset); offset += 4;
    const viewportW = buf.readUInt16LE(offset); offset += 2;
    const viewportH = buf.readUInt16LE(offset); offset += 2;
    const canvasW = buf.readUInt16LE(offset); offset += 2;
    const canvasH = buf.readUInt16LE(offset); offset += 2;

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

// ═══════════════════════════════════════════════════════════════
// 帧组装
// ═══════════════════════════════════════════════════════════════

/**
 * 组装完整帧（未压缩版本）。
 *
 * 帧结构:
 *   [30 bytes Header] [N bytes CommandStream] [4 bytes CRC32]
 *
 * CRC32 覆盖范围: Header + CommandStream
 *
 * @param {object} meta - 帧元数据 (同 serializeFrameHeader 参数)
 * @param {Buffer} commandStream - 命令流字节
 * @returns {Buffer} 完整未压缩帧
 */
function assembleFrame(meta, commandStream) {
    const header = serializeFrameHeader(meta);

    const cmdLen = commandStream ? commandStream.length : 0;

    // 大小检查
    const totalSize = FRAME_HEADER_SIZE + cmdLen + FRAME_TRAILER_SIZE;
    if (totalSize > MAX_BYTES_PER_FRAME) {
        throw new Error(
            `Frame total size ${totalSize} exceeds MAX_BYTES_PER_FRAME (${MAX_BYTES_PER_FRAME})`
        );
    }

    const frame = Buffer.allocUnsafe(totalSize);

    // 拷贝 Header
    header.copy(frame, 0);

    // 拷贝 CommandStream
    if (cmdLen > 0) {
        commandStream.copy(frame, FRAME_HEADER_SIZE);
    }

    // 计算 CRC32 (Header + CommandStream)
    const crcData = frame.subarray(0, FRAME_HEADER_SIZE + cmdLen);
    const crc = computeCRC32(crcData);

    // 写入 CRC32 (uint32 LE)
    frame.writeUInt32LE(crc, FRAME_HEADER_SIZE + cmdLen);

    return frame;
}

// ═══════════════════════════════════════════════════════════════
// gzip 压缩 (v1.6 zip bomb 三层防护)
// ═══════════════════════════════════════════════════════════════

/**
 * 压缩帧。
 *
 * v1.6 安全增强:
 *   - 压缩前检查未压缩大小 ≤ MAX_BYTES_PER_FRAME
 *   - 压缩后检查压缩大小 ≤ MAX_COMPRESSED_FRAME
 *   - 检查压缩比 ≤ MAX_COMPRESSION_RATIO
 *
 * @param {Buffer} frame - 未压缩帧
 * @returns {Promise<Buffer>} gzip 压缩后的帧
 */
async function compressFrame(frame) {
    // 第一层: 未压缩大小必须在限制内
    if (frame.length > MAX_BYTES_PER_FRAME) {
        throw new Error(
            `Frame too large to compress: ${frame.length} > ${MAX_BYTES_PER_FRAME}`
        );
    }

    const compressed = await gzipAsync(frame, { level: 6 });

    // 第二层: 压缩后大小硬限制
    if (compressed.length > MAX_COMPRESSED_FRAME) {
        throw new Error(
            `Compressed frame too large: ${compressed.length} > ${MAX_COMPRESSED_FRAME}`
        );
    }

    // 第三层: 压缩比异常检测 — 与客户端三重防护对齐
    // 若未压缩数据为 0，跳过检查
    if (frame.length > 0) {
        const ratio = compressed.length / frame.length;
        // 压缩后极小但解压后极大的帧 → zip bomb 特征
        // 例如: 63MB 解压后 / 1KB 压缩后 = 63000:1，远超正常 2:1~10:1
        if (frame.length > MAX_COMPRESSION_RATIO * compressed.length) {
            throw new Error(
                `Suspicious compression ratio: ` +
                `${(frame.length / compressed.length).toFixed(1)}:1 > ${MAX_COMPRESSION_RATIO}:1`
            );
        }
    }

    return compressed;
}

// ═══════════════════════════════════════════════════════════════
// 图像 Hash-Ref 去重注册表 (Phase 4)
//
// 服务端维护已发送图像的 SHA-256 哈希集合。
// 当图像模式为 hash-ref 时:
//   - 首次发送: 内联完整图像数据 + 记录 SHA-256
//   - 后续帧: 仅发送 32 字节哈希引用，客户端从 ImageCache 获取
//
// 这可将典型网页增量帧带宽降低 60-80%（图像占帧数据大头）。
// ═══════════════════════════════════════════════════════════════

class ImageHashRegistry {
    /**
     * @param {object} [options]
     * @param {number} [options.maxEntries=10000] - 最大条目数
     */
    constructor(options = {}) {
        this._maxEntries = options.maxEntries || 10000;
        this._hashes = new Set();          // hex hash strings
        this._lru = [];                    // LRU eviction order
    }

    /**
     * 计算图像数据的 SHA-256 哈希。
     * @param {Buffer} imageData
     * @returns {string} 十六进制哈希
     */
    static computeHash(imageData) {
        return crypto.createHash('sha256').update(imageData).digest('hex');
    }

    /**
     * 检查图像是否已发送过。
     * @param {string} hexHash
     * @returns {boolean}
     */
    has(hexHash) {
        return this._hashes.has(hexHash);
    }

    /**
     * 标记图像已发送并记录哈希。
     * @param {string} hexHash
     */
    mark(hexHash) {
        if (this._hashes.has(hexHash)) {
            this._touch(hexHash);
            return;
        }

        // LRU 淘汰
        while (this._hashes.size >= this._maxEntries) {
            const oldest = this._lru.shift();
            if (oldest) this._hashes.delete(oldest);
        }

        this._hashes.add(hexHash);
        this._lru.push(hexHash);
    }

    /**
     * 获取统计信息。
     */
    get stats() {
        return {
            entryCount: this._hashes.size,
            maxEntries: this._maxEntries,
        };
    }

    _touch(hexHash) {
        this._lru = this._lru.filter(h => h !== hexHash);
        this._lru.push(hexHash);
    }
}

// ═══════════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════════

module.exports = {
    serializeFrameHeader,
    deserializeFrameHeader,
    assembleFrame,
    compressFrame,
    computeCRC32,
    ImageHashRegistry,
};
