// io_proxy.js — 输入代理 (CDP 注入)
//
// 将客户端的原始 HID 事件转换为 CDP (Chrome DevTools Protocol) 命令，
// 注入到 Chromium 实例中。
//
// 安全不变量:
//   客户端仅发送原始 HID 事件（坐标、键码、修饰符）——不含页面语义信息。
//   本模块将这些 HID 事件转换为 CDP Input 命令——
//   不解析、不推断、不添加页面级语义。
//
// 坐标转换 (方案 B §7):
//   客户端发送的坐标相对于其当前帧的 canvas。
//   通过帧历史中的 scroll 偏移量和 viewport 尺寸，
//   将 canvas 坐标映射回页面的 CSS 坐标。
//

'use strict';

const { CDP_COMMAND_TIMEOUT_MS } = require('./config');

class InputProxy {
    /**
     * @param {object} cdpClient - CDP 客户端实例 (chrome-remote-interface)
     * @param {Session} session - 用户会话（提供帧历史）
     */
    constructor(cdpClient, session) {
        this._cdp = cdpClient;
        this._session = session;

        // ── 当前视口尺寸 ──
        this._viewportW = 0;
        this._viewportH = 0;
        this._dpr = 1.0;

        // ── 点击计数（双击检测） ──
        this._lastClickTime = 0;
        this._lastClickX = 0;
        this._lastClickY = 0;
        this._clickCount = 0;

        // ── 最近的帧引用 ──
        this._latestFrameId = 0;

        // ── 修饰键状态（用于合成 Input.dispatchKeyEvent 的修饰符）──
        this._modifiers = 0;

        // ── 命令超时 ──
        this._timeoutMs = CDP_COMMAND_TIMEOUT_MS;
    }

    // ═══════════════════════════════════════════════════════════
    // 视口管理
    // ═══════════════════════════════════════════════════════════

    /**
     * 更新视口尺寸（客户端连接或 resize 时调用）。
     * @param {number} width - CSS 宽度
     * @param {number} height - CSS 高度
     * @param {number} dpr - 设备像素比
     */
    async updateViewport(width, height, dpr = 1.0) {
        this._viewportW = width;
        this._viewportH = height;
        this._dpr = dpr;

        try {
            await this._sendCommand('Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: dpr,
                mobile: false,
            });
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

    onFrameGenerated(frameMeta) {
        this._latestFrameId = frameMeta.frameId;
        this._session.recordFrame(frameMeta);
    }

    // ═══════════════════════════════════════════════════════════
    // HID 事件处理
    // ═══════════════════════════════════════════════════════════

    /**
     * 处理客户端 IO 事件。
     *
     * @param {object} event - 客户端 IO 事件
     * @param {string} event.type - 事件类型
     * @param {number} event.x - Canvas X 坐标
     * @param {number} event.y - Canvas Y 坐标
     * @param {number} event.frameId - 客户端当前帧 ID
     */
    async handleIOEvent(event) {
        if (this._session.closed) return;

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
                console.warn(`[io_proxy] Unknown IO event type: ${type}`);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 坐标转换 (方案 B)
    // ═══════════════════════════════════════════════════════════

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
     * @param {number} canvasX - 客户端 canvas X (物理像素)
     * @param {number} canvasY - 客户端 canvas Y (物理像素)
     * @param {number} frameId - 客户端引用的帧 ID
     * @returns {{ pageX: number, pageY: number, valid: boolean }}
     */
    _canvasToPage(canvasX, canvasY, frameId) {
        const meta = this._session.getNearestFrameMeta(frameId);
        if (!meta) {
            // 帧历史中没有匹配的帧（可能已过期）
            // 使用当前已知的 viewport 和假定 scroll=0
            return {
                pageX: canvasX / Math.max(this._dpr, 1),
                pageY: canvasY / Math.max(this._dpr, 1),
                valid: false,
            };
        }

        return {
            pageX: meta.scrollX + canvasX / Math.max(this._dpr, 1),
            pageY: meta.scrollY + canvasY / Math.max(this._dpr, 1),
            valid: true,
        };
    }

    // ═══════════════════════════════════════════════════════════
    // 鼠标事件
    // ═══════════════════════════════════════════════════════════

    async _handleMouseMove(event) {
        const { pageX, pageY } = this._canvasToPage(event.x, event.y, event.frameId);
        await this._sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(pageX),
            y: Math.round(pageY),
            modifiers: this._modifiers,
        });
    }

    async _handleMouseDown(event) {
        const { pageX, pageY } = this._canvasToPage(event.x, event.y, event.frameId);

        // 双击检测（500ms 内，2px 范围内）
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

    async _handleMouseUp(event) {
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

    async _handleWheel(event) {
        const { pageX, pageY } = this._canvasToPage(event.x, event.y, event.frameId);

        // CDP Input.dispatchMouseEvent 的 mouseWheel 类型
        await this._sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Math.round(pageX),
            y: Math.round(pageY),
            deltaX: event.deltaX || 0,
            deltaY: event.deltaY || 0,
            modifiers: this._modifiers,
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 键盘事件
    // ═══════════════════════════════════════════════════════════

    async _handleKeyDown(event) {
        // 更新修饰键状态
        this._updateModifiers(event, true);

        await this._sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: event.key,
            code: event.code,
            location: event.location || 0,
            modifiers: this._modifiers,
            isKeypad: event.location === 3,
            text: event.key.length === 1 ? event.key : undefined,
        });
    }

    async _handleKeyUp(event) {
        this._updateModifiers(event, false);

        await this._sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: event.key,
            code: event.code,
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
     * 客户端: 0=左键, 1=中键, 2=右键
     * CDP: 'left', 'middle', 'right'
     */
    _mapButton(button) {
        switch (button) {
            case 0: return 'left';
            case 1: return 'middle';
            case 2: return 'right';
            default: return 'left';
        }
    }

    /**
     * 更新修饰键位掩码。
     * CDP modifiers 位掩码:
     *   1 = Alt, 2 = Ctrl, 4 = Meta, 8 = Shift
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
            this._modifiers |= mask;
        } else {
            this._modifiers &= ~mask;
        }
    }

    /**
     * 发送 CDP 命令（带超时）。
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
     * @param {string} url
     */
    async navigate(url) {
        try {
            await this._sendCommand('Page.enable');
            await this._sendCommand('Page.navigate', { url });
        } catch (err) {
            console.error(`[io_proxy] Navigation failed:`, err.message);
            throw err;
        }
    }
}

module.exports = InputProxy;
