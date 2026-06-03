// metrics.js — Wison-RBI 监控与指标模块 (Phase 5)
//
// === 模块角色 ===
// 本模块是 Wison-RBI 系统的**运行时可观测性层**。
// 架构角色: 遥测收集器 — 聚合会话/帧/WebSocket/安全事件的多维指标，
//   并通过 /health 和 /metrics HTTP 端点暴露给外部监控系统（Prometheus 兼容）。
//
// === 安全不变量 ===
//   本模块不直接参与安全决策，但为安全监控提供数据源:
//     - SECURITY_CRC_FAILS: 信道完整性异常告警（可能被篡改, §2.1）
//     - SECURITY_OPCODE_REJECTS: 白名单拒绝率异常（可能受攻击, §8）
//     - SECURITY_ZIPBOMB: 压缩炸弹拦截计数（防 DoS, §6.4）
//   告警规则中的 CRC 失败率 > 5% 触发 critical 级别告警（信道可能被篡改）。
//
// === 数据流方向 ===
//   server.js / frame_builder.js / chromium_manager.js → metrics counter/gauge/histogram
//   → MetricsRegistry._counters/_gauges/_histograms (内存 Map)
//   → snapshot() → /health (JSON) 或 Prometheus exporter
//   → checkAlerts() → 告警列表
//
// === 设计文档交叉引用 ===
//   §9.1 — 性能基准 7 项指标（帧率/压缩比/带宽等，对应 FRAME_* 指标）
//   §10  — 审计清单（CRC 失败/白名单拒绝等安全指标）
//   §2.1 — 威胁模型（侧信道防御: 限制度量回传; 但不影响本模块的服务器内部指标）
//   §8   — 错误处理与告警阈值
//
// 暴露端点 (与 server.js 的 _handleHttpRequest 集成):
//   GET /metrics  → JSON 格式完整快照 (Prometheus 兼容格式可选)
//   GET /health   → JSON 健康检查 + 告警摘要
//

'use strict';

/**
 * MetricsRegistry — 轻量级指标注册表
 *
 * 提供三种指标类型（不含依赖，纯内存实现）:
 *   - Counter: 单调递增计数器（如总帧数/总连接数）
 *   - Gauge:   可增减的瞬时值（如活跃会话数/缓冲区大小）
 *   - Histogram: 延迟分布（如帧构建延迟 p50/p95/p99）
 *
 * 设计理由: 避免引入 prom-client 等重量级依赖。
 *   Phase 1 使用纯 JavaScript 实现，Phase 5 可替换为 Prometheus 标准库。
 */
class MetricsRegistry {
    constructor() {
        this._counters = new Map();    // key → number (monotonic)
        this._gauges = new Map();     // key → number (instantaneous)
        this._histograms = new Map(); // key → number[] (samples buffer)
        this._startTime = Date.now(); // 服务启动时间戳，用于计算 uptime
    }

    // ── Counter (单调递增，仅增不减) ──

    /**
     * 递增计数器并返回新值。
     *
     * Counter 语义: 只增不减，代表事件发生的总次数。
     * 用途: FRAMES_SENT, WS_CONNECTIONS, SECURITY_CRC_FAILS 等。
     *
     * @param {string} name - 指标名 (如 'wison_frames_sent')
     * @param {object} [labels={}] - 标签键值对 (如 {session:'abc'})
     * @returns {number} 递增后的计数值
     */
    counter(name, labels = {}) {
        const key = this._formatKey(name, labels);
        if (!this._counters.has(key)) {
            this._counters.set(key, 0);
        }
        this._counters.set(key, this._counters.get(key) + 1);
        return this._counters.get(key);
    }

    /**
     * 获取计数器当前值（不递增）。
     * @param {string} name
     * @param {object} [labels={}]
     * @returns {number}
     */
    getCounter(name, labels = {}) {
        return this._counters.get(this._formatKey(name, labels)) || 0;
    }

    // ── Gauge (可增可减的瞬时值) ──

    /**
     * 设置 Gauge 为指定值（覆盖）。
     *
     * Gauge 语义: 表示当前状态的瞬时快照。
     * 用途: SESSIONS_ACTIVE, CHROMIUM_MEMORY_BYTES 等。
     *
     * @param {string} name
     * @param {number} value
     * @param {object} [labels={}]
     */
    setGauge(name, value, labels = {}) {
        this._gauges.set(this._formatKey(name, labels), value);
    }

    /**
     * Gauge 增量（正数为增，负数为减）。
     * @param {string} name
     * @param {number} [delta=1]
     * @param {object} [labels={}]
     */
    incGauge(name, delta = 1, labels = {}) {
        const key = this._formatKey(name, labels);
        this._gauges.set(key, (this._gauges.get(key) || 0) + delta);
    }

    /**
     * Gauge 减量。
     * @param {string} name
     * @param {number} [delta=1]
     * @param {object} [labels={}]
     */
    decGauge(name, delta = 1, labels = {}) {
        this.incGauge(name, -delta, labels);
    }

    /**
     * 获取 Gauge 当前值。
     * @param {string} name
     * @param {object} [labels={}]
     * @returns {number}
     */
    getGauge(name, labels = {}) {
        return this._gauges.get(this._formatKey(name, labels)) || 0;
    }

    // ── Histogram (延迟分布) ──

    /**
     * 记录一个样本到 Histogram。
     *
     * 用途: FRAME_BUILD_LATENCY 等延迟类指标。
     * 自动限制存储为最近 10000 个样本（滑动窗口），防止内存无限增长。
     *
     * @param {string} name
     * @param {number} valueMs - 延迟值（毫秒）
     * @param {object} [labels={}]
     */
    observe(name, valueMs, labels = {}) {
        const key = this._formatKey(name, labels);
        if (!this._histograms.has(key)) {
            this._histograms.set(key, []);
        }
        const arr = this._histograms.get(key);
        arr.push(valueMs);
        // 滑动窗口: 保留最近 10000 个样本
        // 边界条件: 超出时移除最旧样本，保证内存有界
        if (arr.length > 10000) {
            arr.splice(0, arr.length - 10000);
        }
    }

    /**
     * 计算 Histogram 的统计摘要。
     *
     * 返回 count/mean/p50/p95/p99/max/min，用于性能诊断。
     * 内部对样本排序，时间复杂度 O(n log n)。
     *
     * @param {string} name
     * @param {object} [labels={}]
     * @returns {object|null} 统计摘要，无样本时返回 null
     */
    histogramStats(name, labels = {}) {
        const arr = this._histograms.get(this._formatKey(name, labels)) || [];
        if (arr.length === 0) return null;

        const sorted = [...arr].sort((a, b) => a - b);
        const n = sorted.length;
        return {
            count: n,
            mean: sorted.reduce((a, b) => a + b, 0) / n,
            p50: sorted[Math.floor(n * 0.50)],
            p95: sorted[Math.floor(n * 0.95)],
            p99: sorted[Math.floor(n * 0.99)],
            max: sorted[n - 1],
            min: sorted[0],
        };
    }

    // ── 快照 ──

    /**
     * 返回完整指标快照（JSON 格式）。
     *
     * 被 /health 和 /metrics 端点调用。
     * 快照包含:
     *   - uptime_seconds: 服务运行秒数
     *   - counters: 所有 Counter 的当前值
     *   - gauges: 所有 Gauge 的当前值
     *   - histograms: 所有 Histogram 的统计摘要（均值/p50/p95/p99）
     *
     * @returns {object} 完整指标快照
     */
    snapshot() {
        const uptime = (Date.now() - this._startTime) / 1000;
        return {
            uptime_seconds: uptime,
            counters: Object.fromEntries(this._counters),
            gauges: Object.fromEntries(this._gauges),
            histograms: this._histogramSummaries(),
        };
    }

    /**
     * 内部: 构建所有 Histogram 的统计摘要。
     * @returns {object} key → stats 映射
     */
    _histogramSummaries() {
        const summaries = {};
        for (const [key, _] of this._histograms) {
            summaries[key] = this.histogramStats(key);
        }
        return summaries;
    }

    /**
     * 内部: 将指标名 + 标签格式化为唯一 key。
     *
     * 格式: "name{key1=val1,key2=val2}" 或 "name"（无标签时）
     * 标签按键名字典序排列以保证确定性。
     *
     * @param {string} name - 指标名
     * @param {object} labels - 标签键值对
     * @returns {string} 唯一 key
     */
    _formatKey(name, labels) {
        const labelStr = Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
        return labelStr ? `${name}{${labelStr}}` : name;
    }
}

// ═══════════════════════════════════════════════════════════════
// 预定义指标 (全局单例)
//
// 每个指标名以 'wison_' 为前缀，避免与 Prometheus 内置指标冲突。
// 指标名常量导出给 server.js / frame_builder.js 使用，
// 确保指标命名一致性。
// ═══════════════════════════════════════════════════════════════

const metrics = new MetricsRegistry();

// ── 会话指标 (§4) ──
const SESSIONS_ACTIVE   = 'wison_sessions_active';   // Gauge: 当前活跃会话数
const SESSIONS_TOTAL    = 'wison_sessions_total';    // Counter: 历史连接总数
const SESSIONS_REJECTED = 'wison_sessions_rejected'; // Counter: 被拒绝的会话

// ── 帧指标 (§9.1) ──
const FRAMES_SENT       = 'wison_frames_sent';       // Counter: 已发送帧数
const FRAMES_DROPPED    = 'wison_frames_dropped';    // Counter: 背压丢弃帧数
const FRAMES_REJECTED   = 'wison_frames_rejected';   // Counter: 校验拒绝帧数
const FRAME_BYTES       = 'wison_frame_bytes';       // Histogram: 帧字节数分布
const FRAME_COMPRESS_RATIO = 'wison_frame_compress_ratio'; // Gauge: 压缩比
const FRAME_BUILD_LATENCY = 'wison_frame_build_latency_ms'; // Histogram: 帧构建延迟

// ── 图像去重 (§4, frame_builder.js ImageHashRegistry) ──
const IMAGE_HASH_HITS   = 'wison_image_hash_hits';   // Counter: 哈希命中数
const IMAGE_HASH_MISSES = 'wison_image_hash_misses'; // Counter: 哈希未命中数

// ── WebSocket 指标 ──
const WS_CONNECTIONS    = 'wison_ws_connections';    // Counter: WebSocket 连接总数
const WS_BACKPRESSURE   = 'wison_ws_backpressure_events'; // Counter: 背压事件数
const WS_ERRORS         = 'wison_ws_errors';         // Counter: WebSocket 错误数

// ── 安全指标 (§10, 审计清单) ──
const SECURITY_CRC_FAILS    = 'wison_security_crc_fails';    // Counter: CRC 校验失败
const SECURITY_OPCODE_REJECTS = 'wison_security_opcode_rejects'; // Counter: OpCode 白名单拒绝
const SECURITY_ZIPBOMB      = 'wison_security_zipbomb_blocked'; // Counter: 压缩炸弹拦截

// ═══════════════════════════════════════════════════════════════
// 告警规则 (§8 / §10)
//
// 每条规则检查指标快照的特定条件，返回 {severity, message} 或 null。
// severity 分级:
//   - 'critical': 安全相关（CRC 失败率异常 → 信道可能被篡改）
//   - 'warn':     性能/容量相关（帧丢弃率高、会话饱和、背压频繁）
//
// 规则在 /health 端点每次调用时运行。
// ═══════════════════════════════════════════════════════════════

const ALERT_RULES = Object.freeze([
    {
        name: 'high_frame_drop_rate',
        description: '帧丢弃率高 — 可能存在网络拥塞或客户端性能不足',
        check: (snap) => {
            const sent = snap.counters[FRAMES_SENT] || 0;
            const dropped = snap.counters[FRAMES_DROPPED] || 0;
            // 仅在有足够样本量（>100 帧发送）时触发，避免冷启动误报
            // 丢弃率 > 10% 触发 warn
            if (sent > 100 && dropped / sent > 0.1) {
                return { severity: 'warn', message: `Frame drop rate: ${(dropped/sent*100).toFixed(1)}%` };
            }
            return null;
        },
    },
    {
        name: 'high_crc_failure_rate',
        description: 'CRC 校验失败率异常 — 可能存在信道被篡改 (§2.1 信道中间人威胁)',
        check: (snap) => {
            const sent = snap.counters[FRAMES_SENT] || 0;
            const fails = snap.counters[SECURITY_CRC_FAILS] || 0;
            // CRC 失败率 > 5% 触发 critical — 这可能意味着:
            //   1. 中间人篡改 WebSocket 帧数据
            //   2. 网络传输损坏率异常高
            //   3. 客户端 CRC 计算错误
            if (sent > 50 && fails / sent > 0.05) {
                return { severity: 'critical', message: `CRC failure rate: ${(fails/sent*100).toFixed(1)}%` };
            }
            return null;
        },
    },
    {
        name: 'session_saturation',
        description: '会话数接近上限 — 即将拒绝新连接',
        check: (snap) => {
            const active = snap.gauges[SESSIONS_ACTIVE] || 0;
            if (active >= 4) {
                return { severity: 'warn', message: `Active sessions: ${active}/4` };
            }
            return null;
        },
    },
    {
        name: 'high_backpressure',
        description: 'WebSocket 背压事件频繁 — 客户端消费速度低于服务端发送速度',
        check: (snap) => {
            const events = snap.counters[WS_BACKPRESSURE] || 0;
            const uptime = snap.uptime_seconds || 1;
            // 平均每分钟 > 5 次背压事件触发 warn
            if (events / (uptime / 60) > 5) {
                return { severity: 'warn', message: `Backpressure events: ${events} (${(events/(uptime/60)).toFixed(1)}/min)` };
            }
            return null;
        },
    },
]);

/**
 * 运行所有告警规则检查。
 *
 * 调用时机: /health 端点每次请求时。
 * 返回触发的告警列表，空列表表示系统健康。
 *
 * @returns {Array<{name: string, severity: string, message: string}>}
 *   触发的告警列表（severity: 'critical' | 'warn'）
 */
function checkAlerts() {
    const snap = metrics.snapshot();
    const alerts = [];
    for (const rule of ALERT_RULES) {
        const result = rule.check(snap);
        if (result) {
            alerts.push({ name: rule.name, ...result });
        }
    }
    return alerts;
}

// ═══════════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════════

module.exports = {
    metrics,              // MetricsRegistry 单例
    MetricsRegistry,      // 类本身（用于测试/自定义实例）
    ALERT_RULES,          // 告警规则列表（审计用）
    checkAlerts,          // 告警检查函数
    // 指标名常量 — 确保所有模块使用一致的指标名
    SESSIONS_ACTIVE,
    SESSIONS_TOTAL,
    SESSIONS_REJECTED,
    FRAMES_SENT,
    FRAMES_DROPPED,
    FRAMES_REJECTED,
    FRAME_BYTES,
    FRAME_COMPRESS_RATIO,
    FRAME_BUILD_LATENCY,
    IMAGE_HASH_HITS,
    IMAGE_HASH_MISSES,
    WS_CONNECTIONS,
    WS_BACKPRESSURE,
    WS_ERRORS,
    SECURITY_CRC_FAILS,
    SECURITY_OPCODE_REJECTS,
    SECURITY_ZIPBOMB,
};
