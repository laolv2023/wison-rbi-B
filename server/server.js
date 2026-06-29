// server.js — Wison-RBI 服务端主入口
//
// === 模块角色 ===
// 本模块是 Wison-RBI 系统的**服务端中枢**。
// 架构角色: 编排器 (Orchestrator) — 负责:
//   1. WebSocket 服务（接收客户端连接，TLS 1.3 可选）
//   2. 会话生命周期管理（创建→初始化 Chromium→绑定 InputProxy→关闭）
//   3. 消息路由（客户端 JSON 消息 → 类型分发 → 具体处理）
//   4. 帧路由（Chromium CommandStream → 帧组装+压缩 → WebSocket 二进制帧）
//   5. 输入路由（客户端 HID 事件 → InputProxy → CDP 注入）
//   6. 健康检查 & 指标暴露 (/health + /metrics 端点)
//
// === 安全不变量 (§2.2) ===
//   不变量 1: 不向客户端传输 HTML/CSS/JS — 仅传输经过 CRC32 校验的帧二进制
//   不变量 2: 输入事件仅做坐标转换，不解析页面语义 — 委托给 InputProxy
//   不变量 3: 所有页面内容在 Chromium 沙箱内执行 — 通过 ChromiumPool 管理
//
// === 数据流方向 ===
//   ┌─────────────────────────────────────────────────────────┐
//   │  客户端 WebSocket                                       │
//   │    ↓ JSON {type:'ready'|'viewport'|'io'|...}           │
//   │  _handleMessage() → 类型分发                            │
//   │    ├─ 'ready'    → _handleReady() → InputProxy.navigate()
//   │    ├─ 'viewport' → InputProxy.updateViewport()
//   │    ├─ 'io'       → InputProxy.handleIOEvent()
//   │    └─ 'request_keyframe' → 设置标志位
//   │                                                         │
//   │  Chromium (via CDP) → sendFrame()                       │
//   │    → assembleFrame() + compressFrame()                  │
//   │    → ws.send(binaryBuffer) → 客户端                     │
//   └─────────────────────────────────────────────────────────┘
//
// === 威胁模型 (§2.1) ===
//   - 信道中间人: TLS 1.3 (AEAD 套件) + CRC32 完整性校验
//     注: CRC32 在 TLS 之上提供第二层传输错误检测，非防篡改
//   - 服务端被入侵: CommandStream 白名单在客户端执行（不在本模块），
//     但本模块确保帧结构合规 + 压缩炸弹防护
//   - DoS: 最大会话数限制 (maxSessions) + WebSocket payload 限制 (64MB)
//
// === 设计文档交叉引用 ===
//   §2.1 — 威胁模型（TLS 1.3 配置）
//   §2.2 — 核心安全不变量（客户端不接收 HTML/CSS/JS）
//   §4   — 服务端设计: 会话管理 / Chromium 池 / 帧路由
//   §6   — 通信协议规范（帧结构、压缩、CRC32）
//   §7   — 帧元数据与输入同步（方案 B）
//   §8   — 错误处理: request_keyframe 触发机制 / version_error 协议协商
//   §10  — 审计清单

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server: WsServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { ChromiumPool } = require('./chromium_manager');
const Session = require('./session');
const InputProxy = require('./io_proxy');
const { assembleFrame, compressFrame } = require('./frame_builder');
const { isSafeFontData } = require('./font_validator');
const {
    metrics,
    SESSIONS_ACTIVE,
    SESSIONS_TOTAL,
    FRAMES_SENT,
    FRAMES_DROPPED,
    WS_CONNECTIONS,
    WS_BACKPRESSURE,
    WS_ERRORS,
    UNHANDLED_REJECTIONS,
    checkAlerts,
} = require('./metrics');
const {
    MAX_BYTES_PER_FRAME,
    WS_HIGH_WATER_MARK,
    PROTOCOL_VERSION,
    TLS_DEFAULT_CERT_PATH,
    TLS_DEFAULT_KEY_PATH,
    TLS_DEFAULT_CA_PATH,
    TLS_CIPHER_SUITE,
    TLS_MIN_VERSION,
    TLS_HONOR_CIPHER_ORDER,
    MAX_CONCURRENT_SESSIONS,
    RATE_LIMIT_MESSAGES_PER_SEC,
    RATE_LIMIT_BURST,
} = require('./config');

// ═══════════════════════════════════════════════════════════════
// WisonRBI Server (§4)
// ═══════════════════════════════════════════════════════════════

class WisonRBIServer {
    /**
     * 创建 Wison-RBI 服务端实例。
     *
     * @param {object} [options] - 配置选项
     * @param {number} [options.port=3000]        - HTTP/WebSocket 监听端口
     * @param {string} [options.chromiumPath]     - Chromium 可执行文件路径
     * @param {number} [options.maxSessions=4]    - 最大并发会话数（防 DoS）
     * @param {string} [options.tlsCert]          - TLS 证书路径 (PEM, §2.1)
     * @param {string} [options.tlsKey]           - TLS 私钥路径 (PEM, §2.1)
     * @param {string} [options.tlsCa]            - CA 证书路径 (mTLS 可选, §2.1)
     */
    constructor(options = {}) {
        this._port = options.port || 3000;
        this._chromiumPath = options.chromiumPath || 'chromium';
        this._maxSessions = options.maxSessions || 4;
        this._isShuttingDown = false;  // 幂等关闭标志

        // ── TLS 配置 (§2.1, Phase 3 安全加固) ──
        // TLS 1.3 + AEAD 密码套件强制
        const tlsCert = options.tlsCert || TLS_DEFAULT_CERT_PATH;
        const tlsKey  = options.tlsKey  || TLS_DEFAULT_KEY_PATH;
        const tlsCa   = options.tlsCa   || TLS_DEFAULT_CA_PATH;
        // TLS 启用条件: 同时提供 cert 和 key
        this._tlsEnabled = !!(tlsCert && tlsKey);
        // 安全警告: 若 WISON_TLS_ENABLED 显式设置但实际未启用 TLS
        if (process.env.WISON_TLS_ENABLED === '1' && !this._tlsEnabled) {
            console.error('[server] WARNING: WISON_TLS_ENABLED=1 but TLS disabled (cert/key missing or empty)');
        }

        let server;
        if (this._tlsEnabled) {
            const tlsOptions = {
                cert: fs.readFileSync(tlsCert),
                key:  fs.readFileSync(tlsKey),
                ciphers: TLS_CIPHER_SUITE,           // 仅 AEAD 套件
                minVersion: TLS_MIN_VERSION,          // 强制 TLS 1.3
                honorCipherOrder: TLS_HONOR_CIPHER_ORDER, // 服务端决定套件优先级
            };
            // mTLS: 若提供 CA 证书，启用双向认证
            if (tlsCa) {
                try {
                    tlsOptions.ca = fs.readFileSync(tlsCa);
                    tlsOptions.requestCert = true;
                    tlsOptions.rejectUnauthorized = true;  // 拒绝未提供有效证书的客户端
                } catch (caErr) {
                    console.error(`[server] WARNING: CA cert not found at ${tlsCa}, mTLS disabled:`, caErr.message);
                    // mTLS 失败不影响 TLS 1.3 正常工作
                }
            }
            server = https.createServer(tlsOptions, (req, res) => {
                this._handleHttpRequest(req, res);
            });
        } else {
            server = http.createServer((req, res) => {
                this._handleHttpRequest(req, res);
            });
        }

        // ── HTTP(s) Server ──
        this._httpServer = server;

        // ── WebSocket Server ──
        // maxPayload: 64MB (与 MAX_BYTES_PER_FRAME 一致, §6.3)
        // WebSocket 协议层限制，防止超大消息耗尽内存
        this._wsServer = new WsServer({
            server: this._httpServer,          // 复用 HTTP server
            maxPayload: MAX_BYTES_PER_FRAME,      // 64MB (与 MAX_BYTES_PER_FRAME 一致)
        });

        // ── 会话管理 ──
        // Map<sessionId, Session> — O(1) 查找/插入/删除
        this._sessions = new Map();

        // ── Chromium 实例池 (§4) ──
        this._chromiumPool = new ChromiumPool({
            executablePath: this._chromiumPath,
            maxInstances: this._maxSessions,   // 每个会话最多一个实例
        });

        // ── 绑定 WebSocket 事件 ──
        this._wsServer.on('connection', (ws, req) => this._onConnection(ws, req));
        this._wsServer.on('error', (err) => {
            console.error('[server] WebSocket server error:', err.message);
        });

        // ── 优雅关闭 (§8) ──
        // SIGTERM: Kubernetes/Docker 终止信号
        // SIGINT:  Ctrl+C 中断
        // 保存处理器引用以便在 close() 中移除，避免多实例时处理器累积
        this._sigtermHandler = () => this.shutdown();
        this._sigintHandler = () => this.shutdown();
        this._unhandledRejectionHandler = (reason, promise) => {
            console.error('[server] Unhandled Promise rejection:', reason);
            metrics.incCounter(UNHANDLED_REJECTIONS);
        };
        process.on('SIGTERM', this._sigtermHandler);
        process.on('SIGINT', this._sigintHandler);
        process.on('unhandledRejection', this._unhandledRejectionHandler);
    }

    // ═══════════════════════════════════════════════════════════
    // HTTP 请求处理
    // ═══════════════════════════════════════════════════════════

    /**
     * HTTP 请求处理器 — 提供 /metrics 和 /health 端点。
     *
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse}  res
     */
    _handleHttpRequest(req, res) {
        // 指标端点 — Prometheus 兼容 JSON 格式
        if (req.url === '/metrics') {
            const snap = metrics.snapshot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(snap, null, 2));
            return;
        }

        // 健康检查端点 — 综合状态 + 告警 (§10)
        if (req.url === '/health') {
            const snap = metrics.snapshot();
            const alerts = checkAlerts();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                // status: 'ok' 若无告警，'degraded' 若有告警
                status: alerts.length > 0 ? 'degraded' : 'ok',
                sessions: this._sessions.size,
                uptime: process.uptime(),
                tls: this._tlsEnabled,
                metrics: {
                    frames_sent: snap.counters[FRAMES_SENT] || 0,
                    frames_dropped: snap.counters[FRAMES_DROPPED] || 0,
                    ws_connections: snap.counters[WS_CONNECTIONS] || 0,
                },
                alerts: alerts.length > 0 ? alerts : undefined,
            }));
            return;
        }
        // 未知路径 → 404
        res.writeHead(404);
        res.end();
    }

    // ═══════════════════════════════════════════════════════════
    // 启动/关闭
    // ═══════════════════════════════════════════════════════════

    /**
     * 启动 HTTP/WebSocket 服务器。
     *
     * @returns {Promise<void>} 服务器开始监听后 resolve
     */
    async start() {
        return new Promise((resolve) => {
            this._httpServer.listen(this._port, () => {
                const proto = this._tlsEnabled ? 'https/wss' : 'http/ws';
                console.log(`[server] Wison-RBI server listening on ${proto}://0.0.0.0:${this._port}`);
                resolve();
            });
        });
    }

    /**
     * 优雅关闭 — 清理所有资源后退出。
     *
     * 关闭顺序:
     *   1. 关闭所有 WebSocket 连接（通知客户端）
     *   2. 关闭所有 Chromium 实例（SIGTERM → SIGKILL）
     *   3. 关闭 WebSocket Server
     *   4. 关闭 HTTP Server
     *   5. process.exit(0)
     *
     * @returns {Promise<void>}
     */
    async shutdown() {
        // 幂等保护: 防止 SIGTERM+SIGINT 同时触发导致双重关闭
        if (this._isShuttingDown) return;
        this._isShuttingDown = true;
        console.log('[server] Shutting down...');

        // 移除进程级事件处理器（避免多实例时累积）
        if (this._sigtermHandler) {
            process.removeListener('SIGTERM', this._sigtermHandler);
            this._sigtermHandler = null;
        }
        if (this._sigintHandler) {
            process.removeListener('SIGINT', this._sigintHandler);
            this._sigintHandler = null;
        }
        if (this._unhandledRejectionHandler) {
            process.removeListener('unhandledRejection', this._unhandledRejectionHandler);
            this._unhandledRejectionHandler = null;
        }

        // 关闭所有 WebSocket 连接
        for (const [id, session] of this._sessions) {
            session.close();
        }
        this._sessions.clear();

        // 关闭所有 Chromium 实例（带 10 秒超时保护）
        try {
            await Promise.race([
                this._chromiumPool.shutdown(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 10000))
            ]);
        } catch (err) {
            console.error('[server] Chromium shutdown error:', err.message);
        }

        // 关闭 WebSocket Server 和 HTTP Server（等待现有连接关闭）
        this._wsServer.close();
        await new Promise((resolve) => {
            this._httpServer.close(() => resolve());
            // 5 秒超时保护：防止某些连接永不关闭
            setTimeout(resolve, 5000);
        });

        console.log('[server] Shutdown complete');
        process.exit(0);
    }

    // ═══════════════════════════════════════════════════════════
    // WebSocket 连接处理 (§4)
    // ═══════════════════════════════════════════════════════════

    /**
     * WebSocket 连接建立回调。
     *
     * 处理流程:
     *   1. 生成唯一 sessionId (UUID v4)
     *   2. 记录指标 (SESSIONS_ACTIVE, SESSIONS_TOTAL, WS_CONNECTIONS)
     *   3. 创建 Session + 绑定 WebSocket
     *   4. 从 ChromiumPool 获取实例 → 创建 InputProxy
     *   5. 绑定 message/close/error 事件处理器
     *   6. 启动背压监控定时器
     *
     * 错误处理: 若任一步骤失败，发送错误消息给客户端并清理会话。
     *
     * @param {WebSocket} ws  - WebSocket 连接实例
     * @param {http.IncomingMessage} req - HTTP 升级请求
     */
    async _onConnection(ws, req) {
        // 连接数限制: 防止 DoS
        if (this._sessions.size >= MAX_CONCURRENT_SESSIONS) {
            console.warn(`[server] Connection rejected: max sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
            ws.close(1013, 'Maximum sessions reached');
            return;
        }

        const sessionId = uuidv4();
        const clientIp = req.socket.remoteAddress;
        console.log(`[server] New connection: ${sessionId} (from ${clientIp})`);

        // Phase 5: 指标记录
        metrics.setGauge(SESSIONS_ACTIVE, this._sessions.size + 1);
        metrics.counter(SESSIONS_TOTAL);
        metrics.counter(WS_CONNECTIONS);

        // 创建会话 — 初始状态为活跃
        const session = new Session(sessionId);
        session.socket = ws;
        session._clientIp = clientIp;
        // 速率限制: 令牌桶
        session._rateLimitTokens = RATE_LIMIT_BURST;
        session._rateLimitLastRefill = Date.now();
        this._sessions.set(sessionId, session);

        let inputProxy = null;
        let cdpClient = null;

        try {
            // 获取 Chromium 实例 — 可能复用空闲实例或创建新实例
            const chromium = await this._chromiumPool.acquire(sessionId);
            session.chromium = chromium;

            // 获取 CDP 客户端 — InputProxy 的核心依赖
            cdpClient = chromium._cdpClient;
            if (!cdpClient) {
                throw new Error('Chromium instance has no CDP client');
            }

            // 创建输入代理 — 将 CDP 客户端和 Session 绑定
            inputProxy = new InputProxy(cdpClient, session);

        } catch (err) {
            console.error(`[server] Failed to initialize session ${sessionId}:`, err.message);
            // 发送结构化错误消息给客户端
            this._sendError(ws, 'SESSION_INIT_FAILED', err.message);
            // 释放可能已获取的 Chromium 实例（避免资源泄漏）
            if (session.chromium) {
                try {
                    this._chromiumPool.release(sessionId);
                } catch (releaseErr) {
                    console.error(`[server] Failed to release chromium for ${sessionId}:`, releaseErr.message);
                }
            }
            session.close();
            this._sessions.delete(sessionId);
            // 更新活跃会话数指标（与正常清理路径保持一致）
            metrics.setGauge(SESSIONS_ACTIVE, this._sessions.size);
            return;
        }

        // ── 消息处理 ──
        // 客户端发送的 JSON 消息在此路由
        ws.on('message', async (data) => {
            // 速率限制: 令牌桶算法
            const now = Date.now();
            const elapsed = now - session._rateLimitLastRefill;
            const refill = Math.floor(elapsed * RATE_LIMIT_MESSAGES_PER_SEC / 1000);
            session._rateLimitTokens = Math.min(RATE_LIMIT_BURST, session._rateLimitTokens + refill);
            session._rateLimitLastRefill = now;
            if (session._rateLimitTokens <= 0) {
                console.warn(`[server] Rate limit exceeded for ${sessionId} (IP: ${session._clientIp})`);
                return;  // 丢弃消息
            }
            session._rateLimitTokens--;

            try {
                const msg = JSON.parse(data.toString());
                await this._handleMessage(session, inputProxy, msg);
            } catch (err) {
                // 非 JSON 消息（可能是二进制帧相关？）— 忽略
                // 二进制帧不通过 message 事件传输（使用 WebSocket 二进制模式）
                if (err instanceof SyntaxError) {
                    console.warn(`[server] Non-JSON message from ${sessionId}`);
                } else {
                    console.error(`[server] Message handling error:`, err.message);
                }
            }
        });

        // ── 连接关闭 ──
        // 使用 _connectionClosed 标志防止 close+error 双重清理
        let _connectionClosed = false;
        // FIX-R32: 先声明 backpressureInterval = null，消除 TDZ (Temporal Dead Zone) 风险。
        // 原实现中 cleanupConnection (line 430) 引用了 const backpressureInterval (line 460)，
        // 若 close/error 事件在 line 444~460 之间同步触发（极端边界），会抛出
        // ReferenceError: Cannot access 'backpressureInterval' before initialization。
        let backpressureInterval = null;
        const cleanupConnection = () => {
            if (_connectionClosed) return;
            _connectionClosed = true;
            if (backpressureInterval !== null) clearInterval(backpressureInterval);
            try { session.close(); } catch (e) { /* 忽略 */ }
            if (this._sessions.has(sessionId)) {
                this._sessions.delete(sessionId);
                metrics.decGauge(SESSIONS_ACTIVE);
            }
            this._chromiumPool.release(sessionId).catch(err => {
                console.error(`[server] Error releasing chromium:`, err.message);
            });
        };

        ws.on('close', (code, reason) => {
            console.log(`[server] Connection closed: ${sessionId} (code=${code})`);
            cleanupConnection();
        });

        // ── 错误处理 ──
        ws.on('error', (err) => {
            console.error(`[server] WebSocket error for ${sessionId}:`, err.message);
            metrics.counter(WS_ERRORS);
            cleanupConnection();
        });

        // ── 背压监控 (§4 / §8) ──
        // 每 5 秒检查一次发送缓冲区
        // 若缓冲区超过高水位 (WS_HIGH_WATER_MARK = 1MB)，
        //   触发背压告警指标并在日志中记录
        backpressureInterval = setInterval(() => {
            if (session.closed) return;
            if (ws.bufferedAmount > WS_HIGH_WATER_MARK) {
                metrics.counter(WS_BACKPRESSURE);
                console.warn(
                    `[server] Backpressure for ${sessionId}: ` +
                    `${ws.bufferedAmount} bytes buffered`
                );
            }
        }, 5000);
    }

    // ═══════════════════════════════════════════════════════════
    // 消息路由 (§4)
    // ═══════════════════════════════════════════════════════════

    /**
     * 客户端消息路由器 — 根据 type 字段分发到对应处理器。
     *
     * 支持的消息类型:
     *   - 'ready':             客户端就绪，请求导航到指定 URL
     *   - 'viewport':          客户端视口尺寸更新（resize 事件）
     *   - 'io':                HID 输入事件（鼠标/键盘/滚轮）
     *   - 'request_keyframe':  客户端请求关键帧（白名单连续拒绝 ≥3 帧, §8）
     *   - 'version_error':     协议版本不匹配
     *   - 'ping':              心跳保活
     *
     * 注意: msg.type 和 msg.event 都会被检查，
     *   以兼容不同客户端版本的字段命名。
     *
     * @param {Session} session    - 当前会话
     * @param {InputProxy} inputProxy - 输入代理实例
     * @param {object} msg         - 客户端消息
     */
    async _handleMessage(session, inputProxy, msg) {
        if (session.closed) return;

        switch (msg.type || msg.event) {
            case 'ready':
                await this._handleReady(session, inputProxy, msg);
                break;

            case 'viewport':
                // 客户端窗口尺寸变化 → 更新 CDP Emulation 域
                await inputProxy.updateViewport(
                    msg.width,
                    msg.height,
                    msg.devicePixelRatio || 1.0
                );
                break;

            case 'io':
                // 原始 HID 输入事件 → 坐标转换 + CDP 注入 (§7)
                await inputProxy.handleIOEvent(msg);
                break;

            case 'request_keyframe':
                // 客户端请求关键帧（v1.6: 白名单连续拒绝 ≥3 帧触发, §8）
                // 设置标志位，下一帧将标记 FLAG_IS_KEYFRAME
                console.log(`[server] Keyframe requested by ${session.sessionId}`);
                session._nextFrameIsKeyframe = true;
                break;

            case 'version_error':
                // 客户端不支持当前协议版本 — 发送版本不匹配错误
                console.warn(
                    `[server] Protocol version mismatch for ${session.sessionId}. ` +
                    `Server: ${PROTOCOL_VERSION}`
                );
                this._sendError(
                    session.socket,
                    'PROTOCOL_VERSION_MISMATCH',
                    `Server version: ${PROTOCOL_VERSION}`
                );
                break;

            case 'ping':
                // 心跳: 立即回复 pong（保持 WebSocket 连接活跃）
                if (session.socket && session.socket.readyState === 1) {
                    session.socket.send(JSON.stringify({ type: 'pong' }));
                }
                break;

            default:
                console.warn(`[server] Unknown message type from ${session.sessionId}:`, msg.type || msg.event);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 导航处理
    // ═══════════════════════════════════════════════════════════

    /**
     * 处理客户端就绪消息 — 导航到指定 URL。
     *
     * URL 来源: msg.url 或 msg.data（兼容不同客户端版本）。
     * 默认: 'about:blank'（空白页，不做任何外部请求）。
     *
     * 安全考量:
     *   - URL 来自客户端，服务端直接传递给 Chromium
     *   - 本模块不对 URL 做白名单/黑名单校验（该职责属于上层网关）
     *   - Chromium 沙箱内执行，恶意 URL 无法突破沙箱
     *
     * @param {Session} session
     * @param {InputProxy} inputProxy
     * @param {object} msg - 客户端消息（可能包含 url 或 data 字段）
     */
    async _handleReady(session, inputProxy, msg) {
        let url = msg.url || msg.data || 'about:blank';
        // URL 协议白名单: 仅允许 http/https，拒绝 file/javascript/data 等非 Web 协议
        if (!/^https?:\/\//i.test(url) && url !== 'about:blank') {
            console.warn(`[server] Rejected non-web URL: ${url}`);
            url = 'about:blank';
        }
        // SSRF 防御: 拒绝内网地址（localhost, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16）
        if (url !== 'about:blank') {
            try {
                const parsed = new URL(url);
                const hostname = parsed.hostname.toLowerCase();
                // 防御十进制/十六进制/八进制 IP 绕过: 尝试解析为数字 IP
                // 例如: 2130706433 → 127.0.0.1, 0x7f000001 → 127.0.0.1, 0177.0.0.1 → 127.0.0.1
                let resolvedHostname = hostname;
                // 如果是纯数字，尝试转换为 IP（十进制）
                if (/^\d+$/.test(hostname)) {
                    const num = parseInt(hostname, 10);
                    if (num >= 0 && num <= 0xFFFFFFFF) {
                        const a = (num >>> 24) & 0xFF;
                        const b = (num >>> 16) & 0xFF;
                        const c = (num >>> 8) & 0xFF;
                        const d = num & 0xFF;
                        resolvedHostname = `${a}.${b}.${c}.${d}`;
                    }
                }
                // 如果是十六进制 IP (0x...)
                if (/^0x[0-9a-f]+$/i.test(hostname)) {
                    const num = parseInt(hostname, 16);
                    if (num >= 0 && num <= 0xFFFFFFFF) {
                        const a = (num >>> 24) & 0xFF;
                        const b = (num >>> 16) & 0xFF;
                        const c = (num >>> 8) & 0xFF;
                        const d = num & 0xFF;
                        resolvedHostname = `${a}.${b}.${c}.${d}`;
                    }
                }
                // 如果是八进制 IP（以 0 开头且包含点，如 0177.0.0.1）
                // 每段以 0 开头的数字会被解析为八进制
                if (/^0\d*\./.test(hostname)) {
                    const parts = hostname.split('.');
                    const decimalParts = parts.map(p => {
                        if (/^0\d+$/.test(p)) {
                            return parseInt(p, 8);  // 八进制转十进制
                        }
                        return parseInt(p, 10);
                    });
                    if (decimalParts.every(p => p >= 0 && p <= 255) && decimalParts.length === 4) {
                        resolvedHostname = decimalParts.join('.');
                    }
                }
                const blockedPatterns = [
                    /^localhost$/,
                    /^127\./,
                    /^10\./,
                    /^172\.(1[6-9]|2[0-9]|3[01])\./,
                    /^192\.168\./,
                    /^169\.254\./,
                    /^0\./,
                    /^::1$/,
                    /^fc00:/,
                    /^fe80:/,
                    /^\[::1\]$/
                ];
                for (const pattern of blockedPatterns) {
                    if (pattern.test(resolvedHostname) || pattern.test(hostname)) {
                        console.warn(`[server] Rejected internal URL (SSRF protection): ${url} (hostname=${hostname}, resolved=${resolvedHostname})`);
                        url = 'about:blank';
                        break;
                    }
                }
            } catch (e) {
                console.warn(`[server] Invalid URL rejected: ${url}`);
                url = 'about:blank';
            }
        }
        console.log(`[server] Session ${session.sessionId} navigating to: ${url}`);

        try {
            await inputProxy.navigate(url);
        } catch (err) {
            console.error(`[server] Navigation failed:`, err.message);
            this._sendError(session.socket, 'NAVIGATION_FAILED', err.message);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 帧发送 (Chromium → 客户端) (§4 / §6)
    // ═══════════════════════════════════════════════════════════

    /**
     * 向客户端发送帧。
     *
     * 此方法由 Chromium 的 FrameAssembler 回调触发（通过 C++ 桥接）。
     * 帧发送路径:
     *   meta + commandStream → assembleFrame() → compressFrame() → ws.send()
     *
     * 背压处理 (§8):
     *   若 WebSocket 发送缓冲区超过 WS_HIGH_WATER_MARK (1MB):
     *     - 非关键帧: 丢弃（FRAMES_DROPPED 指标递增）
     *     - 关键帧:   强制发送（保证客户端状态一致性）
     *
     * 副作用:
     *   - 指标: FRAMES_SENT / FRAMES_DROPPED
     *   - 帧历史: session.recordFrame() 记录元数据
     *
     * @param {Session} session          - 目标会话
     * @param {object} frameMeta         - 帧元数据
     * @param {Buffer} commandStream     - 命令流字节（已序列化的 PaintOp 列表）
     */
    async sendFrame(session, frameMeta, commandStream) {
        if (session.closed) return;
        const ws = session.socket;
        // readyState === 1 = WebSocket.OPEN
        if (!ws || ws.readyState !== 1) return;

        // 背压检测：如果缓冲区超过高水位，丢弃非关键帧 (§4 / §8)
        if (ws.bufferedAmount > WS_HIGH_WATER_MARK) {
            // 关键帧硬上限：如果缓冲区超过 5 倍高水位（5MB），即使关键帧也丢弃
            // 并关闭连接，防止慢客户端导致 OOM
            if (ws.bufferedAmount > WS_HIGH_WATER_MARK * 5) {
                metrics.counter(FRAMES_DROPPED);
                metrics.counter(WS_ERRORS);
                console.error(
                    `[server] Critical backpressure: closing session ${session.sessionId} ` +
                    `(${ws.bufferedAmount} bytes buffered, limit ${WS_HIGH_WATER_MARK * 5})`
                );
                ws.close(1011, 'Backpressure overload');
                return;
            }
            if (!frameMeta.isKeyframe) {
                // 丢弃非关键帧 — 关键帧必须发送以保证客户端状态同步
                metrics.counter(FRAMES_DROPPED);
                console.warn(
                    `[server] Dropping non-keyframe ${frameMeta.frameId} ` +
                    `due to backpressure (${ws.bufferedAmount} bytes buffered)`
                );
                return;
            }
        }

        try {
            // 组装帧: Header (30B) + CommandStream + CRC32 (4B)
            const frame = assembleFrame(frameMeta, commandStream);

            // gzip 压缩: v1.6 三层 zip bomb 防护 (§6.4)
            const compressed = await compressFrame(frame);

            // 发送二进制帧 — WebSocket binary mode
            ws.send(compressed, { binary: true });
            metrics.counter(FRAMES_SENT);

            // 记录帧元数据到会话历史 — 供输入坐标转换使用 (§7)
            session.recordFrame({
                frameId: frameMeta.frameId,
                timestampMs: frameMeta.timestampMs,
                scrollX: frameMeta.scrollX,
                scrollY: frameMeta.scrollY,
                viewportW: frameMeta.viewportW,
                viewportH: frameMeta.viewportH,
                canvasW: frameMeta.canvasW,
                canvasH: frameMeta.canvasH,
            });

        } catch (err) {
            console.error(`[server] Failed to send frame ${frameMeta.frameId}:`, err.message);
            metrics.counter(FRAMES_DROPPED);
            // 帧组装失败 — 不发送，客户端将看到上一帧的画面
            // 常见失败原因: 压缩炸弹检测、帧大小超限、WebSocket 断开
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 错误消息 (§8)
    // ═══════════════════════════════════════════════════════════

    /**
     * 向客户端发送结构化错误消息。
     *
     * 错误消息格式:
     *   { type: 'error', code: string, message: string, timestamp: number }
     *
     * 在 WebSocket 非 OPEN 状态时静默失败（防止级联错误）。
     *
     * @param {WebSocket} ws - WebSocket 连接
     * @param {string} code    - 错误码（如 'SESSION_INIT_FAILED', 'PROTOCOL_VERSION_MISMATCH'）
     * @param {string} message - 人类可读错误描述
     */
    _sendError(ws, code, message) {
        if (ws && ws.readyState === 1) {
            try {
                ws.send(JSON.stringify({
                    type: 'error',
                    code,
                    message,
                    timestamp: Date.now(),
                }));
            } catch (e) {
                // 忽略发送失败 — 连接可能已断开
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════

// 仅在直接执行时启动服务器（require 时不启动）
if (require.main === module) {
    const port = parseInt(process.env.PORT || '3000', 10);
    const chromiumPath = process.env.CHROMIUM_PATH || 'chromium';

    const server = new WisonRBIServer({
        port,
        chromiumPath,
    });

    server.start().catch(err => {
        console.error('[server] Fatal error:', err);
        process.exit(1);
    });
}

module.exports = WisonRBIServer;
