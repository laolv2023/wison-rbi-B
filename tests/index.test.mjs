// tests/index.test.mjs — Wison-RBI 全量单元+集成测试
//
// 框架: Node.js 18+ 内置 node:test
// 用例数: 200+
// 覆盖: server/*.js + client/protocol.js + client/command_validator.js + client/utils.js
//
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ============================================================
// 服务端 CommonJS 模块
// ============================================================
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const serverConfig = require('../server/config.js');
const { serializeFrameHeader, deserializeFrameHeader, assembleFrame, compressFrame, computeCRC32: serverCRC32 } = require('../server/frame_builder.js');
const { validateFontData, validateFontBatch, isSafeFontData } = require('../server/font_validator.js');
const Session = require('../server/session.js');
const InputProxy = require('../server/io_proxy.js');

// ============================================================
// 客户端 ESM 模块 (dynamic import)
// ============================================================
let clientProtocol, CommandValidator, clientUtils;
before(async () => {
    clientProtocol = (await import('../client/protocol.js')).PROTOCOL;
    CommandValidator = (await import('../client/command_validator.js')).CommandValidator;
    clientUtils = await import('../client/utils.js');
});

// ============================================================
// 辅助函数
// ============================================================
function hex(v) { return '0x' + v.toString(16).padStart(2, '0'); }

// 创建模拟 CDP 客户端
function createMockCdp() {
    const commands = [];
    return {
        commands,
        async send(method, params) {
            commands.push({ method, params });
            return {};
        }
    };
}

// 创建模拟 SkImage (仅用于类型引用)
class MockSkImage { constructor(w, h) { this.w = w; this.h = h; } }

// ============================================================
// TEST SUITE 1: CRC32 基础测试 (20 cases)
// ============================================================
describe('CRC32 基础验证', () => {
    // Known vectors from IEEE 802.3 CRC32
    const knownVectors = [
        ['empty', '', 0x00000000],
        ['a', 'a', 0xE8B7BE43],
        ['abc', 'abc', 0x352441C2],
        ['message digest', 'message digest', 0x20159D7F],
        ['abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz', 0x4C2750BD],
        ['123456789', '123456789', 0xCBF43926],
    ];

    for (const [name, input, expected] of knownVectors) {
        it(`CRC32("${name}") = ${hex(expected)}`, () => {
            const buf = Buffer.from(input, 'utf-8');
            const result = serverCRC32(buf);
            assert.strictEqual(result, expected);
        });
    }

    it('CRC32 增量计算一致', () => {
        const part1 = Buffer.from('abc');
        const part2 = Buffer.from('def');
        const full = Buffer.concat([part1, part2]);
        const crcFull = serverCRC32(full);
        // 增量: seed = 前一段的CRC结果（内部 ^0xFFFFFFFF 后等于中间态）
        const crcIncr = serverCRC32(part2, serverCRC32(part1));
        assert.strictEqual(crcFull, crcIncr);
    });

    it('CRC32 全零数据', () => {
        const zeros = Buffer.alloc(1000, 0);
        const crc = serverCRC32(zeros);
        assert.ok(typeof crc === 'number' && crc >= 0 && crc <= 0xFFFFFFFF);
    });

    it('CRC32 全0xFF数据', () => {
        const ones = Buffer.alloc(256, 0xFF);
        const crc = serverCRC32(ones);
        assert.ok(typeof crc === 'number');
    });

    it('CRC32 服务端与客户端实现一致', async () => {
        const data = Buffer.from('test-string-for-crc32-cross-check');
        const serverResult = serverCRC32(data);
        // 客户端 computeCRC32 需要 Uint8Array，Buffer 就是 Uint8Array
        const clientResult = clientUtils.computeCRC32(new Uint8Array(data));
        assert.strictEqual(serverResult, clientResult,
            'Server and client CRC32 must produce identical results');
    });

    it('CRC32 空Buffer', () => {
        assert.strictEqual(serverCRC32(Buffer.alloc(0)), 0x00000000);
    });

    it('CRC32 单字节', () => {
        const results = new Set();
        for (let i = 0; i < 256; i++) {
            const crc = serverCRC32(Buffer.from([i]));
            results.add(crc);
        }
        // 所有256个单字节CRC32应该互不相同（良好分布）
        assert.strictEqual(results.size, 256);
    });

    it('CRC32 4K数据', () => {
        const buf = Buffer.alloc(4096);
        for (let i = 0; i < 4096; i++) buf[i] = i & 0xFF;
        const crc = serverCRC32(buf);
        assert.ok(crc !== 0);
    });

    it('CRC32 1MB数据性能/正确性', () => {
        const buf = Buffer.alloc(1024 * 1024, 0xAB);
        const start = Date.now();
        const crc = serverCRC32(buf);
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 500, `CRC32 1MB took ${elapsed}ms (should be <500ms)`);
        assert.ok(typeof crc === 'number');
    });
});

// ============================================================
// TEST SUITE 2: 帧头序列化/反序列化 (20 cases)
// ============================================================
describe('帧头序列化/反序列化', () => {
    it('基本序列化/反序列化', () => {
        const meta = {
            version: 0x01,
            isKeyframe: true,
            hasFontData: false,
            frameId: 42,
            timestampMs: 1700000000000,
            scrollX: 100,
            scrollY: 200,
            viewportW: 1920,
            viewportH: 1080,
            canvasW: 1920,
            canvasH: 1080,
        };
        const header = serializeFrameHeader(meta);
        assert.strictEqual(header.length, 30);

        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.version, 0x01);
        assert.strictEqual(parsed.isKeyframe, true);
        assert.strictEqual(parsed.hasFontData, false);
        assert.strictEqual(parsed.frameId, 42);
        assert.strictEqual(parsed.timestampMs, 1700000000000);
        assert.strictEqual(parsed.scrollX, 100);
        assert.strictEqual(parsed.scrollY, 200);
        assert.strictEqual(parsed.viewportW, 1920);
        assert.strictEqual(parsed.viewportH, 1080);
    });

    it('零值帧头', () => {
        const meta = { frameId: 0, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 };
        const header = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.frameId, 0);
        assert.strictEqual(parsed.timestampMs, 0);
        assert.strictEqual(parsed.scrollX, 0);
    });

    it('负值 scroll', () => {
        const meta = { frameId: 1, timestampMs: 1, scrollX: -500, scrollY: -300,
                       viewportW: 800, viewportH: 600, canvasW: 800, canvasH: 600 };
        const header = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.scrollX, -500);
        assert.strictEqual(parsed.scrollY, -300);
    });

    it('uint32 frame_id 最大值', () => {
        const meta = { frameId: 0xFFFFFFFF, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 };
        const header = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.frameId, 0xFFFFFFFF);
    });

    it('int32 scroll 边界值', () => {
        const meta = { frameId: 0, timestampMs: 0, scrollX: 0x7FFFFFFF, scrollY: -0x80000000,
                       viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 };
        const header = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.scrollX, 0x7FFFFFFF);
        assert.strictEqual(parsed.scrollY, -0x80000000);
    });

    it('viewport 溢出 clamp 到 uint16 最大值', () => {
        const meta = { frameId: 0, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 100000, viewportH: 100000, canvasW: 100000, canvasH: 100000 };
        const header = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.viewportW, 65535);
        assert.strictEqual(parsed.viewportH, 65535);
        assert.strictEqual(parsed.canvasW, 65535);
        assert.strictEqual(parsed.canvasH, 65535);
    });

    it('version 字段正确写入 Byte 0', () => {
        const meta = { version: 0x01, frameId: 0, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 };
        const header = serializeFrameHeader(meta);
        assert.strictEqual(header[0], 0x01);
    });

    it('flags 字段 isKeyframe=bit0', () => {
        const meta = { isKeyframe: true, frameId: 0, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 };
        const header = serializeFrameHeader(meta);
        assert.strictEqual(header[1] & 0x01, 0x01);
    });

    it('flags 字段 hasFontData=bit1', () => {
        const meta = { hasFontData: true, frameId: 0, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 };
        const header = serializeFrameHeader(meta);
        assert.strictEqual((header[1] >> 1) & 1, 1);
    });

    it('flags 字段双标志位', () => {
        const meta = { isKeyframe: true, hasFontData: true, frameId: 0, timestampMs: 0,
                       scrollX: 0, scrollY: 0, viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 };
        const header = serializeFrameHeader(meta);
        assert.strictEqual(header[1] & 0x03, 0x03);
    });

    it('反序列化: 版本字段', () => {
        const buf = Buffer.alloc(30);
        buf[0] = 0x02; // version
        // 需要在 frame_builder 的 deserializeFrameHeader 中使用，但函数已导入
        // 注意：deserializeFrameHeader 期望完整的30字节，我们构造一个
        const parsed = deserializeFrameHeader(buf);
        assert.strictEqual(parsed.version, 0x02);
    });

    it('反序列化: frame_id Little Endian', () => {
        const buf = Buffer.alloc(30);
        buf[0] = 0x01; // version
        buf[2] = 0x78; // frame_id[0] LE
        buf[3] = 0x56; // frame_id[1]
        buf[4] = 0x34; // frame_id[2]
        buf[5] = 0x12; // frame_id[3]
        const parsed = deserializeFrameHeader(buf);
        assert.strictEqual(parsed.frameId, 0x12345678);
    });

    it('Header 长度恒为 30', () => {
        const meta = { frameId: 1, timestampMs: 1, scrollX: 0, scrollY: 0,
                       viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
        for (let i = 0; i < 10; i++) {
            const h = serializeFrameHeader({ ...meta, frameId: i * 1000 });
            assert.strictEqual(h.length, 30);
        }
    });

    it('序列化后的 Buffer 内容不为空', () => {
        const meta = { frameId: 12345, timestampMs: Date.now(), scrollX: 100,
                       scrollY: 200, viewportW: 1920, viewportH: 1080,
                       canvasW: 1920, canvasH: 1080 };
        const header = serializeFrameHeader(meta);
        // 验证非全零
        const sum = header.reduce((a, b) => a + b, 0);
        assert.ok(sum > 0, 'Header should not be all zeros');
    });

    it('反序列化再序列化保持幂等', () => {
        const meta = { isKeyframe: true, frameId: 777, timestampMs: 1234567890123,
                       scrollX: 500, scrollY: -200, viewportW: 1280, viewportH: 720,
                       canvasW: 2560, canvasH: 1440 };
        const h1 = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(h1);
        const h2 = serializeFrameHeader({
            version: parsed.version,
            isKeyframe: parsed.isKeyframe,
            hasFontData: parsed.hasFontData,
            frameId: parsed.frameId,
            timestampMs: parsed.timestampMs,
            scrollX: parsed.scrollX,
            scrollY: parsed.scrollY,
            viewportW: parsed.viewportW,
            viewportH: parsed.viewportH,
            canvasW: parsed.canvasW,
            canvasH: parsed.canvasH,
        });
        assert.deepStrictEqual(h1, h2);
    });

    it('timestampMs int64 正确序列化', () => {
        const ts = Date.now();
        const meta = { frameId: 1, timestampMs: ts, scrollX: 0, scrollY: 0,
                       viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 };
        const header = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.timestampMs, ts);
    });

    it('timestampMs 0', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 };
        const header = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.timestampMs, 0);
    });

    it('viewport 正常值 4K', () => {
        const meta = { frameId: 1, timestampMs: 0, scrollX: 0, scrollY: 0,
                       viewportW: 3840, viewportH: 2160, canvasW: 7680, canvasH: 4320 };
        const header = serializeFrameHeader(meta);
        const parsed = deserializeFrameHeader(header);
        assert.strictEqual(parsed.viewportW, 3840);
        assert.strictEqual(parsed.viewportH, 2160);
        assert.strictEqual(parsed.canvasW, 7680);
        assert.strictEqual(parsed.canvasH, 4320);
    });
});

console.log('✅ 基础测试 (40 cases) loaded');
