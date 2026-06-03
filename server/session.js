// session.js — 用户会话管理
//
// 每个会话对应一个 Chromium 实例 + 一个 WebSocket 连接。
// 管理:
//   - frame_id 单调计数器 (v1.6 P0 A4: compositor_frame_seq_ 自定义计数器)
//   - 帧历史 (用于输入坐标转换)
//   - 会话生命周期 (创建、空闲、销毁)
//

'use strict';

const {
    FRAME_HISTORY_MAX_AGE_MS,
    FRAME_HISTORY_MAX_ENTRIES,
    SESSION_IDLE_TIMEOUT_MS,
} = require('./config');

/**
 * 帧元数据记录（存入帧历史）
 * @typedef {object} FrameMeta
 * @property {number} frameId      - 帧 ID
 * @property {number} timestampMs  - Unix 毫秒时间戳
 * @property {number} scrollX      - 页面滚动 X
 * @property {number} scrollY      - 页面滚动 Y
 * @property {number} viewportW    - CSS 视口宽度
 * @property {number} viewportH    - CSS 视口高度
 * @property {number} canvasW      - 物理画布宽度
 * @property {number} canvasH      - 物理画布高度
 */

class Session {
    /**
     * @param {string} sessionId - 唯一会话标识
     * @param {object} [options]
     * @param {number} [options.frameHistoryMaxAgeMs] - 帧历史保留时间
     * @param {number} [options.frameHistoryMaxEntries] - 帧历史最大条目
     * @param {number} [options.idleTimeoutMs] - 空闲超时
     */
    constructor(sessionId, options = {}) {
        this.sessionId = sessionId;
        this.createdAt = Date.now();
        this.lastActivityAt = Date.now();
        this.closed = false;

        // ── frame_id 计数器 (v1.6 P0 A4) ──
        // 使用 compositor_frame_seq_ 风格的自定义单调计数器
        // 不从 source_frame_number 派生，避免 Chromium 内部帧号不连续
        this._frameIdCounter = 0;

        // ── 帧历史 ──
        // Map<frameId, FrameMeta>
        this.frameHistory = new Map();
        this._frameHistoryMaxAgeMs =
            options.frameHistoryMaxAgeMs || FRAME_HISTORY_MAX_AGE_MS;
        this._frameHistoryMaxEntries =
            options.frameHistoryMaxEntries || FRAME_HISTORY_MAX_ENTRIES;

        // ── 空闲管理 ──
        this._idleTimeoutMs = options.idleTimeoutMs || SESSION_IDLE_TIMEOUT_MS;
        this._idleTimer = null;
        this._resetIdleTimer();

        // ── Chromium 引用 ──
        this.chromium = null;  // ChromiumManager 实例引用

        // ── WebSocket 引用 ──
        this.socket = null;
    }

    // ═══════════════════════════════════════════════════════════
    // Frame ID 管理
    // ═══════════════════════════════════════════════════════════

    /**
     * 分配下一个帧 ID（单调递增）。
     * @returns {number}
     */
    nextFrameId() {
        const id = ++this._frameIdCounter;
        this._touchActivity();
        return id;
    }

    /**
     * 获取当前帧 ID 计数器值（不递增）。
     * @returns {number}
     */
    get currentFrameId() {
        return this._frameIdCounter;
    }

    /**
     * 重置帧 ID 计数器（服务端重启时）。
     * 客户端会通过检测非单调 frame_id 来感知重启。
     */
    resetFrameIdCounter() {
        this._frameIdCounter = 0;
        this.frameHistory.clear();
    }

    // ═══════════════════════════════════════════════════════════
    // 帧历史管理
    // ═══════════════════════════════════════════════════════════

    /**
     * 记录新帧的元数据到帧历史。
     * @param {FrameMeta} meta
     */
    recordFrame(meta) {
        this.frameHistory.set(meta.frameId, {
            frameId: meta.frameId,
            timestampMs: meta.timestampMs,
            scrollX: meta.scrollX,
            scrollY: meta.scrollY,
            viewportW: meta.viewportW,
            viewportH: meta.viewportH,
            canvasW: meta.canvasW,
            canvasH: meta.canvasH,
        });

        // 修剪过期帧
        this._pruneHistory(meta.timestampMs);

        this._touchActivity();
    }

    /**
     * 根据 frame_id 查找帧元数据。
     * 用于输入事件的坐标转换。
     *
     * @param {number} frameId - 输入事件中引用的帧 ID
     * @returns {FrameMeta|null} 找到的帧元数据，或 null（帧已过期）
     */
    getFrameMeta(frameId) {
        const meta = this.frameHistory.get(frameId);
        if (!meta) return null;

        // 检查是否过期
        const age = Date.now() - meta.timestampMs;
        if (age > this._frameHistoryMaxAgeMs) {
            this.frameHistory.delete(frameId);
            return null;
        }

        return meta;
    }

    /**
     * 查找离给定 frame_id 最近的、不大于它的帧元数据。
     * 当精确 frame_id 不匹配时（如帧已过期），向前查找。
     *
     * @param {number} frameId
     * @returns {FrameMeta|null}
     */
    getNearestFrameMeta(frameId) {
        // 先尝试精确匹配
        const exact = this.getFrameMeta(frameId);
        if (exact) return exact;

        // 向前查找最近的帧
        let nearest = null;
        let nearestId = -1;

        for (const [id, meta] of this.frameHistory) {
            if (id <= frameId && id > nearestId) {
                nearest = meta;
                nearestId = id;
            }
        }

        return nearest;
    }

    /**
     * 修剪过期的帧历史条目。
     * @param {number} currentTimeMs - 当前时间戳
     */
    _pruneHistory(currentTimeMs) {
        const cutoff = currentTimeMs - this._frameHistoryMaxAgeMs;

        // 按时间戳删除过期条目
        for (const [id, meta] of this.frameHistory) {
            if (meta.timestampMs < cutoff) {
                this.frameHistory.delete(id);
            }
        }

        // 如果条目数超过上限，删除最旧的
        if (this.frameHistory.size > this._frameHistoryMaxEntries) {
            const sorted = [...this.frameHistory.entries()]
                .sort((a, b) => a[1].timestampMs - b[1].timestampMs);
            const toDelete = sorted.slice(
                0,
                sorted.length - this._frameHistoryMaxEntries
            );
            for (const [id] of toDelete) {
                this.frameHistory.delete(id);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 会话生命周期
    // ═══════════════════════════════════════════════════════════

    /**
     * 标记会话活动（任何操作都应调用此方法）。
     */
    _touchActivity() {
        this.lastActivityAt = Date.now();
        this._resetIdleTimer();
    }

    /**
     * 重置空闲定时器。
     */
    _resetIdleTimer() {
        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
        }
        this._idleTimer = setTimeout(() => {
            this._onIdle();
        }, this._idleTimeoutMs);
    }

    /**
     * 空闲超时回调 — 关闭 Chromium 实例以释放资源。
     */
    _onIdle() {
        console.log(`[session] Session ${this.sessionId} idle timeout, cleaning up`);
        this.close();
    }

    /**
     * 关闭会话，释放所有资源。
     */
    close() {
        if (this.closed) return;
        this.closed = true;

        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }

        // 清理帧历史
        this.frameHistory.clear();

        // 关闭 Chromium
        if (this.chromium) {
            this.chromium.close().catch(err => {
                console.error(`[session] Error closing chromium:`, err.message);
            });
            this.chromium = null;
        }

        // 关闭 WebSocket (通知客户端)
        if (this.socket && this.socket.readyState === 1) {
            this.socket.close(1000, 'Session closed');
            this.socket = null;
        }

        console.log(`[session] Session ${this.sessionId} closed`);
    }

    /**
     * 检查会话是否活跃。
     * @returns {boolean}
     */
    get isActive() {
        return !this.closed;
    }

    /**
     * 获取会话存活时间（毫秒）。
     * @returns {number}
     */
    get age() {
        return Date.now() - this.createdAt;
    }
}

module.exports = Session;
