// session.js — Wison-RBI 用户会话管理
//
// === 模块角色 ===
// 本模块是 Wison-RBI 服务端的**会话生命周期管理器**。
// 每个 Session 实例对应一个 WebSocket 连接 + 一个 Chromium 实例，是服务端的核心调度单元。
//
// 架构角色:
//   1. frame_id 单调计数器 — v1.6 P0 A4: 使用 compositor_frame_seq_ 风格自定义计数器，
//      不从 Chromium 内部 source_frame_number 派生，避免内部帧号不连续导致的同步错误。
//   2. 帧历史 — 存储最近帧的元数据（scroll/viewport/canvas 尺寸），
//      供 InputProxy 进行坐标转换（方案 B §7）。
//   3. 会话生命周期 — 创建→活跃→空闲→销毁，含空闲超时自动回收。
//
// === 安全不变量 (§2.2) ===
//   不变量 2: 客户端发出的每一个字节只能是原始 HID 事件或 frame_id。
//     - frame_id 是客户端引用帧的唯一标识，不含任何页面语义。
//     - 帧历史中仅存储视口/滚动等元数据，不存储任何页面内容。
//
// === 数据流方向 ===
//   帧生成 (Chromium →): session.nextFrameId() → session.recordFrame(meta) → 帧历史
//   帧查询 (← InputProxy): session.getNearestFrameMeta(frameId) → 坐标转换参数
//   会话关闭 (→ 资源回收): session.close() → Chromium.stop() + WebSocket.close()
//
// === 设计文档交叉引用 ===
//   §7   — 帧元数据与输入同步（方案 B）: frame_id + scroll 锚定机制
//   §A4  — frame_id 从 source_frame_number 改为 compositor_frame_seq_ 自定义单调计数器
//   §8   — frame_id 跳跃检测（FRAME_ID_JUMP_THRESHOLD=1000）和重启归零检测
//   §4   — 会话管理: 空闲超时 / 帧历史修剪策略
//

'use strict';

const {
    FRAME_HISTORY_MAX_AGE_MS,
    FRAME_HISTORY_MAX_ENTRIES,
    SESSION_IDLE_TIMEOUT_MS,
} = require('./config');

/**
 * 帧元数据记录（存入帧历史）
 *
 * 每条记录对应一帧的关键元数据，不含任何命令流内容。
 * 用于 InputProxy._canvasToPage() 的坐标转换计算。
 *
 * @typedef {object} FrameMeta
 * @property {number} frameId      - 帧 ID（自定义单调计数器, §A4）
 * @property {number} timestampMs  - Unix 毫秒时间戳（服务端生成时间）
 * @property {number} scrollX      - 页面滚动 X (CSS 像素, 相对于页面原点)
 * @property {number} scrollY      - 页面滚动 Y (CSS 像素, 相对于页面原点)
 * @property {number} viewportW    - CSS 视口宽度
 * @property {number} viewportH    - CSS 视口高度
 * @property {number} canvasW      - 物理画布宽度 (= viewportW * dpr)
 * @property {number} canvasH      - 物理画布高度 (= viewportH * dpr)
 */

class Session {
    /**
     * 创建新会话。
     *
     * @param {string} sessionId - 唯一会话标识（UUID v4，由 server.js 生成）
     * @param {object} [options] - 可选配置覆盖
     * @param {number} [options.frameHistoryMaxAgeMs]  - 帧历史保留时间（默认 3000ms, §7）
     * @param {number} [options.frameHistoryMaxEntries] - 帧历史最大条目（默认 1000）
     * @param {number} [options.idleTimeoutMs]          - 空闲超时（默认 120000ms = 2min）
     */
    constructor(sessionId, options = {}) {
        this.sessionId = sessionId;
        this.createdAt = Date.now();
        this.lastActivityAt = Date.now();
        this.closed = false;

        // ── frame_id 计数器 (v1.6 P0 A4) ──
        // 设计理由: Chromium 的 source_frame_number 在以下场景不连续:
        //   - 标签页切换 / 重载后 frame_number 可能跳跃
        //   - Compositor 提交失败时 frame_number 仍递增但帧未产出
        // 因此使用自定义单调计数器，从 1 开始严格递增。
        // 服务端重启时归零 → 客户端通过 FRAME_ID_JUMP_THRESHOLD 检测重启。
        this._frameIdCounter = 0;

        // ── 帧历史 ──
        // Map<frameId, FrameMeta> — key 为 frame_id，value 为元数据快照
        // 使用 Map 而非 Array 以支持 O(1) 精确查找
        this.frameHistory = new Map();
        this._frameHistoryMaxAgeMs =
            options.frameHistoryMaxAgeMs || FRAME_HISTORY_MAX_AGE_MS;
        this._frameHistoryMaxEntries =
            options.frameHistoryMaxEntries || FRAME_HISTORY_MAX_ENTRIES;

        // ── 空闲管理 ──
        // 空闲超时自动关闭会话以释放 Chromium 实例资源
        this._idleTimeoutMs = options.idleTimeoutMs || SESSION_IDLE_TIMEOUT_MS;
        this._idleTimer = null;
        this._resetIdleTimer();

        // ── Chromium 引用 ──
        // 由 server.js 在 ChromiumPool.acquire() 后赋值
        this.chromium = null;  // ChromiumInstance 实例引用

        // ── WebSocket 引用 ──
        // 由 server.js 在 _onConnection() 中赋值
        this.socket = null;
    }

    // ═══════════════════════════════════════════════════════════
    // Frame ID 管理 (§A4)
    // ═══════════════════════════════════════════════════════════

    /**
     * 分配下一个帧 ID（单调递增）。
     *
     * 调用时机: Chromium 产出新帧时，server.js 在帧组装前调用。
     * 副作用: 递增内部计数器 + 刷新空闲定时器。
     *
     * @returns {number} 新分配的帧 ID（从 1 开始，严格递增）
     */
    nextFrameId() {
        // 前置递增: 首个 frame_id = 1（0 保留为 "无帧" 语义）
        const id = ++this._frameIdCounter;
        this._touchActivity();
        return id;
    }

    /**
     * 获取当前帧 ID 计数器值（不递增）。
     *
     * 用于调试/日志，不产生副作用。
     *
     * @returns {number} 当前已分配的最大帧 ID
     */
    get currentFrameId() {
        return this._frameIdCounter;
    }

    /**
     * 重置帧 ID 计数器（服务端重启时）。
     *
     * 副作用: 清空帧历史（因为所有历史帧的 frame_id 在新计数器下已无效）。
     *
     * 客户端检测机制: 客户端发现 frame_id 非单调递增时，
     *   若跳跃 > FRAME_ID_JUMP_THRESHOLD，判定服务端重启，
     *   发送 'version_error' 重新协商协议。
     */
    resetFrameIdCounter() {
        this._frameIdCounter = 0;
        this.frameHistory.clear();
    }

    // ═══════════════════════════════════════════════════════════
    // 帧历史管理 (§7)
    // ═══════════════════════════════════════════════════════════

    /**
     * 记录新帧的元数据到帧历史。
     *
     * 调用时机: server.js sendFrame() 中，帧成功发送后。
     * 副作用: 插入 Map + 修剪过期条目 + 刷新空闲定时器。
     *
     * @param {FrameMeta} meta - 帧元数据（至少包含 frameId/timestampMs/scroll/viewport/canvas）
     */
    recordFrame(meta) {
        // 浅拷贝元数据，确保帧历史中的对象不可变性
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

        // 每次记录新帧时运行修剪 — 保证帧历史大小有界
        this._pruneHistory(meta.timestampMs);

        this._touchActivity();
    }

    /**
     * 根据 frame_id 精确查找帧元数据。
     *
     * 用于输入事件的坐标转换。
     * 检查帧是否过期（超过 FRAME_HISTORY_MAX_AGE_MS），过期则删除并返回 null。
     *
     * 边界条件: frame_id 不存在或帧已过期 → 返回 null。
     *
     * @param {number} frameId - 输入事件中引用的帧 ID
     * @returns {FrameMeta|null} 找到的帧元数据，或 null（帧不存在/已过期）
     */
    getFrameMeta(frameId) {
        const meta = this.frameHistory.get(frameId);
        if (!meta) return null;

        // 过期检查: 帧元数据超过最大保留时间则视为失效
        // 过期删除是 lazy 的 — 仅在查询时触发，而非定时器扫描
        const age = Date.now() - meta.timestampMs;
        if (age > this._frameHistoryMaxAgeMs) {
            this.frameHistory.delete(frameId);
            return null;
        }

        return meta;
    }

    /**
     * 查找离给定 frame_id 最近的、不大于它的帧元数据。
     *
     * 搜索策略（方案 B §7 的帧引用宽松匹配）:
     *   1. 先尝试精确匹配（通过 getFrameMeta）
     *   2. 若精确匹配失败（帧已过期），向前查找 ≤ frameId 的最大帧
     *
     * 为什么需要宽松匹配？
     *   客户端可能在收到新帧之前就发送了输入事件，
     *   frame_id 引用可能指向已从历史中修剪的帧。
     *   此时用最近的可用帧元数据作为近似，牺牲亚帧精度但不阻塞输入。
     *
     * @param {number} frameId - 客户端引用的帧 ID
     * @returns {FrameMeta|null} 找到的最近帧元数据，或 null（历史完全为空）
     */
    getNearestFrameMeta(frameId) {
        // 先尝试精确匹配
        const exact = this.getFrameMeta(frameId);
        if (exact) return exact;

        // 向前查找最近的帧: 在所有帧中找 ≤ frameId 的最大 id
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
     *
     * 修剪策略:
     *   1. 按时间戳: 删除 timestampMs < (currentTimeMs - maxAge) 的条目
     *   2. 按数量: 若条目数仍超上限，删除最旧的条目（按 timestampMs 排序）
     *
     * 双保险确保帧历史内存有界 — 即使时间戳异常也不会导致无限增长。
     *
     * @param {number} currentTimeMs - 当前时间戳（通常来自新帧的 timestampMs）
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
        // 排序开销 O(n log n)，但仅在 recordFrame 时触发且 n ≤ 1000
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
     *
     * 刷新 lastActivityAt 时间戳并重置空闲定时器。
     * 被 nextFrameId / recordFrame / handleIOEvent 等方法隐式调用。
     *
     * @private
     */
    _touchActivity() {
        this.lastActivityAt = Date.now();
        this._resetIdleTimer();
    }

    /**
     * 重置空闲定时器。
     *
     * 清除之前的定时器，设置新的超时回调。
     * 定时器触发 → _onIdle() → close() → 释放 Chromium 实例。
     *
     * @private
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
     *
     * 设计理由: 每个 Chromium 实例消耗 ~500MB-2GB 内存。
     *   空闲超时回收防止资源泄漏和 OOM。
     *
     * @private
     */
    _onIdle() {
        console.log(`[session] Session ${this.sessionId} idle timeout, cleaning up`);
        this.close();
    }

    /**
     * 关闭会话，释放所有资源。
     *
     * 副作用:
     *   - 标记 closed = true（幂等，重复调用无操作）
     *   - 清除空闲定时器
     *   - 清空帧历史
     *   - 关闭 Chromium 实例（CDP 断开 + 进程终止）
     *   - 关闭 WebSocket 连接（通知客户端）
     *
     * 幂等性保证: closed 标志位确保重复调用安全。
     */
    close() {
        if (this.closed) return;
        this.closed = true;

        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }

        // 清理帧历史 — 释放内存
        this.frameHistory.clear();

        // 关闭 Chromium — 异步操作，不阻塞 close() 返回
        if (this.chromium) {
            this.chromium.close().catch(err => {
                console.error(`[session] Error closing chromium:`, err.message);
            });
            this.chromium = null;
        }

        // 关闭 WebSocket — 仅当连接仍处于 OPEN 状态 (readyState === 1)
        // 1000 = Normal Closure，通知客户端会话正常终止
        if (this.socket && this.socket.readyState === 1) {
            this.socket.close(1000, 'Session closed');
            this.socket = null;
        }

        console.log(`[session] Session ${this.sessionId} closed`);
    }

    /**
     * 检查会话是否活跃。
     *
     * @returns {boolean} true = 会话未关闭，可继续处理消息
     */
    get isActive() {
        return !this.closed;
    }

    /**
     * 获取会话存活时间（毫秒）。
     *
     * 用于监控/日志 — 评估会话平均时长。
     *
     * @returns {number} 从 createdAt 到当前时间的毫秒数
     */
    get age() {
        return Date.now() - this.createdAt;
    }
}

module.exports = Session;
