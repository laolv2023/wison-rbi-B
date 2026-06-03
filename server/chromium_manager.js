// chromium_manager.js — Chromium 进程生命周期管理
//
// 职责:
//   1. 启动 Chromium 实例（headless, CDP 端口）
//   2. 监控进程健康（崩溃检测、重启）
//   3. 资源管理（内存监控、实例池）
//   4. 崩溃恢复（指数退避重启）
//

'use strict';

const { spawn } = require('child_process');
const CDP = require('chrome-remote-interface');
const {
    CHROMIUM_STARTUP_TIMEOUT_MS,
    CHROMIUM_MAX_MEMORY_BYTES,
} = require('./config');

// ═══════════════════════════════════════════════════════════════
// Chromium 实例
// ═══════════════════════════════════════════════════════════════

class ChromiumInstance {
    /**
     * @param {object} options
     * @param {string} options.executablePath - Chromium 可执行文件路径
     * @param {number} options.cdpPort - CDP 调试端口
     * @param {string[]} options.extraArgs - 额外命令行参数
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

        // 崩溃恢复
        this._restartCount = 0;
        this._maxRestartDelayMs = 30000;  // 最大退避延迟 30s
    }

    // ═══════════════════════════════════════════════════════════
    // 启动
    // ═══════════════════════════════════════════════════════════

    /**
     * 启动 Chromium 实例。
     * @returns {Promise<CDP.Client>} CDP 客户端
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

        // 4. 初始化
        await this._initialize();

        this._started = true;
        this._restartCount = 0;
        console.log(`[chromium] Instance started (pid=${this._pid}, port=${this._cdpPort})`);

        return this._cdpClient;
    }

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
            // garnet 配置:
            // '--garnet-image-mode=hash-ref',
            // '--garnet-raster-mode=record-only',
            // 字体一致性:
            // '--font-renderer-hinting=none',
            // '--disable-font-subpixel-positioning',
        ];

        // 安全: --no-sandbox 仅在显式设置环境变量时启用（仅限开发/测试环境）
        // 生产环境必须保持 Chromium 沙箱开启，以隔离恶意网页内容。
        // 设置 GARNET_UNSAFE_NO_SANDBOX=1 可临时绕过（如 Docker 环境需额外配置）。
        if (process.env.GARNET_UNSAFE_NO_SANDBOX === '1') {
            args.push('--no-sandbox');
            args.push('--disable-setuid-sandbox');
        }

        args.push(...this._extraArgs);
        ];

        this._process = spawn(this._executablePath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        this._pid = this._process.pid;

        // 日志流（不阻塞）
        this._process.stdout.on('data', (data) => {
            // Chromium stdout — 可记录但不需要解析
        });
        this._process.stderr.on('data', (data) => {
            console.error(`[chromium:${this._pid}] ${data.toString().trim()}`);
        });

        // 进程退出检测
        this._process.on('exit', (code, signal) => {
            console.warn(
                `[chromium] Process exited (pid=${this._pid}, code=${code}, signal=${signal})`
            );
            this._started = false;
            this._cdpClient = null;
        });

        // 启动超时处理
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

    async _waitForCdp() {
        // 轮询等待 CDP 端口就绪
        const startTime = Date.now();
        while (Date.now() - startTime < CHROMIUM_STARTUP_TIMEOUT_MS) {
            try {
                const list = await CDP.List({ port: this._cdpPort });
                if (list && list.length > 0) {
                    // 找到我们的页面
                    return;
                }
            } catch (e) {
                // CDP 尚未就绪，继续等待
            }
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error('CDP endpoint not ready within timeout');
    }

    async _connectCdp() {
        this._cdpClient = await CDP({ port: this._cdpPort });
    }

    async _initialize() {
        const { Page, Runtime, Network, Emulation, Target } = this._cdpClient;

        await Page.enable();
        await Runtime.enable();
        await Network.enable();

        // 设置初始视口
        await Emulation.setDeviceMetricsOverride({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await Emulation.setVisibleSize({ width: 1920, height: 1080 });
    }

    // ═══════════════════════════════════════════════════════════
    // 崩溃恢复
    // ═══════════════════════════════════════════════════════════

    /**
     * 带指数退避的重启。
     * 在进程异常退出时调用。
     * @returns {Promise<CDP.Client>}
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
     * @returns {boolean}
     */
    isHealthy() {
        if (!this._started || !this._process) return false;

        // 检查进程是否存活
        if (this._process.killed) return false;
        if (this._process.exitCode !== null) return false;

        // 检查内存使用（仅 Linux/macOS）
        try {
            const memUsage = process.memoryUsage().rss; // 这是 Node.js 进程的，不是 Chromium 的
            // 实际的 Chromium 内存监控需要平台特定的 API
            // 此处为占位实现
        } catch (e) {
            // 忽略监控失败
        }

        return true;
    }

    // ═══════════════════════════════════════════════════════════
    // 关闭
    // ═══════════════════════════════════════════════════════════

    /**
     * 关闭 Chromium 实例。
     */
    async close() {
        if (this._closed) return;
        this._closed = true;

        // 断开 CDP
        if (this._cdpClient) {
            try {
                await this._cdpClient.close();
            } catch (e) {
                // 忽略关闭错误
            }
            this._cdpClient = null;
        }

        // 终止进程
        if (this._process && !this._process.killed) {
            try {
                // 先 SIGTERM（优雅关闭）
                this._process.kill('SIGTERM');

                // 5 秒后强制 SIGKILL
                const forceKillTimeout = setTimeout(() => {
                    if (this._process && !this._process.killed) {
                        this._process.kill('SIGKILL');
                    }
                }, 5000);

                await new Promise(resolve => {
                    this._process.once('exit', () => {
                        clearTimeout(forceKillTimeout);
                        resolve();
                    });
                });
            } catch (e) {
                // 忽略
            }
            this._process = null;
        }

        this._started = false;
        console.log(`[chromium] Instance closed (was pid=${this._pid})`);
    }
}

// ═══════════════════════════════════════════════════════════════
// Chromium 实例池 (简单版 — Phase 1 单实例)
// ═══════════════════════════════════════════════════════════════

class ChromiumPool {
    /**
     * @param {object} options - 传递给 ChromiumInstance 的选项
     * @param {number} [options.maxInstances=4] - 最大实例数
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
     * @param {string} instanceId - 请求者标识
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
            // 淘汰最旧的实例（Phase 1: 简单版本）
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
     * @param {string} instanceId
     */
    async release(instanceId) {
        const instance = this._instances.get(instanceId);
        if (!instance) return;

        this._instances.delete(instanceId);
        // Phase 1: 直接关闭，不回收
        await instance.close();
    }

    /**
     * 关闭所有实例。
     */
    async shutdown() {
        const promises = [];
        for (const [id, instance] of this._instances) {
            promises.push(instance.close());
        }
        this._instances.clear();
        this._freeInstances = [];
        await Promise.allSettled(promises);
    }
}

module.exports = {
    ChromiumInstance,
    ChromiumPool,
};
