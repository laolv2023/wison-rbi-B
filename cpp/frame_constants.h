// frame_constants.h — 帧协议常量定义
//
// 定义帧头二进制结构体、Opcode 枚举、CRC32 多项式。
// 此文件是 C++ 服务端 + Node.js 协议层 + 客户端 JS 的单一事实来源。
// Node.js/JS 端通过 protocol.js 使用相同的数值常量。
//
#ifndef GARNET_FRAME_CONSTANTS_H_
#define GARNET_FRAME_CONSTANTS_H_

#include "garnet_config.h"

#include <cstdint>

namespace garnet {

// ═══════════════════════════════════════════════════════════════
// 帧头结构体 (30 bytes, 紧凑布局)
//
// 字节布局 (Little Endian):
//   [0:1]   version       uint8
//   [1:2]   flags         uint8
//   [2:6]   frame_id      uint32 LE
//   [6:14]  timestamp_ms  int64  LE
//   [14:18] scroll_x      int32  LE
//   [18:22] scroll_y      int32  LE
//   [22:24] viewport_w    uint16 LE
//   [24:26] viewport_h    uint16 LE
//   [26:28] canvas_w      uint16 LE
//   [28:30] canvas_h      uint16 LE
//
// ⚠️ 总计: 30 字节。无 padding（uint8+uint8+uint32+int64+int32+int32+...）
//    实际编译器可能插入 6 字节 padding（int64 对齐），需显式序列化。
// ═══════════════════════════════════════════════════════════════

constexpr size_t kFrameHeaderSize = 30;

struct FrameHeader {
    uint8_t  version;       // 协议版本，当前 0x01
    uint8_t  flags;         // 标志位: bit0=is_keyframe, bit1=has_font_data
    uint32_t frame_id;      // 单调递增帧 ID (compositor_frame_seq_)
    int64_t  timestamp_ms;  // Unix 毫秒时间戳
    int32_t  scroll_x;      // 页面滚动 X (px)
    int32_t  scroll_y;      // 页面滚动 Y (px)
    uint16_t viewport_w;    // CSS 视口宽度 (px)
    uint16_t viewport_h;    // CSS 视口高度 (px)
    uint16_t canvas_w;      // 物理画布宽度 (px) = viewport_w × dpr
    uint16_t canvas_h;      // 物理画布高度 (px) = viewport_h × dpr
};

// CRC32 多项式 (IEEE 802.3, 与 zlib/Python binascii 一致)
// 反射多项式: 0xEDB88320
// 用于帧尾校验 Header + Command Stream 的完整性
constexpr uint32_t kCrc32Polynomial = 0xEDB88320;

// 帧尾 CRC32 大小
constexpr size_t kFrameTrailerSize = 4;  // uint32 LE

// ═══════════════════════════════════════════════════════════════
// 命令结构（Command Stream 内的单个命令）
//
// 布局:
//   [0]:     opcode   uint8
//   [1:4]:   pay_len  uint24 LE (3 bytes, max = 1,048,576)
//   [4:4+pay_len]: payload bytes
//
// 命令流以 4 字节边界对齐。
// ═══════════════════════════════════════════════════════════════

constexpr size_t kCommandHeaderSize = 4;  // opcode(1) + pay_len(3)

// ═══════════════════════════════════════════════════════════════
// Opcode 枚举
//
// 范围划分:
//   0x00          保留（空操作标记）
//   0x01-0x0F     状态管理 (save/restore/saveLayer)
//   0x10-0x1F     变换 (concat/translate/scale/rotate)
//   0x20-0x2F     裁剪 (clipRect/clipRRect/clipPath)
//   0x30-0x3F     形状绘制 (rect/rrect/oval/arc/path/points)
//   0x40-0x4F     图像绘制 (image/imageRect/atlas/lattice/edgeAA)
//   0x50-0x5F     文本绘制 (textBlob/glyphRunList)
//   0x60-0x6F     其他绘制 (paint/color/shadow/drawable/annotation/vertices)
//   0x70-0x7F     保留
//   0x80-0xFF     非法（客户端必须拒收）
//
// ⚠️ 与客户端 protocol.js 的 OPCODES 映射保持严格一致。
// ═══════════════════════════════════════════════════════════════

enum class Opcode : uint8_t {
    // ── 状态管理 (0x01-0x0F) ──
    kSave        = 0x01,
    kRestore     = 0x02,
    kSaveLayer   = 0x03,

    // ── 变换 (0x10-0x1F) ──
    kConcat      = 0x10,
    kTranslate   = 0x11,
    kScale       = 0x12,
    kRotate      = 0x13,
    kConcat44    = 0x14,  // SkM44 4×4 矩阵（v1.6 新增支持）

    // ── 裁剪 (0x20-0x2F) ──
    kClipRect    = 0x20,
    kClipRRect   = 0x21,
    kClipPath    = 0x22,

    // ── 形状绘制 (0x30-0x3F) ──
    kDrawRect    = 0x30,
    kDrawRRect   = 0x31,
    kDrawDRRect  = 0x32,
    kDrawOval    = 0x33,
    kDrawArc     = 0x34,
    kDrawPath    = 0x35,
    kDrawPoints  = 0x36,
    kDrawRegion  = 0x37,

    // ── 图像绘制 (0x40-0x4F) ──
    kDrawImage        = 0x40,
    kDrawImageRect    = 0x41,
    kDrawImageLattice = 0x42,
    kDrawAtlas        = 0x43,
    kDrawPatch        = 0x44,
    kDrawEdgeAAQuad   = 0x45,
    kDrawEdgeAAImageSet = 0x46,

    // ── 文本绘制 (0x50-0x5F) ──
    kDrawTextBlob    = 0x50,
    kDrawGlyphRunList = 0x51,

    // ── 其他绘制 (0x60-0x6F) ──
    kDrawPaint          = 0x60,
    kDrawColor          = 0x61,
    kDrawShadow         = 0x62,
    kDrawVerticesObject = 0x63,
    kDrawDrawable       = 0x64,
    kDrawAnnotation     = 0x65,

    // ── 扩展 (0x70-0x7F) ──
    kFontData      = 0x70,  // 字体内联数据（v1.6）
    kImageData     = 0x71,  // 图像内联数据引用
    kSetMatrix     = 0x72,  // 显式矩阵设置

    // ── 特殊 ──
    kNoop          = 0x7F,  // 占位/跳过 (SkDrawable 等不可序列化对象的占位)
};

// 所有合法 opcode 的集合（用于白名单校验初始化）
// 这个集合与 protocol.js 的 VALID_OPCODES 保持同步
inline bool IsValidOpcode(uint8_t op) {
    return op >= 0x01 && op <= 0x7F;
}

// ═══════════════════════════════════════════════════════════════
// 帧序列化辅助
// ═══════════════════════════════════════════════════════════════

// 将 FrameHeader 序列化为 30 字节缓冲区（手动布局，不依赖编译器 packing）
// 输出写入 dst（调用者确保 dst 至少有 kFrameHeaderSize 字节）
void SerializeFrameHeader(const FrameHeader& header, uint8_t* dst);

// 从 30 字节缓冲区反序列化 FrameHeader
FrameHeader DeserializeFrameHeader(const uint8_t* src);

}  // namespace garnet

#endif  // GARNET_FRAME_CONSTANTS_H_
