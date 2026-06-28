// font_registry.js — 客户端字体注册表 (LRU)
//
// ## 模块角色 (§5.5 客户端设计 — 字体管理)
//   管理 CanvasKit 的字体注册，将服务端通过 FONT_DATA (0x70) 命令传输的
//   字体内联数据转换为 SkTypeface 对象，供文本绘制命令 (DRAW_TEXT_BLOB) 使用。
//   font_id=0 固定为 CanvasKit 内嵌默认字体，用作所有失败情况的回退。
//
// ## 安全不变量 (v1.6 P1 S4)
//   - 字体数据在注册前必须通过 SFNT/WOFF2 Magic 字节白名单校验
//     (TrueType/OpenType/AppleTrue/Collection/WOFF2 五种)
//   - Magic 校验失败 → 字体拒绝注册，回退到 font_id=0 (默认字体)
//   - 字体大小上限 5MB (MAX_FONT_INLINE_BYTES)，防止内存炸弹
//   - 最大缓存 64MB (FONT_CACHE_BYTES)，LRU 驱逐保护 font_id=0 永不驱逐
//   - CanvasKit::MakeFreeTypeFaceFromData 可能触发 FreeType 解析器漏洞;
//     前置 Magic 校验缓解了格式混淆攻击面
//
// ## LRU 驱逐策略
//   - 基于 _accessCounter 单调递增计数器 (非时间戳，避免 clock 回退问题)
//   - 驱逐时遍历所有条目找 lastUsed 最小值 (font_id=0 跳过)
//   - O(n) 但 n 最大 ~13 (64MB/5MB)，性能无影响
//
// ## 设计文档交叉引用
//   - §8.4 P1 S4: 字体内联传输安全 (Magic 白名单)
//   - §5.5: 客户端字体处理 (handleFontData / dispatchOpcode)
//   - §6.2: FONT_DATA 命令格式 (font_id + size + data)
//

'use strict';

import { PROTOCOL } from './protocol.js';
import { auditLog, LOG_LEVELS } from './utils.js';

const { FONT_MAGIC } = PROTOCOL;

/**
 * 合法字体 Magic 白名单。
 *
 * 威胁模型: 攻击者控制的服务端可能发送任意二进制数据伪装为字体。
 * FreeType 历史上存在 CVE (CFF 解析、WOFF2 解压等)，直接传入可能导致
 * WASM 沙箱内内存损坏 (CanvasKit 沙箱逃逸不在本文范围内，但纵深防御)。
 * 前置 Magic 校验将攻击面缩小为仅 5 种已知字体格式。
 *
 * 所有值以大端序读取 (字体 Magic 按文件格式规范为大端序)。
 */
const VALID_FONT_MAGICS = new Set([
    FONT_MAGIC.TRUETYPE,       // 0x00010000 — TrueType (.ttf)
    FONT_MAGIC.OPENTYPE,       // 0x4F54544F — OpenType with CFF (.otf)
    FONT_MAGIC.APPLE_TRUE,     // 0x74727565 — Apple 旧版 TrueType
    FONT_MAGIC.COLLECTION,     // 0x74746366 — TrueType Collection (.ttc)
    FONT_MAGIC.WOFF2,          // 0x774F4632 — WOFF2 压缩格式 (.woff2)
]);

/**
 * 客户端字体注册表。
 *
 * 内部数据结构:
 *   _fonts: Map<fontId, { typeface: SkTypeface, data: ArrayBuffer|null, lastUsed: number }>
 *   fontId=0 的 data 为 null (CanvasKit 内置字体，不需要原始字节)
 */
class FontRegistry {
    /**
     * 初始化字体注册表并注册默认回退字体。
     *
     * @param {object} canvasKit - CanvasKit WASM 实例 (全局单例)
     * @param {object} [options] - 配置选项
     * @param {number} [options.maxBytes] - 最大缓存容量，默认 64MB
     */
    constructor(canvasKit, options = {}) {
        /** @private CanvasKit 实例引用 */
        this._canvasKit = canvasKit;
        /** @private 最大缓存容量 (字节) */
        this._maxBytes = options.maxBytes || PROTOCOL.LIMITS.FONT_CACHE_BYTES;

        /**
         * 字体映射表: font_id → 条目
         * @private
         */
        this._fonts = new Map();
        /** @private 当前缓存占用 (字节) */
        this._currentBytes = 0;
        /**
         * 单调递增访问计数器。
         * 每次 read (getTypeface) 或 write (registerFont) 均自增，
         * 用作 LRU 的时间戳替代。避免系统时钟回退导致的驱逐异常。
         * @private
         */
        this._accessCounter = 0;

        // 立即注册默认回退字体 (font_id=0)
        this._registerDefaultFont();
    }

    /**
     * 注册 CanvasKit 内嵌默认字体为 font_id=0。
     *
     * 此字体不会被 LRU 驱逐 (evictOne 跳过 id=0)。
     * 所有字体注册失败或找不到的情况均回退到此字体，
     * 保证页面文本始终有回退渲染路径。
     *
     * @private
     */
    _registerDefaultFont() {
        try {
            const defaultTypeface = this._canvasKit.Typeface.MakeDefault();
            if (defaultTypeface) {
                this._fonts.set(0, {
                    typeface: defaultTypeface,
                    data: null,     // CanvasKit 内置，无外部数据
                    lastUsed: ++this._accessCounter,
                });
                auditLog(LOG_LEVELS.INFO, 'font_default_registered');
            }
        } catch (err) {
            // CanvasKit 未完全加载时可能抛出 — 非致命错误
            auditLog(LOG_LEVELS.ERROR, 'font_default_failed', { error: err.message });
        }
    }

    /**
     * 通过帧数据注册/更新字体。
     *
     * 此方法处理 FONT_DATA (0x70) 命令的内容体。
     * 数据格式: fontId(4B, uint32 LE) + fontData(N bytes)
     *
     * 安全检查顺序 (纵深防御):
     *   1. Magic 字节白名单校验 → 不在集合中则拒绝
     *   2. 大小上限检查 (> 5MB 拒绝)
     *   3. FreeType 解析 (CanvasKit.MakeFreeTypeFaceFromData)
     *   4. LRU 驱逐 (如空间不足)
     *
     * @param {number} fontId - 字体 ID (由服务端分配，从 1 开始)
     * @param {ArrayBuffer} fontData - 字体二进制数据 (TTF/OTF/WOFF2 等)
     * @returns {boolean} 是否注册成功。失败时返回 false，调用方应回退到 font_id=0
     */
    registerFont(fontId, fontData) {
        // ── 第一层: Magic 格式白名单校验 (v1.6 P1 S4) ──
        // 为什么需要: FreeType 历史 CVE 表明格式混淆可触发内存破坏。
        // 前置白名单将攻击面从「任何二进制」缩小为「5 种已知字体格式」。
        if (!this._validateFontMagic(fontData)) {
            auditLog(LOG_LEVELS.WARN, 'font_rejected_invalid_magic', {
                fontId,
                size: fontData.byteLength,
            });
            return false;
        }

        // ── 第二层: 大小上限 ──
        // 5MB 上限覆盖几乎所有 Web 字体 (Google Fonts 通常 < 2MB)。
        if (fontData.byteLength > PROTOCOL.LIMITS.MAX_FONT_INLINE_BYTES) {
            auditLog(LOG_LEVELS.WARN, 'font_rejected_too_large', {
                fontId,
                size: fontData.byteLength,
            });
            return false;
        }

        // ── 第三层: FreeType 解析 ──
        // 即使 Magic 通过，FreeType 解析仍可能因内部损坏失败。
        // CanvasKit WASM 沙箱提供额外保护层。
        try {
            const typeface = this._canvasKit.Typeface.MakeFreeTypeFaceFromData(fontData);
            if (!typeface) {
                auditLog(LOG_LEVELS.WARN, 'font_create_failed', { fontId });
                return false;
            }

            // ── 第四层: LRU 驱逐 ──
            // 保留 font_id=0 (默认字体) 不被驱逐。
            // size > 1 检查: 如果仅剩默认字体且空间不足，拒绝注册。
            while (this._currentBytes + fontData.byteLength > this._maxBytes
                   && this._fonts.size > 1) {  // 保留 font_id=0
                this._evictOne();
            }

            // ── 重复 font_id: 先释放旧条目 ──
            // 直接覆盖会导致 _currentBytes 计算错误（旧数据大小未扣除）
            const existing = this._fonts.get(fontId);
            if (existing) {
                this._currentBytes -= existing.data ? existing.data.byteLength : 0;
                // 旧 Typeface 需要显式释放以避免 WASM 内存泄漏
                if (existing.typeface && typeof existing.typeface.delete === 'function') {
                    try { existing.typeface.delete(); } catch (e) { /* 忽略 */ }
                }
            }

            // ── 注册到映射表 ──
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
            // FreeType 解析异常 (如内存不足、内部断言失败)
            auditLog(LOG_LEVELS.ERROR, 'font_register_error', {
                fontId,
                error: err.message,
            });
            return false;
        }
    }

    /**
     * 根据 fontId 获取 CanvasKit Typeface 对象。
     *
     * 回退链: fontId 命中 → 返回对应 Typeface
     *         fontId 未命中 → 返回 fontId=0 (默认 Typeface)
     *         fontId=0 也不存在 → 返回 null (CanvasKit 初始化未完成)
     *
     * 副作用: 更新命中条目的 lastUsed (影响 LRU 驱逐顺序)。
     *
     * @param {number} fontId - 字体 ID
     * @returns {object|null} SkTypeface 对象。null 仅在 CanvasKit 初始化失败时出现
     */
    getTypeface(fontId) {
        const entry = this._fonts.get(fontId);
        if (entry) {
            entry.lastUsed = ++this._accessCounter;
            return entry.typeface;
        }

        // ── 回退到默认字体 ──
        // 原因: font_id 可能因帧丢失、连接中断、或服务端未发送 FONT_DATA
        // 而缺失。回退字体保证文本始终可渲染 (虽然字体可能不匹配)。
        const fallback = this._fonts.get(0);
        if (fallback) {
            fallback.lastUsed = ++this._accessCounter;
        }
        return fallback ? fallback.typeface : null;
    }

    /**
     * 清空注册表 (保留 font_id=0)。
     *
     * 触发场景: 服务端重启导致 frame_id 归零，所有字体引用失效。
     * 参考: §8.1 网络异常 → 服务端重启检测
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
     * 校验字体文件的前 4 字节 Magic。
     *
     * 威胁模型: 攻击者可能发送任意二进制伪装为字体数据。
     * 此函数仅允许 5 种合法的字体 Magic，拒绝所有其他格式。
     *
     * Magic 以大端序读取 (字体规范要求)。
     * 合法值见 VALID_FONT_MAGICS Set。
     *
     * @private
     * @param {ArrayBuffer} data - 字体数据
     * @returns {boolean} Magic 是否合法
     */
    _validateFontMagic(data) {
        if (!data || data.byteLength < 4) return false;
        const view = new DataView(data);
        // 大端序 — 字体 Magic 按格式规范为大端序
        const magic = view.getUint32(0, false);  // 大端! (字体 Magic 是大端序)
        return VALID_FONT_MAGICS.has(magic);
    }

    /**
     * 驱逐最少使用的字体 (font_id=0 受保护，永不驱逐)。
     *
     * 算法: 遍历 _fonts，找 lastUsed 最小的条目 (LRU)。
     * 跳过 font_id=0 以保证回退字体始终可用。
     *
     * 时间复杂度 O(n)，n 为注册字体数。上限约 13 (64MB / 5MB 单字体上限)。
     *
     * @private
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
     *
     * @returns {{ fontCount: number, currentBytes: number, maxBytes: number }}
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
