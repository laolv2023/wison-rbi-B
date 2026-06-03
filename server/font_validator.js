// font_validator.js — 字体内联传输格式校验 (v1.6 P1 S4)
//
// 安全理由:
//   @font-face 机制允许网页指定自定义字体，这些字体二进制通过帧内联传输。
//   若不对字体格式进行校验，攻击者可滥用 @font-face 作为任意二进制数据外泄通道。
//
// 校验策略:
//   仅接受合法 SFNT（TrueType/OpenType/Collection）或 WOFF2 格式。
//   通过头部 Magic 字节逐一比对白名单。
//
// Magic 白名单:
//   0x00010000 — TrueType (经典 sfVersion)
//   "OTTO"     — OpenType CFF  (0x4F54544F)
//   "true"     — TrueType (Apple) (0x74727565)
//   "ttcf"     — TrueType Collection (0x74746366)
//   "wOF2"     — WOFF2 (0x774F4632)
//
// 校验失败 → 替换为 CanvasKit 回退字体 (font_id=0)
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

// 合法 Magic 集合
const VALID_FONT_MAGICS = new Set([
    SFNT_MAGIC_TRUETYPE,
    SFNT_MAGIC_OPENTYPE,
    SFNT_MAGIC_APPLE_TRUE,
    SFNT_MAGIC_COLLECTION,
    WOFF2_MAGIC,
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
 * @param {Buffer} fontData - 字体文件二进制
 * @returns {{ valid: boolean, format?: string, reason?: string }}
 *   - valid: 是否通过校验
 *   - format: 字体格式名称（校验通过时）
 *   - reason: 校验失败原因（校验失败时）
 */
function validateFontData(fontData) {
    if (!Buffer.isBuffer(fontData) || fontData.length === 0) {
        return { valid: false, reason: 'Empty or non-buffer font data' };
    }

    // 大小检查
    if (fontData.length > MAX_FONT_INLINE_BYTES) {
        return {
            valid: false,
            reason: `Font data too large: ${fontData.length} > ${MAX_FONT_INLINE_BYTES}`,
        };
    }

    // 最小字体文件大小 (至少包含头部)
    if (fontData.length < 4) {
        return { valid: false, reason: 'Font data too short for magic check' };
    }

    // 读取 Magic (前 4 字节，大端序)
    const magic = fontData.readUInt32BE(0);

    if (VALID_FONT_MAGICS.has(magic)) {
        return { valid: true, format: MAGIC_NAMES[magic] || 'Unknown valid format' };
    }

    // WOFF (v1, 非 WOFF2) — 有时也会出现，但这不在我们的白名单中
    // Magic: "wOFF" = 0x774F4646 — 拒绝

    return {
        valid: false,
        reason: `Invalid font magic: 0x${magic.toString(16).padStart(8, '0')} ` +
                `(expected SFNT or WOFF2)`,
    };
}

/**
 * 批量验证字体 — 返回过滤后的安全字体列表。
 * 不安全的字体替换为 null（客户端将使用回退字体 font_id=0）。
 *
 * @param {Array<{fontId: number, data: Buffer}>} fonts
 * @returns {{ safe: Array<{fontId: number, data: Buffer}>,
 *             rejected: Array<{fontId: number, reason: string}> }}
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
 * 检查字体数据是否为指定的 Magic 值。
 * 用于在序列化前快速过滤。
 *
 * @param {Buffer} data
 * @returns {boolean}
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
