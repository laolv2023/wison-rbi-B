// protocol.js — Wison-RBI 协议常量（客户端版）
//
// 与 C++ frame_constants.h 和 server/config.js 保持严格一致。
// 所有常量集中管理，单一事实来源，可审计。
//

'use strict';

const PROTOCOL = Object.freeze({
    // ── 协议版本 ──
    VERSION: 0x01,

    // ── 帧头常量 ──
    FRAME_HEADER_SIZE: 30,
    FRAME_TRAILER_SIZE: 4,  // CRC32 (uint32 LE)

    // ── 帧头字节偏移 ──
    OFFSET_VERSION:      0,
    OFFSET_FLAGS:        1,
    OFFSET_FRAME_ID:     2,
    OFFSET_TIMESTAMP_MS: 6,
    OFFSET_SCROLL_X:     14,
    OFFSET_SCROLL_Y:     18,
    OFFSET_VIEWPORT_W:   22,
    OFFSET_VIEWPORT_H:   24,
    OFFSET_CANVAS_W:     26,
    OFFSET_CANVAS_H:     28,

    // ── 标志位 ──
    FLAG_IS_KEYFRAME:  0x01,
    FLAG_HAS_FONT_DATA: 0x02,

    // ── 命令常量 ──
    COMMAND_HEADER_SIZE: 4,  // opcode(1) + pay_len(3)
    COMMAND_ALIGNMENT: 4,    // 4 字节对齐

    // ── Opcode 枚举 ──
    // 范围: 0x01-0x7F 合法, ≥0x80 非法
    OPCODE: Object.freeze({
        // 状态管理 (0x01-0x0F)
        SAVE:         0x01,
        RESTORE:      0x02,
        SAVE_LAYER:   0x03,

        // 变换 (0x10-0x1F)
        CONCAT:       0x10,
        TRANSLATE:    0x11,
        SCALE:        0x12,
        ROTATE:       0x13,
        CONCAT44:     0x14,

        // 裁剪 (0x20-0x2F)
        CLIP_RECT:    0x20,
        CLIP_RRECT:   0x21,
        CLIP_PATH:    0x22,

        // 形状绘制 (0x30-0x3F)
        DRAW_RECT:    0x30,
        DRAW_RRECT:   0x31,
        DRAW_DRRECT:  0x32,
        DRAW_OVAL:    0x33,
        DRAW_ARC:     0x34,
        DRAW_PATH:    0x35,
        DRAW_POINTS:  0x36,
        DRAW_REGION:  0x37,

        // 图像绘制 (0x40-0x4F)
        DRAW_IMAGE:         0x40,
        DRAW_IMAGE_RECT:    0x41,
        DRAW_IMAGE_LATTICE: 0x42,
        DRAW_ATLAS:         0x43,
        DRAW_PATCH:         0x44,
        DRAW_EDGE_AA_QUAD:  0x45,
        DRAW_EDGE_AA_IMAGE_SET: 0x46,

        // 文本绘制 (0x50-0x5F)
        DRAW_TEXT_BLOB:     0x50,
        DRAW_GLYPH_RUN_LIST: 0x51,

        // 其他绘制 (0x60-0x6F)
        DRAW_PAINT:          0x60,
        DRAW_COLOR:          0x61,
        DRAW_SHADOW:         0x62,
        DRAW_VERTICES_OBJECT: 0x63,
        DRAW_DRAWABLE:       0x64,
        DRAW_ANNOTATION:     0x65,

        // 扩展 (0x70-0x7F)
        FONT_DATA:  0x70,
        IMAGE_DATA: 0x71,
        SET_MATRIX: 0x72,

        // 特殊
        NOOP: 0x7F,
    }),

    // ── 硬上限 ──
    LIMITS: Object.freeze({
        MAX_BYTES_PER_FRAME:      64 * 1024 * 1024,  // 64 MB
        MAX_COMPRESSED_FRAME:     4 * 1024 * 1024,   // 4 MB
        MAX_COMPRESSION_RATIO:    1000,               // 1000:1
        MAX_PAYLOAD_BYTES:        1 * 1024 * 1024,   // 1 MB
        MAX_COMMANDS_PER_FRAME:   100000,
        MAX_PATH_VERBS:           100000,
        MAX_TEXT_BLOB_GLYPHS:     50000,
        MAX_VERTICES_COUNT:       100000,
        MAX_ATLAS_COUNT:          100000,
        IMAGE_CACHE_BYTES:        64 * 1024 * 1024,
        FONT_CACHE_BYTES:         64 * 1024 * 1024,
        MAX_FONT_INLINE_BYTES:    5 * 1024 * 1024,
        FRAME_HISTORY_MAX_AGE_MS: 3000,
        CONSECUTIVE_REJECT_THRESHOLD: 3,
        FRAME_ID_JUMP_THRESHOLD:  1000,
    }),

    // ── CRC32 ──
    CRC32_POLYNOMIAL: 0xEDB88320,

    // ── 字体 Magic ──
    FONT_MAGIC: Object.freeze({
        TRUETYPE:    0x00010000,
        OPENTYPE:    0x4F54544F,
        APPLE_TRUE:  0x74727565,
        COLLECTION:  0x74746366,
        WOFF2:       0x774F4632,
    }),
});

export { PROTOCOL };
