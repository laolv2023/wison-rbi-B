// font_registry.js — 客户端字体注册表 (LRU)
//
// 管理 CanvasKit 的字体注册：
//   1. font_id 0 = CanvasKit 内嵌默认字体（回退）
//   2. 后续 font_id 通过帧的 FONT_DATA 命令传输（@font-face 内联）
//
// 安全 (v1.6 P1 S4):
//   - 字体数据在注册前须通过 SFNT/WOFF2 Magic 校验
//   - 校验失败 → 替换为回退字体 (font_id=0)
//
// LRU 驱逐策略:
//   - 最大 64MB 缓存
//   - 驱逐最少使用的字体
//

'use strict';

import { PROTOCOL } from './protocol.js';
import { auditLog, LOG_LEVELS } from './utils.js';

const { FONT_MAGIC } = PROTOCOL;

// 合法字体 Magic 集合
const VALID_FONT_MAGICS = new Set([
    FONT_MAGIC.TRUETYPE,
    FONT_MAGIC.OPENTYPE,
    FONT_MAGIC.APPLE_TRUE,
    FONT_MAGIC.COLLECTION,
    FONT_MAGIC.WOFF2,
]);

class FontRegistry {
    /**
     * @param {object} canvasKit - CanvasKit 实例
     * @param {object} [options]
     * @param {number} [options.maxBytes] - 最大缓存容量
     */
    constructor(canvasKit, options = {}) {
        this._canvasKit = canvasKit;
        this._maxBytes = options.maxBytes || PROTOCOL.LIMITS.FONT_CACHE_BYTES;

        // font_id → { typeface: SkTypeface, data: ArrayBuffer, lastUsed: number }
        this._fonts = new Map();
        this._currentBytes = 0;
        this._accessCounter = 0;

        // 注册默认回退字体 (font_id=0)
        this._registerDefaultFont();
    }

    /**
     * 注册默认字体 (font_id=0)。
     * CanvasKit 内嵌的回退字体。
     */
    _registerDefaultFont() {
        try {
            const defaultTypeface = this._canvasKit.Typeface.MakeDefault();
            if (defaultTypeface) {
                this._fonts.set(0, {
                    typeface: defaultTypeface,
                    data: null,
                    lastUsed: ++this._accessCounter,
                });
                auditLog(LOG_LEVELS.INFO, 'font_default_registered');
            }
        } catch (err) {
            auditLog(LOG_LEVELS.ERROR, 'font_default_failed', { error: err.message });
        }
    }

    /**
     * 通过帧数据注册/更新字体。
     * 校验字体格式后注册到 CanvasKit。
     *
     * @param {number} fontId - 字体 ID
     * @param {ArrayBuffer} fontData - 字体二进制数据
     * @returns {boolean} 是否注册成功（失败时返回 false，使用回退字体）
     */
    registerFont(fontId, fontData) {
        // 格式校验 (v1.6 P1 S4)
        if (!this._validateFontMagic(fontData)) {
            auditLog(LOG_LEVELS.WARN, 'font_rejected_invalid_magic', {
                fontId,
                size: fontData.byteLength,
            });
            return false;
        }

        // 大小检查
        if (fontData.byteLength > PROTOCOL.LIMITS.MAX_FONT_INLINE_BYTES) {
            auditLog(LOG_LEVELS.WARN, 'font_rejected_too_large', {
                fontId,
                size: fontData.byteLength,
            });
            return false;
        }

        // 尝试创建 Typeface
        try {
            const typeface = this._canvasKit.Typeface.MakeFreeTypeFaceFromData(fontData);
            if (!typeface) {
                auditLog(LOG_LEVELS.WARN, 'font_create_failed', { fontId });
                return false;
            }

            // 驱逐 LRU（如果需要）
            while (this._currentBytes + fontData.byteLength > this._maxBytes
                   && this._fonts.size > 1) {  // 保留 font_id=0
                this._evictOne();
            }

            // 注册
            this._fonts.set(fontId, {
                typeface,
                data: fontData,
                lastUsed: ++this._accessCounter,
            });
            this._currentBytes += fontData.byteLength;

            auditLog(LOG_LEVELS.INFO, 'font_registered', {
                fontId,
                size: fontData.byteLength,
                cacheSize: this._currentBytes,
            });
            return true;

        } catch (err) {
            auditLog(LOG_LEVELS.ERROR, 'font_register_error', {
                fontId,
                error: err.message,
            });
            return false;
        }
    }

    /**
     * 获取字体 Typeface。
     * 找不到 → 返回回退字体 (font_id=0)。
     *
     * @param {number} fontId
     * @returns {object} SkTypeface
     */
    getTypeface(fontId) {
        const entry = this._fonts.get(fontId);
        if (entry) {
            entry.lastUsed = ++this._accessCounter;
            return entry.typeface;
        }

        // 回退到默认字体
        const fallback = this._fonts.get(0);
        if (fallback) {
            fallback.lastUsed = ++this._accessCounter;
        }
        return fallback ? fallback.typeface : null;
    }

    /**
     * 清空注册表（保留 font_id=0）。
     */
    clear() {
        const defaultFont = this._fonts.get(0);
        this._fonts.clear();
        this._currentBytes = 0;
        if (defaultFont) {
            this._fonts.set(0, defaultFont);
        }
    }

    // ── 内部方法 ──

    /**
     * 校验字体 Magic 字节 (v1.6 P1 S4)。
     * @param {ArrayBuffer} data
     * @returns {boolean}
     */
    _validateFontMagic(data) {
        if (!data || data.byteLength < 4) return false;
        const view = new DataView(data);
        const magic = view.getUint32(0, false);  // 大端! (字体 Magic 是大端序)
        return VALID_FONT_MAGICS.has(magic);
    }

    /**
     * 驱逐最少使用的字体（除 font_id=0 外）。
     */
    _evictOne() {
        let oldestId = null;
        let oldestAccess = Infinity;

        for (const [id, entry] of this._fonts) {
            if (id === 0) continue;  // 保留默认字体
            if (entry.lastUsed < oldestAccess) {
                oldestAccess = entry.lastUsed;
                oldestId = id;
            }
        }

        if (oldestId !== null) {
            const entry = this._fonts.get(oldestId);
            this._currentBytes -= entry.data ? entry.data.byteLength : 0;
            this._fonts.delete(oldestId);

            auditLog(LOG_LEVELS.DEBUG, 'font_evicted', { fontId: oldestId });
        }
    }

    /**
     * 获取注册表统计。
     */
    get stats() {
        return {
            fontCount: this._fonts.size,
            currentBytes: this._currentBytes,
            maxBytes: this._maxBytes,
        };
    }
}

export { FontRegistry };
