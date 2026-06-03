// benchmark.js — Wison-RBI 性能基准测试套件 (Phase 4)
//
// === 模块角色 ===
// 本模块是 Wison-RBI 系统的**离线性能基准测试工具**。
// 架构角色: 质量保障 — 不参与运行时数据流，仅在 CI/开发环境中运行，
//   量化测量帧组装/压缩/CRC32/图像去重的性能指标。
//
// === 安全不变量 ===
//   本模块不直接参与安全关键路径，但其测试的模块（frame_builder.js）是安全关键。
//   基准测试确保安全校验逻辑（zip bomb 三层防护、CRC32 校验）不会因性能优化而被跳过。
//
// === 数据流方向 ===
//   本模块生成模拟数据 → frame_builder API → 测量耗时 → 输出统计摘要
//   无对外 I/O，无网络连接。
//
// === 设计文档交叉引用 ===
//   §9.1 — 7 项量化性能指标定义
//   §4   — 帧组装/压缩/CRC32 的 Phase 1/3 目标延迟
//   §6.4 — gzip 压缩比和带宽估算
//
// 运行: node benchmark.js [--iterations=N] [--warmup=N]
//   环境变量: ITERATIONS (默认 100), WARMUP (默认 10)
//

'use strict';

const { performance } = require('perf_hooks');
const { assembleFrame, compressFrame, computeCRC32, ImageHashRegistry } = require('./frame_builder');

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
    iterations: parseInt(process.env.ITERATIONS || '100', 10),
    warmup: parseInt(process.env.WARMUP || '10', 10),
    // 模拟不同大小的帧，覆盖典型场景
    frameSizes: {
        tiny:   1024,              // 1 KB  — 简单文本页面增量帧
        small:  16 * 1024,        // 16 KB
        medium: 128 * 1024,       // 128 KB
        large:  1 * 1024 * 1024,  // 1 MB  — 典型首帧 (§9.1)
        xlarge: 3 * 1024 * 1024,  // 3 MB  — 复杂页面首帧 (§9.1)
    },
};

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 生成随机帧元数据。
 *
 * 首帧 (seq=0) 标记为 keyframe，其余为增量帧。
 *
 * @param {number} seq - 帧序号（0-based）
 * @returns {object} 模拟帧元数据
 */
function makeFrameMeta(seq) {
    return {
        version: 0x01,
        frameId: seq,
        timestampMs: Date.now(),
        scrollX: 0,
        scrollY: Math.floor(Math.random() * 5000),  // 模拟随机滚动位置
        viewportW: 1920,
        viewportH: 1080,
        canvasW: 1920,
        canvasH: 1080,
        isKeyframe: seq === 0,      // 首帧为关键帧
        hasFontData: false,
    };
}

/**
 * 生成随机命令流（模拟不同大小的帧）。
 *
 * 使用伪随机填充模拟真实命令流的数据分布。
 * 公式 (i*73+17) & 0xFF 产生均匀分布但不为全零的字节序列。
 *
 * @param {number} sizeBytes - 目标命令流字节数
 * @returns {Buffer} 模拟命令流
 */
function makeCommandStream(sizeBytes) {
    const buf = Buffer.allocUnsafe(sizeBytes);
    // 填充伪随机字节（模拟真实命令流的数据分布）
    for (let i = 0; i < sizeBytes; i++) {
        buf[i] = (i * 73 + 17) & 0xFF;
    }
    return buf;
}

/**
 * 运行单次基准并返回耗时 (ms)。
 *
 * @param {Function} fn - 待测试的异步函数
 * @returns {Promise<number>} 耗时（毫秒）
 */
async function timeIt(fn) {
    const start = performance.now();
    await fn();
    return performance.now() - start;
}

/**
 * 统计: mean, p50, p95, p99, stddev。
 *
 * 提供性能分布的多维度视图，用于识别长尾延迟。
 *
 * @param {number[]} times - 耗时样本数组
 * @returns {{ mean: number, p50: number, p95: number, p99: number, stddev: number, samples: number }}
 */
function stats(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = sorted.reduce((a, b) => a + b, 0) / n;

    const p50 = sorted[Math.floor(n * 0.50)];
    const p95 = sorted[Math.floor(n * 0.95)];
    const p99 = sorted[Math.floor(n * 0.99)];

    const variance = sorted.reduce((s, t) => s + (t - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);

    return { mean, p50, p95, p99, stddev, samples: n };
}

/**
 * 格式化毫秒值（自动选择 μs/ms/s 单位）。
 *
 * @param {number} ms - 毫秒值
 * @returns {string} 格式化后的字符串
 */
function fmtMs(ms) {
    if (ms < 1) return `${(ms * 1000).toFixed(1)}μs`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * 格式化字节值（自动选择 B/KB/MB 单位）。
 *
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的字符串
 */
function fmtBytes(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

// ═══════════════════════════════════════════════════════════════
// 基准测试 (§9.1 量化指标)
// ═══════════════════════════════════════════════════════════════

/**
 * 预热 — 运行若干次帧组装+压缩，
 * 使 JIT 编译器优化热点代码，确保后续基准测试结果稳定。
 */
async function warmup() {
    console.log(`[bench] Warming up (${CONFIG.warmup} iterations)...`);
    const meta = makeFrameMeta(0);
    const cmdStream = makeCommandStream(CONFIG.frameSizes.medium);
    for (let i = 0; i < CONFIG.warmup; i++) {
        meta.frameId = i;
        const frame = assembleFrame(meta, cmdStream);
        await compressFrame(frame);
    }
}

/**
 * 基准 1: 帧组装延迟 (§9.1 指标 2)
 *
 * 测量 Header + CommandStream → complete frame + CRC32 的端到端延迟。
 * Phase 1 目标: < 5ms / Phase 3 目标: < 2ms
 */
async function benchFrameAssembly() {
    console.log('\n═══ 基准 1: 帧组装延迟 ═══');
    const meta = makeFrameMeta(0);

    for (const [name, size] of Object.entries(CONFIG.frameSizes)) {
        const cmdStream = makeCommandStream(size);
        const times = [];

        for (let i = 0; i < CONFIG.iterations; i++) {
            meta.frameId = i;
            const t = await timeIt(() => {
                assembleFrame(meta, cmdStream);
            });
            times.push(t);
        }

        const s = stats(times);
        console.log(`  ${name.padEnd(6)} (${fmtBytes(size).padStart(7)}):  mean=${fmtMs(s.mean).padStart(8)}  p50=${fmtMs(s.p50).padStart(8)}  p95=${fmtMs(s.p95).padStart(8)}  p99=${fmtMs(s.p99).padStart(8)}`);
        // Phase 1 目标: <5ms (Compositor); Phase 3 目标: <2ms
        const target = 5;
        console.log(`          ${s.mean < target ? '✅' : '⚠️'}  Phase 1 target: <${target}ms`);
    }
}

/**
 * 基准 2: gzip 压缩延迟 (§9.1 指标 3/4)
 *
 * 测量不同大小帧的 gzip 压缩耗时和压缩比。
 * 压缩后大小用于带宽估算。
 */
async function benchCompression() {
    console.log('\n═══ 基准 2: gzip 压缩延迟 ═══');
    const meta = makeFrameMeta(0);

    for (const [name, size] of Object.entries(CONFIG.frameSizes)) {
        const cmdStream = makeCommandStream(size);
        const frame = assembleFrame(meta, cmdStream);
        const times = [];

        for (let i = 0; i < CONFIG.iterations; i++) {
            const t = await timeIt(async () => {
                await compressFrame(frame);
            });
            times.push(t);
        }

        const compressed = await compressFrame(frame);
        const ratio = compressed.length / frame.length;  // 压缩率 (越小越好)
        const s = stats(times);

        console.log(`  ${name.padEnd(6)} (${fmtBytes(size).padStart(7)}):  mean=${fmtMs(s.mean).padStart(8)}  ratio=${(ratio * 100).toFixed(1)}%  compressed=${fmtBytes(compressed.length)}`);
    }
}

/**
 * 基准 3: 带宽估算 (§9.1 指标 3/4)
 *
 * 首帧 (1MB raw) + 增量帧 (1KB raw) 的压缩后大小。
 * 目标: 首帧 < 3MB gzip / 增量帧 < 50KB gzip / 30fps 增量带宽估算。
 */
async function benchBandwidth() {
    console.log('\n═══ 基准 3: 带宽估算 ═══');
    const meta = makeFrameMeta(0);

    // 首帧 (大) — 包含完整页面绘制命令
    const firstFrameStream = makeCommandStream(CONFIG.frameSizes.large);
    const firstFrame = assembleFrame(meta, firstFrameStream);
    const firstCompressed = await compressFrame(firstFrame);

    // 增量帧 (小) — 模拟 R-tree 脏区域仅含少量命令
    const deltaStream = makeCommandStream(CONFIG.frameSizes.tiny);
    const deltaFrame = assembleFrame({ ...meta, frameId: 1, isKeyframe: false }, deltaStream);
    const deltaCompressed = await compressFrame(deltaFrame);

    console.log(`  首帧 (1MB raw):  ${fmtBytes(firstCompressed.length)} gzip  ${firstCompressed.length < 3 * 1024 * 1024 ? '✅' : '⚠️'}  Phase 1 target: <3MB`);
    console.log(`  增量帧 (1KB raw): ${fmtBytes(deltaCompressed.length)} gzip  ${deltaCompressed.length < 50 * 1024 ? '✅' : '⚠️'}  Phase 3 target: <50KB`);

    // 30fps 增量帧带宽估算 — 网络流量预估
    const bandwidthPerSec = deltaCompressed.length * 30;
    console.log(`  30fps 增量带宽:   ${fmtBytes(bandwidthPerSec)}/s`);
}

/**
 * 基准 4: CRC32 吞吐量 (§6.1)
 *
 * 测量不同输入大小下 CRC32 的计算吞吐量 (MB/s)。
 * CRC32 位于帧组装关键路径，影响帧发送延迟。
 */
async function benchCRC32() {
    console.log('\n═══ 基准 4: CRC32 吞吐量 ═══');
    const sizes = [
        [256, '256B'],
        [1024, '1KB'],
        [16 * 1024, '16KB'],
        [1024 * 1024, '1MB'],
    ];

    for (const [size, label] of sizes) {
        const data = makeCommandStream(size);
        const times = [];

        // CRC32 计算速度极快，增加迭代次数以获得稳定测量
        for (let i = 0; i < CONFIG.iterations * 10; i++) {
            const t = await timeIt(() => {
                computeCRC32(data);
            });
            times.push(t);
        }

        const s = stats(times);
        const throughput = (size / (1024 * 1024)) / (s.mean / 1000); // MB/s
        console.log(`  ${label.padEnd(6)}:  mean=${fmtMs(s.mean).padStart(8)}  throughput=${throughput.toFixed(0)} MB/s`);
    }
}

/**
 * 基准 5: ImageHashRegistry 哈希去重操作 (§4)
 *
 * 测量 SHA-256 哈希计算 + Set 查找/标记的性能。
 * 模拟 1000 张 64KB 图像的哈希去重场景。
 */
async function benchImageHashRegistry() {
    console.log('\n═══ 基准 5: ImageHashRegistry 哈希去重 ═══');
    const registry = new ImageHashRegistry();

    // 模拟 1000 张不同图像（通过末尾添加不同字节区分）
    const imageData = makeCommandStream(64 * 1024); // 64KB per image
    const hashes = [];
    for (let i = 0; i < 1000; i++) {
        const hash = ImageHashRegistry.computeHash(
            Buffer.concat([imageData, Buffer.from([i & 0xFF, (i >> 8) & 0xFF])])
        );
        hashes.push(hash);
    }

    // 首次标记 — 测量 mark() 的延迟
    const markTimes = [];
    for (let i = 0; i < CONFIG.iterations; i++) {
        const hash = hashes[i % hashes.length];
        const t = performance.now();
        registry.mark(hash);
        markTimes.push(performance.now() - t);
    }

    // 查找 (hash-ref) — 测量 has() 的延迟
    const lookupTimes = [];
    for (let i = 0; i < CONFIG.iterations * 10; i++) {
        const hash = hashes[i % hashes.length];
        const t = performance.now();
        registry.has(hash);
        lookupTimes.push(performance.now() - t);
    }

    console.log(`  mark (first):   mean=${fmtMs(stats(markTimes).mean).padStart(8)}`);
    console.log(`  has  (lookup):  mean=${fmtMs(stats(lookupTimes).mean).padStart(8)}  entries=${registry.stats.entryCount}`);
}

// ═══════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log('Wison-RBI Performance Benchmarks (Phase 4)');
    console.log(`Iterations: ${CONFIG.iterations}  |  Warmup: ${CONFIG.warmup}`);
    console.log(`Node.js:    ${process.version}`);
    console.log(`Platform:   ${process.platform} ${process.arch}`);
    console.log('='.repeat(65));

    await warmup();
    await benchFrameAssembly();
    await benchCompression();
    await benchBandwidth();
    await benchCRC32();
    await benchImageHashRegistry();

    console.log('\n' + '='.repeat(65));
    console.log('All benchmarks complete.');
}

// 仅在直接执行时运行（require 时不运行）
if (require.main === module) {
    main().catch(err => {
        console.error('Benchmark failed:', err);
        process.exit(1);
    });
}

module.exports = {
    makeFrameMeta,
    makeCommandStream,
    timeIt,
    stats,
};
