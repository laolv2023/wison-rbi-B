// protocol.js — Wison-RBI 协议常量（客户端版）
//
// ## 模块角色 (§6 通信协议规范)
//   此模块是客户端与服务端之间所有数值常量的「单一事实来源」(Single Source of Truth)。
//   与 C++ 端 frame_constants.h 和 server/config.js 保持严格一致。
//   任何修改必须同步更新三处，否则将导致版本不匹配错误 (§8.4)。
//
// ## 安全不变量
//   - Opcode 白名单基础: 0x01-0x7F 合法, ≥0x80 一律非法 (§2.2 不变量 1)
//   - 所有硬上限 (LIMITS) 的默认值均在 CommandValidator 中强制执行
//   - CRC32 多项式选用 IEEE 802.3 标准 (0xEDB88320)，与 zlib/gzip 兼容
//   - 字体 Magic 白名单对准 SFNT/WOFF2 格式标准 (§8.4 P1 S4)
//   - 所有对象通过 Object.freeze() 深度冻结，运行时不可篡改
//
// ## 协议版本语义
//   VERSION 字段嵌入每帧帧头 (offset 0)，客户端必须拒绝不匹配的帧并发送
//   'version_error' 事件。升级策略: 主版本号变更 = 不兼容，需客户端更新。
//
// ## 设计文档交叉引用
//   - §6.1: 协议总览 (消息方向、信道要求)
//   - §6.2: 帧消息二进制格式 (帧头 30B 布局、对齐)
//   - §6.5: 错误消息规范 (version_error 码)
//   - §8.4: 安全边界 (各限制值的威胁模型依据)
//

'use strict';

/**
 * 全局协议常量对象。
 * 使用 Object.freeze() 深度冻结，防止运行时被意外或恶意修改。
 * 这是「不变量 1」的基础 — 只有此白名单中的 opcode 才允许在客户端执行。
 *
 * @constant {object} PROTOCOL
 */
const PROTOCOL = Object.freeze({
    // ── 协议版本 ──
    /**
     * 当前协议版本号。
     * 写入每帧帧头 offset 0。客户端收到的帧版本与此不匹配时，
     * 必须发送 'version_error' 事件并丢弃该帧。
     * 参考: §6.2 (Frame 消息格式 v1.6)
     */
    VERSION: 0x01,

    // ── 帧头常量 ──
    /**
     * 帧头大小 (字节)。
     * 布局: version(1) + flags(1) + frame_id(4) + timestamp(8)
     *       + scroll_x(4) + scroll_y(4) + viewport_w(2) + viewport_h(2)
     *       + canvas_w(2) + canvas_h(2) = 30 字节
     * 参考: §6.2 帧头字节偏移表
     */
    FRAME_HEADER_SIZE: 30,
    /**
     * 帧尾大小 (字节): 仅包含 CRC32 (uint32 LE)。
     * CRC 覆盖范围 = Header(30B) + CommandStream(N B)，不包含 Trailer 自身。
     * 参考: §6.2 尾部校验
     */
    FRAME_TRAILER_SIZE: 4,  // CRC32 (uint32 LE)

    // ── 帧头字节偏移 ──
    // 每个偏移量表示该字段在帧头中的起始字节位置。
    // 使用小端序 (LE) 编码多字节数值。
    /** @constant {number} 协议版本号 (uint8) */
    OFFSET_VERSION:      0,
    /** @constant {number} 标志位 (uint8): bit0=isKeyframe, bit1=hasFontData */
    OFFSET_FLAGS:        1,
    /** @constant {number} 帧 ID (uint32 LE): 服务端 compositor_frame_seq_ 单调递增计数器 */
    OFFSET_FRAME_ID:     2,
    /** @constant {number} 帧时间戳 (int64 LE): 服务端采集时刻的毫秒时间戳 */
    OFFSET_TIMESTAMP_MS: 6,
    /** @constant {number} 水平滚动偏移 (int32 LE): 用于输入坐标转换 (§7.3) */
    OFFSET_SCROLL_X:     14,
    /** @constant {number} 垂直滚动偏移 (int32 LE) */
    OFFSET_SCROLL_Y:     18,
    /** @constant {number} 视口宽度 (uint16 LE): CSS 像素 */
    OFFSET_VIEWPORT_W:   22,
    /** @constant {number} 视口高度 (uint16 LE): CSS 像素 */
    OFFSET_VIEWPORT_H:   24,
    /** @constant {number} Canvas 绘制面宽度 (uint16 LE): 可能 > viewport (包含滚动区域) */
    OFFSET_CANVAS_W:     26,
    /** @constant {number} Canvas 绘制面高度 (uint16 LE) */
    OFFSET_CANVAS_H:     28,

    // ── 标志位 ──
    /**
     * 标志位: 此帧是否为关键帧。
     * 关键帧包含完整的页面快照，客户端必须清空画布后重放。
     * 增量帧仅包含自上一帧以来的变更，在已有内容上叠加渲染。
     * 参考: §6.2 标志位定义
     */
    FLAG_IS_KEYFRAME:  0x01,
    /**
     * 标志位: 此帧是否包含内联字体数据。
     * 设置时，帧的 CommandStream 中包含 FONT_DATA (0x70) 命令。
     * 参考: §8.4 P1 S4 字体内联校验
     */
    FLAG_HAS_FONT_DATA: 0x02,

    // ── 命令常量 ──
    /**
     * 命令头大小 (字节): opcode(1B) + payload 长度(3B, 小端序 uint24)
     * 每条命令 = COMMAND_HEADER_SIZE + payload 长度 + 4字节对齐填充
     */
    COMMAND_HEADER_SIZE: 4,  // opcode(1) + pay_len(3)
    /**
     * 命令对齐粒度: 4 字节。
     * 每条命令末尾填充 0x00 字节到 4 字节边界，
     * 由 CommandValidator 验证填充字节全零。
     */
    COMMAND_ALIGNMENT: 4,    // 4 字节对齐

    // ── Opcode 枚举 ──
    // 范围: 0x01-0x7F 合法, ≥0x80 非法 (§2.2 不变量 1)
    // 新 opcode 必须在 command_validator.js 中添加对应的子结构校验逻辑。
    // 枚举值对照 Skia SkCanvas 方法，参考 recording_canvas.h 的序列化格式。
    OPCODE: Object.freeze({
        // 状态管理 (0x01-0x0F): 对应 SkCanvas::save/restore/saveLayer
        SAVE:         0x01,
        RESTORE:      0x02,
        SAVE_LAYER:   0x03,

        // 变换 (0x10-0x1F): 对应 SkCanvas::concat/translate/scale/rotate
        CONCAT:       0x10,
        TRANSLATE:    0x11,
        SCALE:        0x12,
        ROTATE:       0x13,
        CONCAT44:     0x14,

        // 裁剪 (0x20-0x2F): 对应 SkCanvas::clipRect/clipRRect/clipPath
        CLIP_RECT:    0x20,
        CLIP_RRECT:   0x21,
        CLIP_PATH:    0x22,

        // 形状绘制 (0x30-0x3F): 对应 SkCanvas::drawRect/drawRRect/.../drawRegion
        DRAW_RECT:    0x30,
        DRAW_RRECT:   0x31,
        DRAW_DRRECT:  0x32,
        DRAW_OVAL:    0x33,
        DRAW_ARC:     0x34,
        DRAW_PATH:    0x35,
        DRAW_POINTS:  0x36,
        DRAW_REGION:  0x37,

        // 图像绘制 (0x40-0x4F): 对应 SkCanvas::drawImage/drawImageRect/.../drawAtlas
        DRAW_IMAGE:         0x40,
        DRAW_IMAGE_RECT:    0x41,
        DRAW_IMAGE_LATTICE: 0x42,
        DRAW_ATLAS:         0x43,
        DRAW_PATCH:         0x44,
        DRAW_EDGE_AA_QUAD:  0x45,
        DRAW_EDGE_AA_IMAGE_SET: 0x46,

        // 文本绘制 (0x50-0x5F): 对应 SkCanvas::drawTextBlob/drawGlyphRunList
        DRAW_TEXT_BLOB:     0x50,
        DRAW_GLYPH_RUN_LIST: 0x51,

        // 其他绘制 (0x60-0x6F): 对应 SkCanvas::drawPaint/drawColor/.../drawAnnotation
        DRAW_PAINT:          0x60,
        DRAW_COLOR:          0x61,
        DRAW_SHADOW:         0x62,
        DRAW_VERTICES_OBJECT: 0x63,
        DRAW_DRAWABLE:       0x64,
        DRAW_ANNOTATION:     0x65,

        // 扩展 (0x70-0x7F): 自定义命令，非 SkCanvas 方法直接映射
        FONT_DATA:  0x70,   // 内联字体数据传输 (§8.4 P1 S4)
        IMAGE_DATA: 0x71,   // 图像 hash-ref 或内联传输 (§4.1.4)
        SET_MATRIX: 0x72,   // 直接设置 CTM 矩阵

        // 特殊
        NOOP: 0x7F,          // 无操作，用于对齐/批量填充
    }),

    // ── 硬上限 ──
    // 所有限制值的威胁模型依据见 §8.4 安全边界。
    // 修改任何值必须评估对 zip bomb / OOM / DoS 防护的影响。
    LIMITS: Object.freeze({
        /** 解压后单帧最大字节数 (64MB)。防止内存耗尽。v1.6 P0 S1 引入帧级校验。 */
        MAX_BYTES_PER_FRAME:      64 * 1024 * 1024,  // 64 MB
        /** 压缩帧在传输层的最大字节数 (4MB)。第一层 zip bomb 防护。 */
        MAX_COMPRESSED_FRAME:     4 * 1024 * 1024,   // 4 MB
        /** 最大允许的压缩比 (1000:1)。超过该比例视为 zip bomb，拒绝帧。 */
        MAX_COMPRESSION_RATIO:    1000,               // 1000:1
        /** 单条命令 payload 最大字节数 (1MB)。防止单命令内存炸弹。 */
        MAX_PAYLOAD_BYTES:        1 * 1024 * 1024,   // 1 MB
        /** 单帧最大命令数。防止无限循环、拒绝服务。 */
        MAX_COMMANDS_PER_FRAME:   100000,
        /** drawPath 最大 verb 数 (100k)。防止路径炸弹导致 OOM。 */
        MAX_PATH_VERBS:           100000,
        /** drawTextBlob 最大字形数 (50k)。防止字形炸弹。 */
        MAX_TEXT_BLOB_GLYPHS:     50000,
        /** drawVertices 最大顶点数 (100k)。防止顶点炸弹。 */
        MAX_VERTICES_COUNT:       100000,
        /** drawAtlas 最大 sprite 数量 (100k)。防止图集炸弹。 */
        MAX_ATLAS_COUNT:          100000,
        /** 图像 LRU 缓存最大容量 (64MB)。§4.1.4 hash-ref 模式。 */
        IMAGE_CACHE_BYTES:        64 * 1024 * 1024,
        /** 字体注册表最大容量 (64MB)。§5 客户端字体管理。 */
        FONT_CACHE_BYTES:         64 * 1024 * 1024,
        /** 单次内联字体数据最大字节 (5MB)。超过则拒绝并回退到系统字体。 */
        MAX_FONT_INLINE_BYTES:    5 * 1024 * 1024,
        /** 帧元数据最大保留时间 (3s)。超时的帧元数据在 pruneFrameMetadata 中清理。 */
        FRAME_HISTORY_MAX_AGE_MS: 3000,
        /** 连续拒绝帧数阈值。达到后客户端发送 request_keyframe 请求全量刷新。 */
        CONSECUTIVE_REJECT_THRESHOLD: 3,
        /** frame_id 跳变阈值。检测服务端重启 (frame_id 归零) 或异常帧丢弃。 */
        FRAME_ID_JUMP_THRESHOLD:  1000,
    }),

    // ── CRC32 ──
    /**
     * CRC32 多项式: 0xEDB88320 (IEEE 802.3 标准)。
     * 反射多项式，初始值 0xFFFFFFFF，输出异或 0xFFFFFFFF。
     * 与 zlib/gzip/PKZIP 兼容，便于调试时使用标准工具验证。
     */
    CRC32_POLYNOMIAL: 0xEDB88320,

    // ── 字体 Magic ──
    /**
     * 合法字体格式的 Magic 字节 (大端序前 4 字节)。
     * 用于 FontRegistry._validateFontMagic() 的白名单校验 (§8.4 P1 S4)。
     * 不在该集合中的 Magic 一律拒绝，字体回退到 CanvasKit 默认字体 (font_id=0)。
     */
    FONT_MAGIC: Object.freeze({
        TRUETYPE:    0x00010000,   // 'true' (经典 TrueType, Microsoft)
        OPENTYPE:    0x4F54544F,   // 'OTTO' (OpenType with CFF outlines)
        APPLE_TRUE:  0x74727565,   // 'true' (Apple 旧版 TrueType)
        COLLECTION:  0x74746366,   // 'ttcf' (TrueType Collection / TTC)
        WOFF2:       0x774F4632,   // 'wOF2' (WOFF2 压缩格式)
    }),

    // ── Shader 类型 (Phase 2) ──
    /**
     * Shader 变体类型枚举。
     * 对应 readShader() 中的分支逻辑 (§5.5 客户端 Shader 反序列化)。
     * NONE (0x00) 表示无 shader，画刷使用纯色填充。
     */
    SHADER_TYPE: Object.freeze({
        NONE:              0x00,
        LINEAR_GRADIENT:   0x01,   // SkShader::MakeLinearGradient
        RADIAL_GRADIENT:   0x02,   // SkShader::MakeRadialGradient
        SWEEP_GRADIENT:    0x03,   // SkShader::MakeSweepGradient
        CONICAL_GRADIENT:  0x04,   // SkShader::MakeTwoPointConicalGradient
    }),

    // ── TileMode (Skia SkTileMode) ──
    /**
     * 渐变/图像平铺模式。
     * 值与 Skia C++ 枚举 SkTileMode 保持一致，可直接传入 CanvasKit API。
     */
    TILE_MODE: Object.freeze({
        CLAMP:  0,   // 边缘颜色延伸 (默认)
        REPEAT: 1,   // 重复平铺
        MIRROR: 2,   // 镜像重复
        DECAL:  3,   // 透明填充 (仅在透明黑色下可见)
    }),

    // ── Shader 头部大小 (不含颜色表) ──
    /**
     * 每种 Shader 类型的序列化头部字节数。
     * 包含: 几何参数 + tileMode(1B) + colorCount(1B) + 2B 填充。
     * 颜色表附加在头部之后: colorCount × 8B (RGBA u32 + position f32)。
     * 该映射用于 CommandValidator._validatePaintShader() 的边界检查。
     */
    SHADER_HEADER_SIZE: {
        0x01: 20,  // LinearGradient: sx,sy,ex,ey (4×f32) + tileMode + colorCount + 2B pad
        0x02: 20,  // RadialGradient: cx,cy,r (3×f32) + _pad(4B) + tileMode + colorCount + 2B pad
        0x03: 20,  // SweepGradient:  cx,cy,sa,ea (4×f32) + tileMode + colorCount + 2B pad
        0x04: 28,  // Conical:       sx,sy,sr,ex,ey,er (6×f32) + tileMode + colorCount + 2B pad
    },

    // ── 渐变颜色停止点最大数量 ──
    /**
     * Shader 渐变的最大颜色停止点数。
     * 防止攻击者发送超大数据结构的颜色表导致 OOM。
     * 32 个停止点覆盖所有合理的渐变用途 (CSS 规范也无此限制，但实际无限会 OOM)。
     */
    MAX_GRADIENT_COLORS: 32,
});

export { PROTOCOL };
