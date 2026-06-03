// metrics.js — Wison-RBI 监控与指标模块 (Phase 5)
//
// 提供生产环境所需的运行时监控、性能指标暴露和告警阈值。
//
// 指标类别:
//   1. 会话指标: 活跃数、总连接数、拒绝数
//   2. 帧指标:   帧率、压缩比、带宽、丢帧数
//   3. Chromium 指标: 实例数、内存使用、启动耗时
//   4. WebSocket 指标: 连接数、背压事件、错误数
//   5. 安全指标:   帧拒绝数、白名单拒绝数、CRC 失败数
//
// 暴露端点 (与 server.js 的 /health 集成):
//   GET /metrics  → Prometheus 格式 (可选)
//   GET /health   → JSON 健康检查
//
'use strict';

class MetricsRegistry {
    constructor() {
        this._counters = new Map();
        this._gauges = new Map();
        this._histograms = new Map();
        this._startTime = Date.now();
    }

    // ── Counter (单调递增) ──

    counter(name, labels = {}) {
        const key = this._formatKey(name, labels);
        if (!this._counters.has(key)) {
            this._counters.set(key, 0);
        }
        this._counters.set(key, this._counters.get(key) + 1);
        return this._counters.get(key);
    }

    getCounter(name, labels = {}) {
        return this._counters.get(this._formatKey(name, labels)) || 0;
    }

    // ── Gauge (可增可减) ──

    setGauge(name, value, labels = {}) {
        this._gauges.set(this._formatKey(name, labels), value);
    }

    incGauge(name, delta = 1, labels = {}) {
        const key = this._formatKey(name, labels);
        this._gauges.set(key, (this._gauges.get(key) || 0) + delta);
    }

    decGauge(name, delta = 1, labels = {}) {
        this.incGauge(name, -delta, labels);
    }

    getGauge(name, labels = {}) {
        return this._gauges.get(this._formatKey(name, labels)) || 0;
    }

    // ── Histogram (延迟分布) ──

    observe(name, valueMs, labels = {}) {
        const key = this._formatKey(name, labels);
        if (!this._histograms.has(key)) {
            this._histograms.set(key, []);
        }
        const arr = this._histograms.get(key);
        arr.push(valueMs);
        // 限制存储: 保留最近 10000 个样本
        if (arr.length > 10000) {
            arr.splice(0, arr.length - 10000);
        }
    }

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

    _histogramSummaries() {
        const summaries = {};
        for (const [key, _] of this._histograms) {
            summaries[key] = this.histogramStats(key);
        }
        return summaries;
    }

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
// ═══════════════════════════════════════════════════════════════

const metrics = new MetricsRegistry();

// ── 会话 ──
const SESSIONS_ACTIVE   = 'wison_sessions_active';
const SESSIONS_TOTAL    = 'wison_sessions_total';
const SESSIONS_REJECTED = 'wison_sessions_rejected';

// ── 帧 ──
const FRAMES_SENT       = 'wison_frames_sent';
const FRAMES_DROPPED    = 'wison_frames_dropped';
const FRAMES_REJECTED   = 'wison_frames_rejected';
const FRAME_BYTES       = 'wison_frame_bytes';
const FRAME_COMPRESS_RATIO = 'wison_frame_compress_ratio';
const FRAME_BUILD_LATENCY = 'wison_frame_build_latency_ms';

// ── 图像去重 ──
const IMAGE_HASH_HITS   = 'wison_image_hash_hits';
const IMAGE_HASH_MISSES = 'wison_image_hash_misses';

// ── WebSocket ──
const WS_CONNECTIONS    = 'wison_ws_connections';
const WS_BACKPRESSURE   = 'wison_ws_backpressure_events';
const WS_ERRORS         = 'wison_ws_errors';

// ── 安全 ──
const SECURITY_CRC_FAILS    = 'wison_security_crc_fails';
const SECURITY_OPCODE_REJECTS = 'wison_security_opcode_rejects';
const SECURITY_ZIPBOMB      = 'wison_security_zipbomb_blocked';

// ═══════════════════════════════════════════════════════════════
// 告警规则
// ═══════════════════════════════════════════════════════════════

const ALERT_RULES = Object.freeze([
    {
        name: 'high_frame_drop_rate',
        description: '帧丢弃率高 — 可能存在网络拥塞或客户端性能不足',
        check: (snap) => {
            const sent = snap.counters[FRAMES_SENT] || 0;
            const dropped = snap.counters[FRAMES_DROPPED] || 0;
            if (sent > 100 && dropped / sent > 0.1) {
                return { severity: 'warn', message: `Frame drop rate: ${(dropped/sent*100).toFixed(1)}%` };
            }
            return null;
        },
    },
    {
        name: 'high_crc_failure_rate',
        description: 'CRC 校验失败率异常 — 可能存在信道被篡改',
        check: (snap) => {
            const sent = snap.counters[FRAMES_SENT] || 0;
            const fails = snap.counters[SECURITY_CRC_FAILS] || 0;
            if (sent > 50 && fails / sent > 0.05) {
                return { severity: 'critical', message: `CRC failure rate: ${(fails/sent*100).toFixed(1)}%` };
            }
            return null;
        },
    },
    {
        name: 'session_saturation',
        description: '会话数接近上限',
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
        description: 'WebSocket 背压事件频繁',
        check: (snap) => {
            const events = snap.counters[WS_BACKPRESSURE] || 0;
            const uptime = snap.uptime_seconds || 1;
            if (events / (uptime / 60) > 5) {
                return { severity: 'warn', message: `Backpressure events: ${events} (${(events/(uptime/60)).toFixed(1)}/min)` };
            }
            return null;
        },
    },
]);

/**
 * 运行告警规则检查。
 * @returns {Array<{name, severity, message}>}
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
    metrics,
    MetricsRegistry,
    ALERT_RULES,
    checkAlerts,
    // 指标名常量
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
