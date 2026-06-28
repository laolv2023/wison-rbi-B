// io_proxy.js — 输入代理 (CDP 注入)
//
// === 模块角色 ===
// 本模块是 Wison-RBI 服务端**输入路径的翻译层**。
// 架构角色: 协议转换器 — 将客户端原始 HID 事件转换为 CDP (Chrome DevTools Protocol) 命令，
//   注入到 Chromium 实例中，实现"用户输入 → 页面响应"的闭环。
//
// === 安全不变量 (§2.2 不变量 2) ===
//   客户端仅发送原始 HID 事件（坐标、键码、修饰符）——不含页面语义信息。
//   本模块将这些 HID 事件转换为 CDP Input 命令——
//   不解析、不推断、不添加页面级语义。
//
//   关键约束:
//   - 不解析 HTML 元素（不做 elementFromPoint 等 DOM 查询）
//   - 不推断用户意图（不根据坐标猜测点击目标）
//   - 仅做纯坐标数学变换（canvas pixels → CSS pixels）
//
// === 数据流方向 ===
//   客户端 WebSocket (JSON HID event)
//     → InputProxy.handleIOEvent() 事件类型分发
//     → _canvasToPage() 坐标转换（方案 B §7）
//     → _sendCommand('Input.dispatchMouseEvent' / 'Input.dispatchKeyEvent')
//     → Chromium CDP → 页面内容响应
//
// === 威胁模型 (§2.1) ===
//   CDP 注入路径的防护:
//   - 坐标值范围检查（在 _canvasToPage 中间接通过 frame 元数据约束）
//   - 修饰键位掩码仅接受标准值（Alt/Ctrl/Meta/Shift）
//   - CDP 命令超时保护（CDP_COMMAND_TIMEOUT_MS=3000ms）
//   - 事件类型白名单（仅 mousemove/mousedown/mouseup/wheel/keydown/keyup）
//
// === 设计文档交叉引用 ===
//   §7     — 方案 B 帧元数据 + 坐标转换（canvas→CSS 坐标映射公式）
//   §4     — IO 代理与 CDP Input 域集成
//   §2.2   — 安全不变量: 输入数据不含页面语义
//   §A1    — SubmitNonPictureLayers: 输入事件转发层
//   §S5    — 侧信道防御: ±1ms 渲染循环随机抖动（Phase 2，客户端的防护，本模块不涉及）
//

'use strict';

const { CDP_COMMAND_TIMEOUT_MS } = require('./config');

class InputProxy {
    /**
     * 创建输入代理实例。
     *
     * @param {object} cdpClient - CDP 客户端实例 (chrome-remote-interface)
     *       提供 .send(method, params) 方法，用于发送 CDP 命令
     * @param {Session} session - 用户会话（提供帧历史以进行坐标转换）
     *       提供 .getNearestFrameMeta(frameId) 和 .recordFrame(meta) 方法
     */
    constructor(cdpClient, session) {
        this._cdp = cdpClient;
        this._session = session;

        // ── 当前视口尺寸 ──
        // 由 updateViewport() 设置，用于设备像素比转换
        this._viewportW = 0;
        this._viewportH = 0;
        this._dpr = 1.0;

        // ── 点击计数（双击检测） ──
        // 500ms 内、2px 范围内的连续点击计为双击/三击
        this._lastClickTime = 0;
        this._lastClickX = 0;
        this._lastClickY = 0;
        this._clickCount = 0;

        // ── 最近的帧引用 ──
        // 记录最近生成的帧的 frame_id，用于 onFrameGenerated 回调
        this._latestFrameId = 0;

        // ── 修饰键状态（用于合成 Input.dispatchKeyEvent 的修饰符）──
        // 位掩码: bit0=Alt, bit1=Ctrl, bit2=Meta, bit3=Shift
        this._modifiers = 0;

        // ── 命令超时 ──
        // CDP 命令的最大等待时间，超时则拒绝 Promise
        this._timeoutMs = CDP_COMMAND_TIMEOUT_MS;
    }

    // ═══════════════════════════════════════════════════════════
    // 视口管理
    // ═══════════════════════════════════════════════════════════

    /**
     * 更新视口尺寸（客户端连接或 resize 时调用）。
     *
     * 通过 CDP Emulation 域设置 Chromium 的设备指标和可见大小。
     * 这会影响:
     *   - 页面布局（CSS 像素 width/height）
     *   - 设备像素比（影响 canvas 物理尺寸 = CSS 尺寸 × dpr）
     *
     * @param {number} width  - CSS 宽度（如 1920）
     * @param {number} height - CSS 高度（如 1080）
     * @param {number} [dpr=1.0] - 设备像素比（如 Retina 为 2.0）
     * @returns {Promise<void>}
     */
    async updateViewport(width, height, dpr = 1.0) {
        // 输入验证: 防止恶意客户端发送非法视口尺寸
        if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(dpr)) {
            console.warn(`[io_proxy] Invalid viewport: w=${width} h=${height} dpr=${dpr}`);
            return;
        }
        // 钳制到合理范围: 1-8192 像素
        width = Math.max(1, Math.min(8192, Math.floor(width)));
        height = Math.max(1, Math.min(8192, Math.floor(height)));
        // DPR 范围: 0.1 - 4.0
        dpr = Math.max(0.1, Math.min(4.0, dpr));

        this._viewportW = width;
        this._viewportH = height;
        this._dpr = dpr;

        try {
            // 设置设备指标: 页面使用指定 CSS 尺寸渲染
            await this._sendCommand('Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: dpr,
                mobile: false,
            });
            // 设置可见大小: 控制 Compositor 的可见区域
            await this._sendCommand('Emulation.setVisibleSize', {
                width,
                height,
            });
        } catch (err) {
            console.error(`[io_proxy] Failed to update viewport:`, err.message);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 帧元数据回调（新帧生成时调用）
    // ═══════════════════════════════════════════════════════════

    /**
     * 帧生成回调 — 更新最新帧引用并记录元数据。
     *
     * 由 server.js 的 sendFrame() 在帧发送后调用。
     * 此处的 frame_id 用于后续输入事件的坐标回溯。
     *
     * @param {object} frameMeta - 帧元数据（包含 frameId/scroll/viewport 等）
     */
    onFrameGenerated(frameMeta) {
        this._latestFrameId = frameMeta.frameId;
        this._session.recordFrame(frameMeta);
    }

    // ═══════════════════════════════════════════════════════════
    // HID 事件处理
    // ═══════════════════════════════════════════════════════════

    /**
     * 处理客户端 IO 事件的主入口。
     *
     * 事件类型白名单: 仅处理以下 6 种类型，其余类型被忽略。
     * 这是安全关键路径 — 不接受任何非白名单事件类型。
     *
     * @param {object} event - 客户端 IO 事件
     * @param {string} event.type    - 事件类型: mousemove|mousedown|mouseup|wheel|keydown|keyup
     * @param {number} event.x       - Canvas X 坐标（物理像素, 相对于 canvas 元素）
     * @param {number} event.y       - Canvas Y 坐标（物理像素, 相对于 canvas 元素）
     * @param {number} event.frameId - 客户端当前帧 ID（用于坐标回溯）
     * @param {number} [event.button] - 鼠标按钮编号: 0=左键 1=中键 2=右键
     * @param {number} [event.deltaX] - 滚轮水平增量
     * @param {number} [event.deltaY] - 滚轮垂直增量
     * @param {string} [event.key]    - 键盘按键值 (如 'a', 'Enter')
     * @param {string} [event.code]   - 键盘物理键码 (如 'KeyA', 'Enter')
     * @param {number} [event.location] - 键盘位置: 0=标准 1=左侧 2=右侧 3=数字键盘
     * @param {boolean} [event.altKey]  - Alt 键是否按下
     * @param {boolean} [event.ctrlKey] - Ctrl 键是否按下
     * @param {boolean} [event.metaKey] - Meta 键是否按下
     * @param {boolean} [event.shiftKey] - Shift 键是否按下
     * @returns {Promise<void>}
     */
    async handleIOEvent(event) {
        // 快速退出: 会话已关闭则不处理任何输入
        if (this._session.closed) return;

        // 防御: 拒绝非对象或空事件
        if (!event || typeof event !== 'object') return;

        const { type, frameId } = event;

        switch (type) {
            case 'mousemove':
                await this._handleMouseMove(event);
                break;
            case 'mousedown':
                await this._handleMouseDown(event);
                break;
            case 'mouseup':
                await this._handleMouseUp(event);
                break;
            case 'wheel':
                await this._handleWheel(event);
                break;
            case 'keydown':
                await this._handleKeyDown(event);
                break;
            case 'keyup':
                await this._handleKeyUp(event);
                break;
            default:
                // 非白名单事件类型 — 记录警告但不阻塞
                console.warn(`[io_proxy] Unknown IO event type: ${type}`);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 坐标转换 (方案 B §7)
    //
    // 坐标系关系:
    //   - Canvas 坐标系: 客户端 <canvas> 元素的物理像素空间 (viewportW*dpr × viewportH*dpr)
    //   - CSS 坐标系:    页面布局坐标空间 (viewportW × viewportH)
    //   - Page 坐标系:   页面绝对坐标 (CSS 坐标 + scroll 偏移)
    //
    // 转换公式:
    //   pageX = scrollX + (canvasX / dpr)
    //   pageY = scrollY + (canvasY / dpr)
    //
    // 使用帧历史中记录的 scroll 偏移量完成 canvas→page 映射。
    // 如果找不到精确帧匹配，向前查找最近的帧。
    // ═══════════════════════════════════════════════════════════════

    /**
     * 将客户端 canvas 坐标转换为页面 CSS 坐标。
     *
     * 坐标系关系:
     *   pageX = scrollX + (canvasX / dpr)
     *   pageY = scrollY + (canvasY / dpr)
     *
     * 使用帧历史中记录的 scroll 偏移量。
     * 如果找不到精确帧匹配，向前查找最近的帧。
     *
     * 边界条件:
     *   - frameId 不存在于帧历史 → valid=false, 使用当前 viewport 和假定 scroll=0
     *     这会导致输入偏移，但好于拒绝输入（可用性优先）
     *   - dpr ≤ 0 的防御: Math.max(this._dpr, 1) 防止除以零
     *
     * @param {number} canvasX - 客户端 canvas X (物理像素)
     * @param {number} canvasY - 客户端 canvas Y (物理像素)
     * @param {number} frameId - 客户端引用的帧 ID
     * @returns {{ pageX: number, pageY: number, valid: boolean }}
     *   - pageX/pageY: 页面 CSS 坐标
     *   - valid: 是否精确匹配到帧（false 表示使用了近似/回退坐标）
     */
    _canvasToPage(canvasX, canvasY, frameId) {
        const meta = this._session.getNearestFrameMeta(frameId);
        if (!meta) {
            // 帧历史中没有匹配的帧（可能已过期）
            // 使用当前已知的 viewport 和假定 scroll=0
            // valid=false 标记坐标精度降低
            return {
                pageX: canvasX / Math.max(this._dpr, 1),
                pageY: canvasY / Math.max(this._dpr, 1),
                valid: false,
            };
        }

        return {
            // 核心转换公式: canvas物理像素 / dpr + scroll偏移 = 页面CSS坐标
            // 边界钳制: 限制在合理视口范围 ±100px 内，防止异常坐标注入
            pageX: Math.max(-100, Math.min(meta.viewportW + 100,
                meta.scrollX + canvasX / Math.max(this._dpr, 1))),
            pageY: Math.max(-100, Math.min(meta.viewportH + 100,
                meta.scrollY + canvasY / Math.max(this._dpr, 1))),
            valid: true,
        };
    }

    // ═══════════════════════════════════════════════════════════
    // 鼠标事件
    // ═══════════════════════════════════════════════════════════

    /**
     * 处理鼠标移动事件。
     *
     * CDP 'mouseMoved' 类型: 发送坐标（integer CSS px）和修饰键状态。
     * 注意: 坐标使用 Math.round 取整 — CDP 不接受浮点坐标。
     *
     * @param {object} event - HID 事件
     * @returns {Promise<void>}
     */
    async _handleMouseMove(event) {
        // 输入验证: x/y 必须为有限数字
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
        const { pageX, pageY } = this._canvasToPage(event.x, event.y, event.frameId);
        await this._sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(pageX),
            y: Math.round(pageY),
            modifiers: this._modifiers,
        });
    }

    /**
     * 处理鼠标按下事件。
     *
     * 双击检测逻辑:
     *   - 时间窗口: 500ms 内
     *   - 空间窗口: 2px 范围内
     *   - clickCount 上限为 3（超过三击仍计为 3）
     *
     * @param {object} event - HID 事件
     * @returns {Promise<void>}
     */
    async _handleMouseDown(event) {
        // 输入验证: x/y 必须为有限数字
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
        const { pageX, pageY } = this._canvasToPage(event.x, event.y, event.frameId);

        // 双击检测（500ms 内，2px 范围内）
        // 注意: 使用 canvas 坐标而非 page 坐标做比较，
        //   因为两次点击之间的 scroll 可能已变化
        const now = Date.now();
        if (
            now - this._lastClickTime < 500 &&
            Math.abs(event.x - this._lastClickX) < 2 &&
            Math.abs(event.y - this._lastClickY) < 2
        ) {
            this._clickCount = Math.min(this._clickCount + 1, 3);
        } else {
            this._clickCount = 1;
        }
        this._lastClickTime = now;
        this._lastClickX = event.x;
        this._lastClickY = event.y;

        await this._sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: Math.round(pageX),
            y: Math.round(pageY),
            button: this._mapButton(event.button),
            clickCount: this._clickCount,
            modifiers: this._modifiers,
        });
    }

    /**
     * 处理鼠标释放事件。
     *
     * clickCount 继承自 _handleMouseDown 设置的值，
     * 保证 mousedown/mouseup 的 clickCount 一致。
     *
     * @param {object} event - HID 事件
     * @returns {Promise<void>}
     */
    async _handleMouseUp(event) {
        // 输入验证: x/y 必须为有限数字
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
        const { pageX, pageY } = this._canvasToPage(event.x, event.y, event.frameId);

        await this._sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: Math.round(pageX),
            y: Math.round(pageY),
            button: this._mapButton(event.button),
            clickCount: this._clickCount,
            modifiers: this._modifiers,
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 滚轮事件
    // ═══════════════════════════════════════════════════════════

    /**
     * 处理滚轮事件。
     *
     * CDP 使用 Input.dispatchMouseEvent 的 'mouseWheel' 类型。
     * deltaX/deltaY 单位为"像素"，由浏览器解释并转换为实际滚动距离。
     *
     * @param {object} event - HID 事件（含 deltaX/deltaY 字段）
     * @returns {Promise<void>}
     */
    async _handleWheel(event) {
        // 输入验证: x/y 必须为有限数字
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
        const { pageX, pageY } = this._canvasToPage(event.x, event.y, event.frameId);

        // CDP Input.dispatchMouseEvent 的 mouseWheel 类型
        await this._sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Math.round(pageX),
            y: Math.round(pageY),
            deltaX: Number.isFinite(event.deltaX) ? event.deltaX : 0,
            deltaY: Number.isFinite(event.deltaY) ? event.deltaY : 0,
            modifiers: this._modifiers,
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 键盘事件
    // ═══════════════════════════════════════════════════════════

    /**
     * 处理键盘按下事件。
     *
     * 步骤:
     *   1. 更新修饰键状态（如果按下的键是 Alt/Ctrl/Meta/Shift）
     *   2. 发送 CDP keyDown 事件
     *
     * text 字段: 仅当 key 是单个可打印字符时传递，用于文本输入。
     *
     * @param {object} event - HID 键盘事件
     * @returns {Promise<void>}
     */
    async _handleKeyDown(event) {
        // 更新修饰键状态 — 必须在发送事件前更新
        this._updateModifiers(event, true);

        // 防御: event.key 可能为 null/undefined/非字符串（恶意或异常客户端）
        const keyStr = typeof event.key === 'string' ? event.key : '';
        const codeStr = typeof event.code === 'string' ? event.code : '';

        await this._sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: keyStr,
            code: codeStr,
            location: event.location || 0,
            modifiers: this._modifiers,
            isKeypad: event.location === 3,  // location=3 = 数字键盘
            // text: 仅可打印单字符传递，用于文本输入合成
            text: keyStr.length === 1 ? keyStr : undefined,
        });
    }

    /**
     * 处理键盘释放事件。
     *
     * 修饰键在 keyUp 时才清除 —— 保证 keyDown/keyUp 之间修饰键状态一致。
     *
     * @param {object} event - HID 键盘事件
     * @returns {Promise<void>}
     */
    async _handleKeyUp(event) {
        this._updateModifiers(event, false);

        // 防御: event.key 可能为 null/undefined/非字符串
        const keyStr = typeof event.key === 'string' ? event.key : '';
        const codeStr = typeof event.code === 'string' ? event.code : '';

        await this._sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: keyStr,
            code: codeStr,
            location: event.location || 0,
            modifiers: this._modifiers,
            isKeypad: event.location === 3,
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 辅助方法
    // ═══════════════════════════════════════════════════════════

    /**
     * 映射客户端按钮编号到 CDP 按钮名称。
     *
     * 客户端: 0=左键, 1=中键, 2=右键
     * CDP:    'left', 'middle', 'right'
     *
     * 默认回退为 'left' — 防御性处理未知按钮编号。
     *
     * @param {number} button - 客户端按钮编号
     * @returns {string} CDP 按钮名称
     */
    _mapButton(button) {
        switch (button) {
            case 0: return 'left';
            case 1: return 'middle';
            case 2: return 'right';
            default: return 'left';  // 未知按钮 → 默认左键
        }
    }

    /**
     * 更新修饰键位掩码。
     *
     * CDP modifiers 位掩码:
     *   1 = Alt, 2 = Ctrl, 4 = Meta (Win/Cmd), 8 = Shift
     *
     * 这些值与 W3C UI Events 规范一致。
     * 按压时 OR 置位，释放时 AND NOT 清零。
     *
     * @param {object} event - HID 事件（含 altKey/ctrlKey/metaKey/shiftKey 布尔字段）
     * @param {boolean} pressed - true=按下, false=释放
     */
    _updateModifiers(event, pressed) {
        const MOD_ALT = 1;
        const MOD_CTRL = 2;
        const MOD_META = 4;
        const MOD_SHIFT = 8;

        const { altKey, ctrlKey, metaKey, shiftKey } = event;
        const mask =
            (altKey ? MOD_ALT : 0) |
            (ctrlKey ? MOD_CTRL : 0) |
            (metaKey ? MOD_META : 0) |
            (shiftKey ? MOD_SHIFT : 0);

        if (pressed) {
            this._modifiers |= mask;     // 置位: 不覆盖其他已按下的修饰键
        } else {
            this._modifiers &= ~mask;    // 清零: 仅清除当前释放的修饰键
        }
    }

    /**
     * 发送 CDP 命令（带超时保护）。
     *
     * 包装 chrome-remote-interface 的 .send() 方法，添加超时拒绝。
     * 超时值: CDP_COMMAND_TIMEOUT_MS (默认 3000ms)
     *
     * 为什么需要超时？
     *   CDP 命令可能因 Chromium 进程卡死/繁忙而无限挂起，
     *   没有超时会阻塞整个输入代理的消息处理循环。
     *
     * @param {string} method - CDP 方法名（如 'Input.dispatchMouseEvent'）
     * @param {object} params - CDP 方法参数
     * @returns {Promise<any>} CDP 命令结果
     * @throws {Error} 超时或 CDP 命令执行失败
     */
    async _sendCommand(method, params) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`CDP command timeout: ${method}`));
            }, this._timeoutMs);

            this._cdp.send(method, params)
                .then(result => {
                    clearTimeout(timer);
                    resolve(result);
                })
                .catch(err => {
                    clearTimeout(timer);
                    reject(err);
                });
        });
    }

    /**
     * 导航到指定 URL。
     *
     * 先启用 Page 域（幂等操作），然后执行导航。
     *
     * @param {string} url - 目标 URL
     * @returns {Promise<void>}
     * @throws {Error} 导航失败时向上抛出
     */
    async navigate(url) {
        try {
            // Page.enable 是幂等的 — 多次调用安全
            await this._sendCommand('Page.enable');
            await this._sendCommand('Page.navigate', { url });
        } catch (err) {
            console.error(`[io_proxy] Navigation failed:`, err.message);
            throw err;
        }
    }
}

module.exports = InputProxy;
