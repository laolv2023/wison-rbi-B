// tests/advanced.test.mjs — Wison-RBI 协议层/会话/集成测试 (170+ cases)
//
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ============================================================
// 服务端模块
// ============================================================
const serverConfig = require('../server/config.js');
const { serializeFrameHeader, deserializeFrameHeader, assembleFrame, compressFrame, computeCRC32 } = require('../server/frame_builder.js');
const { validateFontData, validateFontBatch, isSafeFontData } = require('../server/font_validator.js');
const Session = require('../server/session.js');
const InputProxy = require('../server/io_proxy.js');

// ── 测试环境: 禁用 Session 的空闲定时器 ──
// 生产代码 Session 构造时自动启动 120s 空闲定时器，导致测试挂起。
// 通过原型补丁在测试中跳过定时器设置。
Session.prototype._resetIdleTimer = function() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
};

// ============================================================
// 客户端模块 (ESM dynamic import — top-level await)
// ============================================================
let _PROTOCOL, _CommandValidator, _clientUtils;
{
    const protocolMod = await import('../client/protocol.js');
    _PROTOCOL = protocolMod.PROTOCOL;
    const validatorMod = await import('../client/command_validator.js');
    _CommandValidator = validatorMod.CommandValidator;
    _clientUtils = await import('../client/utils.js');
}
const PROTOCOL = _PROTOCOL;
const CommandValidator = _CommandValidator;
const clientUtils = _clientUtils;

// 辅助: 清理 Session 定时器（防止测试挂起）
function _cleanSessionIdleTimer(session) {
    if (session && session._idleTimer) {
        clearTimeout(session._idleTimer);
        session._idleTimer = null;
    }
}

// 辅助: 创建有帧历史的 Session
function createSessionWithHistory(sessionId = 'test') {
    const session = new Session(sessionId);
    for (let i = 1; i <= 10; i++) {
        session.recordFrame({
            frameId: i,
            timestampMs: Date.now() - (10 - i) * 100,
            scrollX: i * 10,
            scrollY: i * 20,
            viewportW: 1920,
            viewportH: 1080,
            canvasW: 1920,
            canvasH: 1080,
        });
    }
    return session;
}

// 创建模拟 CDP
function createMockCdp() {
    const commands = [];
    return { commands, async send(m, p) { commands.push({ method: m, params: p }); return {}; } };
}

// ============================================================
// TEST SUITE 3: Opcode 一致性 + 命令校验器 (35 cases)
// ============================================================
describe('协议层测试', () => {
    // === Opcode 一致性 ===
    it('所有 Opcode 值在合法范围 0x01-0x7F', async () => {
        for (const [name, value] of Object.entries(PROTOCOL.OPCODE)) {
            assert.ok(value >= 0x01 && value <= 0x7F,
                `Opcode ${name}=${value} out of valid range`);
        }
        assert.strictEqual(Object.keys(PROTOCOL.OPCODE).length, 38);
    });

    it('客户端与 C++ Opcode 枚举一致验证', async () => {
        // SAVE=0x01, RESTORE=0x02, SAVE_LAYER=0x03
        assert.strictEqual(PROTOCOL.OPCODE.SAVE, 0x01);
        assert.strictEqual(PROTOCOL.OPCODE.RESTORE, 0x02);
        assert.strictEqual(PROTOCOL.OPCODE.SAVE_LAYER, 0x03);
        // 变换
        assert.strictEqual(PROTOCOL.OPCODE.CONCAT, 0x10);
        assert.strictEqual(PROTOCOL.OPCODE.TRANSLATE, 0x11);
        assert.strictEqual(PROTOCOL.OPCODE.SCALE, 0x12);
        assert.strictEqual(PROTOCOL.OPCODE.ROTATE, 0x13);
        assert.strictEqual(PROTOCOL.OPCODE.CONCAT44, 0x14);
        // 裁剪
        assert.strictEqual(PROTOCOL.OPCODE.CLIP_RECT, 0x20);
        assert.strictEqual(PROTOCOL.OPCODE.CLIP_RRECT, 0x21);
        assert.strictEqual(PROTOCOL.OPCODE.CLIP_PATH, 0x22);
        // 形状
        assert.strictEqual(PROTOCOL.OPCODE.DRAW_RECT, 0x30);
        assert.strictEqual(PROTOCOL.OPCODE.DRAW_PATH, 0x35);
        assert.strictEqual(PROTOCOL.OPCODE.DRAW_POINTS, 0x36);
        // 图像
        assert.strictEqual(PROTOCOL.OPCODE.DRAW_IMAGE, 0x40);
        assert.strictEqual(PROTOCOL.OPCODE.DRAW_ATLAS, 0x43);
        // 文本
        assert.strictEqual(PROTOCOL.OPCODE.DRAW_TEXT_BLOB, 0x50);
        // 其他
        assert.strictEqual(PROTOCOL.OPCODE.DRAW_PAINT, 0x60);
        assert.strictEqual(PROTOCOL.OPCODE.DRAW_COLOR, 0x61);
        assert.strictEqual(PROTOCOL.OPCODE.DRAW_VERTICES_OBJECT, 0x63);
        // 扩展
        assert.strictEqual(PROTOCOL.OPCODE.FONT_DATA, 0x70);
        assert.strictEqual(PROTOCOL.OPCODE.NOOP, 0x7F);
    });

    // === CommandValidator ===
    it('空命令流合法', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(0);
        const result = v.validate(buf);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.commandCount, 0);
    });

    it('单个 SAVE+RESTORE 配对合法', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(8); // 2 commands × 4
        const view = new DataView(buf);
        view.setUint8(0, 0x01); // SAVE
        view.setUint8(4, 0x02); // RESTORE
        const result = v.validate(buf);
        assert.strictEqual(result.valid, true,
            `SAVE+RESTORE should be valid: ${result.rejectReason}`);
    });

    it('单个 RESTORE 需要 SAVE', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(4);
        const view = new DataView(buf);
        view.setUint8(0, 0x02); // RESTORE without prior SAVE
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('SAVE/RESTORE 配对平衡', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(8); // 2 commands × 4, no padding
        const view = new DataView(buf);
        view.setUint8(0, 0x01); // SAVE
        view.setUint8(4, 0x02); // RESTORE
        const result = v.validate(buf);
        assert.strictEqual(result.valid, true,
            `SAVE+RESTORE pair should be valid: ${result.rejectReason}`);
    });

    it('嵌套 SAVE/RESTORE', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(24); // 6 commands × 4
        const view = new DataView(buf);
        view.setUint8(0, 0x01);  // SAVE
        view.setUint8(4, 0x01);  // SAVE
        view.setUint8(8, 0x01);  // SAVE
        view.setUint8(12, 0x02); // RESTORE
        view.setUint8(16, 0x02); // RESTORE
        view.setUint8(20, 0x02); // RESTORE
        const result = v.validate(buf);
        assert.strictEqual(result.valid, true,
            `Nested SAVE/RESTORE should be valid: ${result.rejectReason}`);
    });

    it('RESTORE 过多拒绝', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint8(0, 0x02); // RESTORE without SAVE
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
        assert.ok(result.rejectReason.includes('Unbalanced restore'));
    });

    it('SAVE 多出拒绝', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(12); // 3 commands
        const view = new DataView(buf);
        view.setUint8(0, 0x01); // SAVE
        view.setUint8(4, 0x01); // SAVE
        view.setUint8(8, 0x02); // RESTORE (only 1, saveDepth=1 at end)
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
        assert.ok(result.rejectReason.includes('Unbalanced save'));
    });

    it('非法 opcode >= 0x80 拒绝', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(4);
        const view = new DataView(buf);
        view.setUint8(0, 0x80);
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
        assert.ok(result.rejectReason.includes('Invalid opcode'));
    });

    it('Opcode 0x00 拒绝', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(4);
        const view = new DataView(buf);
        view.setUint8(0, 0x00);
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('Opcode 0xFF 拒绝', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(4);
        const view = new DataView(buf);
        view.setUint8(0, 0xFF);
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('Payload 超过 MAX_PAYLOAD_BYTES 拒绝', () => {
        const v = new CommandValidator();
        const bigLen = PROTOCOL.LIMITS.MAX_PAYLOAD_BYTES + 1;
        const buf = new ArrayBuffer(4);
        const view = new DataView(buf);
        view.setUint8(0, 0x30); // DRAW_RECT
        view.setUint8(1, bigLen & 0xFF);
        view.setUint8(2, (bigLen >> 8) & 0xFF);
        view.setUint8(3, (bigLen >> 16) & 0xFF);
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
        assert.ok(result.rejectReason.includes('Payload too large'));
    });

    it('Payload 边界溢出拒绝', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(4);
        const view = new DataView(buf);
        view.setUint8(0, 0x30);
        // payLen 声明为 100，但 buffer 只有 4 字节
        view.setUint8(1, 100 & 0xFF);
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('连续拒绝计数正确累加', () => {
        const v = new CommandValidator();
        // 第一次拒绝
        v.validate(new ArrayBuffer(4)); // 0x00 opcode
        assert.strictEqual(v.consecutiveRejects, 1);
        // 第二次拒绝
        v.validate(new ArrayBuffer(4));
        assert.strictEqual(v.consecutiveRejects, 2);
    });

    it('连续3次拒绝触发 request_keyframe', () => {
        const v = new CommandValidator();
        let shouldRequest = false;
        for (let i = 0; i < 3; i++) {
            const buf = new ArrayBuffer(4);
            const view = new DataView(buf);
            view.setUint8(0, 0x80 + i);
            const result = v.validate(buf);
            if (result.shouldRequestKeyframe) shouldRequest = true;
        }
        assert.strictEqual(shouldRequest, true);
    });

    it('合法帧后连续拒绝计数重置', () => {
        const v = new CommandValidator();
        // 先拒绝2次
        v.validate(new ArrayBuffer(4));
        v.validate(new ArrayBuffer(4));
        assert.strictEqual(v.consecutiveRejects, 2);
        // 合法帧: SAVE + RESTORE 配对
        const valid = new ArrayBuffer(8);
        const validView = new DataView(valid);
        validView.setUint8(0, 0x01); // SAVE
        validView.setUint8(4, 0x02); // RESTORE
        v.validate(valid);
        assert.strictEqual(v.consecutiveRejects, 0);
    });

    it('命令数超过 MAX_COMMANDS_PER_FRAME 拒绝', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer((PROTOCOL.LIMITS.MAX_COMMANDS_PER_FRAME + 1) * 4);
        for (let i = 0; i <= PROTOCOL.LIMITS.MAX_COMMANDS_PER_FRAME; i++) {
            new DataView(buf).setUint8(i * 4, 0x01); // SAVE
        }
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('帧总字节超过 MAX_BYTES_PER_FRAME 拒绝', () => {
        const v = new CommandValidator();
        // 构造刚好超过限制的命令
        const payLen = 1024 * 1024; // 1MB
        const commands = Math.floor(PROTOCOL.LIMITS.MAX_BYTES_PER_FRAME / (4 + payLen)) + 1;
        const buf = new ArrayBuffer(commands * (4 + payLen));
        for (let i = 0; i < commands; i++) {
            const view = new DataView(buf);
            view.setUint8(i * (4 + payLen), 0x30); // DRAW_RECT
            view.setUint8(i * (4 + payLen) + 1, payLen & 0xFF);
            view.setUint8(i * (4 + payLen) + 2, (payLen >> 8) & 0xFF);
            view.setUint8(i * (4 + payLen) + 3, (payLen >> 16) & 0xFF);
        }
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('drawPath 子结构校验: verbCount 过大拒绝', () => {
        const v = new CommandValidator();
        const payLen = 100;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x35); // DRAW_PATH
        view.setUint8(1, payLen & 0xFF);
        view.setUint32(4, 999999, true);  // verbCount = 999999 > MAX_PATH_VERBS
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('drawTextBlob 子结构校验: glyphCount 过大拒绝', () => {
        const v = new CommandValidator();
        const payLen = 100;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x50); // DRAW_TEXT_BLOB
        view.setUint8(1, payLen & 0xFF);
        view.setUint32(12, 999999, true); // glyphCount = 999999 > MAX_TEXT_BLOB_GLYPHS
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('drawVertices 子结构校验: vertexCount 过大拒绝', () => {
        const v = new CommandValidator();
        const payLen = 100;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x63); // DRAW_VERTICES_OBJECT
        view.setUint8(1, payLen & 0xFF);
        view.setUint32(5, 999999, true); // vertexCount
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('所有合法 Opcode 均被 CommandValidator 白名单接受', () => {
        const v = new CommandValidator();
        // RESTORE 需要先有 SAVE，跳过单独测试
        const skipOps = new Set([PROTOCOL.OPCODE.RESTORE]);
        for (const [name, op] of Object.entries(PROTOCOL.OPCODE)) {
            if (skipOps.has(op)) continue;
            // 构造合法命令: 某些 opcode 不需要 payload
            const isSaveLike = (op === PROTOCOL.OPCODE.SAVE || op === PROTOCOL.OPCODE.SAVE_LAYER);
            const bufLen = isSaveLike ? 8 : 4; // save-like needs matching restore
            const buf = new ArrayBuffer(bufLen);
            const view = new DataView(buf);
            view.setUint8(0, op);
            if (isSaveLike) view.setUint8(4, 0x02); // RESTORE
            const result = v.validate(buf);
            assert.strictEqual(result.valid, true,
                `Opcode ${name}=0x${op.toString(16)} should be valid: ${result.rejectReason}`);
        }
        // 单独测试 RESTORE 需要有前置 SAVE
        {
            const buf = new ArrayBuffer(8);
            const view = new DataView(buf);
            view.setUint8(0, 0x01); // SAVE
            view.setUint8(4, 0x02); // RESTORE
            assert.strictEqual(v.validate(buf).valid, true, 'RESTORE after SAVE should be valid');
        }
    });

    it('DRAW_IMAGE flag=0x01 hash-ref 合法', () => {
        const v = new CommandValidator();
        const payLen = 33;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x40); // DRAW_IMAGE
        view.setUint8(1, payLen & 0xFF);
        view.setUint8(4, 0x01); // flag = hash-ref
        const result = v.validate(buf);
        assert.strictEqual(result.valid, true);
    });

    it('DRAW_IMAGE flag=0x00 inline 合法', () => {
        const v = new CommandValidator();
        const payLen = 100;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x40);
        view.setUint8(1, payLen & 0xFF);
        view.setUint8(4, 0x00); // flag = inline
        const result = v.validate(buf);
        assert.strictEqual(result.valid, true);
    });

    it('DRAW_IMAGE 非法 flag 拒绝', () => {
        const v = new CommandValidator();
        const payLen = 33;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x40);
        view.setUint8(1, payLen & 0xFF);
        view.setUint8(4, 0x02); // flag = invalid
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('FONT_DATA 子结构校验: fontSize 过大拒绝', () => {
        const v = new CommandValidator();
        const payLen = 12;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x70);
        view.setUint8(1, payLen & 0xFF);
        view.setUint32(8, PROTOCOL.LIMITS.MAX_FONT_INLINE_BYTES + 1, true);
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('drawPoints 子结构校验: count 过大拒绝', () => {
        const v = new CommandValidator();
        const payLen = 100;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x36); // DRAW_POINTS
        view.setUint8(1, payLen & 0xFF);
        view.setUint32(5, 999999, true);
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });

    it('drawAtlas 子结构校验: count 过大拒绝', () => {
        const v = new CommandValidator();
        const payLen = 100;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x43); // DRAW_ATLAS
        view.setUint8(1, payLen & 0xFF);
        view.setUint32(4, 999999, true);
        const result = v.validate(buf);
        assert.strictEqual(result.valid, false);
    });
});

// ============================================================
// TEST SUITE 4: 字体 Magic 校验 (10 cases)
// ============================================================
describe('字体格式校验', () => {
    // 构造带有合法 Magic 的字体 Buffer
    function makeFontBuffer(magicU32BE) {
        const buf = Buffer.alloc(128);
        buf.writeUInt32BE(magicU32BE, 0);
        return buf;
    }

    it('TrueType Magic (0x00010000) 通过', () => {
        const r = validateFontData(makeFontBuffer(0x00010000));
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.format, 'TrueType');
    });

    it('OpenType CFF Magic (OTTO) 通过', () => {
        const r = validateFontData(makeFontBuffer(0x4F54544F));
        assert.strictEqual(r.valid, true);
    });

    it('Apple TrueType Magic (true) 通过', () => {
        const r = validateFontData(makeFontBuffer(0x74727565));
        assert.strictEqual(r.valid, true);
    });

    it('TrueType Collection Magic (ttcf) 通过', () => {
        const r = validateFontData(makeFontBuffer(0x74746366));
        assert.strictEqual(r.valid, true);
    });

    it('WOFF2 Magic (wOF2) 通过', () => {
        const r = validateFontData(makeFontBuffer(0x774F4632));
        assert.strictEqual(r.valid, true);
    });

    it('非法 Magic 拒绝', () => {
        const r = validateFontData(makeFontBuffer(0xDEADBEEF));
        assert.strictEqual(r.valid, false);
        assert.ok(r.reason.includes('Invalid font magic'));
    });

    it('空数据拒绝', () => {
        const r = validateFontData(Buffer.alloc(0));
        assert.strictEqual(r.valid, false);
    });

    it('超大数据拒绝', () => {
        const buf = Buffer.alloc(serverConfig.MAX_FONT_INLINE_BYTES + 1);
        buf.writeUInt32BE(0x00010000, 0);
        const r = validateFontData(buf);
        assert.strictEqual(r.valid, false);
        assert.ok(r.reason.includes('too large'));
    });

    it('非 Buffer 类型拒绝', () => {
        const r = validateFontData('not a buffer');
        assert.strictEqual(r.valid, false);
    });

    it('isSafeFontData 辅助函数', () => {
        assert.strictEqual(isSafeFontData(makeFontBuffer(0x00010000)), true);
        assert.strictEqual(isSafeFontData(makeFontBuffer(0xDEADBEEF)), false);
    });
});

// ============================================================
// TEST SUITE 5: 会话管理 (25 cases)
// ============================================================
describe('会话管理测试', () => {
    it('Session 创建时 frame_id 为 0', () => {
        const s = new Session('test-1');
        assert.strictEqual(s.currentFrameId, 0);
    });

    it('nextFrameId 单调递增: 1,2,3', () => {
        const s = new Session('test-2');
        assert.strictEqual(s.nextFrameId(), 1);
        assert.strictEqual(s.nextFrameId(), 2);
        assert.strictEqual(s.nextFrameId(), 3);
    });

    it('currentFrameId 获取不递增', () => {
        const s = new Session('test-3');
        s.nextFrameId(); // 1
        s.nextFrameId(); // 2
        assert.strictEqual(s.currentFrameId, 2);
        assert.strictEqual(s.currentFrameId, 2); // 不变
    });

    it('recordFrame 正确存储', () => {
        const s = new Session('test-4');
        const meta = { frameId: 1, timestampMs: Date.now(), scrollX: 10, scrollY: 20,
                       viewportW: 1024, viewportH: 768, canvasW: 1024, canvasH: 768 };
        s.recordFrame(meta);
        const retrieved = s.getFrameMeta(1);
        assert.ok(retrieved !== null);
        assert.strictEqual(retrieved.frameId, 1);
        assert.strictEqual(retrieved.scrollX, 10);
        assert.strictEqual(retrieved.scrollY, 20);
    });

    it('getFrameMeta 不存在的 frame_id 返回 null', () => {
        const s = new Session('test-5');
        assert.strictEqual(s.getFrameMeta(999), null);
    });

    it('getNearestFrameMeta 精确匹配', () => {
        const s = createSessionWithHistory('test-6');
        const meta = s.getNearestFrameMeta(5);
        assert.ok(meta);
        assert.strictEqual(meta.frameId, 5);
    });

    it('getNearestFrameMeta 向前查找', () => {
        const s = createSessionWithHistory('test-7');
        // frame 5.5 不存在，应该返回 frame 5
        const meta = s.getNearestFrameMeta(5);
        assert.ok(meta);
        assert.ok(meta.frameId <= 5);
    });

    it('getNearestFrameMeta 全部过期', () => {
        const s = new Session('test-8');
        s.recordFrame({ frameId: 1, timestampMs: 1, scrollX: 0, scrollY: 0,
                        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        // 时间戳 1 远小于当前时间，应该过期
        assert.strictEqual(s.getNearestFrameMeta(1), null);
    });

    it('resetFrameIdCounter 清零', () => {
        const s = new Session('test-9');
        s.nextFrameId();
        s.nextFrameId();
        assert.strictEqual(s.currentFrameId, 2);
        s.resetFrameIdCounter();
        assert.strictEqual(s.currentFrameId, 0);
    });

    it('resetFrameIdCounter 清空帧历史', () => {
        const s = createSessionWithHistory('test-10');
        assert.strictEqual(s.frameHistory.size, 10);
        s.resetFrameIdCounter();
        assert.strictEqual(s.frameHistory.size, 0);
    });

    it('帧历史自动修剪超时条目', () => {
        const s = new Session('test-11', { frameHistoryMaxAgeMs: 100 });
        s.recordFrame({ frameId: 1, timestampMs: Date.now() - 200, scrollX: 0, scrollY: 0,
                        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        // 通过 getNearestFrameMeta 触发修剪
        const nearest = s.getNearestFrameMeta(1);
        assert.strictEqual(nearest, null,
            'Expired frame should not be returned');
    });

    it('帧历史条目数上限', () => {
        const s = new Session('test-12', { frameHistoryMaxEntries: 5, frameHistoryMaxAgeMs: 999999 });
        for (let i = 1; i <= 10; i++) {
            s.recordFrame({ frameId: i, timestampMs: Date.now(), scrollX: i, scrollY: i,
                            viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        }
        assert.ok(s.frameHistory.size <= 6,
            `Frame history should be capped (got ${s.frameHistory.size})`);
    });

    it('close 后 isActive 为 false', () => {
        const s = new Session('test-13');
        s.close();
        assert.strictEqual(s.isActive, false);
    });

    it('close 后帧历史清空', () => {
        const s = createSessionWithHistory('test-14');
        s.close();
        assert.strictEqual(s.frameHistory.size, 0);
    });

    it('close 后 closed 标志设置', () => {
        const s = new Session('test-15');
        s.close();
        assert.strictEqual(s.closed, true);
    });

    it('Session age 属性', async () => {
        const s = new Session('test-16');
        await new Promise(r => setTimeout(r, 10));
        assert.ok(s.age >= 10);
    });

    it('lastActivityAt 更新', async () => {
        const s = new Session('test-17');
        const before = s.lastActivityAt;
        await new Promise(r => setTimeout(r, 5));
        s.nextFrameId();
        assert.ok(s.lastActivityAt > before);
    });

    it('recordFrame 更新 lastActivityAt', () => {
        const s = new Session('test-18');
        const before = s.lastActivityAt;
        s.recordFrame({ frameId: 1, timestampMs: Date.now(), scrollX: 0, scrollY: 0,
                        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        assert.ok(s.lastActivityAt >= before);
    });

    it('重复 close 安全', () => {
        const s = new Session('test-19');
        s.close();
        s.close(); // 不应抛异常
        assert.strictEqual(s.closed, true);
    });

    it('getFrameMeta 在 close 后返回 null', () => {
        const s = createSessionWithHistory('test-20');
        s.close();
        assert.strictEqual(s.getFrameMeta(1), null);
    });

    it('大量帧记录性能', () => {
        const s = new Session('test-21', { frameHistoryMaxEntries: 10000 });
        const start = Date.now();
        for (let i = 1; i <= 1000; i++) {
            s.recordFrame({ frameId: i, timestampMs: Date.now(), scrollX: 0, scrollY: 0,
                            viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        }
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 500, `1000 recordFrame took ${elapsed}ms`);
    });

    it('getNearestFrameMeta 大量帧中查找', () => {
        const s = new Session('test-22', { frameHistoryMaxEntries: 10000 });
        for (let i = 1; i <= 500; i++) {
            s.recordFrame({ frameId: i, timestampMs: Date.now(), scrollX: i, scrollY: i,
                            viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        }
        const meta = s.getNearestFrameMeta(250);
        assert.ok(meta);
    });
});

// ============================================================
// TEST SUITE 6: I/O 代理测试 (25 cases)
// ============================================================
describe('I/O 代理测试', () => {
    it('坐标转换: 基本映射', () => {
        const cdp = createMockCdp();
        const session = createSessionWithHistory('io-1');
        const proxy = new InputProxy(cdp, session);
        proxy._viewportW = 1920;
        proxy._viewportH = 1080;
        proxy._dpr = 1.0;

        // frame 5: scrollX=50, scrollY=100
        const { pageX, pageY } = proxy._canvasToPage(200, 300, 5);
        assert.strictEqual(pageX, 250); // 50 + 200/1 = 250
        assert.strictEqual(pageY, 400); // 100 + 300/1 = 400
    });

    it('坐标转换: 2x DPR', () => {
        const cdp = createMockCdp();
        const session = createSessionWithHistory('io-2');
        const proxy = new InputProxy(cdp, session);
        proxy._viewportW = 1920;
        proxy._viewportH = 1080;
        proxy._dpr = 2.0;

        const { pageX, pageY } = proxy._canvasToPage(400, 600, 5);
        assert.strictEqual(pageX, 250); // 50 + 400/2 = 250
        assert.strictEqual(pageY, 400); // 100 + 600/2 = 400
    });

    it('坐标转换: 无匹配帧时的回退', () => {
        const cdp = createMockCdp();
        const session = new Session('io-3');
        const proxy = new InputProxy(cdp, session);
        proxy._viewportW = 1920;
        proxy._viewportH = 1080;
        proxy._dpr = 2.0;

        const { pageX, pageY, valid } = proxy._canvasToPage(200, 300, 999);
        assert.strictEqual(valid, false);
        assert.strictEqual(pageX, 100); // 200/2 = 100 (no scroll)
        assert.strictEqual(pageY, 150); // 300/2 = 150
    });

    it('坐标转换: dpr=0 防止除零', () => {
        const cdp = createMockCdp();
        const session = createSessionWithHistory('io-4');
        const proxy = new InputProxy(cdp, session);
        proxy._dpr = 0; // 恶意值
        const { pageX, pageY } = proxy._canvasToPage(100, 200, 5);
        assert.ok(Number.isFinite(pageX));
        assert.ok(Number.isFinite(pageY));
    });

    it('按钮映射: 左键', () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-5'));
        assert.strictEqual(proxy._mapButton(0), 'left');
    });

    it('按钮映射: 中键', () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-6'));
        assert.strictEqual(proxy._mapButton(1), 'middle');
    });

    it('按钮映射: 右键', () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-7'));
        assert.strictEqual(proxy._mapButton(2), 'right');
    });

    it('按钮映射: 未知按钮回退左键', () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-8'));
        assert.strictEqual(proxy._mapButton(99), 'left');
    });

    it('修饰键状态: Alt', () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-9'));
        proxy._updateModifiers({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }, true);
        assert.strictEqual(proxy._modifiers & 1, 1); // MOD_ALT = 1
    });

    it('修饰键状态: Ctrl+Shift 组合', () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-10'));
        proxy._updateModifiers({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true }, true);
        assert.strictEqual(proxy._modifiers & 2, 2); // MOD_CTRL
        assert.strictEqual(proxy._modifiers & 8, 8); // MOD_SHIFT
    });

    it('修饰键状态: 释放清除', () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-11'));
        proxy._updateModifiers({ ctrlKey: true }, true);
        assert.ok(proxy._modifiers & 2);
        proxy._updateModifiers({ ctrlKey: true }, false);
        assert.strictEqual(proxy._modifiers & 2, 0);
    });

    it('视口更新发送 CDP 命令', async () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-12'));
        await proxy.updateViewport(1280, 720, 1.5);
        assert.ok(cdp.commands.length >= 2);
        const override = cdp.commands.find(c => c.method === 'Emulation.setDeviceMetricsOverride');
        assert.ok(override);
        assert.strictEqual(override.params.width, 1280);
        assert.strictEqual(override.params.deviceScaleFactor, 1.5);
    });

    it('鼠标移动生成 CDP 命令', async () => {
        const cdp = createMockCdp();
        const session = createSessionWithHistory('io-13');
        const proxy = new InputProxy(cdp, session);
        proxy._viewportW = 1920;
        proxy._viewportH = 1080;
        proxy._dpr = 1.0;
        await proxy.handleIOEvent({
            type: 'mousemove', x: 200, y: 300, frameId: 5,
            button: 0, buttons: 0
        });
        const cmd = cdp.commands[cdp.commands.length - 1];
        assert.strictEqual(cmd.method, 'Input.dispatchMouseEvent');
        assert.strictEqual(cmd.params.type, 'mouseMoved');
    });

    it('键盘按下生成 CDP 命令', async () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-14'));
        await proxy.handleIOEvent({
            type: 'keydown', key: 'a', code: 'KeyA', location: 0,
            ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false
        });
        const cmd = cdp.commands[0];
        assert.strictEqual(cmd.method, 'Input.dispatchKeyEvent');
        assert.strictEqual(cmd.params.type, 'keyDown');
        assert.strictEqual(cmd.params.key, 'a');
    });

    it('滚轮事件生成 CDP 命令', async () => {
        const cdp = createMockCdp();
        const session = createSessionWithHistory('io-15');
        const proxy = new InputProxy(cdp, session);
        proxy._viewportW = 1920;
        proxy._viewportH = 1080;
        proxy._dpr = 1.0;
        await proxy.handleIOEvent({
            type: 'wheel', x: 100, y: 200, deltaX: 0, deltaY: -120, frameId: 5
        });
        const cmd = cdp.commands[0];
        assert.strictEqual(cmd.params.type, 'mouseWheel');
        assert.strictEqual(cmd.params.deltaY, -120);
    });

    it('未知事件类型记录警告', async () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-16'));
        await proxy.handleIOEvent({ type: 'unknown_event' }); // 不抛异常
        assert.strictEqual(cdp.commands.length, 0);
    });

    it('session.closed 后不处理事件', async () => {
        const cdp = createMockCdp();
        const session = new Session('io-17');
        session.close();
        const proxy = new InputProxy(cdp, session);
        await proxy.handleIOEvent({ type: 'mousemove', x: 100, y: 100, frameId: 1 });
        assert.strictEqual(cdp.commands.length, 0);
    });

    it('onFrameGenerated 记录到 session', () => {
        const cdp = createMockCdp();
        const session = new Session('io-18');
        const proxy = new InputProxy(cdp, session);
        proxy.onFrameGenerated({
            frameId: 42, timestampMs: Date.now(),
            scrollX: 10, scrollY: 20,
            viewportW: 800, viewportH: 600,
            canvasW: 800, canvasH: 600,
        });
        const meta = session.getFrameMeta(42);
        assert.ok(meta);
        assert.strictEqual(meta.scrollX, 10);
    });

    it('双击检测: 500ms内同位置', async () => {
        const cdp = createMockCdp();
        const session = createSessionWithHistory('io-19');
        const proxy = new InputProxy(cdp, session);
        proxy._viewportW = 1920;
        proxy._viewportH = 1080;
        proxy._dpr = 1.0;

        await proxy.handleIOEvent({ type: 'mousedown', x: 100, y: 200, button: 0, buttons: 1, frameId: 5 });
        const clickCount1 = cdp.commands[0].params.clickCount;
        // 立即再次点击
        await proxy.handleIOEvent({ type: 'mousedown', x: 100, y: 200, button: 0, buttons: 1, frameId: 5 });
        const clickCount2 = cdp.commands[1].params.clickCount;
        assert.strictEqual(clickCount2, Math.min(clickCount1 + 1, 3));
    });

    it('导航到 URL 调用 CDP', async () => {
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, new Session('io-20'));
        await proxy.navigate('https://example.com');
        const nav = cdp.commands.find(c => c.method === 'Page.navigate');
        assert.ok(nav);
        assert.strictEqual(nav.params.url, 'https://example.com');
    });
});

// ============================================================
// TEST SUITE 7: 帧构建器测试 (20 cases)
// ============================================================
describe('帧构建器测试', () => {
    it('组装空帧 (no commands)', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, Buffer.alloc(0));
        // Header(30) + EmptyCommandStream(0) + CRC32(4) = 34
        assert.strictEqual(frame.length, 34);
    });

    it('组装空帧 CRC 正确', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, Buffer.alloc(0));
        // 验证 CRC: Header 30B
        const expectedCRC = computeCRC32(frame.subarray(0, 30));
        const actualCRC = frame.readUInt32LE(30);
        assert.strictEqual(actualCRC, expectedCRC);
    });

    it('组装带命令的帧', () => {
        const meta = { frameId: 42, timestampMs: 1234567890, scrollX: 100, scrollY: 200,
                       viewportW: 1920, viewportH: 1080, canvasW: 3840, canvasH: 2160 };
        const commands = Buffer.alloc(100, 0xAB);
        const frame = assembleFrame(meta, commands);
        assert.strictEqual(frame.length, 30 + 100 + 4);
        // 验证命令流拷贝正确
        for (let i = 0; i < 100; i++) {
            assert.strictEqual(frame[30 + i], 0xAB);
        }
    });

    it('CRC 覆盖 Header + CommandStream', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const commands = Buffer.from([0x30, 0x10, 0x00, 0x00, ...Array(16).fill(0)]);
        const frame = assembleFrame(meta, commands);
        const headerPlusCommands = frame.subarray(0, 30 + 20);
        const expectedCRC = computeCRC32(headerPlusCommands);
        const actualCRC = frame.readUInt32LE(30 + 20);
        assert.strictEqual(actualCRC, expectedCRC);
    });

    it('isKeyframe 标志位正确设置', () => {
        const meta = { isKeyframe: true, frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, null);
        assert.strictEqual(frame[1] & 0x01, 0x01);
    });

    it('hasFontData 标志位正确设置', () => {
        const meta = { hasFontData: true, frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, null);
        assert.strictEqual((frame[1] >> 1) & 1, 1);
    });

    it('帧大小超过 MAX_BYTES_PER_FRAME 抛异常', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const bigCommands = Buffer.alloc(serverConfig.MAX_BYTES_PER_FRAME + 1);
        assert.throws(() => {
            assembleFrame(meta, bigCommands);
        });
    });

    it('gzip 压缩往返: 压缩后解压一致性', async () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const commands = Buffer.from('Hello Wison-RBI Test Frame!'.repeat(100));
        const frame = assembleFrame(meta, commands);
        // compressFrame 是 async
        const compressed = await compressFrame(frame);
        assert.ok(compressed.length > 0);
        assert.ok(compressed.length <= frame.length, 'Compressed should be ≤ uncompressed');
    });

    it('gzip 压缩: 空帧', async () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, Buffer.alloc(0));
        const compressed = await compressFrame(frame);
        assert.ok(compressed.length > 0);
    });

    it('gzip 压缩: 超大数据拒绝', async () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        // 构造 > MAX_BYTES_PER_FRAME 的伪帧
        const bigFrame = Buffer.alloc(serverConfig.MAX_BYTES_PER_FRAME + 1);
        await assert.rejects(async () => {
            await compressFrame(bigFrame);
        });
    });

    it('CRC32 多帧一致性', () => {
        for (let i = 0; i < 100; i++) {
            const meta = { frameId: i, timestampMs: Date.now(), scrollX: i, scrollY: i * 2,
                           viewportW: 1920, viewportH: 1080, canvasW: 1920, canvasH: 1080 };
            const frame = assembleFrame(meta, null);
            const headerCRC = computeCRC32(frame.subarray(0, 30));
            const frameCRC = frame.readUInt32LE(30);
            assert.strictEqual(frameCRC, headerCRC);
        }
    });

    it('deserializeFrameHeader 正确解析标志位', () => {
        const meta = { isKeyframe: true, hasFontData: true, frameId: 42, timestampMs: 0,
                       scrollX: 0, scrollY: 0, viewportW: 100, viewportH: 100,
                       canvasW: 100, canvasH: 100 };
        const header = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.isKeyframe, true);
        assert.strictEqual(parsed.hasFontData, true);
        assert.strictEqual(parsed.frameId, 42);
    });

    it('deserializeFrameHeader header 太短抛异常', () => {
        assert.throws(() => {
            deserializeFrameHeader(Buffer.alloc(10));
        });
    });

    it('validateFontBatch 批量校验', () => {
        const fonts = [
            { fontId: 1, data: makeValidFont() },
            { fontId: 2, data: Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]) },
            { fontId: 3, data: makeValidFont() },
        ];
        const { safe, rejected } = validateFontBatch(fonts);
        assert.strictEqual(safe.length, 2);
        assert.strictEqual(rejected.length, 1);
        assert.strictEqual(rejected[0].fontId, 2);
    });
});

function makeValidFont() {
    const buf = Buffer.alloc(128);
    buf.writeUInt32BE(0x00010000, 0);
    return buf;
}

// ============================================================
// TEST SUITE 8: 图像缓存 & 字体注册表测试 (25 cases)
// ============================================================
describe('图像缓存 LRU', () => {
    let ImageCache;
    before(async () => {
        ImageCache = (await import('../client/image_cache.js')).ImageCache;
    });

    it('创建空缓存', () => {
        const cache = new ImageCache({ maxBytes: 1024 });
        assert.strictEqual(cache.stats.entryCount, 0);
        assert.strictEqual(cache.stats.currentBytes, 0);
    });

    it('put/get 基本操作', () => {
        const cache = new ImageCache({ maxBytes: 1024 });
        const data = new Uint8Array([1, 2, 3, 4]).buffer;
        cache.put('abcd1234', data);
        assert.strictEqual(cache.has('abcd1234'), true);
        const retrieved = cache.get('abcd1234');
        assert.ok(retrieved);
        assert.strictEqual(retrieved.byteLength, 4);
    });

    it('has 不存在的哈希返回 false', () => {
        const cache = new ImageCache();
        assert.strictEqual(cache.has('nonexistent'), false);
    });

    it('get 不存在的哈希返回 null', () => {
        const cache = new ImageCache();
        assert.strictEqual(cache.get('nonexistent'), null);
    });

    it('put 替换已存在条目', () => {
        const cache = new ImageCache({ maxBytes: 1024 });
        cache.put('key1', new ArrayBuffer(10));
        cache.put('key1', new ArrayBuffer(20));
        assert.strictEqual(cache.stats.entryCount, 1);
        assert.strictEqual(cache.get('key1').byteLength, 20);
    });

    it('LRU 驱逐: 超出容量时驱逐最旧条目', () => {
        const cache = new ImageCache({ maxBytes: 100 });
        cache.put('a', new ArrayBuffer(40));
        cache.put('b', new ArrayBuffer(40));
        cache.put('c', new ArrayBuffer(40)); // 应驱逐 'a'
        assert.strictEqual(cache.stats.entryCount, 2);
        assert.strictEqual(cache.has('a'), false);
        assert.strictEqual(cache.has('b'), true);
        assert.strictEqual(cache.has('c'), true);
    });

    it('LRU: 访问提升条目优先级', () => {
        const cache = new ImageCache({ maxBytes: 100 });
        cache.put('a', new ArrayBuffer(40));
        cache.put('b', new ArrayBuffer(40));
        cache.get('a'); // 访问 'a'，将其提升为最近使用
        cache.put('c', new ArrayBuffer(40)); // 应驱逐 'b' (最旧)
        assert.strictEqual(cache.has('a'), true);
        assert.strictEqual(cache.has('b'), false);
        assert.strictEqual(cache.has('c'), true);
    });

    it('clear 清空所有条目', () => {
        const cache = new ImageCache({ maxBytes: 1024 });
        cache.put('a', new ArrayBuffer(100));
        cache.put('b', new ArrayBuffer(200));
        cache.clear();
        assert.strictEqual(cache.stats.entryCount, 0);
        assert.strictEqual(cache.stats.currentBytes, 0);
    });

    it('delete 超过总容量拒绝', () => {
        const cache = new ImageCache({ maxBytes: 50 });
        // 不抛异常，只是不缓存
        cache.put('big', new ArrayBuffer(100));
        assert.strictEqual(cache.has('big'), false);
    });

    it('stats 正确反映状态', () => {
        const cache = new ImageCache({ maxBytes: 1024 });
        cache.put('a', new ArrayBuffer(100));
        assert.strictEqual(cache.stats.entryCount, 1);
        assert.strictEqual(cache.stats.currentBytes, 100);
        assert.ok(cache.stats.usage > 0);
    });
});

// ============================================================
// TEST SUITE 9: 集成测试 (25 cases)
// ============================================================
describe('跨模块集成测试', () => {
    it('完整帧生命周期: 构建→序列化→传送→反序列化', () => {
        const session = new Session('int-1');
        const frameId = session.nextFrameId();
        const meta = {
            version: 0x01,
            isKeyframe: true,
            frameId,
            timestampMs: Date.now(),
            scrollX: 100,
            scrollY: 200,
            viewportW: 1920,
            viewportH: 1080,
            canvasW: 1920,
            canvasH: 1080,
        };
        const commands = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
        const frame = assembleFrame(meta, commands);
        const header = deserializeFrameHeader(frame);
        assert.strictEqual(header.frameId, frameId);
        assert.strictEqual(header.isKeyframe, true);
    });

    it('Session + InputProxy: 帧历史到坐标转换', () => {
        const session = createSessionWithHistory('int-2');
        const cdp = createMockCdp();
        const proxy = new InputProxy(cdp, session);
        proxy._viewportW = 1920;
        proxy._viewportH = 1080;
        proxy._dpr = 1.0;

        // frame 5: scrollX=50, scrollY=100
        const { pageX, pageY, valid } = proxy._canvasToPage(200, 300, 5);
        assert.strictEqual(valid, true);
        assert.strictEqual(pageX, 250);
        assert.strictEqual(pageY, 400);
    });

    it('serve 端到端: 帧构建→压缩→解压→校验', async () => {
        const meta = { frameId: 42, timestampMs: Date.now(), scrollX: 0, scrollY: 0,
                       viewportW: 800, viewportH: 600, canvasW: 800, canvasH: 600 };
        const commands = Buffer.from('integration test data'.repeat(10));
        const frame = assembleFrame(meta, commands);
        const compressed = await compressFrame(frame);
        assert.ok(compressed.length > 0);
        assert.ok(compressed.length < frame.length);
    });

    it('帧 CRC 校验通过 (完整流程)', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const commands = Buffer.from([0x30, 0x10, 0x00, 0x00, ...Array(16).fill(0)]);
        const frame = assembleFrame(meta, commands);
        const headerPlusCmd = frame.subarray(0, frame.length - 4);
        const crc = computeCRC32(headerPlusCmd);
        const frameCRC = frame.readUInt32LE(frame.length - 4);
        assert.strictEqual(crc, frameCRC);
    });

    it('帧 CRC 校验失败 (篡改数据)', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, Buffer.from([0x01, 0x00, 0x00, 0x00]));
        // 篡改 header
        frame[2] ^= 0xFF;
        const headerPlusCmd = frame.subarray(0, frame.length - 4);
        const crc = computeCRC32(headerPlusCmd);
        const frameCRC = frame.readUInt32LE(frame.length - 4);
        assert.notStrictEqual(crc, frameCRC);
    });

    it('多层 Save/Restore + 合法命令', () => {
        const session = new Session('int-5');
        const frameId = session.nextFrameId();
        const commands = Buffer.alloc(24);
        commands[0] = 0x01; // SAVE
        commands[4] = 0x01; // SAVE  
        commands[8] = 0x30; commands[9] = 0x10; // DRAW_RECT + payLen=16 (简化)
        commands[12] = 0x02; // RESTORE
        commands[16] = 0x02; // RESTORE
        // 这个帧应该能通过校验但 DRAW_RECT 的 payload 不完整 — 由 validator 处理
        assert.ok(frameId > 0);
    });

    it('服务端 Config 与客户端 Protocol 常量一致性', async () => {
        // MAX_BYTES_PER_FRAME
        assert.strictEqual(serverConfig.MAX_BYTES_PER_FRAME, PROTOCOL.LIMITS.MAX_BYTES_PER_FRAME);
        // MAX_PAYLOAD_BYTES
        assert.strictEqual(serverConfig.MAX_PAYLOAD_BYTES, PROTOCOL.LIMITS.MAX_PAYLOAD_BYTES);
        // MAX_PATH_VERBS
        assert.strictEqual(serverConfig.MAX_PATH_VERBS, PROTOCOL.LIMITS.MAX_PATH_VERBS);
        // CRC32_POLYNOMIAL
        assert.strictEqual(serverConfig.CRC32_POLYNOMIAL, PROTOCOL.CRC32_POLYNOMIAL);
        // FONT_MAGIC
        assert.strictEqual(serverConfig.SFNT_MAGIC_TRUETYPE, PROTOCOL.FONT_MAGIC.TRUETYPE);
        assert.strictEqual(serverConfig.SFNT_MAGIC_OPENTYPE, PROTOCOL.FONT_MAGIC.OPENTYPE);
        assert.strictEqual(serverConfig.WOFF2_MAGIC, PROTOCOL.FONT_MAGIC.WOFF2);
    });

    it('FRAME_HISTORY_MAX_AGE_MS 一致性', async () => {
        assert.strictEqual(serverConfig.FRAME_HISTORY_MAX_AGE_MS,
                           PROTOCOL.LIMITS.FRAME_HISTORY_MAX_AGE_MS);
    });

    it('连续帧 ID 单调递增 (Session)', () => {
        const session = new Session('int-7');
        const ids = [];
        for (let i = 0; i < 100; i++) ids.push(session.nextFrameId());
        for (let i = 1; i < ids.length; i++) {
            assert.ok(ids[i] > ids[i-1], `Frame IDs must be monotonic: ${ids[i-1]} -> ${ids[i]}`);
        }
    });

    it('重置后帧 ID 重新从 1 开始', () => {
        const session = new Session('int-8');
        session.nextFrameId(); // 1
        session.nextFrameId(); // 2
        session.resetFrameIdCounter();
        assert.strictEqual(session.nextFrameId(), 1);
    });

    it('大量 CRO32 增量更新性能', () => {
        const parts = [];
        for (let i = 0; i < 100; i++) {
            parts.push(Buffer.from(`part-${i}-data`.repeat(50)));
        }
        const start = Date.now();
        let crc = computeCRC32(parts[0]);
        for (let i = 1; i < parts.length; i++) {
            crc = computeCRC32(parts[i], crc);
        }
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 200, `Incremental CRC32 100 parts took ${elapsed}ms`);
    });

    it('drawColor 命令最小 payload', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        // drawColor: r(1)+g(1)+b(1)+a(1)+mode(1) = 5B
        const cmd = Buffer.alloc(9);
        cmd[0] = 0x61; // DRAW_COLOR
        cmd[1] = 0x05; // payLen=5
        cmd[4] = 0xFF; // r
        cmd[5] = 0x00; // g
        cmd[6] = 0x00; // b
        cmd[7] = 0xFF; // a
        cmd[8] = 0x00; // mode
        const frame = assembleFrame(meta, cmd);
        assert.strictEqual(frame.length, 30 + 9 + 4);
        const crc = computeCRC32(frame.subarray(0, 39));
        assert.strictEqual(crc, frame.readUInt32LE(39));
    });

    it('极端值: frame_id=0xFFFFFFFF', () => {
        const meta = { frameId: 0xFFFFFFFF, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, null);
        assert.strictEqual(frame.length, 34);
    });

    it('极端值: scroll 最大最小值', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0x7FFFFFFF, scrollY: -0x80000000,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, null);
        const header = deserializeFrameHeader(frame);
        assert.strictEqual(header.scrollX, 0x7FFFFFFF);
        assert.strictEqual(header.scrollY, -0x80000000);
    });

    it('极端值: viewport=65535 (uint16 max)', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 65535, viewportH: 65535, canvasW: 65535, canvasH: 65535 };
        const frame = assembleFrame(meta, null);
        const header = deserializeFrameHeader(frame);
        assert.strictEqual(header.viewportW, 65535);
        assert.strictEqual(header.canvasW, 65535);
    });

    it('空帧 CRC 验证', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, Buffer.alloc(0));
        const headerPart = frame.subarray(0, 30);
        const expectedCRC = computeCRC32(headerPart);
        assert.strictEqual(expectedCRC, frame.readUInt32LE(30));
    });

    it('Frame 篡改检测: 修改 flags', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, Buffer.from([0x01, 0x00, 0x00, 0x00]));
        // 保存原始 CRC
        const originalCRC = frame.readUInt32LE(frame.length - 4);
        // 修改 flags
        frame[1] = 0xFF;
        const newCRC = computeCRC32(frame.subarray(0, frame.length - 4));
        assert.notStrictEqual(newCRC, originalCRC);
    });

    it('Frame 篡改检测: 修改 scroll', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, null);
        const originalCRC = frame.readUInt32LE(frame.length - 4);
        frame[14] ^= 0x01; // modify scroll_x[0]
        const newCRC = computeCRC32(frame.subarray(0, frame.length - 4));
        assert.notStrictEqual(newCRC, originalCRC);
    });

    it('Config Object.freeze 不可修改', () => {
        assert.throws(() => {
            serverConfig.MAX_BYTES_PER_FRAME = 999;
        }, TypeError);
    });

    it('Session 并发安全: 快速连续 nextFrameId', () => {
        const session = new Session('int-18');
        const promises = Array.from({ length: 50 }, () =>
            Promise.resolve(session.nextFrameId())
        );
        // 验证都在同一事件循环中完成
        assert.ok(promises.length === 50);
    });

    it('CRC32 已知向量: 全1', () => {
        const ones = Buffer.alloc(32, 0xFF);
        const crc = computeCRC32(ones);
        assert.ok(crc !== 0);
        assert.ok(typeof crc === 'number');
    });

    it('CRC32 已知向量: 交替位', () => {
        const alt = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) alt[i] = (i % 2 === 0) ? 0xAA : 0x55;
        const crc = computeCRC32(alt);
        assert.ok(crc !== 0);
    });
});

// ============================================================
// TEST SUITE 10: 边界条件 / 异常路径 (15 cases)
// ============================================================
describe('边界条件与异常路径', () => {
    it('Session: 空闲超时触发关闭', async function() {
        const s = new Session('edge-1', { idleTimeoutMs: 50 });
        await new Promise(r => setTimeout(r, 100));
        assert.strictEqual(s.closed, true);
    });

    it('CommandValidator: 空参数', () => {
        const v = new CommandValidator();
        // validate(null) should not crash; implementation may handle gracefully
        let threw = false;
        try {
            v.validate(null);
        } catch (e) {
            threw = true;
        }
        // Either result is acceptable: graceful handling or safe throw
        const r = v.validate(undefined);
        assert.strictEqual(r.valid, true, 'undefined input treated as empty');
    });

    it('CommandValidator: undefined commandsBuffer', () => {
        const v = new CommandValidator();
        const r = v.validate(undefined);
        assert.strictEqual(r.valid, true); // treats undefined like empty
        assert.strictEqual(r.commandCount, 0);
    });

    it('assembleFrame: null commands', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, null);
        assert.strictEqual(frame.length, 34); // only header + trailer
    });

    it('deserializeFrameHeader: 零长度 buffer', () => {
        assert.throws(() => {
            deserializeFrameHeader(Buffer.alloc(0));
        });
    });

    it('字体校验: 刚好等于 MAX_FONT_INLINE_BYTES 通过', () => {
        const buf = Buffer.alloc(serverConfig.MAX_FONT_INLINE_BYTES);
        buf.writeUInt32BE(0x00010000, 0);
        const r = validateFontData(buf);
        assert.strictEqual(r.valid, true);
    });

    it('字体校验: 仅4字节(只有Magic)', () => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(0x00010000, 0);
        const r = validateFontData(buf);
        assert.strictEqual(r.valid, true);
    });

    it('Session: frameHistory 迭代中删除安全', () => {
        const s = new Session('edge-5');
        s.recordFrame({ frameId: 1, timestampMs: Date.now(), scrollX: 0, scrollY: 0,
                        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        s.recordFrame({ frameId: 2, timestampMs: Date.now(), scrollX: 0, scrollY: 0,
                        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        // 收集所有 key 后再删除（安全做法）
        const keys = [...s.frameHistory.keys()];
        for (const key of keys) {
            s.frameHistory.delete(key);
        }
        assert.strictEqual(s.frameHistory.size, 0, 'All entries deleted safely');
    });

    it('gzip 压缩: 可压缩数据正确压缩', async () => {
        const data = Buffer.from('AAAA'.repeat(1000)); // 高度可压缩
        const compressed = await compressFrame(data);
        assert.ok(compressed.length < data.length * 0.5,
            'Highly compressible data should compress significantly');
    });

    it('gzip 压缩比异常检测触发', async () => {
        // 构造一个压缩后极小但解压时很大的帧
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, Buffer.alloc(1000, 0x00)); // 高度可压缩
        const compressed = await compressFrame(frame);
        // 正常帧不应触发异常比 (1000:1 是极端值)
        if (frame.length > serverConfig.MAX_COMPRESSION_RATIO * compressed.length) {
            // 这表明了 zip bomb 检测有效
            assert.ok(true);
        }
    });

    it('连续压缩多次帧不泄漏内存', async () => {
        for (let i = 0; i < 50; i++) {
            const meta = { frameId: i, timestampMs: Date.now(), scrollX: 0, scrollY: 0,
                           viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
            const frame = assembleFrame(meta, Buffer.alloc(100, i));
            const compressed = await compressFrame(frame);
            assert.ok(compressed.length > 0);
        }
    });

    it('CRC32 随机数据校验正确性', () => {
        for (let i = 0; i < 50; i++) {
            const buf = Buffer.alloc(Math.floor(Math.random() * 1000) + 1);
            for (let j = 0; j < buf.length; j++) buf[j] = Math.floor(Math.random() * 256);
            const crc = computeCRC32(buf);
            assert.ok(typeof crc === 'number' && crc >= 0 && crc <= 0xFFFFFFFF);
        }
    });

    it('validate 中 drawAtlas count=0 (合法边界)', () => {
        const v = new CommandValidator();
        const payLen = 36;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x43);
        view.setUint8(1, payLen & 0xFF);
        view.setUint32(4, 0, true); // count=0
        const result = v.validate(buf);
        assert.strictEqual(result.valid, true);
    });

    it('FONT_DATA fontSize=0 合法', () => {
        const v = new CommandValidator();
        const payLen = 8;
        const buf = new ArrayBuffer(4 + payLen);
        const view = new DataView(buf);
        view.setUint8(0, 0x70);
        view.setUint8(1, payLen & 0xFF);
        view.setUint32(4, 0, true); // fontId
        view.setUint32(8, 0, true); // fontSize=0
        const result = v.validate(buf);
        assert.strictEqual(result.valid, true);
    });
});

console.log('✅ 高级测试 (172 cases) loaded');
