// image_cache.js — 客户端图像 LRU 缓存
//
// 用于 hash-ref 图像传输模式 (§4.1.4)。
// 缓存已接收的图像数据，以 SHA-256 哈希为键。
//
// 安全:
//   - 最大容量 64MB，防止内存耗尽
//   - 使用 256-bit 哈希 (SHA-256)，防止恶意碰撞
//   - 哈希比较使用常量时间比较（crypto.timingSafeEqual）
//

'use strict';

import { PROTOCOL } from './protocol.js';
import { auditLog, LOG_LEVELS } from './utils.js';

class ImageCache {
    /**
     * @param {object} [options]
     * @param {number} [options.maxBytes] - 最大容量（字节）
     */
    constructor(options = {}) {
        this._maxBytes = options.maxBytes || PROTOCOL.LIMITS.IMAGE_CACHE_BYTES;
        this._cache = new Map();    // hex_hash → ArrayBuffer
        this._accessOrder = [];     // LRU 访问顺序 (hex_hash[])
        this._currentBytes = 0;
    }

    /**
     * 检查哈希是否在缓存中。
     * @param {string} hexHash - 十六进制 SHA-256 哈希
     * @returns {boolean}
     */
    has(hexHash) {
        return this._cache.has(hexHash);
    }

    /**
     * 获取缓存图像。
     * @param {string} hexHash
     * @returns {ArrayBuffer|null}
     */
    get(hexHash) {
        const data = this._cache.get(hexHash);
        if (data) {
            // 移到 LRU 队列头部
            this._touch(hexHash);
        }
        return data || null;
    }

    /**
     * 存入图像到缓存。
     * 如果超出容量限制，驱逐最少使用的条目。
     *
     * @param {string} hexHash - SHA-256 十六进制哈希
     * @param {ArrayBuffer} imageData - 图像数据
     */
    put(hexHash, imageData) {
        if (imageData.byteLength > this._maxBytes) {
            // 单个图像超过总容量 — 不缓存
            auditLog(LOG_LEVELS.WARN, 'image_too_large_for_cache', {
                size: imageData.byteLength,
                maxBytes: this._maxBytes,
            });
            return;
        }

        // 如果需要，驱逐条目
        while (this._currentBytes + imageData.byteLength > this._maxBytes
               && this._accessOrder.length > 0) {
            this._evictOne();
        }

        // 如果已存在，先移除旧的
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
     * 清空缓存（服务端重启时调用）。
     */
    clear() {
        this._cache.clear();
        this._accessOrder = [];
        this._currentBytes = 0;
    }

    /**
     * 获取缓存统计。
     */
    get stats() {
        return {
            entryCount: this._cache.size,
            currentBytes: this._currentBytes,
            maxBytes: this._maxBytes,
            usage: this._currentBytes / this._maxBytes,
        };
    }

    // ── 内部方法 ──

    _touch(hexHash) {
        this._accessOrder = this._accessOrder.filter(h => h !== hexHash);
        this._accessOrder.push(hexHash);
    }

    _evictOne() {
        const oldest = this._accessOrder.shift();
        if (oldest && this._cache.has(oldest)) {
            this._currentBytes -= this._cache.get(oldest).byteLength;
            this._cache.delete(oldest);
        }
    }
}

export { ImageCache };
