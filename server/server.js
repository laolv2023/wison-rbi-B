// server.js — Wison-RBI 服务端主入口
//
// 职责:
//   1. WebSocket 服务（接收客户端连接）
//   2. 会话生命周期管理
//   3. Chromium 实例池管理
//   4. 帧路由（Chromium → 客户端）
//   5. 输入路由（客户端 → Chromium）
//
// 安全不变量:
//   - 不向客户端传输 HTML/CSS/JS
//   - 输入事件仅做坐标转换，不解析页面语义
//   - 所有帧经过 CRC32 校验和组装
//

'use strict';

const http = require('http');
const { Server: WsServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { ChromiumPool } = require('./chromium_manager');
const Session = require('./session');
const InputProxy = require('./io_proxy');
const { assembleFrame, compressFrame } = require('./frame_builder');
const { isSafeFontData } = require('./font_validator');
const { WS_HIGH_WATER_MARK, PROTOCOL_VERSION } = require('./config');

// ═══════════════════════════════════════════════════════════════
// WisonRBI Server
// ═══════════════════════════════════════════════════════════════

class WisonRBIServer {
    /**
     * @param {object} [options]
     * @param {number} [options.port=3000] - HTTP/WebSocket 端口
     * @param {string} [options.chromiumPath] - Chromium 可执行路径
     * @param {number} [options.maxSessions=4] - 最大并发会话数
     */
    constructor(options = {}) {
        this._port = options.port || 3000;
        this._chromiumPath = options.chromiumPath || 'chromium';
        this._maxSessions = options.maxSessions || 4;

        // ── HTTP Server (WebSocket 需要升级) ──
        this._httpServer = http.createServer((req, res) => {
            // 健康检查端点
            if (req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    sessions: this._sessions.size,
                    uptime: process.uptime(),
                }));
                return;
            }
            res.writeHead(404);
            res.end();
        });

        // ── WebSocket Server ──
        this._wsServer = new WsServer({
            server: this._httpServer,
            maxPayload: 64 * 1024 * 1024,  // 64MB (与 MAX_BYTES_PER_FRAME 一致)
        });

        // ── 会话管理 ──
        this._sessions = new Map();  // sessionId → Session

        // ── Chromium 实例池 ──
        this._chromiumPool = new ChromiumPool({
            executablePath: this._chromiumPath,
            maxInstances: this._maxSessions,
        });

        // ── 绑定 WebSocket 事件 ──
        this._wsServer.on('connection', (ws, req) => this._onConnection(ws, req));
        this._wsServer.on('error', (err) => {
            console.error('[server] WebSocket server error:', err.message);
        });

        // ── 优雅关闭 ──
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
    }

    // ═══════════════════════════════════════════════════════════
    // 启动/关闭
    // ═══════════════════════════════════════════════════════════

    async start() {
        return new Promise((resolve) => {
            this._httpServer.listen(this._port, () => {
                console.log(`[server] Wison-RBI server listening on port ${this._port}`);
                resolve();
            });
        });
    }

    async shutdown() {
        console.log('[server] Shutting down...');

        // 关闭所有 WebSocket 连接
        for (const [id, session] of this._sessions) {
            session.close();
        }
        this._sessions.clear();

        // 关闭所有 Chromium 实例
        await this._chromiumPool.shutdown();

        // 关闭 HTTP Server
        this._wsServer.close();
        this._httpServer.close();

        console.log('[server] Shutdown complete');
        process.exit(0);
    }

    // ═══════════════════════════════════════════════════════════
    // WebSocket 连接处理
    // ═══════════════════════════════════════════════════════════

    async _onConnection(ws, req) {
        const sessionId = uuidv4();
        console.log(`[server] New connection: ${sessionId} (from ${req.socket.remoteAddress})`);

        // 创建会话
        const session = new Session(sessionId);
        session.socket = ws;
        this._sessions.set(sessionId, session);

        let inputProxy = null;
        let cdpClient = null;

        try {
            // 获取 Chromium 实例
            const chromium = await this._chromiumPool.acquire(sessionId);
            session.chromium = chromium;

            // 获取 CDP 客户端
            cdpClient = chromium._cdpClient;
            if (!cdpClient) {
                throw new Error('Chromium instance has no CDP client');
            }

            // 创建输入代理
            inputProxy = new InputProxy(cdpClient, session);

        } catch (err) {
            console.error(`[server] Failed to initialize session ${sessionId}:`, err.message);
            this._sendError(ws, 'SESSION_INIT_FAILED', err.message);
            session.close();
            this._sessions.delete(sessionId);
            return;
        }

        // ── 消息处理 ──
        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                await this._handleMessage(session, inputProxy, msg);
            } catch (err) {
                // 非 JSON 消息（可能是二进制帧相关？）— 忽略
                if (err instanceof SyntaxError) {
                    console.warn(`[server] Non-JSON message from ${sessionId}`);
                } else {
                    console.error(`[server] Message handling error:`, err.message);
                }
            }
        });

        // ── 连接关闭 ──
        ws.on('close', (code, reason) => {
            console.log(`[server] Connection closed: ${sessionId} (code=${code})`);
            clearInterval(backpressureInterval);
            session.close();
            this._sessions.delete(sessionId);
            this._chromiumPool.release(sessionId).catch(err => {
                console.error(`[server] Error releasing chromium:`, err.message);
            });
        });

        // ── 错误处理 ──
        ws.on('error', (err) => {
            console.error(`[server] WebSocket error for ${sessionId}:`, err.message);
        });

        // ── 背压监控 ──
        const backpressureInterval = setInterval(() => {
            if (session.closed) return;
            if (ws.bufferedAmount > WS_HIGH_WATER_MARK) {
                console.warn(
                    `[server] Backpressure for ${sessionId}: ` +
                    `${ws.bufferedAmount} bytes buffered`
                );
            }
        }, 5000);
    }

    // ═══════════════════════════════════════════════════════════
    // 消息路由
    // ═══════════════════════════════════════════════════════════

    async _handleMessage(session, inputProxy, msg) {
        if (session.closed) return;

        switch (msg.type || msg.event) {
            case 'ready':
                await this._handleReady(session, inputProxy, msg);
                break;

            case 'viewport':
                await inputProxy.updateViewport(
                    msg.width,
                    msg.height,
                    msg.devicePixelRatio || 1.0
                );
                break;

            case 'io':
                await inputProxy.handleIOEvent(msg);
                break;

            case 'request_keyframe':
                // 客户端请求关键帧（v1.6: 白名单连续拒绝≥3帧触发）
                console.log(`[server] Keyframe requested by ${session.sessionId}`);
                // 下一帧将标记为 keyframe
                session._nextFrameIsKeyframe = true;
                break;

            case 'version_error':
                // 客户端不支持当前协议版本
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
                if (session.socket && session.socket.readyState === 1) {
                    session.socket.send(JSON.stringify({ type: 'pong' }));
                }
                break;

            default:
                console.warn(`[server] Unknown message type from ${session.sessionId}:`, msg.type || msg.event);
        }
    }

    // ═══════════════════════════════════════════════════════════

    async _handleReady(session, inputProxy, msg) {
        const url = msg.url || msg.data || 'about:blank';
        console.log(`[server] Session ${session.sessionId} navigating to: ${url}`);

        try {
            await inputProxy.navigate(url);
        } catch (err) {
            console.error(`[server] Navigation failed:`, err.message);
            this._sendError(session.socket, 'NAVIGATION_FAILED', err.message);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 帧发送 (Chromium → 客户端)
    // ═══════════════════════════════════════════════════════════

    /**
     * 向客户端发送帧。
     * 此方法由 Chromium 的 FrameAssembler 回调触发（通过 C++ 桥接）。
     *
     * @param {Session} session
     * @param {object} frameMeta - 帧元数据
     * @param {Buffer} commandStream - 命令流
     */
    async sendFrame(session, frameMeta, commandStream) {
        if (session.closed) return;
        const ws = session.socket;
        if (!ws || ws.readyState !== 1) return;

        // 背压检测：如果缓冲区超过高水位，丢弃非关键帧
        if (ws.bufferedAmount > WS_HIGH_WATER_MARK) {
            if (!frameMeta.isKeyframe) {
                // 丢弃非关键帧
                console.warn(
                    `[server] Dropping non-keyframe ${frameMeta.frameId} ` +
                    `due to backpressure (${ws.bufferedAmount} bytes buffered)`
                );
                return;
            }
        }

        try {
            // 组装帧
            const frame = assembleFrame(frameMeta, commandStream);

            // gzip 压缩 (v1.6 三层防护)
            const compressed = await compressFrame(frame);

            // 发送二进制帧
            ws.send(compressed, { binary: true });

            // 记录帧元数据到会话历史
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
            // 帧组装失败 — 不发送
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 错误消息
    // ═══════════════════════════════════════════════════════════

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
                // 忽略发送失败
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════

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
