// config.js — Wison-RBI 服务端运行时配置常量
//
// === 模块角色 ===
// 本模块是 Wison-RBI 系统所有配置常量的**集中定义点**。
// 架构角色: 配置权威源 (Single Source of Truth)
//
// === 安全不变量 ===
// 所有硬上限常量在此集中管理，确保:
//   1. 每项限制有明确的安全理由（防 DoS / 防压缩炸弹 / 防内存耗尽）
//   2. 与 C++ garnet_config.h 中定义的值严格保持一致（跨语言边界审计）
//   3. Object.freeze() 冻结整个配置对象，防止运行时意外篡改
//
// === 数据流方向 ===
//   无运行时数据流 — 本模块仅导出静态配置常量，
//   被 server.js / frame_builder.js / session.js / font_validator.js 等模块 import。
//
// 威胁模型 (§2.1): 服务端被入侵场景下，攻击者可能尝试修改运行时配置。
//   冻结对象 + 单一定义点降低了篡改面。
//
// === 设计文档交叉引用 ===
//   §6.1 — 帧结构定义（FRAME_HEADER_SIZE=30, FRAME_TRAILER_SIZE=4）
//   §6.2 — 协议版本号（PROTOCOL_VERSION=0x01）
//   §6.3 — 帧级硬上限（MAX_BYTES_PER_FRAME=64MB, MAX_COMPRESSED_FRAME=4MB）
//   §6.4 — 压缩炸弹防护（MAX_COMPRESSION_RATIO=1000:1）
//   §7   — 帧历史配置（FRAME_HISTORY_MAX_AGE_MS=3000ms, FRAME_HISTORY_MAX_ENTRIES=1000）
//   §8   — 错误处理阈值（CONSECUTIVE_REJECT_THRESHOLD=3, FRAME_ID_JUMP_THRESHOLD=1000）
//   §2.1 — TLS 配置（mTLS cipher suites, TLSv1.3 最低版本）
//   §S4  — 字体 Magic 白名单（SFNT_MAGIC_* / WOFF2_MAGIC）
//

'use strict';

module.exports = Object.freeze({
    // ── 协议 (§6.2) ──
    // 协议版本号。客户端在首帧握手时比对，不匹配则拒绝连接。
    PROTOCOL_VERSION: 0x01,

    // ── 帧级硬上限 (§6.3, v1.6 P0 S1) ──
    // MAX_BYTES_PER_FRAME: 单帧（Header+CommandStream+Trailer）的绝对字节上限。
    //   超出此值的帧在组装阶段即被拒绝，防止内存耗尽 DoS。
    MAX_BYTES_PER_FRAME: 64 * 1024 * 1024,       // 64 MB
    // MAX_COMPRESSED_FRAME: gzip 压缩后帧的硬上限，防止压缩炸弹第一层。
    MAX_COMPRESSED_FRAME: 4 * 1024 * 1024,        // 4 MB
    // MAX_COMPRESSION_RATIO: 压缩比异常阈值。若 compressed/original < 1/1000，
    //   判定为 zip bomb 特征（压缩后极小但解压后极大）—— 第二层防护。
    MAX_COMPRESSION_RATIO: 1000,                   // 1000:1

    // ── 命令级硬上限 ──
    // MAX_PAYLOAD_BYTES: 单个 PaintOp 子结构（路径/文本/图像）的最大字节数。
    //   防止单个恶意 Op 耗尽缓冲区。
    MAX_PAYLOAD_BYTES: 1 * 1024 * 1024,           // 1 MB
    // MAX_COMMANDS_PER_FRAME: 每帧最大 PaintOp 数量。
    //   防止攻击者通过海量微小 Op 耗尽 CPU/内存。
    MAX_COMMANDS_PER_FRAME: 100000,

    // ── 路径/文本子结构上限 ──
    // 针对 Skia 特定 API 的参数上限，防止恶意构造的几何/字形数据。
    MAX_PATH_VERBS: 100000,        // SkPath 动词（moveTo/lineTo/cubicTo 等）上限
    MAX_TEXT_BLOB_GLYPHS: 50000,   // 单次 drawTextBlob 字形数上限
    MAX_VERTICES_COUNT: 100000,    // drawVertices 顶点数上限
    MAX_ATLAS_COUNT: 100000,       // drawAtlas 精灵数上限

    // ── 缓存上限 ──
    // IMAGE_CACHE_BYTES: 客户端 ImageCache 总容量，超出则 LRU 淘汰。
    IMAGE_CACHE_BYTES: 64 * 1024 * 1024,          // 64 MB
    // FONT_CACHE_BYTES: 客户端 FontCache 总容量。
    FONT_CACHE_BYTES: 64 * 1024 * 1024,           // 64 MB
    // MAX_FONT_INLINE_BYTES: 帧内联传输单字体文件的最大字节数 (§S4)。
    //   超出此值的字体将被拒绝，客户端使用回退字体。
    MAX_FONT_INLINE_BYTES: 5 * 1024 * 1024,       // 5 MB

    // ── 帧历史 (§7) ──
    // FRAME_HISTORY_MAX_AGE_MS: 帧元数据保留时间。
    //   与客户端 protocol.js 保持一致，用于输入事件坐标回溯。
    FRAME_HISTORY_MAX_AGE_MS: 3000,
    // FRAME_HISTORY_MAX_ENTRIES: 帧历史最大条目数。
    //   防止帧历史 Map 无限增长导致内存泄漏。
    FRAME_HISTORY_MAX_ENTRIES: 1000,

    // ── 阈值 (§8) ──
    // CONSECUTIVE_REJECT_THRESHOLD: 连续帧白名单拒绝触发 request_keyframe 的阈值。
    //   客户端连续收到 ≥3 帧被拒绝后，主动请求关键帧以重置状态。
    CONSECUTIVE_REJECT_THRESHOLD: 3,
    // FRAME_ID_JUMP_THRESHOLD: frame_id 跳跃检测阈值。
    //   若非单调递增超过此值，客户端视为服务端重启。
    FRAME_ID_JUMP_THRESHOLD: 1000,

    // ── 超时 (ms) ──
    // CHROMIUM_STARTUP_TIMEOUT_MS: Chromium 进程启动 + CDP 就绪的最大等待时间。
    //   超时则抛出错误，由上层重试或拒绝会话。
    CHROMIUM_STARTUP_TIMEOUT_MS: 60000,
    // PAGE_LOAD_TIMEOUT_MS: 页面导航完成的最大等待时间。
    PAGE_LOAD_TIMEOUT_MS: 30000,
    // CDP_COMMAND_TIMEOUT_MS: 单个 CDP 命令的等待上限。
    //   防止 Input.dispatchMouseEvent 等命令无限挂起。
    CDP_COMMAND_TIMEOUT_MS: 3000,
    // SESSION_IDLE_TIMEOUT_MS: 会话空闲后自动关闭的等待时间。
    //   释放 Chromium 实例资源。
    SESSION_IDLE_TIMEOUT_MS: 120000,

    // ── 服务端资源 ──
    // CHROMIUM_MAX_MEMORY_BYTES: 单个 Chromium 实例的硬性内存上限（2GB）。
    //   超出时触发进程终止，防止 OOM。
    CHROMIUM_MAX_MEMORY_BYTES: 2 * 1024 * 1024 * 1024,  // 2 GB
    // WS_HIGH_WATER_MARK: WebSocket 发送缓冲区高水位（1MB）。
    //   超出时触发背压检测，丢弃非关键帧以保证低延迟。
    WS_HIGH_WATER_MARK: 1 * 1024 * 1024,                 // 1 MB

    // ── 连接限制 (DoS 防护) ──
    // MAX_CONCURRENT_SESSIONS: 最大并发会话数。超出时拒绝新连接。
    //   防止攻击者通过海量连接耗尽 Chromium 实例池。
    MAX_CONCURRENT_SESSIONS: 100,
    // RATE_LIMIT_MESSAGES_PER_SEC: 每客户端每秒最大消息数。
    //   超出时丢弃消息并警告，防止消息洪水。
    RATE_LIMIT_MESSAGES_PER_SEC: 100,
    // RATE_LIMIT_BURST: 令牌桶突发上限。
    RATE_LIMIT_BURST: 200,

    // ── 帧头偏移常量 (§6.1) ──
    FRAME_HEADER_SIZE: 30,     // 帧头固定 30 字节
    FRAME_TRAILER_SIZE: 4,     // 帧尾: CRC32 (uint32 LE)

    // ── 标志位 (§6.1) ──
    FLAG_IS_KEYFRAME: 0x01,    // 帧头 flags bit 0: 是否为关键帧
    FLAG_HAS_FONT_DATA: 0x02,  // 帧头 flags bit 1: 是否含字体数据
    FLAG_HAS_DIRTY_RECTS: 0x04, // 帧头 flags bit 2: 是否含脏区域矩形 (Phase 4)

    // ── R-tree 增量帧 (§4.1.1) ──
    DIRTY_RECT_ENTRY_SIZE: 16,  // x(f32)+y(f32)+w(f32)+h(f32)
    MAX_DIRTY_RECTS: 64,        // 单帧最大脏区域矩形数

    // ── 字体 Magic 白名单 (§S4, v1.6 P1) ──
    // 仅允许 SFNT 系列和 WOFF2 格式。WOFF v1 (0x774F4646) 明确拒绝。
    // 每个 Magic 以大端序 uint32 存储在字体文件头 4 字节。
    SFNT_MAGIC_TRUETYPE:    0x00010000,  // TrueType (经典 sfVersion)
    SFNT_MAGIC_OPENTYPE:    0x4F54544F,  // 'OTTO' — OpenType CFF
    SFNT_MAGIC_APPLE_TRUE:  0x74727565,  // 'true' — TrueType (Apple)
    SFNT_MAGIC_COLLECTION:  0x74746366,  // 'ttcf' — TrueType Collection
    WOFF2_MAGIC:            0x774F4632,  // 'wOF2' — WOFF2

    // ── CRC32 (§6.1) ──
    // IEEE 802.3 标准多项式，与客户端、zlib crc32 一致。
    CRC32_POLYNOMIAL: 0xEDB88320,

    // ── TLS (§2.1, Phase 3 安全加固) ──
    // 生产环境通过环境变量设置证书路径:
    //   WISON_TLS_CERT=/path/to/fullchain.pem
    //   WISON_TLS_KEY=/path/to/privkey.pem
    //   WISON_TLS_CA=/path/to/ca.pem     (可选, mTLS 双向认证)
    //   WISON_TLS_ENABLED=1
    TLS_DEFAULT_CERT_PATH: process.env.WISON_TLS_CERT || '',
    TLS_DEFAULT_KEY_PATH:  process.env.WISON_TLS_KEY  || '',
    TLS_DEFAULT_CA_PATH:   process.env.WISON_TLS_CA   || '',
    // TLS_CIPHER_SUITE: 仅允许 AEAD 套件（GCM + ChaCha20-Poly1305）。
    //   明确禁用 CBC/RC4/3DES 等已知弱套件。
    TLS_CIPHER_SUITE: [
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256',
    ].join(':'),
    // TLS_MIN_VERSION: 强制 TLS 1.3，禁用所有旧版本。
    TLS_MIN_VERSION: 'TLSv1.3',
    // TLS_HONOR_CIPHER_ORDER: 服务端决定密码套件优先级，防止降级攻击。
    TLS_HONOR_CIPHER_ORDER: true,
});
