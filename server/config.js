// config.js — 服务端运行时配置常量
//
// 与 C++ garnet_config.h 中定义的值严格保持一致。
// 所有硬上限在此集中管理，可审计。
//

'use strict';

module.exports = Object.freeze({
    // ── 协议 ──
    PROTOCOL_VERSION: 0x01,

    // ── 帧级硬上限 ──
    MAX_BYTES_PER_FRAME: 64 * 1024 * 1024,       // 64 MB
    MAX_COMPRESSED_FRAME: 4 * 1024 * 1024,        // 4 MB
    MAX_COMPRESSION_RATIO: 1000,                   // 1000:1

    // ── 命令级硬上限 ──
    MAX_PAYLOAD_BYTES: 1 * 1024 * 1024,           // 1 MB
    MAX_COMMANDS_PER_FRAME: 100000,

    // ── 路径/文本子结构上限 ──
    MAX_PATH_VERBS: 100000,
    MAX_TEXT_BLOB_GLYPHS: 50000,
    MAX_VERTICES_COUNT: 100000,
    MAX_ATLAS_COUNT: 100000,

    // ── 缓存上限 ──
    IMAGE_CACHE_BYTES: 64 * 1024 * 1024,          // 64 MB
    FONT_CACHE_BYTES: 64 * 1024 * 1024,           // 64 MB
    MAX_FONT_INLINE_BYTES: 5 * 1024 * 1024,       // 5 MB

    // ── 帧历史 ──
    FRAME_HISTORY_MAX_AGE_MS: 3000,  // 与客户端 protocol.js 保持一致
    FRAME_HISTORY_MAX_ENTRIES: 1000,

    // ── 阈值 ──
    CONSECUTIVE_REJECT_THRESHOLD: 3,
    FRAME_ID_JUMP_THRESHOLD: 1000,

    // ── 超时 (ms) ──
    CHROMIUM_STARTUP_TIMEOUT_MS: 60000,
    PAGE_LOAD_TIMEOUT_MS: 30000,
    CDP_COMMAND_TIMEOUT_MS: 3000,
    SESSION_IDLE_TIMEOUT_MS: 120000,

    // ── 服务端资源 ──
    CHROMIUM_MAX_MEMORY_BYTES: 2 * 1024 * 1024 * 1024,  // 2 GB
    WS_HIGH_WATER_MARK: 1 * 1024 * 1024,                 // 1 MB

    // ── 帧头偏移常量 ──
    FRAME_HEADER_SIZE: 30,
    FRAME_TRAILER_SIZE: 4,  // CRC32

    // ── 标志位 ──
    FLAG_IS_KEYFRAME: 0x01,
    FLAG_HAS_FONT_DATA: 0x02,

    // ── 字体 Magic ──
    SFNT_MAGIC_TRUETYPE:    0x00010000,
    SFNT_MAGIC_OPENTYPE:    0x4F54544F,  // 'OTTO'
    SFNT_MAGIC_APPLE_TRUE:  0x74727565,  // 'true'
    SFNT_MAGIC_COLLECTION:  0x74746366,  // 'ttcf'
    WOFF2_MAGIC:            0x774F4632,  // 'wOF2'

    // ── CRC32 ──
    CRC32_POLYNOMIAL: 0xEDB88320,
});
