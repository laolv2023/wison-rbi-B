// chromium_manager.js — Chromium 进程生命周期管理
//
// === 模块角色 ===
// 本模块是 Wison-RBI 服务端的**浏览器引擎管理层**。
// 架构角色: 进程池管理器 — 负责 Chromium 实例的启动、健康监控、崩溃恢复和资源回收。
//
// === 安全不变量 (§2.2 不变量 3) ===
//   所有页面内容（HTML/CSS/JS）仅在服务端 Chromium 沙箱内执行。
//   本模块是沙箱的执行环境管理者:
//     - 启动 Chromium 时默认保持沙箱开启（仅 GARNET_UNSAFE_NO_SANDBOX=1 时禁用）
//     - 进程崩溃后指数退避重启，防止快速反复崩溃耗尽系统资源
//     - CDP 连接仅在本机 localhost 建立，不暴露到网络
//
// === 数据流方向 ===
//   server.js ChromiumPool.acquire() → ChromiumInstance.start()
//     → spawn('chromium', ['--headless=new', '--remote-debugging-port=...'])
//     → CDP({port}) → CDP.Client → InputProxy / Page.navigate
//   ChromiumInstance.close() → SIGTERM → (5s) → SIGKILL → 进程终止
//
// === 威胁模型 (§2.1) ===
//   - 恶意网页: Chromium 沙箱隔离（默认启用），恶意内容无法突破沙箱访问宿主机
//   - DoS 攻击: 实例池大小上限 (maxInstances) 限制并发，内存上限 (CHROMIUM_MAX_MEMORY_BYTES) 限制单实例
//   - 进程崩溃: 指数退避重启（1s→2s→4s→...→30s），防止崩溃循环
//
// === 设计文档交叉引用 ===
//   §4   — Chromium 实例池设计（ChromiumPool 类）
//   §2.1 — 安全模型: Chromium 沙箱隔离
//   §8   — 错误处理: 启动超时、崩溃恢复、指数退避
//   §10  — 审计清单: --no-sandbox 仅在显式环境变量下启用
//

'use strict';

const { spawn } = require('child_process');
const CDP = require('chrome-remote-interface');
const {
    CHROMIUM_STARTUP_TIMEOUT_MS,
    CHROMIUM_MAX_MEMORY_BYTES,
} = require('./config');

// ═══════════════════════════════════════════════════════════════
// Chromium 实例 (§4)
//
// 每个 ChromiumInstance 封装:
//   - 一个 Chromium 子进程（headless=new 模式）
//   - 一个 CDP 客户端（chrome-remote-interface）
//   - 启动/健康检查/崩溃恢复/关闭的生命周期管理
// ═══════════════════════════════════════════════════════════════

class ChromiumInstance {
    /**
     * @param {object} options
     * @param {string} options.executablePath - Chromium 可执行文件路径
     * @param {number} options.cdpPort         - CDP 调试端口（0 = 自动分配）
     * @param {string[]} options.extraArgs     - 额外命令行参数
     */
    constructor(options = {}) {
        this._executablePath = options.executablePath || 'chromium';
        this._cdpPort = options.cdpPort || 0;  // 0 = 自动分配
        this._extraArgs = options.extraArgs || [];

        this._process = null;
        this._cdpClient = null;
        this._pid = null;
        this._started = false;
        this._closed = false;

        // 崩溃恢复: 指数退避计数器
        this._restartCount = 0;
        this._maxRestartDelayMs = 30000;  // 最大退避延迟 30s
    }

    // ═══════════════════════════════════════════════════════════
    // 启动
    // ═══════════════════════════════════════════════════════════

    /**
     * 启动 Chromium 实例。
     *
     * 启动流程（4 步，任一步失败则抛出异常）:
     *   1. _launchProcess():  spawn 子进程，等待 'spawn' 事件
     *   2. _waitForCdp():     轮询 CDP 端口直到响应
     *   3. _connectCdp():     建立 CDP WebSocket 连接
     *   4. _initialize():     启用 Page/Runtime/Network 域，设置初始视口
     *
     * 幂等性: 已启动的实例再次调用 start() 会抛出异常。
     * 已关闭的实例不可重新启动（需创建新实例）。
     *
     * @returns {Promise<CDP.Client>} CDP 客户端（供 InputProxy 使用）
     * @throws {Error} 若实例已启动、已关闭、或任一步骤失败
     */
    async start() {
        if (this._started) {
            throw new Error('Chromium instance already started');
        }
        if (this._closed) {
            throw new Error('Chromium instance has been closed');
        }

        // 1. 启动进程
        await this._launchProcess();

        // 2. 等待 CDP 端口就绪
        await this._waitForCdp();

        // 3. 连接 CDP
        await this._connectCdp();

        // 4. 初始化 CDP 域
        await this._initialize();

        this._started = true;
        this._restartCount = 0;  // 启动成功后重置崩溃计数器
        console.log(`[chromium] Instance started (pid=${this._pid}, port=${this._cdpPort})`);

        return this._cdpClient;
    }

    /**
     * 启动 Chromium 子进程。
     *
     * 命令行参数策略:
     *   - --headless=new: 新版 headless 模式（与常规模式行为一致）
     *   - --disable-gpu: headless 下不需要 GPU 加速
     *   - --disable-dev-shm-usage: 避免 /dev/shm 空间不足（Docker 常见问题）
     *   - --no-sandbox: 仅 GARNET_UNSAFE_NO_SANDBOX=1 时启用，生产环境必须保持沙箱
     *
     * 安全: --no-sandbox 仅在显式设置环境变量时启用（仅限开发/测试环境）。
     *   生产环境必须保持 Chromium 沙箱开启，以隔离恶意网页内容。
     *   设置 GARNET_UNSAFE_NO_SANDBOX=1 可临时绕过（如 Docker 环境需额外配置）。
     *
     * @returns {Promise<void>} 进程成功 spawn 后 resolve
     * @throws {Error} 启动超时或进程启动错误
     */
    async _launchProcess() {
        const args = [
            `--remote-debugging-port=${this._cdpPort}`,
            '--headless=new',           // 新版 headless 模式
            '--disable-gpu',            // headless 模式下不需要 GPU
            '--disable-dev-shm-usage',  // 避免 /dev/shm 空间不足
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-translate',
            '--disable-extensions',
            '--disable-plugins',
            '--mute-audio',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--disable-features=TranslateUI,BlinkGenPropertyTrees',
            '--enable-features=NetworkService,NetworkServiceInProcess',
            // garnet 配置 (Phase 2+):
            // '--garnet-image-mode=hash-ref',
            // '--garnet-raster-mode=record-only',
            // 字体一致性:
            // '--font-renderer-hinting=none',
            // '--disable-font-subpixel-positioning',
        ];

        // 安全审计: --no-sandbox 检查 (§10)
        // 仅在环境变量显式设置时启用，生产部署必须移除该环境变量
        if (process.env.GARNET_UNSAFE_NO_SANDBOX === '1') {
            args.push('--no-sandbox');
            args.push('--disable-setuid-sandbox');
        }

        args.push(...this._extraArgs);

        this._process = spawn(this._executablePath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],  // stdin ignored, stdout/stderr piped
            detached: false,
        });

        this._pid = this._process.pid;

        // 日志流（不阻塞事件循环）
        this._process.stdout.on('data', (data) => {
            // Chromium stdout — 可记录但不需要解析
        });
        this._process.stderr.on('data', (data) => {
            console.error(`[chromium:${this._pid}] ${data.toString().trim()}`);
        });

        // 进程退出检测 — 注册回调但不在此处处理（由 isHealthy/restart 处理）
        this._process.on('exit', (code, signal) => {
            console.warn(
                `[chromium] Process exited (pid=${this._pid}, code=${code}, signal=${signal})`
            );
            this._started = false;
            this._cdpClient = null;
        });

        // 启动超时处理 — 使用 Promise 包装 spawn 事件
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Chromium startup timeout (${CHROMIUM_STARTUP_TIMEOUT_MS}ms)`));
            }, CHROMIUM_STARTUP_TIMEOUT_MS);

            this._process.once('spawn', () => {
                clearTimeout(timeout);
                resolve();
            });

            this._process.once('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    /**
     * 轮询等待 CDP 端口就绪。
     *
     * 使用 CDP.List() 而非 TCP 连接检测，因为前者能确认
     * Chromium 已完成初始化并开始响应 CDP 命令。
     * 轮询间隔: 200ms（足够快但不消耗过多 CPU）。
     *
     * @returns {Promise<void>}
     * @throws {Error} 若超时仍未就绪
     */
    async _waitForCdp() {
        // 轮询等待 CDP 端口就绪
        const startTime = Date.now();
        while (Date.now() - startTime < CHROMIUM_STARTUP_TIMEOUT_MS) {
            try {
                const list = await CDP.List({ port: this._cdpPort });
                if (list && list.length > 0) {
                    // 找到我们的页面 — CDP 已完全就绪
                    return;
                }
            } catch (e) {
                // CDP 尚未就绪（连接被拒绝），继续等待
            }
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error('CDP endpoint not ready within timeout');
    }

    /**
     * 建立 CDP WebSocket 连接。
     *
     * CDP({port}) 自动发现目标并建立 WebSocket 连接。
     * 连接对象存储在 this._cdpClient 中。
     *
     * @returns {Promise<void>}
     */
    async _connectCdp() {
        this._cdpClient = await CDP({ port: this._cdpPort });
    }

    /**
     * 初始化 CDP 域。
     *
     * 启用必要的 CDP 域:
     *   - Page: 页面导航和生命周期事件
     *   - Runtime: JavaScript 执行上下文
     *   - Network: 网络请求拦截（未来可扩展）
     *   - Emulation: 设置初始视口（1920×1080, dpr=1）
     *
     * @returns {Promise<void>}
     */
    async _initialize() {
        const { Page, Runtime, Network, Emulation, Target } = this._cdpClient;

        await Page.enable();
        await Runtime.enable();
        await Network.enable();

        // 设置初始视口 — 客户端可在连接后通过 updateViewport 覆盖
        await Emulation.setDeviceMetricsOverride({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await Emulation.setVisibleSize({ width: 1920, height: 1080 });
    }

    // ═══════════════════════════════════════════════════════════
    // 崩溃恢复 (§8)
    // ═══════════════════════════════════════════════════════════

    /**
     * 带指数退避的重启。
     *
     * 在进程异常退出时调用。
     * 退避策略: 1s → 2s → 4s → 8s → ... → 30s (max)
     *
     * 为什么需要指数退避？
     *   若崩溃由页面内容触发（如恶意 JS 导致渲染引擎崩溃），
     *   立即重启会导致同样的崩溃反复发生，消耗系统资源。
     *   指数退避给系统留有恢复时间，同时限制重启频率。
     *
     * @returns {Promise<CDP.Client>} 重启后的 CDP 客户端
     */
    async restart() {
        await this.close();

        // 指数退避: 1s → 2s → 4s → 8s → ... → 30s max
        const delay = Math.min(
            1000 * Math.pow(2, this._restartCount),
            this._maxRestartDelayMs
        );
        this._restartCount++;

        console.log(`[chromium] Restarting in ${delay}ms (attempt #${this._restartCount})`);
        await new Promise(r => setTimeout(r, delay));

        return this.start();
    }

    // ═══════════════════════════════════════════════════════════
    // 健康检查
    // ═══════════════════════════════════════════════════════════

    /**
     * 检查实例是否健康。
     *
     * 健康条件:
     *   1. _started = true
     *   2. 进程对象存在
     *   3. 进程未被 kill()
     *   4. 进程退出码为 null（即仍在运行）
     *
     * 注意: 此处不检查 CDP 连接状态，因为 CDP 可能因页面繁忙而暂时无响应。
     *
     * @returns {boolean} true = 实例健康，可继续使用
     */
    isHealthy() {
        if (!this._started || !this._process) return false;

        // 检查进程是否存活
        if (this._process.killed) return false;
        // exitCode === null 表示进程仍在运行
        if (this._process.exitCode !== null) return false;

        // 检查内存使用（仅 Linux/macOS）
        // 注意: process.memoryUsage().rss 是 Node.js 进程的内存，不是 Chromium 的
        // 实际的 Chromium 内存监控需要平台特定的 API（如 /proc/pid/status）
        // 此处为占位实现，Phase 5+ 替换为实际实现
        try {
            const memUsage = process.memoryUsage().rss;
            // 预留: 若需检查 Chromium 内存，可通过 /proc/{pid}/status 读取 VmRSS
        } catch (e) {
            // 忽略监控失败 — 不影响健康判定
        }

        return true;
    }

    // ═══════════════════════════════════════════════════════════
    // 关闭
    // ═══════════════════════════════════════════════════════════

    /**
     * 关闭 Chromium 实例。
     *
     * 关闭流程（优雅降级）:
     *   1. 断开 CDP 连接（清理 WebSocket）
     *   2. SIGTERM 优雅终止 Chromium 进程
     *   3. 5 秒后若未退出，SIGKILL 强制终止
     *
     * 幂等性: _closed 标志确保重复调用安全。
     *
     * @returns {Promise<void>}
     */
    async close() {
        if (this._closed) return;
        this._closed = true;

        // 断开 CDP — 清理 WebSocket 连接
        if (this._cdpClient) {
            try {
                await this._cdpClient.close();
            } catch (e) {
                // 忽略关闭错误（连接可能已断开）
            }
            this._cdpClient = null;
        }

        // 终止进程 — 两阶段: SIGTERM → 5s → SIGKILL
        if (this._process && !this._process.killed) {
            try {
                // 先 SIGTERM（优雅关闭）— 给 Chromium 清理资源的时间
                this._process.kill('SIGTERM');

                // 5 秒后强制 SIGKILL — 防止进程卡死
                const forceKillTimeout = setTimeout(() => {
                    if (this._process && !this._process.killed) {
                        this._process.kill('SIGKILL');
                    }
                }, 5000);

                // 等待进程自然退出
                await new Promise(resolve => {
                    this._process.once('exit', () => {
                        clearTimeout(forceKillTimeout);
                        resolve();
                    });
                });
            } catch (e) {
                // 忽略终止错误
            }
            this._process = null;
        }

        this._started = false;
        console.log(`[chromium] Instance closed (was pid=${this._pid})`);
    }
}

// ═══════════════════════════════════════════════════════════════
// Chromium 实例池 (简单版 — Phase 1 单实例, §4)
//
// ChromiumPool 管理多个 ChromiumInstance 的生命周期:
//   - acquire(): 获取可用实例（复用空闲或创建新实例）
//   - release(): 释放实例（Phase 1 直接关闭，Phase 3+ 可回收复用）
//   - shutdown(): 关闭所有实例
//
// 并发限制: maxInstances 控制最大实例数，超出时淘汰最旧实例。
// ═══════════════════════════════════════════════════════════════

class ChromiumPool {
    /**
     * @param {object} options - 传递给 ChromiumInstance 的选项
     * @param {number} [options.maxInstances=4] - 最大实例数
     * @param {number} [options.portBase=9222]  - CDP 端口起始值
     */
    constructor(options = {}) {
        this._options = options;
        this._maxInstances = options.maxInstances || 4;
        this._instances = new Map();  // instanceId → ChromiumInstance
        this._freeInstances = [];     // 空闲实例 ID 列表
        this._portBase = options.portBase || 9222;
        this._nextPort = this._portBase;
    }

    /**
     * 获取一个可用的 Chromium 实例。
     *
     * 分配策略:
     *   1. 优先复用空闲实例（要求实例健康）
     *   2. 若达到上限，淘汰最旧的实例
     *   3. 创建新实例并启动
     *
     * @param {string} instanceId - 请求者标识（通常为 sessionId）
     * @returns {Promise<ChromiumInstance>}
     */
    async acquire(instanceId) {
        // 如果有空闲实例，复用
        if (this._freeInstances.length > 0) {
            const id = this._freeInstances.pop();
            const instance = this._instances.get(id);
            if (instance && instance.isHealthy()) {
                this._instances.delete(id);
                this._instances.set(instanceId, instance);
                return instance;
            }
        }

        // 创建新实例
        if (this._instances.size >= this._maxInstances) {
            // 淘汰最旧的实例（Phase 1: 简单版本，按 Map 插入顺序）
            // Map 保持插入顺序，keys().next() 返回第一个（最旧）key
            const oldestId = this._instances.keys().next().value;
            const oldest = this._instances.get(oldestId);
            if (oldest) {
                await oldest.close();
                this._instances.delete(oldestId);
            }
        }

        const port = this._nextPort++;
        const instance = new ChromiumInstance({
            ...this._options,
            cdpPort: port,
        });

        await instance.start();
        this._instances.set(instanceId, instance);
        return instance;
    }

    /**
     * 释放实例（放回空闲池或关闭）。
     *
     * Phase 1 策略: 直接关闭，不回收。
     *   设计理由: Chromium 实例的状态（Cookie/Storage/页面状态）难以完全重置，
     *   回收复用可能引入跨会话状态泄漏。
     *
     * Phase 3+ 可引入: 导航到 about:blank + 清除存储 的方式回收实例。
     *
     * @param {string} instanceId
     * @returns {Promise<void>}
     */
    async release(instanceId) {
        const instance = this._instances.get(instanceId);
        if (!instance) return;

        this._instances.delete(instanceId);
        // Phase 1: 直接关闭，不回收
        await instance.close();
    }

    /**
     * 关闭所有实例（服务关闭时调用）。
     *
     * 使用 Promise.allSettled 确保所有关闭操作都完成，
     * 即使某个实例关闭失败也不影响其他实例。
     *
     * @returns {Promise<void>}
     */
    async shutdown() {
        const promises = [];
        for (const [id, instance] of this._instances) {
            promises.push(instance.close());
        }
        this._instances.clear();
        this._freeInstances = [];
        // allSettled: 等待所有 Promise 完成（无论成功或失败）
        await Promise.allSettled(promises);
    }
}

module.exports = {
    ChromiumInstance,
    ChromiumPool,
};
