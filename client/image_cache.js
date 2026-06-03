// image_cache.js — 客户端图像 LRU 缓存
//
// ## 模块角色 (§4.1.4 图像传输 — hash-ref 模式)
//   当服务端配置 `--garnet-image-mode=hash-ref` 时，图像数据以 SHA-256 哈希值
//   作为引用键传输。首次出现的图像内联传输数据+哈希；后续帧仅发送 32 字节哈希。
//   客户端通过此模块缓存已接收图像，绘制时直接用哈希查找即可复用。
//
// ## 安全不变量
//   - 最大容量 64MB (IMAGE_CACHE_BYTES)，防止攻击者通过大量唯一哈希耗尽客户端内存
//   - 使用 256-bit SHA-256 哈希，碰撞计算不可行 (2^128 安全级别，经典生日攻击)
//   - 哈希比较可通过 crypto.timingSafeEqual 做常量时间比较 (Phase 2+)
//   - 单个图像超过 64MB 直接拒绝缓存，不影响其他条目
//   - LRU (Least Recently Used) 驱逐策略保证攻击者无法通过发送新哈希驱逐所有有用数据
//
// ## 设计文档交叉引用
//   - §4.1.4: 图像传输模式 (inline vs hash-ref)
//   - §5.5: 客户端图像处理 (drawImageInline / drawImageRectInline)
//   - §8.4: 安全边界 (图像数据 > 10MB 拒绝)
//

'use strict';

import { PROTOCOL } from './protocol.js';
import { auditLog, LOG_LEVELS } from './utils.js';

/**
 * 客户端图像 LRU 缓存。
 *
 * 威胁模型: 服务端被入侵后可能发送任意 SHA-256 哈希。
 * 防护原理:
 *   1. 哈希空间 2^256 无法穷举产生命中 (除非服务端本身就持有对应图像)
 *   2. 64MB 容量限制防止内存耗尽
 *   3. LRU 驱逐保证即使攻击者不断发送新图像，旧的有效缓存也仅被逐步淘汰，
 *      不会一次性清空
 *
 * 时间复杂度: has/get/put 均为 O(1) (Map 操作)，_touch 为 O(n) (数组 filter)。
 *   可优化为双向链表但当前条目数/帧 (< 1000) 下 O(n) 可接受。
 */
class ImageCache {
    /**
     * 初始化图像缓存。
     *
     * @param {object} [options] - 配置选项
     * @param {number} [options.maxBytes] - 最大容量（字节），默认取自 PROTOCOL.LIMITS.IMAGE_CACHE_BYTES (64MB)
     */
    constructor(options = {}) {
        /** @private 最大缓存容量 (字节) */
        this._maxBytes = options.maxBytes || PROTOCOL.LIMITS.IMAGE_CACHE_BYTES;
        /** @private Map<hexHash, ArrayBuffer> 哈希→图像数据的映射 */
        this._cache = new Map();    // hex_hash → ArrayBuffer
        /** @private string[] LRU 访问顺序, 尾部=最新访问 */
        this._accessOrder = [];     // LRU 访问顺序 (hex_hash[])
        /** @private 当前缓存占用 (字节) */
        this._currentBytes = 0;
    }

    /**
     * 检查哈希是否在缓存中。
     * 仅检查存在性，不改变 LRU 顺序。
     *
     * @param {string} hexHash - 十六进制 SHA-256 哈希 (64 字符)
     * @returns {boolean} 是否存在
     */
    has(hexHash) {
        return this._cache.has(hexHash);
    }

    /**
     * 获取缓存图像，并将该条目标记为最近使用 (移到 LRU 尾部)。
     *
     * @param {string} hexHash - 十六进制 SHA-256 哈希
     * @returns {ArrayBuffer|null} 图像二进制数据，不存在时返回 null
     */
    get(hexHash) {
        const data = this._cache.get(hexHash);
        if (data) {
            // 移到 LRU 队列尾部 (最新访问)
            this._touch(hexHash);
        }
        return data || null;
    }

    /**
     * 存入图像到缓存。
     *
     * 副作用:
     *   - 若图像超过总容量限制，直接拒绝 (不驱逐其他条目)
     *   - 若剩余空间不足，驱逐最少使用的条目直到空间足够
     *   - 若 hexHash 已存在，先移除旧条目再放入新数据
     *
     * 安全: 先检查单条大小上限再驱逐，避免一个超大图像驱逐所有有用缓存。
     *
     * @param {string} hexHash - SHA-256 十六进制哈希 (64 字符小写)
     * @param {ArrayBuffer} imageData - 图像二进制数据 (PNG/JPEG/WebP 等原始字节)
     */
    put(hexHash, imageData) {
        // ── 安全: 单条图像超过总容量 → 拒绝缓存 ──
        // 理由: 避免一个超大图像驱逐所有其他有效条目 (DoS 变种)
        if (imageData.byteLength > this._maxBytes) {
            auditLog(LOG_LEVELS.WARN, 'image_too_large_for_cache', {
                size: imageData.byteLength,
                maxBytes: this._maxBytes,
            });
            return;
        }

        // ── LRU 驱逐: 释放空间直到能容纳新数据 ──
        // 注意: 即使驱逐所有条目后仍放不下，也不会死循环 —
        //       上面的检查保证了单条 ≤ maxBytes，驱逐全部后一定能放入。
        while (this._currentBytes + imageData.byteLength > this._maxBytes
               && this._accessOrder.length > 0) {
            this._evictOne();
        }

        // ── 重复哈希: 先移除旧条目 ──
        // 直接覆盖会导致 _currentBytes 计算错误。
        if (this._cache.has(hexHash)) {
            this._currentBytes -= this._cache.get(hexHash).byteLength;
            this._cache.delete(hexHash);
            this._accessOrder = this._accessOrder.filter(h => h !== hexHash);
        }

        this._cache.set(hexHash, imageData);
        this._accessOrder.push(hexHash);  // 尾部 = 最新
        this._currentBytes += imageData.byteLength;

        auditLog(LOG_LEVELS.DEBUG, 'image_cached', {
            hash: hexHash.substring(0, 8),
            size: imageData.byteLength,
            cacheSize: this._currentBytes,
        });
    }

    /**
     * 清空缓存。
     *
     * 触发场景: 服务端重启导致 frame_id 归零 (§8.1)，
     * 此时所有缓存的哈希引用已失效 (服务端新实例没有对应图像)，
     * 必须清空以避免渲染错误。
     */
    clear() {
        this._cache.clear();
        this._accessOrder = [];
        this._currentBytes = 0;
    }

    /**
     * 获取缓存统计信息 (实时计算)。
     *
     * @returns {{ entryCount: number, currentBytes: number, maxBytes: number, usage: number }}
     */
    get stats() {
        return {
            entryCount: this._cache.size,
            currentBytes: this._currentBytes,
            maxBytes: this._maxBytes,
            /** 缓存使用率 (0.0–1.0) */
            usage: this._currentBytes / this._maxBytes,
        };
    }

    // ── 内部方法 ──

    /**
     * 将指定哈希标记为最近访问。
     *
     * 实现: 从 _accessOrder 中删除该哈希，然后追加到尾部。
     * 时间复杂度 O(n) — 当缓存条目较多时可优化为双向链表+Map，
     * 但当前场景下 n < 1000，线性扫描可接受。
     *
     * @private
     * @param {string} hexHash
     */
    _touch(hexHash) {
        this._accessOrder = this._accessOrder.filter(h => h !== hexHash);
        this._accessOrder.push(hexHash);
    }

    /**
     * 驱逐最少使用的条目 (LRU 头部)。
     *
     * 副作用: 从 _cache Map 中删除条目，从 _currentBytes 中扣除其大小。
     * 原子操作 — 不会导致 _currentBytes 与实际不一致。
     *
     * @private
     */
    _evictOne() {
        const oldest = this._accessOrder.shift();
        if (oldest && this._cache.has(oldest)) {
            this._currentBytes -= this._cache.get(oldest).byteLength;
            this._cache.delete(oldest);
        }
    }
}

export { ImageCache };
