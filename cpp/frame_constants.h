// frame_constants.h — 帧协议常量定义 (协议单一事实来源)
//
// ═══════════════════════════════════════════════════════════════════════════════
// 模块在 Wison-RBI 架构中的角色
// ═══════════════════════════════════════════════════════════════════════════════
// 本文件定义帧协议的二进制常量，是以下三端的单一事实来源 (Single Source of Truth):
//   - C++ 服务端: garnet/ 目录下的 CommandBuffer, SerializeFrameHeader 等
//   - Node.js 协议层: server/protocol.js（使用相同的数值常量）
//   - 客户端 JS:    client/protocol.js（通过 CanvasKit WASM 解析）
//
// 包含三大类定义:
//   1. FrameHeader 结构体 — 30 字节帧头二进制布局 (§6.2)
//   2. Opcode 枚举 — 命令操作码白名单（0x01-0x7F 合法，0x80-0xFF 非法）
//   3. CRC32 多项式 + 命令结构常量
//
// 在 Chromium 源码树中的挂载点:
//   - 挂载路径: //garnet/frame_constants.h
//   - 编译依赖: 仅依赖 garnet_config.h（编译时常量）
//   - 零 Chromium 头文件依赖（可在 Node.js native addon 中直接 include）
//
// ═══════════════════════════════════════════════════════════════════════════════
// 安全不变量
// ═══════════════════════════════════════════════════════════════════════════════
//   I-1: Opcode 白名单 — 仅 0x01-0x7F 为合法 opcode，
//        0x80-0xFF 客户端必须拒收（IsValidOpcode 校验）
//   I-2: 命令结构 — 每条命令 4 字节对齐 (kCommandHeaderSize=4)，
//        pay_len 为 uint24 LE（最大 kMaxPayloadBytes=1MB）
//   I-3: CRC32 多项式与 IEEE 802.3 / zlib 一致（0xEDB88320），
//        确保跨语言 CRC 校验一致
//   I-4: 帧头手动序列化 — 因 int64_t 对齐问题，不直接 memcpy 结构体
//        （见 SerializeFrameHeader 实现）
#ifndef GARNET_FRAME_CONSTANTS_H_
#define GARNET_FRAME_CONSTANTS_H_

#include "garnet_config.h"

#include <cstdint>

namespace garnet {

// ═══════════════════════════════════════════════════════════════
// FrameHeader — 帧头结构体 (30 字节有效载荷)
//
// §6.2 Server → Client Frame 消息格式:
//   帧 = [Header(30B)] + [CommandStream(N bytes)] + [CRC32(4B)]
//
// 字节布局 (Little Endian, 手动序列化):
//   [0:1]   version       uint8   协议版本（当前 0x01, §6.2 Byte 0）
//   [1:2]   flags         uint8   标志位: bit0=is_keyframe, bit1=has_font_data
//   [2:6]   frame_id      uint32  LE  单调递增帧 ID (compositor_frame_seq_)
//   [6:14]  timestamp_ms  int64   LE  Unix 毫秒时间戳
//   [14:18] scroll_x      int32   LE  页面滚动 X (px)
//   [18:22] scroll_y      int32   LE  页面滚动 Y (px)
//   [22:24] viewport_w    uint16  LE  CSS 视口宽度 (px)
//   [24:26] viewport_h    uint16  LE  CSS 视口高度 (px)
//   [26:28] canvas_w      uint16  LE  物理画布宽度 = viewport_w × dpr
//   [28:30] canvas_h      uint16  LE  物理画布高度 = viewport_h × dpr
//
// ⚠️ 安全警告: 总计 30 字节有效载荷。结构体含 int64_t 字段可能导致
//    编译器插入 6 字节 padding（为 8 字节对齐）。因此必须通过
//    SerializeFrameHeader() / DeserializeFrameHeader() 逐字段序列化，
//    不可直接 memcpy 或 sizeof(FrameHeader) 用于网络传输。
//    见 command_buffer.cpp 实现。
// ═══════════════════════════════════════════════════════════════

/// @brief 帧头大小: 30 字节（手动序列化后的网络字节数，非 sizeof）。
constexpr size_t kFrameHeaderSize = 30;

/// @brief 帧头二进制结构体（C++ 内存布局，可能含 padding）。
///
/// 字段含义:
///   - version/flags:     协议版本号 + 标志位掩码 (§6.2 Byte 0-1)
///   - frame_id:          帧序号，单调递增，用于增量帧/丢帧检测 (§7)
///   - timestamp_ms:      服务端帧生成时间戳 (Unix ms)
///   - scroll_x/scroll_y: 页面滚动偏移（§7.3 坐标转换公式）
///   - viewport_w/h:      CSS 视口尺寸（§6.3 viewport 消息）
///   - canvas_w/h:        物理画布尺寸 = viewport × devicePixelRatio
struct FrameHeader {
    uint8_t  version;       ///< 协议版本，当前 0x01 (§6.2 Byte 0)
    uint8_t  flags;         ///< 标志位: bit0=is_keyframe, bit1=has_font_data
    uint32_t frame_id;      ///< 单调递增帧 ID (§7: compositor_frame_seq_)
    int64_t  timestamp_ms;  ///< Unix 毫秒时间戳
    int32_t  scroll_x;      ///< 页面滚动 X (px), §7.3 坐标转换
    int32_t  scroll_y;      ///< 页面滚动 Y (px)
    uint16_t viewport_w;    ///< CSS 视口宽度 (px), §6.3
    uint16_t viewport_h;    ///< CSS 视口高度 (px)
    uint16_t canvas_w;      ///< 物理画布宽度 = viewport_w × dpr
    uint16_t canvas_h;      ///< 物理画布高度 = viewport_h × dpr
};

/// @brief CRC32 多项式 (IEEE 802.3 反射形式)。
///
/// 与 zlib crc32() 和 Python binascii.crc32() 一致。
/// 用于帧尾校验 Header + CommandStream 的完整性 (§6.2 Trailer)。
/// 安全: CRC32 仅检测意外损坏，防篡改由 TLS 1.3 保证。
constexpr uint32_t kCrc32Polynomial = 0xEDB88320;

/// @brief 帧尾 CRC32 大小: 4 字节 (uint32 LE)。
constexpr size_t kFrameTrailerSize = 4;

// ═══════════════════════════════════════════════════════════════
// 命令结构 (§6.2 Command Stream)
//
// 单条命令布局:
//   [0]:     opcode   uint8        (1 字节)
//   [1:4]:   pay_len  uint24 LE    (3 字节, max = kMaxPayloadBytes = 1MB)
//   [4:4+pay_len]: payload bytes  (变长, 4 字节边界对齐)
//
// 命令流以 4 字节边界对齐（endCommand → padToAlignment(4)）。
// ═══════════════════════════════════════════════════════════════

/// @brief 命令头大小: opcode(1B) + pay_len(3B) = 4 字节。
constexpr size_t kCommandHeaderSize = 4;

// ═══════════════════════════════════════════════════════════════
// Opcode 枚举 — 命令操作码白名单
//
// §6.2 Opcode 分配表（与客户端 protocol.js 的 OPCODES 映射严格一致）:
//
//   范围         用途                         示例命令
//   ─────────────────────────────────────────────────────────
//   0x00         保留（空操作标记）
//   0x01-0x0F    状态管理                      save/restore/saveLayer
//   0x10-0x1F    变换                          concat/translate/scale/rotate/concat44
//   0x20-0x2F    裁剪                          clipRect/clipRRect/clipPath
//   0x30-0x3F    形状绘制                      rect/rrect/oval/arc/path/points
//   0x40-0x4F    图像绘制                      image/imageRect/atlas/lattice/edgeAA
//   0x50-0x5F    文本绘制                      textBlob/glyphRunList
//   0x60-0x6F    其他绘制                      paint/color/shadow/vertices/drawable/annotation
//   0x70-0x7F    扩展                          fontData/imageData/setMatrix/noop
//   0x80-0xFF    非法（客户端必须拒收）
//
// 安全不变量: 所有 opcode 必须在此枚举中有对应项。
// 客户端通过 IsValidOpcode() 白名单校验，任何 0x80-0xFF 的 opcode
// 应视为协议攻击尝试（§2.1 威胁模型: 服务端被入侵场景）。
// ═══════════════════════════════════════════════════════════════

enum class Opcode : uint8_t {
    // ── 状态管理 (0x01-0x0F) — §4.1.2 RecordingCanvas 状态机 ──
    kSave        = 0x01,  ///< 保存当前画布状态（矩阵 + 裁剪）
    kRestore     = 0x02,  ///< 恢复最近保存的画布状态
    kSaveLayer   = 0x03,  ///< 保存图层（bounds + paint 可选）

    // ── 变换 (0x10-0x1F) — §4.1.2 变换捕获 ──
    kConcat      = 0x10,  ///< 连接 3×3 矩阵（SkMatrix）
    kTranslate   = 0x11,  ///< 平移 (dx, dy)
    kScale       = 0x12,  ///< 缩放 (sx, sy)
    kRotate      = 0x13,  ///< 旋转 (radians)
    kConcat44    = 0x14,  ///< 连接 4×4 矩阵 SkM44（v1.6 新增，支持 3D 变换）

    // ── 裁剪 (0x20-0x2F) ──
    kClipRect    = 0x20,  ///< 矩形裁剪
    kClipRRect   = 0x21,  ///< 圆角矩形裁剪
    kClipPath    = 0x22,  ///< 路径裁剪（任意形状）

    // ── 形状绘制 (0x30-0x3F) — §4.1.2 onDraw* 拦截 ──
    kDrawRect    = 0x30,  ///< 绘制矩形
    kDrawRRect   = 0x31,  ///< 绘制圆角矩形
    kDrawDRRect  = 0x32,  ///< 绘制双圆角矩形（外+内）
    kDrawOval    = 0x33,  ///< 绘制椭圆
    kDrawArc     = 0x34,  ///< 绘制圆弧
    kDrawPath    = 0x35,  ///< 绘制路径（最通用形状原语）
    kDrawPoints  = 0x36,  ///< 绘制点集
    kDrawRegion  = 0x37,  ///< 绘制区域（SkRegion）

    // ── 图像绘制 (0x40-0x4F) — §4.1.4 图像序列化 ──
    kDrawImage        = 0x40,  ///< 绘制单张图像
    kDrawImageRect    = 0x41,  ///< 绘制图像到矩形区域 (src→dst)
    kDrawImageLattice = 0x42,  ///< 九宫格图像绘制
    kDrawAtlas        = 0x43,  ///< 纹理图集绘制（精灵批处理）
    kDrawPatch        = 0x44,  ///< 绘制补丁 (9-patch)
    kDrawEdgeAAQuad   = 0x45,  ///< 绘制带 AA 的四边形
    kDrawEdgeAAImageSet = 0x46,  ///< 批量图像 + AA 四边形

    // ── 文本绘制 (0x50-0x5F) — v1.6 字体内联传输 ──
    kDrawTextBlob    = 0x50,  ///< 绘制文本块 (SkTextBlob)
    kDrawGlyphRunList = 0x51,  ///< 绘制字形运行列表 (SkGlyphRunList)

    // ── 其他绘制 (0x60-0x6F) ──
    kDrawPaint          = 0x60,  ///< 使用 Paint 填充整个画布
    kDrawColor          = 0x61,  ///< 用纯色填充整个画布
    kDrawShadow         = 0x62,  ///< 绘制阴影 (SkDrawShadowRec)
    kDrawVerticesObject = 0x63,  ///< 绘制顶点对象 (SkVertices)
    kDrawDrawable       = 0x64,  ///< 绘制 SkDrawable（不可序列化→降级为 kNoop）
    kDrawAnnotation     = 0x65,  ///< 绘制注解 (SkAnnotation)

    // ── 扩展 (0x70-0x7F) — v1.6 新增 ──
    kFontData      = 0x70,  ///< 字体内联数据（§8.4: SFNT/WOFF2 Magic 白名单校验）
    kImageData     = 0x71,  ///< 图像内联数据引用（关联 ImageSlot）
    kSetMatrix     = 0x72,  ///< 显式矩阵设置（非增量 concat）

    // ── 特殊 ──
    kNoop          = 0x7F,  ///< 空操作占位（SkDrawable 等不可序列化对象的降级）
};

/// @brief Opcode 白名单校验 — 安全关键路径 (§2.1 威胁模型)。
///
/// 合法范围: 0x01 ≤ op ≤ 0x7F（与 protocol.js 的 VALID_OPCODES 同步）。
/// 0x00 保留（空操作标记），0x80-0xFF 为非法 opcode。
///
/// 威胁模型: 若服务端被入侵，攻击者可能尝试注入非法 opcode 以
/// 触发客户端解析器漏洞。客户端必须在命令解析前调用此函数，
/// 任何不在白名单内的 opcode 应触发帧拒收 + 安全日志。
///
/// @param op 待校验的 opcode 值
/// @returns true 若 op 在 0x01-0x7F 范围
inline bool IsValidOpcode(uint8_t op) {
    return op >= 0x01 && op <= 0x7F;
}

// ═══════════════════════════════════════════════════════════════
// 帧序列化辅助 — 显式手动序列化，不依赖编译器结构体 packing
//
// 实现位于 command_buffer.cpp。
// ═══════════════════════════════════════════════════════════════

/// @brief 将 FrameHeader 序列化为 30 字节 LE 缓冲区。
///
/// @param header 帧头结构体
/// @param dst    目标缓冲区（调用者确保 ≥ kFrameHeaderSize=30 字节）
void SerializeFrameHeader(const FrameHeader& header, uint8_t* dst);

/// @brief 从 30 字节 LE 缓冲区反序列化 FrameHeader。
///
/// @param src 源缓冲区（至少 30 字节）
/// @returns 反序列化后的帧头
FrameHeader DeserializeFrameHeader(const uint8_t* src);

}  // namespace garnet

#endif  // GARNET_FRAME_CONSTANTS_H_
