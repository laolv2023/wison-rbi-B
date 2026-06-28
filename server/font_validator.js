// font_validator.js — 字体内联传输格式校验 (v1.6 P1 S4)
//
// === 模块角色 ===
// 本模块是 Wison-RBI 服务端安全关键路径中的**字体格式网关**。
// 架构角色: 安全过滤器 — 在帧序列化流水线中，位于帧组装之前。
//
// === 安全不变量 ===
// 核心不变量 (§2.2 不变量 1): 客户端收到的每一个字节必须是合法的 Skia 绘制命令或帧元数据。
//   - 字体内联传输（@font-face 二进制）是 Skia drawTextBlob 的依赖数据，
//     若不对格式进行校验，攻击者可滥用 @font-face 机制将任意二进制数据伪装为字体，
//     绕过高层次的内容检查，作为隐蔽数据外泄通道。
//   - 本模块通过 Magic 字节白名单确保: 只有合法的 SFNT/WOFF2 字体二进制能通过帧传输。
//
// === 数据流方向 ===
//   服务端 Chromium @font-face 字体数据 → font_validator.validateFontData()
//   → (通过) → 帧组装 → WebSocket → 客户端 CanvasKit FontCache
//   → (拒绝) → 丢弃，客户端使用回退字体 font_id=0
//
// === 威胁模型 (§2.1) ===
//   攻击场景: 恶意网页通过 @font-face + CSS 引用，将非字体二进制（如泄露的敏感数据）
//   伪装为"自定义字体"随帧发送至客户端。
//   防护: Magic 白名单仅放行已知字体格式，拒绝任何其他 Magic 值。
//
// === 设计文档交叉引用 ===
//   §S4  — 字体 Magic 白名单规范（SFNT/WOFF2）
//   §2.2 — 核心安全不变量（客户端仅接收合法 Skia 命令）
//   §8   — 白名单连续拒绝 ≥3 帧触发 request_keyframe（在 server.js 中实现）
//

'use strict';

const {
    SFNT_MAGIC_TRUETYPE,
    SFNT_MAGIC_OPENTYPE,
    SFNT_MAGIC_APPLE_TRUE,
    SFNT_MAGIC_COLLECTION,
    WOFF2_MAGIC,
    MAX_FONT_INLINE_BYTES,
} = require('./config');

// ═══════════════════════════════════════════════════════════════
// 合法 Magic 集合 (§S4)
//
// SFNT (Spline Font / Scalable Font) 格式族:
//   - TrueType (0x00010000): 最广泛使用的轮廓字体格式
//   - OpenType CFF ("OTTO"): Adobe PostScript CFF 轮廓的 OpenType 变体
//   - TrueType Apple ("true"): Apple 特有的 sfVersion 标记
//   - TrueType Collection ("ttcf"): 多字体集合文件 (.ttc)
//
// WOFF2 ("wOF2"): Web Open Font Format 2.0，Brotli 压缩的 Web 字体格式
//
// 明确拒绝:
//   - WOFF v1 ("wOFF" = 0x774F4646): 旧版 Web 字体，不在白名单中
//   - EOT/SVG 字体: 非标准 Web 字体格式
//   - 任意非字体二进制: Magic 不匹配直接拒绝
// ═══════════════════════════════════════════════════════════════

// 合法 Magic 集合 (使用 Set 实现 O(1) 查找)
const VALID_FONT_MAGICS = new Set([
    SFNT_MAGIC_TRUETYPE,    // 0x00010000
    SFNT_MAGIC_OPENTYPE,    // 'OTTO'
    SFNT_MAGIC_APPLE_TRUE,  // 'true'
    SFNT_MAGIC_COLLECTION,  // 'ttcf'
    WOFF2_MAGIC,            // 'wOF2'
]);

// Magic 名称映射 (调试/审计用)
const MAGIC_NAMES = {
    [SFNT_MAGIC_TRUETYPE]: 'TrueType',
    [SFNT_MAGIC_OPENTYPE]: 'OpenType CFF',
    [SFNT_MAGIC_APPLE_TRUE]: 'TrueType (Apple)',
    [SFNT_MAGIC_COLLECTION]: 'TrueType Collection',
    [WOFF2_MAGIC]: 'WOFF2',
};

/**
 * 验证字体二进制数据是否具有合法格式头部。
 *
 * 校验步骤（三层防御，fail-fast）：
 *   1. 类型检查：必须是非空 Buffer — 拒绝非 Buffer 输入（如字符串/数字伪装）
 *   2. 大小上限：≤ MAX_FONT_INLINE_BYTES — 防止单个"字体"过大耗尽内存（§S4）
 *   3. 大小下限：≥ 4 字节 — 至少能容纳一个 uint32 Magic
 *   4. Magic 白名单：前 4 字节大端序 uint32 必须在 VALID_FONT_MAGICS 中
 *
 * 为什么用大端序读取 Magic？
 *   SFNT/WOFF2 的 Magic 字段遵循网络字节序（Big Endian），
 *   与文件格式规范一致。WOFF2 的 "wOF2" = 0x774F4632 在大端序下才是正确值。
 *
 * @param {Buffer} fontData - 字体文件二进制
 * @returns {{ valid: boolean, format?: string, reason?: string }}
 *   - valid: 是否通过所有校验
 *   - format: 字体格式名称（仅 valid=true 时存在）
 *   - reason: 校验失败原因（仅 valid=false 时存在），用于审计日志和指标
 */
function validateFontData(fontData) {
    // 第 1 层: 类型检查
    // 非 Buffer 输入在此拒绝 — 防止任意类型绕过 Magic 比对
    if (!Buffer.isBuffer(fontData) || fontData.length === 0) {
        return { valid: false, reason: 'Empty or non-buffer font data' };
    }

    // 第 2 层: 大小上限检查
    // MAX_FONT_INLINE_BYTES = 5MB — 合法字体通常 < 2MB，5MB 留有冗余
    if (fontData.length > MAX_FONT_INLINE_BYTES) {
        return {
            valid: false,
            reason: `Font data too large: ${fontData.length} > ${MAX_FONT_INLINE_BYTES}`,
        };
    }

    // 第 3 层: 大小下限检查
    // 字体文件至少需要 4 字节的 Magic 字段
    if (fontData.length < 4) {
        return { valid: false, reason: 'Font data too short for magic check' };
    }

    // 第 4 层: Magic 白名单比对
    // readUInt32BE(0): 从偏移 0 读取 4 字节大端序无符号整数
    const magic = fontData.readUInt32BE(0);

    if (VALID_FONT_MAGICS.has(magic)) {
        return { valid: true, format: MAGIC_NAMES[magic] || 'Unknown valid format' };
    }

    // WOFF v1 明确拒绝 — Magic: "wOFF" = 0x774F4646
    // 不在白名单中，统一走拒绝路径

    return {
        valid: false,
        // 审计信息: 打印实际 Magic 十六进制值，便于事后追溯
        reason: `Invalid font magic: 0x${magic.toString(16).padStart(8, '0')} ` +
                `(expected SFNT or WOFF2)`,
    };
}

/**
 * 批量验证字体 — 返回过滤后的安全字体列表。
 *
 * 用于帧组装阶段，一次性校验帧中携带的所有字体数据。
 * 不安全的字体被记录到 rejected 列表，不影响 safe 列表中的合法字体。
 *
 * 客户端行为: 被拒绝的字体对应 font_id 不会出现在帧中，
 *   客户端将回退到 CanvasKit 内置回退字体 (font_id=0)，确保文本始终可渲染。
 *
 * @param {Array<{fontId: number, data: Buffer}>} fonts - 待验证字体列表
 *        fontId: 客户端字体缓存键
 *        data:   字体二进制数据
 * @returns {{ safe: Array<{fontId: number, data: Buffer}>,
 *             rejected: Array<{fontId: number, reason: string}> }}
 *   - safe: 通过所有校验的字体（直接用于帧组装）
 *   - rejected: 被拒绝的字体及原因（用于日志/指标/触发 request_keyframe）
 */
function validateFontBatch(fonts) {
    const safe = [];
    const rejected = [];

    for (const font of fonts) {
        const result = validateFontData(font.data);
        if (result.valid) {
            safe.push(font);
        } else {
            rejected.push({
                fontId: font.fontId,
                reason: result.reason,
            });
        }
    }

    return { safe, rejected };
}

/**
 * 便捷函数: 检查字体数据是否为安全格式。
 *
 * 用于 server.js 中快速过滤 — 在帧组装前判断 FLAG_HAS_FONT_DATA。
 * 这是一个布尔谓词，等同于 validateFontData(data).valid。
 *
 * @param {Buffer} data - 字体数据
 * @returns {boolean} true 表示通过 Magic 白名单校验，可安全传输
 */
function isSafeFontData(data) {
    return validateFontData(data).valid;
}

module.exports = {
    validateFontData,
    validateFontBatch,
    isSafeFontData,
    VALID_FONT_MAGICS,
    MAGIC_NAMES,
};
