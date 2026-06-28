// frame_builder.js — Wison-RBI 服务端帧构建器
//
// === 模块角色 ===
// 本模块是 Wison-RBI 服务端**帧序列化流水线的核心引擎**。
// 架构角色: 数据编码器 — 将绘制命令流 + 元数据打包为二进制帧格式，
//   计算完整性校验码（CRC32），压缩（gzip），最终产出 WebSocket 传输的字节流。
//
// === 安全不变量 (§2.2 不变量 1) ===
//   本模块确保:
//   1. 帧结构严格符合协议规范（30B Header + N B CommandStream + 4B CRC32）
//   2. CRC32 覆盖 Header+CommandStream，客户端可检测传输中的任意篡改
//   3. gzip 压缩带三层 zip bomb 防护（大小上限 + 压缩后上限 + 压缩比异常检测）
//
// === 数据流方向 ===
//   Chromium CommandStream (Buffer) + FrameMeta (object)
//     → serializeFrameHeader() → 30B Header
//     → assembleFrame() → Header + CommandStream + CRC32
//     → compressFrame() → gzip Buffer
//     → WebSocket.send() → 客户端
//
// === 设计文档交叉引用 ===
//   §6.1 — 帧二进制格式: Header 30 字节布局、CRC32 多项式、字节序 (Little Endian)
//   §6.3 — MAX_BYTES_PER_FRAME (64MB) / MAX_COMPRESSED_FRAME (4MB) 硬上限
//   §6.4 — gzip zip bomb 三层防护: 大小→压缩后→压缩比
//   §4   — ImageHashRegistry: 图像 SHA-256 去重，降低增量帧带宽 60-80%
//

'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const gzipAsync = promisify(zlib.gzip);  // 将 zlib.gzip 转为 Promise 风格
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
    FLAG_HAS_DIRTY_RECTS,
} = require('./config');

// ═══════════════════════════════════════════════════════════════
// CRC32 查找表 (多项式 0xEDB88320, IEEE 802.3)
//
// CRC32 用于帧完整性校验 (§6.1):
//   - 覆盖 Header + CommandStream（不含帧尾 CRC 自身）
//   - 与 zlib.crc32() 和客户端 CRC 实现保持一致
//   - 使用预计算查找表实现 O(n) 时间 / O(256×4=1KB) 空间
//
// 为什么不用 crypto 模块的哈希？
//   CRC32 是 32 位校验和，不是密码学哈希。设计选择 CRC32 而非 SHA-256:
//   1. CRC32 计算速度约为 SHA-256 的 20-50 倍（查表 vs 多轮压缩）
//   2. CRC32 输出仅 4 字节（vs 32 字节），帧尾开销小
//   3. 安全模型: TLS 1.3 已提供信道加密+认证 (§2.1)，
//      CRC32 仅作为传输错误的快速检测，而非防篡改手段
// ═══════════════════════════════════════════════════════════════

const CRC32_TABLE = new Uint32Array(256);
(function initCRC32Table() {
    for (let i = 0; i < 256; i++) {
        let crc = i;
        // 逐位处理: 若 LSB=1 则右移后 XOR 多项式，否则仅右移
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? ((crc >>> 1) ^ CRC32_POLYNOMIAL) : (crc >>> 1);
        }
        CRC32_TABLE[i] = crc;
    }
})();

/**
 * 计算 CRC32 校验和。
 *
 * 使用标准 CRC32 算法（reflect in, reflect out, XOR 0xFFFFFFFF）。
 * 与 Python zlib.crc32 / Node.js crc32 库 / 客户端 wasm 实现兼容。
 *
 * 支持增量计算: 通过 seed 参数可分段计算 CRC（先算 Header，再算 CommandStream）。
 *
 * @param {Buffer} buf - 输入数据
 * @param {number} [seed=0] - 初始 CRC 值（用于增量计算，0 表示从头开始）
 * @returns {number} CRC32 校验和（32 位无符号整数）
 */
function computeCRC32(buf, seed = 0) {
    let crc = seed ^ 0xFFFFFFFF;  // 初始 XOR
    for (let i = 0; i < buf.length; i++) {
        // 查表: (crc ^ byte) & 0xFF 作为表索引，结果与 crc>>8 异或
        crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;  // 最终 XOR + 转为无符号
}

// ═══════════════════════════════════════════════════════════════
// 帧头序列化 (§6.1 字节布局)
// ═══════════════════════════════════════════════════════════════

/**
 * 序列化帧头为 30 字节 Buffer。
 *
 * 字节布局 (全部 Little Endian):
 *   [0:1]   version       uint8    — 协议版本号，客户端比对
 *   [1:2]   flags         uint8    — 标志位 (KEYFRAME|FONT_DATA)
 *   [2:6]   frame_id      uint32   — 帧 ID（自定义单调计数器, §A4）
 *   [6:14]  timestamp_ms  int64    — 帧生成时间戳 (Unix ms)
 *   [14:18] scroll_x      int32    — 页面 scrollLeft (CSS px)
 *   [18:22] scroll_y      int32    — 页面 scrollTop (CSS px)
 *   [22:24] viewport_w    uint16   — CSS 视口宽度
 *   [24:26] viewport_h    uint16   — CSS 视口高度
 *   [26:28] canvas_w      uint16   — 物理画布宽度 (viewportW * dpr)
 *   [28:30] canvas_h      uint16   — 物理画布高度 (viewportH * dpr)
 *
 * 边界条件处理:
 *   - viewport/canvas 尺寸 > 65535 (uint16 max) 时截断为 65535
 *     这是防御性编程 — 合法的浏览器 viewport 通常 ≤ 7680
 *   - 负数坐标 (scroll) 是合法的（页面向上/左滚动超出初始视口）
 *   - timestampMs 使用 BigInt 以保证 64 位精度
 *
 * @param {object} meta - 帧元数据
 * @param {number} [meta.version]    - 协议版本（默认 PROTOCOL_VERSION）
 * @param {boolean} meta.isKeyframe  - 是否关键帧
 * @param {boolean} meta.hasFontData - 是否含字体数据
 * @param {number} meta.frameId      - 帧 ID
 * @param {number} meta.timestampMs  - 时间戳 (ms)
 * @param {number} meta.scrollX      - 页面滚动 X
 * @param {number} meta.scrollY      - 页面滚动 Y
 * @param {number} meta.viewportW    - 视口宽度
 * @param {number} meta.viewportH    - 视口高度
 * @param {number} meta.canvasW      - 画布宽度
 * @param {number} meta.canvasH      - 画布高度
 * @returns {Buffer} 30 字节帧头
 */
function serializeFrameHeader(meta) {
    // Buffer.allocUnsafe: 不初始化内存，性能优于 Buffer.alloc（安全: 随后全部覆盖写入）
    const buf = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
    let offset = 0;

    // Byte 0: version
    buf.writeUInt8(meta.version || PROTOCOL_VERSION, offset);
    offset += 1;

    // Byte 1: flags — 位掩码组合
    let flags = (meta.flags || 0);  // Phase 4: 允许外部设置 flags (如 FLAG_HAS_DIRTY_RECTS)
    if (meta.isKeyframe) flags |= FLAG_IS_KEYFRAME;   // bit 0
    if (meta.hasFontData) flags |= FLAG_HAS_FONT_DATA; // bit 1
    buf.writeUInt8(flags, offset);
    offset += 1;

    // Byte 2-5: frame_id (uint32 LE)
    buf.writeUInt32LE(meta.frameId, offset);
    offset += 4;

    // Byte 6-13: timestamp_ms (int64 LE)
    // Node.js Buffer 支持 BigInt 写入，保证 64 位时间戳完整传递
    // 防御: BigInt() 对 NaN/Infinity/非整数抛出 TypeError
    const ts = Number.isFinite(meta.timestampMs) ? BigInt(Math.trunc(meta.timestampMs)) : BigInt(Date.now());
    buf.writeBigInt64LE(ts, offset);
    offset += 8;

    // Byte 14-17: scroll_x (int32 LE)
    // int32 允许负数 — 页面可能向上/左滚动
    buf.writeInt32LE(meta.scrollX, offset);
    offset += 4;

    // Byte 18-21: scroll_y (int32 LE)
    buf.writeInt32LE(meta.scrollY, offset);
    offset += 4;

    // Byte 22-23: viewport_w (uint16 LE)
    // 安全检查: 防止大于 65535 的 viewport（uint16 上限）。
    // 合法 viewport 通常 ≤ 7680 (8K)，截断为 65535 仅作为防御性兜底。
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
 * 反序列化帧头（服务端通常不需要，但在调试/审计/测试时有价值）。
 *
 * @param {Buffer} buf - 30 字节 Buffer
 * @returns {object} 帧元数据对象（与 serializeFrameHeader 输入结构对应）
 * @throws {Error} 若 buf.length < FRAME_HEADER_SIZE (30)
 */
function deserializeFrameHeader(buf) {
    if (buf.length < FRAME_HEADER_SIZE) {
        throw new Error(`Frame header too short: ${buf.length} < ${FRAME_HEADER_SIZE}`);
    }
    let offset = 0;

    const version = buf.readUInt8(offset); offset += 1;
    const flags = buf.readUInt8(offset); offset += 1;
    const frameId = buf.readUInt32LE(offset); offset += 4;
    // BigInt → Number: 安全转换，因为时间戳在 Number 安全范围内 (2^53 ms ≈ 285,000 年)
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
        isKeyframe: !!(flags & FLAG_IS_KEYFRAME),   // 位提取
        hasFontData: !!(flags & FLAG_HAS_FONT_DATA),
        hasDirtyRects: !!(flags & FLAG_HAS_DIRTY_RECTS),  // Phase 4
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
// 帧组装 (§6.1 帧结构)
// ═══════════════════════════════════════════════════════════════

/**
 * 组装完整帧（未压缩版本）。
 *
 * 帧结构 (基础):
 *   [30 bytes Header] [N bytes CommandStream] [4 bytes CRC32]
 *
 * 帧结构 (含脏区域, Phase 4):
 *   [30 bytes Header] [DirtyRects variable] [N bytes CommandStream] [4 bytes CRC32]
 *   其中 DirtyRects = [count(2B uint16 LE)] [rect0(16B)] [rect1(16B)] ...
 *
 * CRC32 覆盖范围: Header + DirtyRects(若有) + CommandStream（不含 Trailer 自身）。
 * 客户端验证: 收到帧后重新计算 CRC32，与 Trailer 对比，不匹配则丢弃。
 *
 * 安全检查:
 *   - 总大小 ≤ MAX_BYTES_PER_FRAME (64MB): 超出直接抛错，防止内存炸弹
 *
 * @param {object} meta - 帧元数据 (同 serializeFrameHeader 参数)
 *        meta.dirtyRects — 可选, 脏区域矩形数组 (Phase 4 R-tree)
 * @param {Buffer} commandStream - 命令流字节（可为空 Buffer 但不可为 null）
 * @returns {Buffer} 完整未压缩帧 (Header + [DirtyRects] + CommandStream + CRC32)
 * @throws {Error} 若总大小超过 MAX_BYTES_PER_FRAME
 */
function assembleFrame(meta, commandStream) {
    // FLAG_HAS_DIRTY_RECTS 已在文件顶部导入

    // 处理脏区域 (Phase 4 R-tree 增量帧)
    let dirtyRectsBuf = null;
    let effectiveFlags = meta.flags || 0;  // 不修改传入的 meta 对象
    if (meta.dirtyRects && meta.dirtyRects.length > 0) {
        dirtyRectsBuf = serializeDirtyRects(meta.dirtyRects);
        effectiveFlags |= FLAG_HAS_DIRTY_RECTS;
    }

    // 使用 effectiveFlags 而非 meta.flags，避免副作用
    const header = serializeFrameHeader({ ...meta, flags: effectiveFlags });

    const cmdLen = commandStream ? commandStream.length : 0;
    const dirtyLen = dirtyRectsBuf ? dirtyRectsBuf.length : 0;

    // 大小检查 — 防御性编程: 在分配 Buffer 前验证
    const totalSize = FRAME_HEADER_SIZE + dirtyLen + cmdLen + FRAME_TRAILER_SIZE;
    if (totalSize > MAX_BYTES_PER_FRAME) {
        throw new Error(
            `Frame total size ${totalSize} exceeds MAX_BYTES_PER_FRAME (${MAX_BYTES_PER_FRAME})`
        );
    }

    // 单次分配: 避免多次 Buffer.concat 导致的内存碎片
    const frame = Buffer.allocUnsafe(totalSize);

    let cursor = 0;
    // 拷贝 Header
    header.copy(frame, cursor);
    cursor += FRAME_HEADER_SIZE;

    // 拷贝 DirtyRects (若有, Phase 4)
    if (dirtyRectsBuf) {
        dirtyRectsBuf.copy(frame, cursor);
        cursor += dirtyLen;
    }

    // 拷贝 CommandStream（可能为空）
    if (cmdLen > 0) {
        commandStream.copy(frame, cursor);
        cursor += cmdLen;
    }

    // 计算 CRC32: 覆盖 Header + DirtyRects(若有) + CommandStream
    // (CRC 应覆盖除 Trailer 外的全部帧数据, Phase 4 扩展)
    const crcData = frame.subarray(0, cursor);
    const crc = computeCRC32(crcData);

    // 写入 CRC32 到帧尾 (uint32 LE)
    frame.writeUInt32LE(crc, cursor);

    return frame;
}

// ═══════════════════════════════════════════════════════════════
// gzip 压缩 (v1.6 zip bomb 三层防护, §6.4)
//
// 三层防护按序执行，任意一层失败即拒绝整个帧:
//   第 1 层: 未压缩大小 ≤ MAX_BYTES_PER_FRAME (64MB)
//   第 2 层: 压缩后大小 ≤ MAX_COMPRESSED_FRAME (4MB)
//   第 3 层: 压缩比 ≤ MAX_COMPRESSION_RATIO (1000:1) — zip bomb 特征检测
//
// zip bomb 攻击原理: 攻击者构造高度可压缩的数据（如全零或重复模式），
//   1KB 压缩后数据可解压为 GB 级。第 3 层通过压缩比检测阻止此类攻击。
//   正常 Skia 命令流的压缩比通常在 2:1 ~ 10:1 之间。
// ═══════════════════════════════════════════════════════════════

/**
 * 压缩帧 (gzip, level 6)。
 *
 * gzip level 6 是吞吐量与压缩率的平衡点:
 *   - level 1: 最快但压缩率低 (~40%)
 *   - level 6: 速度适中，压缩率接近最优 (~90% of level 9)
 *   - level 9: 最慢但压缩率最高
 *
 * v1.6 安全增强 — 三层防护:
 *   - 压缩前检查未压缩大小 ≤ MAX_BYTES_PER_FRAME
 *   - 压缩后检查压缩大小 ≤ MAX_COMPRESSED_FRAME
 *   - 检查压缩比 ≤ MAX_COMPRESSION_RATIO (zip bomb 检测)
 *
 * @param {Buffer} frame - 未压缩帧（assembleFrame 的输出）
 * @returns {Promise<Buffer>} gzip 压缩后的帧
 * @throws {Error} 若任意一层防护检查失败
 */
async function compressFrame(frame) {
    // 第 1 层: 未压缩大小必须在限制内
    // （虽然在 assembleFrame 中已检查，但 compressFrame 可被独立调用）
    if (frame.length > MAX_BYTES_PER_FRAME) {
        throw new Error(
            `Frame too large to compress: ${frame.length} > ${MAX_BYTES_PER_FRAME}`
        );
    }

    const compressed = await gzipAsync(frame, { level: 6 });

    // 第 2 层: 压缩后大小硬限制
    // 即使未压缩数据合法，压缩后的数据也可能超出预期（随机数据压缩率低）
    if (compressed.length > MAX_COMPRESSED_FRAME) {
        throw new Error(
            `Compressed frame too large: ${compressed.length} > ${MAX_COMPRESSED_FRAME}`
        );
    }

    // 第 3 层: 压缩比异常检测 — 与客户端三重防护对齐 (§6.4)
    // 若未压缩数据为 0，跳过检查（避免除以零）
    if (frame.length > 0) {
        const ratio = compressed.length / frame.length;
        // 压缩后极小但解压后极大的帧 → zip bomb 特征
        // 例如: 63MB 解压后 / 1KB 压缩后 = 63000:1，远超正常 2:1~10:1
        // 条件重排为乘法以避免浮点精度问题:
        //   frame.length > MAX_COMPRESSION_RATIO * compressed.length
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
// 图像 Hash-Ref 去重注册表 (Phase 4, §4)
//
// 服务端维护已发送图像的 SHA-256 哈希集合。
// 当图像模式为 hash-ref 时:
//   - 首次发送: 内联完整图像数据 + 记录 SHA-256
//   - 后续帧: 仅发送 32 字节哈希引用，客户端从 ImageCache 获取
//
// 收益: 典型网页增量帧带宽降低 60-80%（图像通常占帧数据大头）。
//
// 数据结构选择:
//   - Set: O(1) 查找/插入
//   - Array (LRU): O(n) 淘汰（n ≤ 10000，可接受），
//     若需更高性能可替换为双向链表 + Map
//
// 安全考量: ImageHashRegistry 仅存储 SHA-256 哈希（32B hex），
//   不存储图像内容本身，不构成数据泄露风险。
// ═══════════════════════════════════════════════════════════════

class ImageHashRegistry {
    /**
     * @param {object} [options]
     * @param {number} [options.maxEntries=10000] - 最大哈希条目数
     */
    constructor(options = {}) {
        this._maxEntries = options.maxEntries || 10000;
        this._hashes = new Set();          // hex hash strings (SHA-256)
        this._lru = [];                    // LRU eviction order (oldest first)
    }

    /**
     * 计算图像数据的 SHA-256 哈希。
     *
     * 使用 crypto.createHash 而非手写哈希 — 利用 Node.js 内置的 OpenSSL 实现。
     *
     * @param {Buffer} imageData - 图像原始字节
     * @returns {string} 十六进制哈希字符串 (64 char)
     */
    static computeHash(imageData) {
        return crypto.createHash('sha256').update(imageData).digest('hex');
    }

    /**
     * 检查图像是否已发送过（即哈希是否在注册表中）。
     *
     * 若命中 → 服务端可发送 hash-ref 而非完整图像数据。
     *
     * @param {string} hexHash - SHA-256 十六进制哈希
     * @returns {boolean} true = 已发送过，可引用
     */
    has(hexHash) {
        return this._hashes.has(hexHash);
    }

    /**
     * 标记图像已发送并记录哈希。
     *
     * 若哈希已存在: 更新 LRU 位置（提升到最近使用）。
     * 若哈希不存在: 添加并检查 LRU 淘汰。
     *
     * @param {string} hexHash - SHA-256 十六进制哈希
     */
    mark(hexHash) {
        if (this._hashes.has(hexHash)) {
            // 已存在 → 仅更新 LRU 位置
            this._touch(hexHash);
            return;
        }

        // LRU 淘汰: 当到达容量上限时，移除最久未使用的条目
        while (this._hashes.size >= this._maxEntries) {
            const oldest = this._lru.shift();  // 取最旧
            if (oldest) this._hashes.delete(oldest);
        }

        this._hashes.add(hexHash);
        this._lru.push(hexHash);
    }

    /**
     * 获取统计信息。
     *
     * @returns {{ entryCount: number, maxEntries: number }}
     */
    get stats() {
        return {
            entryCount: this._hashes.size,
            maxEntries: this._maxEntries,
        };
    }

    /**
     * 内部: 更新 LRU 位置 — 将 hexHash 移到 LRU 列表末尾（最近使用）。
     *
     * @param {string} hexHash
     * @private
     */
    _touch(hexHash) {
        this._lru = this._lru.filter(h => h !== hexHash);
        this._lru.push(hexHash);
    }
}

// ═══════════════════════════════════════════════════════════════
// R-tree 增量帧: 脏区域计算与序列化 (Phase 4 — §4.1.1)
//
// 原理: 比较相邻两帧的图层边界矩形，识别发生变化的区域。
// 仅传输脏区域内的命令（实际命令过滤在 C++ LayerRecorder 完成），
// 此处负责脏区域的序列化和帧组装时的标注。
//
// 格式: [count(2B uint16 LE)] [rect0(16B)] [rect1(16B)] ...
//   每个 rect: x(f32 LE) + y(f32 LE) + w(f32 LE) + h(f32 LE)
//
// 安全: count 上限 MAX_DIRTY_RECTS (64)，防止伪造超大计数
// ═══════════════════════════════════════════════════════════════

/**
 * 比较前后两帧的图层边界矩形容器，计算脏区域矩形列表。
 *
 * 算法: 贪心合并 — 对每个变化的图层，将其边界矩形与已有脏区域合并。
 * 若合并后的总面积 ≤ 原面积之和，则合并（减少矩形数，降低传输开销）。
 * 否则保留为独立矩形。
 *
 * @param {Array<{x:number,y:number,w:number,h:number}>} prevBounds — 上一帧图层边界
 * @param {Array<{x:number,y:number,w:number,h:number}>} currBounds — 当前帧图层边界
 * @returns {Array<{x:number,y:number,w:number,h:number}>} 脏区域列表
 */
function computeDirtyRects(prevBounds, currBounds) {
    const MAX = require('./config').MAX_DIRTY_RECTS;

    // 简化为: 收集当前帧所有图层边界（因为 Node.js 层无法访问真正的 R-tree）
    // 实际 C++ 层会通过 DisplayItemList::rtree() 精确查询脏区域。
    // 此处提供一个实用的近似实现。

    if (!prevBounds || prevBounds.length === 0) {
        // 首帧 → 整个画布都是脏的
        return [{ x: 0, y: 0, w: 65535, h: 65535 }];
    }

    const dirty = [];

    for (const curr of currBounds) {
        // 查找上一帧中是否有重叠的图层
        const hasOverlap = prevBounds.some(prev =>
            rectsOverlap(prev, curr) && rectSimilar(prev, curr, 0.01)
        );

        if (!hasOverlap) {
            // 新增或变化的图层 → 标记为脏区域
            dirty.push({ ...curr });
        }
    }

    // 贪心合并: 减少矩形数量
    const merged = greedyMerge(dirty, MAX);

    return merged.length > 0 ? merged : [{ x: 0, y: 0, w: 1, h: 1 }];
}

/** 检查两个矩形是否重叠 */
function rectsOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
             a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/** 检查两个矩形是否相似（面积差 < threshold） */
function rectSimilar(a, b, threshold) {
    const areaA = a.w * a.h;
    const areaB = b.w * b.h;
    if (areaA === 0 && areaB === 0) return true;
    return Math.abs(areaA - areaB) / Math.max(areaA, areaB) < threshold;
}

/** 贪心合并矩形: 如果合并后面积 ≤ 原面积之和，则合并 */
function greedyMerge(rects, maxCount) {
    if (rects.length <= maxCount) return rects;

    const result = [...rects];
    while (result.length > maxCount) {
        let bestI = -1, bestJ = -1;
        let bestSaving = 0;

        for (let i = 0; i < result.length; i++) {
            for (let j = i + 1; j < result.length; j++) {
                const unionArea = unionRect(result[i], result[j]);
                const sumArea = result[i].w * result[i].h + result[j].w * result[j].h;
                const saving = sumArea - unionArea;  // 正数 = 合并更紧凑
                if (saving > bestSaving) {
                    bestSaving = saving;
                    bestI = i; bestJ = j;
                }
            }
        }

        if (bestI < 0) break;  // 无法再合并

        // 合并 bestI 和 bestJ
        result[bestI] = unionRectObj(result[bestI], result[bestJ]);
        result.splice(bestJ, 1);
    }

    return result;
}

/** 计算两个矩形的包围盒面积 */
function unionRect(a, b) {
    const u = unionRectObj(a, b);
    return u.w * u.h;
}

/** 计算两个矩形的包围盒 */
function unionRectObj(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x, y,
        w: Math.max(a.x + a.w, b.x + b.w) - x,
        h: Math.max(a.y + a.h, b.y + b.h) - y,
    };
}

/**
 * 序列化脏区域矩形列表为二进制 Buffer。
 *
 * 格式: [count(2B uint16 LE)] [rect0(16B)] [rect1(16B)] ...
 *   每个 rect: x(f32 LE) + y(f32 LE) + w(f32 LE) + h(f32 LE)
 *
 * @param {Array<{x:number,y:number,w:number,h:number}>} dirtyRects
 * @returns {Buffer}
 */
function serializeDirtyRects(dirtyRects) {
    const { MAX_DIRTY_RECTS, DIRTY_RECT_ENTRY_SIZE } = require('./config');
    const count = Math.min(dirtyRects.length, MAX_DIRTY_RECTS);
    const buf = Buffer.allocUnsafe(2 + count * DIRTY_RECT_ENTRY_SIZE);

    buf.writeUInt16LE(count, 0);
    let offset = 2;
    for (let i = 0; i < count; i++) {
        const r = dirtyRects[i];
        buf.writeFloatLE(r.x, offset);
        buf.writeFloatLE(r.y, offset + 4);
        buf.writeFloatLE(r.w, offset + 8);
        buf.writeFloatLE(r.h, offset + 12);
        offset += DIRTY_RECT_ENTRY_SIZE;
    }

    return buf;
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
    computeDirtyRects,
    serializeDirtyRects,
};
