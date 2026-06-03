// command_buffer.h — 序列化命令缓冲区
//
// CommandBuffer 是帧的核心数据载体，封装：
// 1. 命令流 (opcode + pay_len + payload 的平坦序列)
// 2. 图像槽位 (延迟编码，Worker 线程异步处理)
// 3. 序列化/反序列化为网络传输用的平坦字节缓冲区
//
// 线程安全:
//   - 写入:  仅 Compositor 线程（RecordingCanvas 回调）
//   - 最终化: Compositor 线程调用 Finalize()
//   - 编码:   Worker 线程调用 EncodePendingImages()
//   - 读取:   序列化后的字节缓冲区不可变，多线程安全
//
// OOP 光栅化 UAF 防护 (v1.6 P1 A2):
//   - 当 `--garnet-raster-mode=record-only` 且 OOP 光栅化启用时，
//     DisplayItemList 由 Viz 进程持有。本模块通过 Lock + DeepCopy
//     方式复制 PaintOp 数据，确保不持有跨进程的悬空引用。
//
#ifndef GARNET_COMMAND_BUFFER_H_
#define GARNET_COMMAND_BUFFER_H_

#include "frame_constants.h"
#include "garnet_config.h"

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

// 前向声明 Skia 类型（不引入完整 Skia 头以减少编译依赖）
class SkImage;
class SkPaint;
class SkPath;
class SkTextBlob;
class SkVertices;
class SkSamplingOptions;
class SkRSXform;
class SkRect;
class SkRRect;
class SkPoint;
class SkColor4f;
class SkDrawShadowRec;
class SkImageFilter;
class SkShader;
class SkMaskFilter;
class SkColorFilter;
class SkPathEffect;
class SkBlender;
struct SkM44;

namespace garnet {

// ═══════════════════════════════════════════════════════════════
// 图像槽位 — 延迟编码机制
//
// 设计理由 (§4.1.4): Compositor 线程不应调用 image->encodeToData()
//（可能涉及 I/O 或长时间计算）。改为分配槽位，由 Worker 线程异步编码。
// ═══════════════════════════════════════════════════════════════
struct ImageSlot {
    uint32_t id;              // 槽位 ID（在命令流中引用）
    const SkImage* image;     // sk_sp 持有引用（非拥有）
    bool encoded;             // 是否已编码（防止重复编码）
    std::vector<uint8_t> data; // 编码后的图像数据（PNG/JPEG/WebP）

    ImageSlot() : id(0), image(nullptr), encoded(false) {}
};

// ═══════════════════════════════════════════════════════════════
// 图像传输模式
// ═══════════════════════════════════════════════════════════════
enum class ImageMode {
    kInline,    // 每帧内联传输（默认）
    kHashRef,   // SHA-256 引用去重
};

// ═══════════════════════════════════════════════════════════════
// CommandBuffer
// ═══════════════════════════════════════════════════════════════
class CommandBuffer {
public:
    CommandBuffer();
    explicit CommandBuffer(ImageMode image_mode);
    ~CommandBuffer();

    // 禁止拷贝（内部有动态缓冲区和 sk_sp 引用）
    CommandBuffer(const CommandBuffer&) = delete;
    CommandBuffer& operator=(const CommandBuffer&) = delete;

    // 移动语义
    CommandBuffer(CommandBuffer&& other) noexcept;
    CommandBuffer& operator=(CommandBuffer&& other) noexcept;

    // ═══════════════════════════════════════════════════════════
    // 命令写入 (Compositor 线程) — O(1) 摊销
    // ═══════════════════════════════════════════════════════════

    // 开始一条新命令。调用者随后写入 payload。
    void beginCommand(Opcode opcode);

    // 完成当前命令（写入 pay_len 到头部）
    void endCommand();

    // 便捷方法：写入完整命令（opcode + payload 一次性写入）
    void writeCommand(Opcode opcode, const uint8_t* payload, uint32_t pay_len);

    // ═══════════════════════════════════════════════════════════
    // Payload 写入辅助方法 (Little Endian)
    // ═══════════════════════════════════════════════════════════

    void writeU8(uint8_t value);
    void writeU16(uint16_t value);
    void writeU24(uint32_t value);  // 低 24 位
    void writeU32(uint32_t value);
    void writeU64(uint64_t value);
    void writeI32(int32_t value);
    void writeI64(int64_t value);
    void writeF32(float value);
    void writeF64(double value);
    void writeBool(bool value);     // 1 byte
    void writeBlob(const uint8_t* data, size_t len);
    void writeBlob(const void* data, size_t len);
    void writeString(const std::string& str);

    // 对齐填充（到 4 字节边界）
    void padToAlignment(size_t alignment = 4);

    // ═══════════════════════════════════════════════════════════
    // Skia 对象序列化（委托给 RecordingCanvas 调用）
    // ═══════════════════════════════════════════════════════════

    void writePaint(const SkPaint& paint);
    void writePath(const SkPath& path);
    void writeTextBlob(const SkTextBlob* blob);
    void writeImage(const SkImage* image);
    void writeSamplingOptions(const SkSamplingOptions& sampling);
    void writeVertices(const SkVertices* vertices);
    void writeRect(const SkRect& rect);
    void writeRRect(const SkRRect& rrect);
    void writePoint(const SkPoint& pt);
    void writeColor4f(const SkColor4f& color);
    void writeShadowRec(const SkDrawShadowRec& rec);
    void writeM44(const SkM44& matrix);

    // ═══════════════════════════════════════════════════════════
    // 图像槽位管理
    // ═══════════════════════════════════════════════════════════

    // 预留图像槽位（仅分配 ID，不编码），返回槽位 ID
    uint32_t reserveImageSlot(const SkImage* image);

    // 编码所有待处理的图像（Worker 线程调用）
    void encodePendingImages();

    // ═══════════════════════════════════════════════════════════
    // 最终化
    // ═══════════════════════════════════════════════════════════

    // 返回命令流总字节数（不含图像槽位编码数据）
    size_t commandStreamSize() const { return buffer_.size(); }

    // 返回完整帧字节数（命令流 + 内联图像数据）
    size_t totalSize() const;

    // 获取命令流只读视图
    const uint8_t* data() const { return buffer_.data(); }

    // 获取图像槽位（用于帧组装器编码）
    const std::vector<ImageSlot>& imageSlots() const { return image_slots_; }

    // 清空缓冲区（用于帧间复用）
    void clear();

    // 是否为空（无任何命令）
    bool empty() const { return buffer_.empty(); }

    // ═══════════════════════════════════════════════════════════
    // 图像哈希去重（hash-ref 模式）
    // ═══════════════════════════════════════════════════════════

    struct ImageHash {
        uint8_t bytes[32];  // SHA-256 (32 bytes)

        bool operator==(const ImageHash& other) const {
            return std::memcmp(bytes, other.bytes, 32) == 0;
        }
    };

    // 检查图像哈希是否已发送（本轮会话）
    bool hasImageHash(const ImageHash& hash) const;
    void markImageHashSent(const ImageHash& hash);

private:
    std::vector<uint8_t> buffer_;               // 命令流缓冲区
    std::vector<ImageSlot> image_slots_;        // 图像槽位
    std::vector<ImageHash> sent_hashes_;        // 已发送图像哈希集合

    ImageMode image_mode_;

    // 当前正在构建的命令的起始偏移（用于 endCommand 回填 pay_len）
    size_t current_command_start_;
    bool in_command_;

    // 内部辅助
    void ensureCapacity(size_t additional_bytes);
    void growBuffer(size_t min_capacity);
};

// ═══════════════════════════════════════════════════════════════
// CRC32 计算
// ═══════════════════════════════════════════════════════════════

// 计算 CRC32 (多项式 0xEDB88320, IEEE 802.3)
// 种子 crc 用于增量计算（初始调用时传 0）
uint32_t ComputeCRC32(const uint8_t* data, size_t len, uint32_t crc = 0);

// ═══════════════════════════════════════════════════════════════
// 帧序列化实现（在 command_buffer.cpp 中）
// ═══════════════════════════════════════════════════════════════

void SerializeFrameHeader(const FrameHeader& header, uint8_t* dst);
FrameHeader DeserializeFrameHeader(const uint8_t* src);

// 帧字节缓冲区辅助：分配并组装完整帧（Header + Commands + Trailer CRC）
// 返回完整帧字节（调用者负责释放）
struct FrameBuffer {
    std::unique_ptr<uint8_t[]> data;
    size_t size;
};

FrameBuffer AssembleFrame(const FrameHeader& header,
                          const CommandBuffer& commands);

}  // namespace garnet

#endif  // GARNET_COMMAND_BUFFER_H_
