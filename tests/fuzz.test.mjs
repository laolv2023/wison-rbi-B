// tests/fuzz.test.mjs — Wison-RBI 对抗性 Fuzzing 测试 (Phase 4)
//
// 目标: 对安全关键路径进行随机/边界/对抗性输入测试。
//
// 注意: 本测试运行在 Node.js 环境。
//   客户端 decompressWithProtection (使用浏览器 DecompressionStream)
//   的测试需在真实浏览器中运行。本文件聚焦 Node.js 可测范围。
//
'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);

const {
    assembleFrame, compressFrame, computeCRC32,
    serializeDirtyRects, computeDirtyRects,
} = require('../server/frame_builder.js');
const serverConfig = require('../server/config.js');

let PROTOCOL, CommandValidator, clientUtils;
{
    const pm = await import('../client/protocol.js');
    PROTOCOL = pm.PROTOCOL;
    const vm = await import('../client/command_validator.js');
    CommandValidator = vm.CommandValidator;
    clientUtils = await import('../client/utils.js');
}

// ── 辅助 ──
function randomBytes(length) {
    const buf = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) buf[i] = Math.floor(Math.random() * 256);
    return buf;
}
function zeroBytes(n) { return Buffer.alloc(n, 0); }
function onesBytes(n) { return Buffer.alloc(n, 0xFF); }

function makeMinimalFrame(overrides = {}) {
    const meta = {
        version: overrides.version ?? 0x01,
        frameId: overrides.frameId ?? 1,
        timestampMs: overrides.timestampMs ?? 0,
        scrollX: overrides.scrollX ?? 0, scrollY: overrides.scrollY ?? 0,
        viewportW: overrides.viewportW ?? 100, viewportH: overrides.viewportH ?? 100,
        canvasW: overrides.canvasW ?? 100, canvasH: overrides.canvasH ?? 100,
        isKeyframe: overrides.isKeyframe !== false,
        hasFontData: !!overrides.hasFontData,
    };
    return assembleFrame(meta, Buffer.from([0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]));
}

// ═══════════════════════════════════════════════════════════════
// F1: CommandValidator 对抗性 Fuzz
// ═══════════════════════════════════════════════════════════════
describe('F1: CommandValidator Fuzz', () => {
    it('F1.1 空输入', () => {
        const v = new CommandValidator();
        const r = v.validate(new ArrayBuffer(0));
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.commandCount, 0);
    });

    it('F1.2 单字节随机 (10000 次)', () => {
        const v = new CommandValidator();
        for (let i = 0; i < 10000; i++) {
            const buf = new ArrayBuffer(1);
            new DataView(buf).setUint8(0, Math.floor(Math.random() * 256));
            const r = v.validate(buf);
            assert.ok(typeof r.valid === 'boolean');
        }
    });

    it('F1.3 4KB 全随机 (500 次)', () => {
        const v = new CommandValidator();
        for (let i = 0; i < 500; i++) {
            const raw = randomBytes(4096);
            const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
            const r = v.validate(buf);
            assert.ok(typeof r.valid === 'boolean');
            // 不能崩溃或无限循环
        }
    });

    it('F1.4 全零字节 (各种长度)', () => {
        const v = new CommandValidator();
        for (const len of [0, 1, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096]) {
            const r = v.validate(zeroBytes(len).buffer);
            assert.ok(typeof r.valid === 'boolean', `len=${len}`);
        }
    });

    it('F1.5 全 0xFF 字节 (各种长度)', () => {
        const v = new CommandValidator();
        for (const len of [0, 1, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096]) {
            const r = v.validate(onesBytes(len).buffer);
            assert.ok(typeof r.valid === 'boolean', `len=${len}`);
        }
    });

    it('F1.6 超限 payload (payLen=0xFFFFFF → 16MB > 1MB)', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint8(0, 0x01);       // SAVE (合法 opcode)
        view.setUint8(1, 0xFF); view.setUint8(2, 0xFF); view.setUint8(3, 0xFF);  // payLen=16MB
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
        assert.ok(r.rejectReason.includes('Payload too large'));
    });

    it('F1.7 伪造 drawPath verbCount', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(12);
        const view = new DataView(buf);
        view.setUint8(0, 0x35);  // DRAW_PATH
        view.setUint8(1, 0x08); view.setUint8(2, 0x00); view.setUint8(3, 0x00);
        view.setUint32(4, 999999, true);  // verbCount 伪造
        view.setUint32(8, 0, true);
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
    });

    it('F1.8 伪造 drawTextBlob glyphCount', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(20);
        const view = new DataView(buf);
        view.setUint8(0, 0x50);          // DRAW_TEXT_BLOB
        view.setUint8(1, 0x10);          // payLen = 16
        view.setUint8(2, 0x00); view.setUint8(3, 0x00);
        // payload: x(4B at offset4) + y(4B at offset8) + glyphCount(4B at offset12)
        view.setUint32(12, 999999, true); // glyphCount 伪造 (payload offset 8)
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
    });

    it('F1.9 非法 opcode 0x80-0xFF (全部 128 个)', () => {
        const v = new CommandValidator();
        for (let op = 0x80; op <= 0xFF; op++) {
            const buf = new ArrayBuffer(4);
            new DataView(buf).setUint8(0, op);
            const r = v.validate(buf);
            assert.strictEqual(r.valid, false,
                `Opcode 0x${op.toString(16)} must be rejected`);
        }
    });

    it('F1.10 Save/Restore 不平衡 — 过多 Restore', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint8(0, 0x02);  // RESTORE 无配对 SAVE
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
    });

    it('F1.11 Save/Restore 不平衡 — 仅 Save', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint8(0, 0x01); view.setUint8(4, 0x01);  // SAVE + SAVE
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
    });

    it('F1.12 连续拒绝 3 次触发 request_keyframe', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint8(0, 0xFF);  // 非法
        v.validate(buf);  // reject 1
        v.validate(buf);  // reject 2
        const r = v.validate(buf);  // reject 3
        assert.strictEqual(r.valid, false);
        assert.strictEqual(r.shouldRequestKeyframe, true);
    });

    it('F1.13 混合合法/非法命令流 — 整帧拒绝', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(12);
        const view = new DataView(buf);
        view.setUint8(0, 0x01);   // SAVE 合法
        view.setUint8(4, 0xFF);   // 非法
        view.setUint8(8, 0x02);   // RESTORE 合法
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
    });

    it('F1.14 对齐填充非零字节', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint8(0, 0x01);     // SAVE (0 payload)
        view.setUint8(4, 0xFF);     // 非零填充! (应为 0x00)
        view.setUint8(5, 0x00); view.setUint8(6, 0x00); view.setUint8(7, 0x00);
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
    });

    it('F1.15 Shader colorCount 伪造', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(100);
        const view = new DataView(buf);
        view.setUint8(0, 0x30);  // DRAW_RECT
        view.setUint8(1, 80);    // payLen
        // paint at payload[16], has_shader at 16+18=34
        view.setUint8(4 + 16 + 18, 1);   // has_shader=1
        view.setUint8(4 + 16 + 19, 0x01); // LINEAR_GRADIENT
        // colorCount at offset 4+16+19+17=56
        view.setUint8(4 + 16 + 19 + 17, 100);  // 100 > MAX_GRADIENT_COLORS(32)
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
    });

    it('F1.16 Shader type 非法值', () => {
        const v = new CommandValidator();
        const buf = new ArrayBuffer(50);
        const view = new DataView(buf);
        view.setUint8(0, 0x30);  // DRAW_RECT
        view.setUint8(1, 46);    // payLen
        view.setUint8(4 + 16 + 18, 1);   // has_shader=1
        view.setUint8(4 + 16 + 19, 0xFF); // shader_type 非法
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
    });
});

// ═══════════════════════════════════════════════════════════════
// F2: gzip 压缩往返 + 边界 (Node.js 兼容)
// ═══════════════════════════════════════════════════════════════
describe('F2: gzip 压缩往返 Fuzz', () => {
    it('F2.1 空命令流帧往返', async () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
            viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        const frame = assembleFrame(meta, Buffer.alloc(0));
        const compressed = await compressFrame(frame);
        assert.ok(compressed.length > 0);
        const decompressed = zlib.gunzipSync(compressed);
        assert.deepStrictEqual(decompressed, frame);
    });

    it('F2.2 随机命令流 100 次往返', async () => {
        for (let i = 0; i < 100; i++) {
            const meta = { frameId: i, timestampMs: Date.now(), scrollX: 0, scrollY: 0,
                viewportW: 100 + i, viewportH: 100 + i, canvasW: 100, canvasH: 100 };
            const cmd = randomBytes(Math.floor(Math.random() * 4096) + 1);
            const frame = assembleFrame(meta, cmd);
            const compressed = await compressFrame(frame);
            const decompressed = zlib.gunzipSync(compressed);
            assert.deepStrictEqual(decompressed, frame);
        }
    });

    it('F2.3 高熵 vs 低熵压缩比', async () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
            viewportW: 1920, viewportH: 1080, canvasW: 1920, canvasH: 1080 };
        // 高熵 (随机) → 低压缩
        const f1 = assembleFrame(meta, randomBytes(65536));
        const c1 = await compressFrame(f1);
        // 低熵 (重复) → 高压缩
        const f2 = assembleFrame(meta, Buffer.alloc(65536, 0x41));
        const c2 = await compressFrame(f2);
        assert.ok(c2.length < c1.length,
            `Low entropy should compress better: ${c2.length} vs ${c1.length}`);
    });

    it('F2.4 超帧大小拒绝', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
            viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        assert.throws(() => {
            assembleFrame(meta, Buffer.alloc(serverConfig.MAX_BYTES_PER_FRAME + 1, 0));
        }, /MAX_BYTES_PER_FRAME/);
    });

    it('F2.5 损坏 gzip 数据抛异常', () => {
        assert.throws(() => { zlib.gunzipSync(randomBytes(100)); });
    });

    it('F2.6 含脏区域的帧往返', async () => {
        const meta = {
            frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
            viewportW: 1920, viewportH: 1080, canvasW: 1920, canvasH: 1080,
            dirtyRects: [{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 300, w: 50, h: 50 }],
        };
        const frame = assembleFrame(meta, randomBytes(1024));
        const compressed = await compressFrame(frame);
        const decompressed = zlib.gunzipSync(compressed);
        assert.deepStrictEqual(decompressed, frame);
        const header = clientUtils.parseFrameHeader(frame);
        assert.strictEqual(header.hasDirtyRects, true);
        assert.strictEqual(header.dirtyRects.length, 2);
    });
});

// ═══════════════════════════════════════════════════════════════
// F3: 帧头解析 Fuzz
// ═══════════════════════════════════════════════════════════════
describe('F3: 帧头解析 Fuzz', () => {
    it('F3.1 过短帧 (<30 bytes)', () => {
        for (let len = 0; len < 30; len++) {
            // 注意: Buffer.buffer 可能大于 len (Node.js Buffer pooling)
            const ab = new ArrayBuffer(len);
            assert.throws(() => clientUtils.parseFrameHeader(ab), /too short/);
        }
    });

    it('F3.2 极端 viewport (0, 0)', () => {
        const frame = makeMinimalFrame({ viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 });
        const header = clientUtils.parseFrameHeader(frame);
        assert.strictEqual(header.viewportW, 0);
    });

    it('F3.3 负 scroll 值', () => {
        const frame = makeMinimalFrame({ scrollX: -9999, scrollY: -9999 });
        const header = clientUtils.parseFrameHeader(frame);
        assert.strictEqual(header.scrollX, -9999);
        assert.strictEqual(header.scrollY, -9999);
    });

    it('F3.4 Canvas 65535 (GPU 纹理上限)', () => {
        const frame = makeMinimalFrame({ canvasW: 65535, canvasH: 65535 });
        const header = clientUtils.parseFrameHeader(frame);
        assert.strictEqual(header.canvasW, 65535);
    });

    it('F3.5 脏区域 count 超限被过滤', () => {
        // 在 30B 帧头后构造超限 count
        const frame = makeMinimalFrame();
        const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
        view.setUint8(1, view.getUint8(1) | 0x04);  // 设置 FLAG_HAS_DIRTY_RECTS
        view.setUint16(30, 200, true);  // count=200 > MAX_DIRTY_RECTS(64)
        const header = clientUtils.parseFrameHeader(frame);
        assert.strictEqual(header.hasDirtyRects, true);
        // 超限 count 被过滤，返回空列表
        assert.strictEqual(header.dirtyRects.length, 0);
    });
});

// ═══════════════════════════════════════════════════════════════
// F4: CRC32 完整性 Fuzz
// ═══════════════════════════════════════════════════════════════
describe('F4: CRC32 完整性 Fuzz', () => {
    it('F4.1 随机篡改单字节 (500 次)', () => {
        let collisions = 0;
        for (let i = 0; i < 500; i++) {
            const frame = makeMinimalFrame();
            const pos = Math.floor(Math.random() * (frame.length - 4));
            const orig = frame[pos];
            frame[pos] = (orig + 1 + Math.floor(Math.random() * 254)) % 256;
            if (clientUtils.validateFrameCRC(frame)) collisions++;
        }
        // 500 次随机篡改中 CRC 碰撞应极少 (理论上 <1)
        assert.ok(collisions < 5, `CRC collisions: ${collisions}/500 (too many)`);
    });

    it('F4.2 CRC 空数据 = 0x00000000', () => {
        assert.strictEqual(computeCRC32(Buffer.alloc(0)), 0x00000000);
    });

    it('F4.3 CRC 1MB 数据不超时', () => {
        const start = Date.now();
        const crc = computeCRC32(randomBytes(1024 * 1024));
        assert.ok(Date.now() - start < 1000, 'CRC32 1MB < 1s');
    });
});

// ═══════════════════════════════════════════════════════════════
// F5: DirtyRects 算法边界
// ═══════════════════════════════════════════════════════════════
describe('F5: DirtyRects 算法 Fuzz', () => {
    it('F5.1 空输入 → 有输出', () => {
        const r = computeDirtyRects(null, []);
        assert.ok(r.length > 0);
    });

    it('F5.2 相同图层 → 最小脏区域', () => {
        const prev = [{ x: 0, y: 0, w: 100, h: 100 }];
        const curr = [{ x: 0, y: 0, w: 100, h: 100 }];
        const r = computeDirtyRects(prev, curr);
        assert.ok(r.length > 0);
    });

    it('F5.3 100 个随机图层 (100 次)', () => {
        for (let t = 0; t < 100; t++) {
            const prev = [], curr = [];
            for (let i = 0; i < 100; i++) {
                prev.push({ x: Math.random()*1000, y: Math.random()*1000,
                    w: Math.random()*500+10, h: Math.random()*500+10 });
                const changed = Math.random() < 0.5;
                curr.push({ x: changed?Math.random()*1000:prev[i].x,
                    y: changed?Math.random()*1000:prev[i].y,
                    w: changed?Math.random()*500+10:prev[i].w,
                    h: changed?Math.random()*500+10:prev[i].h });
            }
            const r = computeDirtyRects(prev, curr);
            assert.ok(r.length > 0);
            assert.ok(r.length <= serverConfig.MAX_DIRTY_RECTS);
        }
    });

    it('F5.4 序列化往返', () => {
        const rects = [{ x: 1, y: 2, w: 100, h: 200 }, { x: 50, y: 60, w: 300, h: 400 }];
        const buf = serializeDirtyRects(rects);
        assert.strictEqual(buf.length, 2 + 2 * 16);
        assert.strictEqual(buf.readUInt16LE(0), 2);
        assert.strictEqual(buf.readFloatLE(2), 1.0);
        assert.strictEqual(buf.readFloatLE(6), 2.0);
    });

    it('F5.5 超限截断到 MAX_DIRTY_RECTS', () => {
        const rects = Array.from({ length: 200 }, (_, i) =>
            ({ x: i, y: i, w: 10, h: 10 }));
        const buf = serializeDirtyRects(rects);
        assert.strictEqual(buf.readUInt16LE(0), serverConfig.MAX_DIRTY_RECTS);
    });
});

// ═══════════════════════════════════════════════════════════════
// F6: 边界值注入
// ═══════════════════════════════════════════════════════════════
describe('F6: 边界值注入', () => {
    it('F6.1 MAX_COMMANDS_PER_FRAME 边界 (刚好超限)', () => {
        const v = new CommandValidator();
        const count = PROTOCOL.LIMITS.MAX_COMMANDS_PER_FRAME + 1;
        const buf = new ArrayBuffer(count * 4);
        const view = new DataView(buf);
        for (let i = 0; i < count; i++) view.setUint8(i * 4, 0x7F);  // NOOP
        const r = v.validate(buf);
        assert.strictEqual(r.valid, false);
    });

    it('F6.2 MAX_COMMANDS_PER_FRAME - 1 (应通过)', () => {
        const v = new CommandValidator();
        const count = PROTOCOL.LIMITS.MAX_COMMANDS_PER_FRAME - 1;
        const buf = new ArrayBuffer(count * 4);
        const view = new DataView(buf);
        for (let i = 0; i < count; i++) view.setUint8(i * 4, 0x7F);
        // 不抛异常即可
        const r = v.validate(buf);
        assert.ok(typeof r.valid === 'boolean');
    });

    it('F6.3 Canvas 尺寸 65536 (>GPU上限)', () => {
        const frame = makeMinimalFrame({ canvasW: 65536, canvasH: 65536 });
        // 帧组装不限制 canvas 尺寸 (限制在客户端)
        assert.ok(frame.length > 0);
    });

    it('F6.4 frame_id=0 (初始值)', () => {
        const frame = makeMinimalFrame({ frameId: 0 });
        const header = clientUtils.parseFrameHeader(frame);
        assert.strictEqual(header.frameId, 0);
    });

    it('F6.5 frame_id=0xFFFFFFFF (uint32 最大值)', () => {
        const frame = makeMinimalFrame({ frameId: 0xFFFFFFFF });
        const header = clientUtils.parseFrameHeader(frame);
        assert.strictEqual(header.frameId, 0xFFFFFFFF);
    });

    it('F6.6 超大时间戳', () => {
        const frame = makeMinimalFrame({ timestampMs: Number.MAX_SAFE_INTEGER });
        const header = clientUtils.parseFrameHeader(frame);
        assert.ok(header.timestampMs > 0);
    });
});
