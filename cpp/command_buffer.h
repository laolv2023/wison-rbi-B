// command_buffer.h — 序列化命令缓冲区（CommandBuffer 声明 + 图像模式枚举 + CRC32/帧序列化接口）
//
// ═══════════════════════════════════════════════════════════════════════════════
// 模块在 Wison-RBI 架构中的角色
// ═══════════════════════════════════════════════════════════════════════════════
// CommandBuffer 是 Wison-RBI 服务端 C++ 层的核心数据载体，位于 Compositor 拦截
// 管线的最末端（参见 §3.1 全局数据流）。它封装了帧的完整可传输表示：
//
//   1. 命令流 — Opcode + pay_len + payload 的平坦序列（§4.1.3 序列化格式）
//   2. 图像槽位 — 延迟编码机制，Compositor 线程仅捕获 sk_sp 引用，
//      Worker 线程异步调用 encodeToData()（§4.1.4 并发模型）
//   3. 帧序列化 — Header(30B) + CommandStream + CRC32 Trailer(4B)（§6.2 Frame 消息）
//
// 在 Chromium 源码树中的挂载点：
//   - 挂载路径: //garnet/command_buffer.h（独立模块，不修改 Chromium 源码）
//   - 调用方: RecordingCanvas（录制阶段）、FrameAssembler（组装阶段）、
//             Node.js I/O 代理（最终发送）
//   - 编译依赖: 仅依赖 frame_constants.h + garnet_config.h
//     （通过前向声明隔离 Skia 类型，减少编译传播）
//
// ═══════════════════════════════════════════════════════════════════════════════
// 安全不变量
// ═══════════════════════════════════════════════════════════════════════════════
//   I-1: 每帧总字节 ≤ kMaxBytesPerFrame (64MB)，在 growBuffer() 和
//        AssembleFrame() 中双重校验（§2.2 不变量 1, §8.4 安全边界）
//   I-2: 单条命令 payload ≤ kMaxPayloadBytes (1MB)，endCommand() 回填前检查
//   I-3: Opcode 必须在 0x01-0x7F 白名单内，beginCommand() 入口校验
//   I-4: 所有多字节整数使用 Little Endian，显式逐字节写入（不依赖编译器 layout）
//   I-5: 命令流 4 字节对齐填充，防止客户端解析器未对齐访问崩溃
//   I-6: hash-ref 模式使用完整 SHA-256（32B），256-bit 空间防止恶意碰撞
//        （生日界 ~2^128 次操作，计算上不可行）
//
// ═══════════════════════════════════════════════════════════════════════════════
// 线程安全
// ═══════════════════════════════════════════════════════════════════════════════
//   - 写入:     仅 Compositor 线程（RecordingCanvas 回调）— 单线程，无锁
//   - 最终化:   Compositor 线程调用 Finalize()
//   - 编码:     Worker 线程调用 EncodePendingImages()
//   - 读取:     序列化后的字节缓冲区不可变，多线程安全
//   - 关键设计: PostTask 后 CommandBuffer 所有权转移（move），无共享状态
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

// sk_sp<T> 智能指针 — Skia 线程安全引用计数 (§4.1.4 并发模型)
// 通过条件编译开关选择 Mock（独立编译）或真实 Skia（Chromium 集成）
#include "garnet_standalone.h"

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
// ImageSlot — 图像延迟编码槽位
// ═══════════════════════════════════════════════════════════════
//
// 设计理由 (§4.1.4 并发模型): Compositor 线程不应调用 image->encodeToData()
//（可能涉及 I/O 或长时间计算，4K 图像耗时 10-50ms）。
// 改为在命令流中分配槽位并写入占位偏移，由 Worker 线程异步编码后回填。
//
// 生命周期:
//   1. Compositor 线程: reserveImageSlot() → 捕获 sk_sp<SkImage> 引用
//   2. Worker 线程:     encodePendingImages() → encodeToData() → 填充 data
//   3. 帧组装:          totalSize() 统计时计入已编码数据
//
// 线程安全: sk_sp<SkImage> 引用计数是线程安全的 (Skia 保证)。
//           data 仅在 Worker 线程写入，之后内存屏障保证可见性。
struct ImageSlot {
    uint32_t id;              ///< 槽位 ID（在命令流中通过 writeU32 引用）
    sk_sp<const SkImage> image; ///< sk_sp 持有引用，线程安全引用计数 (Skia 保证)
    bool encoded;             ///< 是否已编码标志（防止 Worker 线程重复编码）
    std::vector<uint8_t> data; ///< 编码后的图像数据（PNG/JPEG/WebP 原始字节）

    ImageSlot() : id(0), image(nullptr), encoded(false) {}
};

// ═══════════════════════════════════════════════════════════════
// ImageMode — 图像传输模式枚举
// ═══════════════════════════════════════════════════════════════
//
// §4.1.4 运行时配置: 通过 --garnet-image-mode 命令行参数控制，
// 可在不重新编译的情况下切换。
//
// 安全性分析（两种模式共同保证）:
//   - kInline:  客户端无状态，无缓存一致性问题，但带宽开销大
//   - kHashRef: SHA-256 256-bit 空间，恶意碰撞需 ~2^128 次操作，
//               计算上不可行。客户端 LRU 缓存上限 kImageCacheBytes (64MB)
enum class ImageMode {
    kInline,    ///< 每帧内联传输图像编码数据（默认，无状态模式）
    kHashRef,   ///< SHA-256 引用去重（节省带宽，需客户端 LRU 缓存）
};

// ═══════════════════════════════════════════════════════════════
// CommandBuffer — 序列化命令缓冲区
// ═══════════════════════════════════════════════════════════════
//
/// @brief 帧的核心数据载体，封装命令流写入、图像槽位管理、帧序列化。
///
/// 生命周期:
///   1. 构造 → RecordingCanvas 创建并绑定
///   2. 录制 → Compositor 线程通过 beginCommand/write*/endCommand 写入命令
///   3. 图像分配 → reserveImageSlot() 捕获 sk_sp 引用（不编码）
///   4. 最终化 → commandStreamSize() / totalSize() / data() 提供只读视图
///   5. 编码 → Worker 线程调用 encodePendingImages() 异步编码图像
///   6. 组装 → AssembleFrame() 将 header + 命令流 + CRC32 合并为 FrameBuffer
///
/// @invariant 命令流缓冲区大小 ≤ kMaxBytesPerFrame (64MB)
/// @invariant 单条命令 payload ≤ kMaxPayloadBytes (1MB)
/// @invariant 写入状态机: in_command_ 标志保证 begin/end 成对调用
class CommandBuffer {
public:
    /// @brief 默认构造函数，使用 kInline 图像模式，预分配 64KB。
    CommandBuffer();

    /// @brief 指定图像传输模式的构造函数。
    /// @param image_mode 图像传输模式（kInline 或 kHashRef，参见 ImageMode 枚举）
    explicit CommandBuffer(ImageMode image_mode);

    ~CommandBuffer();

    // 禁止拷贝（内部有动态缓冲区和 sk_sp 引用，拷贝语义不明确）
    CommandBuffer(const CommandBuffer&) = delete;
    CommandBuffer& operator=(const CommandBuffer&) = delete;

    /// @name 移动语义
    /// @brief 支持高效的帧间传递（PostTask 后 move 到 Worker 线程）
    /// @{

    /// @brief 移动构造函数。移动后 other 处于有效但未指定状态。
    /// @param other 要移动的源 CommandBuffer（其后 in_command_=false, start=0）
    CommandBuffer(CommandBuffer&& other) noexcept;

    /// @brief 移动赋值运算符。自赋值安全。
    /// @param other 要移动的源 CommandBuffer
    /// @returns *this 的引用
    CommandBuffer& operator=(CommandBuffer&& other) noexcept;

    /// @}

    // ═══════════════════════════════════════════════════════════
    // 命令写入 (Compositor 线程) — O(1) 摊销
    //
    // 威胁模型 (§2.1): 以下方法是安全关键路径。每条命令写入前必须:
    //   1. Opcode 白名单校验 (IsValidOpcode)
    //   2. 容量边界检查 (ensureCapacity → growBuffer → kMaxBytesPerFrame)
    //   3. 状态机校验 (in_command_ 保证 begin/end 成对)
    // ═══════════════════════════════════════════════════════════

    /// @brief 开始一条新命令，写入 opcode + 3 字节 pay_len 占位符。
    ///
    /// 安全关键: 调用前校验 opcode 白名单 (0x01-0x7F)。
    /// 调用者随后通过 write* 系列方法写入 payload，最后必须调用 endCommand()。
    ///
    /// @param opcode 命令操作码（参见 Opcode 枚举，§6.2 Opcode 分配表）
    /// @throws std::logic_error 如果上一条命令尚未结束 (in_command_==true)
    /// @throws std::invalid_argument 如果 opcode 不在白名单内
    /// @see endCommand(), writeCommand(), IsValidOpcode()
    void beginCommand(Opcode opcode);

    /// @brief 完成当前命令：回填 pay_len (uint24 LE)，然后 4 字节对齐填充。
    ///
    /// 安全关键: 回填前校验 payload 大小 ≤ kMaxPayloadBytes (1MB)。
    /// 若超限则回退缓冲区（resize 到 current_command_start_）并抛出异常。
    ///
    /// @throws std::logic_error 如果当前没有进行中的命令 (in_command_==false)
    /// @throws std::length_error 如果 payload 超过 kMaxPayloadBytes
    /// @see beginCommand()
    void endCommand();

    /// @brief 中止当前命令：回退缓冲区到 current_command_start_，丢弃所有已写入的 payload。
    ///
    /// 安全关键: 用于异常路径下回滚部分写入的命令，防止客户端解析到
    /// 截断的 payload 导致协议反序列化错位。
    ///
    /// @throws std::logic_error 如果当前没有进行中的命令 (in_command_==false)
    /// @see beginCommand(), endCommand()
    void abortCommand();

    /// @brief 便捷方法：一次性写入完整命令（opcode + payload）。
    ///
    /// 等价于 beginCommand(opcode) + writeBlob(payload, pay_len) + endCommand()。
    /// 适用于命令内容已知且不需要逐步构建 payload 的场景。
    ///
    /// @param opcode 命令操作码
    /// @param payload 指向 payload 数据的指针（可为 nullptr 若 pay_len==0）
    /// @param pay_len payload 字节数（≤ kMaxPayloadBytes）
    /// @throws 同 beginCommand() 和 endCommand()
    void writeCommand(Opcode opcode, const uint8_t* payload, uint32_t pay_len);

    // ═══════════════════════════════════════════════════════════
    // Payload 写入辅助方法 (全部 Little Endian — §6.2 帧格式)
    //
    // 所有多字节写入显式逐字节移位，不依赖编译器字节序或结构体 packing。
    // 安全理由: 在网络传输场景中，接收端可能是 JavaScript (CanvasKit WASM)
    // 或其他架构，显式 LE 序列化保证跨平台一致性。
    // ═══════════════════════════════════════════════════════════

    /// @brief 写入 1 字节无符号整数。
    /// @param value [0, 255]
    void writeU8(uint8_t value);

    /// @brief 写入 2 字节无符号整数（Little Endian）。
    /// @param value [0, 65535]
    void writeU16(uint16_t value);

    /// @brief 写入 3 字节无符号整数（低 24 位有效，Little Endian）。
    ///
    /// 常用于 pay_len 字段（§6.2: pay_len 为 uint24 LE，最大值 1MB）。
    ///
    /// @param value 仅低 24 位有效，高 8 位被忽略
    void writeU24(uint32_t value);

    /// @brief 写入 4 字节无符号整数（Little Endian）。
    /// @param value [0, 2^32-1]
    void writeU32(uint32_t value);

    /// @brief 写入 8 字节无符号整数（Little Endian）。
    ///
    /// 用于时间戳、ID 等 64-bit 字段。
    ///
    /// @param value [0, 2^64-1]
    void writeU64(uint64_t value);

    /// @brief 写入 4 字节有符号整数（二进制补码，Little Endian）。
    ///
    /// 实现方式: 先 reinterpret_cast 为 uint32_t，再通过 writeU32 逐字节写入。
    /// 这保证了补码表示的跨平台一致性。
    ///
    /// @param value 任意 int32_t
    void writeI32(int32_t value);

    /// @brief 写入 8 字节有符号整数（二进制补码，Little Endian）。
    ///
    /// 实现方式: 先 reinterpret_cast 为 uint64_t，再通过 writeU64 逐字节写入。
    ///
    /// @param value 任意 int64_t
    void writeI64(int64_t value);

    /// @brief 写入 IEEE 754 单精度浮点数（Little Endian）。
    ///
    /// 实现方式: std::memcpy 到 uint32_t 后逐字节写入。
    /// 注意: 不使用 reinterpret_cast（严格别名规则违规风险）。
    ///
    /// @param value 任意 float
    void writeF32(float value);

    /// @brief 写入 IEEE 754 双精度浮点数（Little Endian）。
    ///
    /// 实现方式: std::memcpy 到 uint64_t 后逐字节写入。
    ///
    /// @param value 任意 double
    void writeF64(double value);

    /// @brief 写入布尔值（1 字节: 0 = false, 1 = true）。
    /// @param value 布尔值
    void writeBool(bool value);

    /// @brief 写入原始字节块（二进制安全）。
    ///
    /// 安全关键: 调用前必须 ensureCapacity(len)。
    /// 零长度输入是安全的（直接返回）。
    ///
    /// @param data 指向源数据的指针（可为 nullptr 若 len==0）
    /// @param len 字节数
    void writeBlob(const uint8_t* data, size_t len);

    /// @brief 写入原始字节块（void* 重载，委托到 uint8_t* 版本）。
    /// @param data 指向源数据的指针
    /// @param len 字节数
    void writeBlob(const void* data, size_t len);

    /// @brief 写入字符串（长度前缀 + UTF-8 数据）。
    ///
    /// 格式: str_len(u32 LE) + utf8_bytes[str_len]
    /// 注意: 不写入 null 终止符，解码端根据 str_len 读取。
    ///
    /// @param str UTF-8 编码的字符串
    void writeString(const std::string& str);

    /// @brief 对齐填充到指定字节边界（写入零字节）。
    ///
    /// 安全关键 (§6.2): 客户端解析器假设命令流在 4 字节边界对齐。
    /// 未对齐的命令流可能导致客户端崩溃（未对齐访问 SIGBUS）
    /// 或被利用为信息泄露通道。
    ///
    /// 实现细节: 计算 (buffer_.size() % alignment)，若非零则填充
    /// (alignment - remainder) 个零字节。
    ///
    /// @param alignment 对齐粒度，默认 4 字节（与协议规范一致）
    void padToAlignment(size_t alignment = 4);

    // ═══════════════════════════════════════════════════════════
    // Skia 对象序列化（由 RecordingCanvas 在 onDraw* 虚函数中调用）
    //
    // §4.1.2 RecordingCanvas 实现: 这些方法将 Skia C++ 对象展平为
    // 协议兼容的字节序列。序列化格式见各方法注释。
    // 注意: 头文件中的声明仅提供接口签名；实际序列化逻辑在
    // RecordingCanvas 子类中实现或在此处作为 stub。
    // ═══════════════════════════════════════════════════════════

    /// @brief 序列化 SkPaint（§4.1.3: 简单 Paint ~8B, 复杂 Paint 101-301B）
    ///
    /// 序列化格式: color(4B)+blendMode(1B)+style(1B)+strokeWidth(f32)+
    ///   strokeMiter(f32)+strokeCap(1B)+strokeJoin(1B)+antiAlias(1B)+
    ///   hasShader(1B)+hasMaskFilter(1B)+hasColorFilter(1B)+
    ///   hasPathEffect(1B)+hasImageFilter(1B)
    ///   若有 shader/filter，后续递归序列化对应对象。
    void writePaint(const SkPaint& paint);

    /// @brief 序列化 SkPath（verbCount + pointCount + verbs[] + points[]）
    void writePath(const SkPath& path);

    /// @brief 序列化 SkTextBlob（glyph 列表 + 位置 + 字体引用）
    void writeTextBlob(const SkTextBlob* blob);

    /// @brief 序列化图像引用（核心方法，§4.1.4 writeImage 实现）
    ///
    /// hash-ref 模式: 先查 SHA-256 哈希集合，若已发送则仅写 32B 引用；
    /// 否则分配槽位并写入哈希。
    /// kInline 模式: 直接分配槽位，不查重。
    ///
    /// @warning 此方法在 Compositor 线程调用，仅捕获 sk_sp 引用，
    ///          不调用 encodeToData()。实际编码在 Worker 线程异步完成。
    void writeImage(const SkImage* image);

    /// @brief 序列化 SkSamplingOptions（filter 模式 + mipmap + cubic 参数）
    void writeSamplingOptions(const SkSamplingOptions& sampling);

    /// @brief 序列化 SkVertices（顶点模式 + 位置 + 纹理坐标 + 颜色 + 索引）
    void writeVertices(const SkVertices* vertices);

    /// @brief 序列化 SkRect (left/top/right/bottom 各 f32 = 16B)
    void writeRect(const SkRect& rect);

    /// @brief 序列化 SkRRect (type + rect + 4 radii = 49B)
    void writeRRect(const SkRRect& rrect);

    /// @brief 序列化 SkPoint (x/y 各 f32 = 8B)
    void writePoint(const SkPoint& pt);

    /// @brief 序列化 SkColor4f (r/g/b/a 各 f32 = 16B)
    void writeColor4f(const SkColor4f& color);

    /// @brief 序列化 SkDrawShadowRec
    void writeShadowRec(const SkDrawShadowRec& rec);

    /// @brief 序列化 SkM44 4×4 变换矩阵（v1.6 新增 opcode 0x14）
    ///
    /// 格式: 16 × f32 = 64B，行主序 (row-major)。
    /// 替代 Phase 1/2 的 3×3 SkMatrix，支持 3D 变换 (CSS transform: matrix3d)。
    void writeM44(const SkM44& matrix);

    // ═══════════════════════════════════════════════════════════
    // 图像槽位管理 — 延迟编码机制 (§4.1.4 并发模型)
    // ═══════════════════════════════════════════════════════════

    /// @brief 预留图像槽位（仅分配 ID + 捕获 sk_sp 引用，不编码）。
    ///
    /// O(1) 操作。在命令流中写入槽位 ID 后，Worker 线程通过该 ID
    /// 找到对应 ImageSlot 并调用 encodeToData()。
    ///
    /// @param image Skia 图像指针（调用者保证生命周期 ≥ 本 CommandBuffer）
    /// @returns 槽位 ID（从 0 开始单调递增，在命令流中通过 writeU32 写入）
    /// @note Compositor 线程调用，不阻塞
    uint32_t reserveImageSlot(const SkImage* image);

    /// @brief 编码所有待处理的图像（Worker 线程调用）。
    ///
    /// 遍历 image_slots_，对所有 !encoded 的槽位调用
    /// image->encodeToData(SkEncodedImageFormat::kPNG, 85)。
    /// 编码结果写入 slot.data。
    ///
    /// @warning 此方法可能耗时（单张 4K 图像 10-50ms）。
    ///          必须在 Worker 线程调用，绝不可在 Compositor 线程调用。
    /// @see reserveImageSlot()
    void encodePendingImages();

    /// @brief 将已编码的图像槽位作为 kImageData 命令追加到命令流。
    ///
    /// 必须在 AssembleFrame 之前调用。每个图像槽位生成一个 kImageData 命令:
    ///   opcode(1B) + payload_len(3B) + slot_id(4B) + data_size(4B) + data(N)
    /// 客户端通过 IMAGE_DATA 处理器接收并存入 slot 缓存。
    void appendImageCommands();

    // ═══════════════════════════════════════════════════════════
    // 最终化 — 提供只读视图
    // ═══════════════════════════════════════════════════════════

    /// @brief 返回命令流总字节数（不含图像槽位编码数据）。
    size_t commandStreamSize() const { return buffer_.size(); }

    /// @brief 返回完整帧字节数（命令流 + 所有图像槽位编码数据 + 槽位头）。
    ///
    /// 计算: buffer_.size() + Σ(slot.data.size() + 8)
    /// 其中 +8 = slot_id(u32) + size(u32) 头部开销。
    size_t totalSize() const;

    /// @brief 获取命令流只读视图（用于帧组装时的 memcpy）。
    const uint8_t* data() const { return buffer_.data(); }

    /// @brief 获取图像槽位列表（只读，用于帧组装器编码）。
    const std::vector<ImageSlot>& imageSlots() const { return image_slots_; }

    /// @brief 清空缓冲区与所有槽位（用于帧间复用，避免重复分配）。
    ///
    /// 重置所有状态字段 (in_command_, current_command_start_)，
    /// 重新 reserve(65536) 以减少后续几何增长。
    void clear();

    /// @brief 命令流是否为空（无任何命令）。
    bool empty() const { return buffer_.empty(); }

    // ═══════════════════════════════════════════════════════════
    // 图像哈希去重（hash-ref 模式，§4.1.4 配置项 1）
    //
    // 安全不变量: 使用完整 SHA-256（32B），非截断哈希。
    // 256-bit 空间防止恶意碰撞攻击。
    // 客户端 LRU 缓存容量: kImageCacheBytes (64MB)。
    // ═══════════════════════════════════════════════════════════

    /// @brief 图像的 SHA-256 哈希（32 字节）。
    struct ImageHash {
        uint8_t bytes[32];  ///< SHA-256 原始字节（非 hex 字符串）

        /// @brief 恒定时间比较（使用 memcmp，安全关键路径）。
        bool operator==(const ImageHash& other) const {
            return std::memcmp(bytes, other.bytes, 32) == 0;
        }
    };

    /// @brief 检查图像哈希是否已在本轮会话中发送。
    ///
    /// O(n) 线性扫描（n = 已发送图像数），适用于典型网页
    /// （< 1000 张去重图像）。
    ///
    /// @param hash 图像的 SHA-256 哈希
    /// @returns true 若已发送（客户端缓存中有该图像）
    bool hasImageHash(const ImageHash& hash) const;

    /// @brief 将图像哈希标记为已发送。
    ///
    /// 在 writeImage() 中，hash-ref 模式首次遇到图像时调用。
    ///
    /// @param hash 要标记的哈希
    void markImageHashSent(const ImageHash& hash);

private:
    /// @brief 命令流缓冲区（平坦字节序列）。
    ///
    /// 布局: [cmd1_header(4B)][cmd1_payload][padding]...[cmdN_header][cmdN_payload][padding]
    /// 每条命令 4 字节对齐。
    /// 预分配 64KB (reserve)，几何增长因子 1.5×，硬上限 kMaxBytesPerFrame。
    std::vector<uint8_t> buffer_;

    /// @brief 图像延迟编码槽位列表。
    ///
    /// Compositor 线程写入 sk_sp 引用，
    /// Worker 线程写入编码数据。线程安全由 sk_sp 引用计数保证。
    /// 槽位 ID 由 next_slot_id_ 单调递增分配，不依赖 vector 索引。
    std::vector<ImageSlot> image_slots_;

    /// @brief 下一个图像槽位 ID（单调递增，不复用）。
    ///
    /// 避免 FIFO 淘汰时 slot_id 碰撞。uint32_t 范围足够单帧使用。
    uint32_t next_slot_id_ = 0;

    /// @brief 已发送图像哈希集合（hash-ref 模式去重）。
    ///
    /// 在 writeImage() 中查询/更新。O(n) 线性扫描，n = 去重图像数。
    std::vector<ImageHash> sent_hashes_;

    ImageMode image_mode_;  ///< 图像传输模式（构造时设定，运行期不变）

    /// @brief 当前正在构建的命令在 buffer_ 中的起始偏移。
    ///
    /// 由 beginCommand() 设置，endCommand() 用于回填 pay_len。
    /// 回填完成后此值不再有效。
    size_t current_command_start_;

    /// @brief 状态机标志: 是否正在构建一条命令。
    ///
    /// 保证 beginCommand / endCommand 成对调用。
    /// 若 in_command_==true 时再次调用 beginCommand() 则抛出 logic_error。
    bool in_command_;

    /// @brief 确保缓冲区有足够容量容纳 additional_bytes 额外字节。
    ///
    /// 若当前容量不足则调用 growBuffer() 进行几何增长。
    /// 安全关键: 增长前检查 kMaxBytesPerFrame 硬上限。
    ///
    /// @param additional_bytes 即将写入的字节数
    /// @throws std::length_error 若增长后超出 kMaxBytesPerFrame
    /// @see growBuffer()
    void ensureCapacity(size_t additional_bytes);

    /// @brief 执行缓冲区几何增长（1.5× 策略，上限 kMaxBytesPerFrame）。
    ///
    /// 增长策略: new_cap = max(capacity * 1.5, min_capacity)。
    /// 若 new_cap > kMaxBytesPerFrame 则钳制到 kMaxBytesPerFrame。
    /// 若仍无法满足 min_capacity 则抛出 length_error。
    ///
    /// @param min_capacity 所需的最小容量
    /// @throws std::length_error 若 min_capacity > kMaxBytesPerFrame
    void growBuffer(size_t min_capacity);
};

// ═══════════════════════════════════════════════════════════════
// CRC32 计算 — 帧完整性校验 (§6.2 Trailer)
// ═══════════════════════════════════════════════════════════════
//
// 校验范围: FrameHeader(30B) + CommandStream(N bytes)
// 多项式: 0xEDB88320 (IEEE 802.3，与 zlib/Python binascii 一致)
// 表驱动实现，查找表 kCrc32Table[256] 在编译期预计算。
//
// 安全不变量: CRC32 仅用于检测意外损坏（网络传输错误），
// 不提供防篡改保护。防篡改由 TLS 1.3 保证（§2.1 威胁模型）。

/// @brief 计算 CRC32 校验值（表驱动，IEEE 802.3 多项式）。
///
/// 支持增量计算：可通过 crc 参数传入上一次的 CRC 值实现分块 CRC。
///
/// @param data 指向数据的指针
/// @param len  数据字节数
/// @param crc  初始 CRC 值（首次调用传 0，增量调用传上次结果）
/// @returns 最终 CRC32 值
uint32_t ComputeCRC32(const uint8_t* data, size_t len, uint32_t crc = 0);

// ═══════════════════════════════════════════════════════════════
// 帧头序列化/反序列化 — 手动布局，不依赖编译器 packing
// ═══════════════════════════════════════════════════════════════
//
// §6.2 FrameHeader 30 字节布局。因结构体含 int64_t 字段，编译器可能
// 插入 6 字节 padding。必须通过显式逐字段序列化函数，不可直接 memcpy。

/// @brief 将 FrameHeader 序列化为 30 字节缓冲区（手动逐字段 LE）。
/// @param header 要序列化的帧头
/// @param dst    目标缓冲区（调用者确保 ≥ kFrameHeaderSize=30 字节）
void SerializeFrameHeader(const FrameHeader& header, uint8_t* dst);

/// @brief 从 30 字节缓冲区反序列化 FrameHeader。
/// @param src 源缓冲区（至少 30 字节）
/// @returns 反序列化后的 FrameHeader
FrameHeader DeserializeFrameHeader(const uint8_t* src);

/// @brief 帧字节缓冲区：持有完整帧数据（拥有所有权）。
///
/// 布局: [FrameHeader(30B)][CommandStream(N bytes)][CRC32(4B)]
/// 总大小 = kFrameHeaderSize + commandStreamSize + kFrameTrailerSize
struct FrameBuffer {
    std::unique_ptr<uint8_t[]> data;  ///< 拥有所有权的帧字节数组
    size_t size;                       ///< 帧总字节数
};

/// @brief 组装完整帧：Header + Command Stream + CRC32 Trailer。
///
/// 安全关键: 组装前校验 total size ≤ kMaxBytesPerFrame (64MB)，防止溢出。
///
/// @param header   帧元数据（frame_id, scroll, viewport 等）
/// @param commands 已最终化的 CommandBuffer（只读视图）
/// @returns 完整的帧字节缓冲区
/// @throws std::length_error 若 total size > kMaxBytesPerFrame
FrameBuffer AssembleFrame(const FrameHeader& header,
                          const CommandBuffer& commands);

}  // namespace garnet

#endif  // GARNET_COMMAND_BUFFER_H_
