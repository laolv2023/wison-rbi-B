// command_buffer.cpp — CommandBuffer 实现 (CommandBuffer 写入/序列化/CRC32/帧序列化)
//
// ═══════════════════════════════════════════════════════════════════════════════
// 模块在 Wison-RBI 架构中的角色
// ═══════════════════════════════════════════════════════════════════════════════
// 本文件实现 CommandBuffer 的所有核心逻辑，是帧数据从 Compositor 拦截到
// 网络传输的最后 C++ 处理环节（§3.1 全局数据流 Finalize 阶段）。
//
// 包含四大功能块：
//   1. CommandBuffer 写入/序列化 — beginCommand/endCommand/write* 系列
//      （§4.1.3 CommandBuffer 序列化格式）
//   2. CRC32 计算 — 表驱动 IEEE 802.3 多项式（§6.2 Trailer）
//   3. 帧头序列化/反序列化 — 手动 LE 布局，不依赖编译器 packing（§6.2 Frame Header）
//   4. 帧组装 — AssembleFrame: Header + Commands + CRC32 → FrameBuffer
//
// 在 Chromium 源码树中的挂载点:
//   - 挂载路径: //garnet/command_buffer.cpp
//   - 编译单元: 与 command_buffer.h 一同编译为 garnet 静态库
//   - 依赖链: frame_constants.h + garnet_config.h (无 Chromium 内部头文件)
//
// ═══════════════════════════════════════════════════════════════════════════════
// 安全关键路径 (威胁模型 §2.1)
// ═══════════════════════════════════════════════════════════════════════════════
//   [CRITICAL] beginCommand()    — Opcode 白名单校验 (IsValidOpcode)
//   [CRITICAL] endCommand()      — pay_len 回填 + kMaxPayloadBytes 边界检查
//   [CRITICAL] growBuffer()      — kMaxBytesPerFrame 硬上限检查 (防 OOM)
//   [CRITICAL] AssembleFrame()   — 组装前 total size 硬上限检查
//   [CRITICAL] ComputeCRC32()    — Header + Commands 完整性校验
//   [CRITICAL] padToAlignment()  — 4 字节对齐填充 (防客户端解析器崩溃)
//
// 字节序: 全部 Little Endian (§6.2 协议规范)
//
#include "command_buffer.h"

#include <algorithm>
#include <cassert>
#include <cstring>
#include <new>
#include <stdexcept>

// Skia 实际头文件路径 (Chromium 源码树):
//   挂载路径: third_party/skia/include/
//   序列化所需的完整类型定义（非前向声明）
#include "include/core/SkRect.h"
#include "include/core/SkRRect.h"
#include "include/core/SkPoint.h"
#include "include/core/SkM44.h"
#include "include/core/SkPath.h"
#include "include/core/SkTextBlob.h"
#include "include/core/SkVertices.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPathEffect.h"
#include "include/core/SkShader.h"
#include "include/core/SkImage.h"
#include "include/core/SkData.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkSamplingOptions.h"
#include "include/core/SkDrawShadowRec.h"
#include "include/core/SkColorPriv.h"       // SkColorGetA, SkColorGetR, etc.
#include "include/encode/SkEncodedImageFormat.h"

// SHA-256: 优先使用 Chromium 内置 BoringSSL，回退到 OpenSSL 或 DJB2
#if defined(USE_BORINGSSL) || defined(USE_OPENSSL)
#include <openssl/sha.h>
#endif

namespace garnet {

// ═══════════════════════════════════════════════════════════════
// CommandBuffer 构造/析构
// ═══════════════════════════════════════════════════════════════

/// @brief 默认构造函数。
///
/// 初始化状态:
///   - image_mode_ = kInline（默认模式，无状态客户端兼容）
///   - current_command_start_ = 0
///   - in_command_ = false
///   - buffer_ 预分配 64KB（典型帧的合理初始容量，减少几何增长次数）
///
/// @note 64KB 预分配覆盖大多数增量帧（典型 ~10-50KB gzip 后），
///       首帧（可达 1MB+）会触发 1-3 次几何增长。
CommandBuffer::CommandBuffer()
    : image_mode_(ImageMode::kInline)
    , current_command_start_(0)
    , in_command_(false)
{
    buffer_.reserve(65536);  // 预分配 64KB（覆盖典型增量帧）
}

/// @brief 指定图像传输模式的构造函数。
/// @param image_mode kInline（默认）或 kHashRef（SHA-256 去重）
CommandBuffer::CommandBuffer(ImageMode image_mode)
    : image_mode_(image_mode)
    , current_command_start_(0)
    , in_command_(false)
{
    buffer_.reserve(65536);
}

CommandBuffer::~CommandBuffer() = default;

/// @brief 移动构造函数。
///
/// 移动后 other 处于有效但未指定状态:
///   - other.in_command_ = false
///   - other.current_command_start_ = 0
///   - other.buffer_ 为空（被移走）
///
/// 线程安全: 移动后 other 不再被 Compositor 线程访问（所有权已转移）。
CommandBuffer::CommandBuffer(CommandBuffer&& other) noexcept
    : buffer_(std::move(other.buffer_))
    , image_slots_(std::move(other.image_slots_))
    , sent_hashes_(std::move(other.sent_hashes_))
    , image_mode_(other.image_mode_)
    , current_command_start_(other.current_command_start_)
    , in_command_(other.in_command_)
{
    other.current_command_start_ = 0;
    other.in_command_ = false;
}

/// @brief 移动赋值运算符。自赋值安全 (this != &other)。
CommandBuffer& CommandBuffer::operator=(CommandBuffer&& other) noexcept {
    if (this != &other) {
        buffer_ = std::move(other.buffer_);
        image_slots_ = std::move(other.image_slots_);
        sent_hashes_ = std::move(other.sent_hashes_);
        image_mode_ = other.image_mode_;
        current_command_start_ = other.current_command_start_;
        in_command_ = other.in_command_;
        other.current_command_start_ = 0;
        other.in_command_ = false;
    }
    return *this;
}

// ═══════════════════════════════════════════════════════════════
// 内部辅助 — 容量管理与几何增长
//
// 安全关键路径: 所有写入操作前必须调用 ensureCapacity()。
// 缓冲区增长受 kMaxBytesPerFrame (64MB) 硬上限约束。
// ═══════════════════════════════════════════════════════════════

/// @brief 确保缓冲区有足够容量。
///
/// 如果当前容量不足以容纳 buffer_.size() + additional_bytes，
/// 则调用 growBuffer() 扩展。这是所有 write* 方法的前置条件。
///
/// @param additional_bytes 即将写入的字节数
void CommandBuffer::ensureCapacity(size_t additional_bytes) {
    // 防御: 整数溢出检查 — buffer_.size() + additional_bytes 可能溢出 size_t
    if (additional_bytes > kMaxBytesPerFrame ||
        buffer_.size() > kMaxBytesPerFrame - additional_bytes) {
        throw std::length_error("CommandBuffer: requested size exceeds kMaxBytesPerFrame");
    }
    if (buffer_.size() + additional_bytes > buffer_.capacity()) {
        growBuffer(buffer_.size() + additional_bytes);
    }
}

/// @brief 执行缓冲区几何增长。
///
/// 增长策略 (§9.1 性能目标):
///   1. 计算 new_cap = max(capacity * 1.5, min_capacity)  — 1.5× 几何增长
///   2. 若 new_cap > kMaxBytesPerFrame，钳制到 kMaxBytesPerFrame (64MB)
///   3. 若钳制后仍无法满足 min_capacity，抛出 length_error
///
/// 威胁模型 (§2.1 恶意网页): 攻击者可能通过构造包含海量绘制命令的页面
/// 试图耗尽服务端内存。kMaxBytesPerFrame 硬上限阻止此攻击：
///   64MB 覆盖 4K 全屏内联图像（~32MB）+ 大量绘制命令，
///   超出此范围的帧一律拒绝。
///
/// @param min_capacity 所需的最小容量
/// @throws std::length_error 若无法在 kMaxBytesPerFrame 内满足 min_capacity
void CommandBuffer::growBuffer(size_t min_capacity) {
    // 1.5× 几何增长，平衡分配次数与内存浪费
    size_t new_cap = std::max(buffer_.capacity() * 3 / 2, min_capacity);
    // 钳制到帧级硬上限（§8.4 安全边界）
    if (new_cap > kMaxBytesPerFrame) {
        new_cap = kMaxBytesPerFrame;
    }
    // 二次检查: min_capacity 本身是否超出硬上限
    if (min_capacity > kMaxBytesPerFrame) {
        throw std::length_error("CommandBuffer: frame exceeds MAX_BYTES_PER_FRAME");
    }
    buffer_.reserve(new_cap);
}

// ═══════════════════════════════════════════════════════════════
// 命令写入 — 安全关键路径 (§2.1 威胁模型)
//
// 每条命令写入经历三道防线:
//   D1: Opcode 白名单校验 (IsValidOpcode, 0x01-0x7F)
//   D2: 状态机校验 (in_command_ 标志保证 begin/end 成对)
//   D3: 容量边界检查 (ensureCapacity → growBuffer → kMaxBytesPerFrame)
// ═══════════════════════════════════════════════════════════════

/// @brief 开始一条新命令。
///
/// 按顺序执行:
///   1. 状态机检查 — 若 in_command_==true 则抛出（嵌套 begin 被禁止）
///   2. Opcode 白名单校验 — 若 opcode 不在 0x01-0x7F 范围则抛出
///      （§6.2: 0x80-0xFF 为非法 opcode，客户端必须拒收）
///   3. 记录 current_command_start_ = buffer_.size()（用于 end 回填）
///   4. 写入 opcode(1B) + 3 字节 pay_len 占位符（0x00 填充）
///   5. 设置 in_command_ = true（状态机进入"命令中"状态）
///
/// @param opcode 命令操作码（Opcode 枚举值）
/// @throws std::logic_error 若已有进行中的命令
/// @throws std::invalid_argument 若 opcode 不在 0x01-0x7F 范围
void CommandBuffer::beginCommand(Opcode opcode) {
    if (in_command_) {
        throw std::logic_error("beginCommand called while command in progress");
    }
    if (!IsValidOpcode(static_cast<uint8_t>(opcode))) {
        throw std::invalid_argument("CommandBuffer: invalid opcode");
    }

    current_command_start_ = buffer_.size();

    // 写 opcode + 占位 pay_len（3 字节 0x00，endCommand 时回填）
    ensureCapacity(kCommandHeaderSize);
    buffer_.push_back(static_cast<uint8_t>(opcode));
    buffer_.push_back(0);  // pay_len[0] 占位 (LSB)
    buffer_.push_back(0);  // pay_len[1] 占位
    buffer_.push_back(0);  // pay_len[2] 占位 (MSB)

    in_command_ = true;
}

/// @brief 完成当前命令。
///
/// 按顺序执行:
///   1. 状态机检查 — 若 in_command_==false 则抛出
///   2. 计算 payload_size = buffer_.size() - (current_command_start_ + 4)
///   3. **安全检查**: 若 payload_size > kMaxPayloadBytes (1MB):
///      - 回退缓冲区: buffer_.resize(current_command_start_)
///      - 重置状态: in_command_ = false
///      - 抛出 length_error（§8.4: 单条命令独立上限检查，防止绕过帧级检查）
///   4. 回填 3 字节 pay_len 到命令头的 [off+1..off+3]（uint24 LE）
///   5. 4 字节对齐填充 — padToAlignment(4)
///   6. 设置 in_command_ = false
///
/// @throws std::logic_error 若没有进行中的命令
/// @throws std::length_error 若 payload > 1MB（缓冲区已回退）
void CommandBuffer::endCommand() {
    if (!in_command_) {
        throw std::logic_error("endCommand called without beginCommand");
    }

    // 计算 payload 大小: 当前 buffer 末尾 - 命令头末尾
    size_t payload_start = current_command_start_ + kCommandHeaderSize;
    size_t payload_size = buffer_.size() - payload_start;

    // 安全检查: 单条命令 payload 硬上限 (1MB, §8.4 命令级上限)
    if (payload_size > kMaxPayloadBytes) {
        // 原子回退: 移除整条命令，恢复状态一致性
        buffer_.resize(current_command_start_);
        in_command_ = false;
        throw std::length_error("CommandBuffer: payload exceeds MAX_PAYLOAD_BYTES");
    }

    // 回填 pay_len 为 3 字节 Little Endian (§6.2: uint24 LE)
    // Byte 1: 低 8 位 (LSB)
    buffer_[current_command_start_ + 1] = static_cast<uint8_t>(payload_size & 0xFF);
    // Byte 2: 中 8 位
    buffer_[current_command_start_ + 2] = static_cast<uint8_t>((payload_size >> 8) & 0xFF);
    // Byte 3: 高 8 位 (MSB)
    buffer_[current_command_start_ + 3] = static_cast<uint8_t>((payload_size >> 16) & 0xFF);

    // 4 字节对齐填充 — 客户端解析器依赖此对齐
    // 安全理由: 未对齐命令流可导致客户端 WASM 内存访问 SIGBUS，
    // 或被用于构造信息泄露（padding 字节可能泄露栈/堆残留数据）
    padToAlignment(4);

    in_command_ = false;
}

/// @brief 便捷方法：一次性写入完整命令。
///
/// 等价于: beginCommand(opcode) + writeBlob(payload, pay_len) + endCommand()
/// 提供原子性语义：若任一子步骤失败，整条命令被回退。
///
/// @param opcode 命令操作码
/// @param payload payload 数据指针（可为 nullptr 若 pay_len==0）
/// @param pay_len payload 字节数
void CommandBuffer::writeCommand(Opcode opcode, const uint8_t* payload, uint32_t pay_len) {
    beginCommand(opcode);
    writeBlob(payload, pay_len);
    endCommand();
}

// ═══════════════════════════════════════════════════════════════
// Payload 基本类型写入 (Little Endian — §6.2)
//
// 所有多字节类型显式逐字节写入，不依赖编译器字节序。
// 安全理由: 客户端可能是 JavaScript/CanvasKit WASM (DataView 读取)，
// 或 ARM 设备（不同字节序），显式 LE 保证跨平台一致性。
// ═══════════════════════════════════════════════════════════════

/// @brief 写入 uint8 (1 字节，直接 append)。
void CommandBuffer::writeU8(uint8_t value) {
    ensureCapacity(1);
    buffer_.push_back(value);
}

/// @brief 写入 uint16 (2 字节，Little Endian)。
///
/// 序列化顺序: [LSB][MSB] — 先低字节，后高字节。
/// 示例: value=0x1234 → buf = [0x34, 0x12]
void CommandBuffer::writeU16(uint16_t value) {
    ensureCapacity(2);
    buffer_.push_back(static_cast<uint8_t>(value & 0xFF));         // LSB
    buffer_.push_back(static_cast<uint8_t>((value >> 8) & 0xFF)); // MSB
}

/// @brief 写入 uint24 (3 字节低 24 位，Little Endian)。
///
/// 用于 pay_len 字段 (§6.2: pay_len 为 uint24 LE，max=1,048,576)。
/// 高 8 位被忽略（value 为 uint32_t，仅低 24 位写入）。
///
/// @param value 仅低 24 位有效
void CommandBuffer::writeU24(uint32_t value) {
    ensureCapacity(3);
    buffer_.push_back(static_cast<uint8_t>(value & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
}

/// @brief 写入 uint32 (4 字节，Little Endian)。
///
/// 序列化顺序: LSB → ... → MSB。
/// 示例: value=0xDEADBEEF → buf = [0xEF, 0xBE, 0xAD, 0xDE]
void CommandBuffer::writeU32(uint32_t value) {
    ensureCapacity(4);
    buffer_.push_back(static_cast<uint8_t>(value & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
}

/// @brief 写入 int32 (二进制补码，Little Endian)。
///
/// 实现: 将 int32_t reinterpret_cast 为 uint32_t 后逐字节写入。
/// 这保证了补码表示的跨平台一致性（所有现代平台均为补码）。
void CommandBuffer::writeI32(int32_t value) {
    writeU32(static_cast<uint32_t>(value));
}

/// @brief 写入 int64 (二进制补码，Little Endian)。
void CommandBuffer::writeI64(int64_t value) {
    writeU64(static_cast<uint64_t>(value));
}

/// @brief 写入 uint64 (8 字节，Little Endian)。
///
/// 用于 timestamp_ms (int64)、frame_id (uint32 的扩展预留) 等 64-bit 字段。
/// 8 字节展开为 8 次 push_back，分段掩码移位。
void CommandBuffer::writeU64(uint64_t value) {
    ensureCapacity(8);
    buffer_.push_back(static_cast<uint8_t>(value & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 32) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 40) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 48) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 56) & 0xFF));
}

/// @brief 写入 IEEE 754 float32 (Little Endian)。
///
/// 实现方式: std::memcpy → uint32_t，而非 reinterpret_cast。
/// 原因: 避免 C++ 严格别名规则 (strict aliasing) 导致未定义行为。
void CommandBuffer::writeF32(float value) {
    uint32_t bits;
    std::memcpy(&bits, &value, sizeof(bits));
    writeU32(bits);
}

/// @brief 写入 IEEE 754 float64 (Little Endian)。
void CommandBuffer::writeF64(double value) {
    uint64_t bits;
    std::memcpy(&bits, &value, sizeof(bits));
    writeU64(bits);  // writeU64 内部已调用 ensureCapacity(8)
}

/// @brief 写入布尔值 (1 字节: 0=false, 1=true)。
void CommandBuffer::writeBool(bool value) {
    writeU8(value ? 1 : 0);
}

/// @brief 写入原始字节块（二进制安全，零拷贝）。
///
/// 使用 vector::insert (范围插入)，可能触发 memmove。
/// 零长度输入是安全的（直接返回，不修改缓冲区）。
///
/// @param data 源指针（可为 nullptr 若 len==0）
/// @param len  字节数
void CommandBuffer::writeBlob(const uint8_t* data, size_t len) {
    if (len == 0) return;
    // 安全: 禁止 nullptr + len>0 的未定义行为（C++ 标准 [expr.add]）
    if (data == nullptr) {
        throw std::invalid_argument("writeBlob: null data with non-zero length");
    }
    ensureCapacity(len);
    buffer_.insert(buffer_.end(), data, data + len);
}

/// @brief 写入原始字节块 (void* 重载，委托到 uint8_t* 版本)。
void CommandBuffer::writeBlob(const void* data, size_t len) {
    writeBlob(static_cast<const uint8_t*>(data), len);
}

/// @brief 写入长度前缀字符串 (str_len + UTF-8 data)。
///
/// 格式: [str_len: u32 LE][utf8_bytes: str_len bytes]
/// 注意: 不写入 null 终止符；解码端根据 str_len 读取。
///
/// @param str UTF-8 字符串
void CommandBuffer::writeString(const std::string& str) {
    // Bounds check: string length must fit in uint32_t and not exceed frame payload limit
    if (str.size() > kMaxBytesPerFrame) {
        throw std::length_error("writeString: string exceeds frame payload limit");
    }
    writeU32(static_cast<uint32_t>(str.size()));
    writeBlob(reinterpret_cast<const uint8_t*>(str.data()), str.size());
}

/// @brief 对齐填充到指定字节边界。
///
/// 计算 remainder = buffer_.size() % alignment。
/// 若 remainder != 0，写入 (alignment - remainder) 个 0x00 字节。
///
/// 威胁模型: 未对齐的命令流可被恶意利用:
///   - 客户端崩溃 (SIGBUS on ARM)
///   - 信息泄露 (padding 字节若未清零，可能泄露缓冲区历史数据)
/// 因此填充值必须为 0x00（非"未初始化"）。
///
/// @param alignment 对齐粒度（默认 4，与 §6.2 协议一致）
void CommandBuffer::padToAlignment(size_t alignment) {
    size_t remainder = buffer_.size() % alignment;
    if (remainder != 0) {
        size_t pad = alignment - remainder;
        ensureCapacity(pad);
        for (size_t i = 0; i < pad; ++i) {
            buffer_.push_back(0);  // 零填充防止信息泄露
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Skia 对象序列化 (stub — 实际序列化逻辑由 RecordingCanvas 实现)
//
// §4.1.2 RecordingCanvas 实现: 以下方法提供签名和文档，实际的
// Skia 对象遍历和字节序列化由 RecordingCanvas 子类在 onDraw* 虚函数中完成。
// 此处仅保留 image 序列化的完整实现（因涉及图像槽位管理）。
// ═══════════════════════════════════════════════════════════════

/// @brief 序列化 SkPaint (v4 MVP: 基础属性 + 线性渐变 Shader + Dash PathEffect)
///
/// v4 SCOPE (BASIC ONLY, ~220 lines):
///   Fixed fields: color4f(16B) + blendMode(u8) + style(u8) + strokeWidth(f32) +
///                 strokeMiter(f32) + strokeCap(u8) + strokeJoin(u8) + antiAlias(u8)
///   Shader: only linear gradient (≤2 stops). Non-gradient → skip.
///   Effects: only Dash path effect. MaskFilter/ColorFilter/ImageFilter → always 0.
///   Blender: always 0 (kSrcOver default).
///
/// Style encoding: 0=Fill, 1=Stroke, 2=Hair (stroke + strokeWidth==0)
void CommandBuffer::writePaint(const SkPaint& paint) {
    // ── Fixed fields (与客户端 readPaint 格式一致) ──────────────

    // Color (4B: RGBA u32 LE) — 客户端在 offset+0 读取 getUint32
    writeU32(static_cast<uint32_t>(paint.getColor()));

    // StrokeWidth (4B: f32) — 客户端在 offset+4 读取 getFloat32
    writeF32(paint.getStrokeWidth());

    // Style (1B) — 客户端在 offset+8 读取 getUint8
    {
        uint8_t style;
        switch (paint.getStyle()) {
            case SkPaint::kFill_Style:
                style = 0;  // Fill
                break;
            case SkPaint::kStroke_Style:
                style = (paint.getStrokeWidth() == 0.0f) ? 2 : 1;
                break;
            case SkPaint::kStrokeAndFill_Style:
                style = 1;
                break;
            default:
                style = 0;
                break;
        }
        writeU8(style);
    }

    // Cap (1B) — 客户端在 offset+9 读取 getUint8
    writeU8(static_cast<uint8_t>(paint.getStrokeCap()));

    // Join (1B) — 客户端在 offset+10 读取 getUint8
    writeU8(static_cast<uint8_t>(paint.getStrokeJoin()));

    // _pad (1B) — 对齐填充，客户端在 offset+11 跳过
    writeU8(0);

    // MiterLimit (4B: f32) — 客户端在 offset+12 读取 getFloat32
    writeF32(paint.getStrokeMiter());

    // BlendMode (1B) — 客户端在 offset+16 读取 getUint8
    writeU8(static_cast<uint8_t>(paint.getBlendMode_or(SkBlendMode::kSrcOver)));

    // AntiAlias (1B) — 客户端在 offset+17 读取 getUint8
    writeU8(paint.isAntiAlias() ? 1 : 0);

    // ── Shader ────────────────────────────────────────────────────
    // 客户端在 offset+18 读取 hasShader (1B)
    {
        sk_sp<SkShader> shader = paint.refShader();
        if (shader) {
            SkColor      colors[16];
            SkScalar     offsets[16];
            SkShader::GradientInfo gradInfo;
            gradInfo.fColors        = colors;
            gradInfo.fColorOffsets  = offsets;
            gradInfo.fColorCount    = 16;
            int actualStops = shader->asAGradient(&gradInfo);

            if (actualStops > 0 && actualStops <= 16) {
                writeU8(1);  // hasShader = true
                writeU8(0);  // shaderType = LINEAR (客户端 SHADER_HEADER_SIZE[0])

                // startPoint + endPoint (16B total: 4 × f32)
                writeF32(gradInfo.fPoint[0].x());
                writeF32(gradInfo.fPoint[0].y());
                writeF32(gradInfo.fPoint[1].x());
                writeF32(gradInfo.fPoint[1].y());

                // tileMode (1B) + colorCount (1B) + _pad (2B) = 4B
                // 客户端在 headerSize-4 读取 tileMode, headerSize-3 读取 colorCount
                writeU8(static_cast<uint8_t>(gradInfo.fTileMode));
                writeU8(static_cast<uint8_t>(actualStops));
                writeU16(0);  // _pad (2B)

                // 颜色停止点: 每对 8B = RGBA u32 (4B) + position f32 (4B)
                // 与客户端 readShader 和 command_validator 一致
                for (int i = 0; i < actualStops; ++i) {
                    writeU32(static_cast<uint32_t>(gradInfo.fColors[i]));    // RGBA u32
                    writeF32(gradInfo.fColorOffsets[i]);                     // position f32
                }
            } else {
                writeU8(0);  // hasShader = false
            }
        } else {
            writeU8(0);  // hasShader = false
        }
    }

    // ── MaskFilter (placeholder: 1B hasMask + 8B if present) ──
    writeU8(0);  // hasMask = false (Phase 3 placeholder)

    // ── ColorFilter (placeholder: 1B hasColorFilter + 16B if present) ──
    writeU8(0);  // hasColorFilter = false (Phase 3 placeholder)

    // ── ImageFilter (placeholder: 1B hasImageFilter + 16B if present) ──
    writeU8(0);  // hasImageFilter = false (Phase 3 placeholder)
}

void CommandBuffer::writePath(const SkPath& path) {
    // Format: verbCount(u32) + pointCount(u32) + verbs[u8*] + points[f32*]
    // Verb values: 0=move, 1=line, 2=quad, 3=conic, 4=cubic, 5=close
    int verbCount = path.countVerbs();
    int pointCount = path.countPoints();

    // Bounds check (§8.4 深度校验): verbCount ≤ kMaxPathVerbs, pointCount ≤ kMaxPathPoints
    if (static_cast<uint32_t>(verbCount) > kMaxPathVerbs ||
        static_cast<uint32_t>(pointCount) > kMaxPathPoints) {
        return;  // Degrade: skip oversized path (avoid OOM)
    }

    writeU32(static_cast<uint32_t>(verbCount));
    writeU32(static_cast<uint32_t>(pointCount));

    // Write verbs
    if (verbCount > 0) {
        std::vector<uint8_t> verbs(verbCount);
        path.getVerbs(verbs.data(), verbCount);
        writeBlob(verbs.data(), verbCount);
    }

    // Write points
    if (pointCount > 0) {
        std::vector<SkPoint> points(pointCount);
        path.getPoints(points.data(), pointCount);
        for (int i = 0; i < pointCount; ++i) {
            writeF32(points[i].x());
            writeF32(points[i].y());
        }
    }

    // Write conic weights (one f32 per kConic verb)
    // Skia stores conic weights separately from points; client readPath expects
    // weights interleaved into the points array at conicTo positions.
    // To match the client's readPath which reads weight as points[ptIdx+4],
    // we must write weights as additional f32 values after the points array,
    // one per kConic verb, in order.
    {
        // Count conic verbs
        int conicCount = 0;
        if (verbCount > 0) {
            std::vector<uint8_t> verbs(verbCount);
            path.getVerbs(verbs.data(), verbCount);
            for (int i = 0; i < verbCount; ++i) {
                if (verbs[i] == SkPath::kConic_Verb) conicCount++;
            }
            // Write conic weights
            if (conicCount > 0) {
                std::vector<SkScalar> conicWeights(conicCount);
                path.getConicWeights(conicWeights.data(), conicCount);
                for (int i = 0; i < conicCount; ++i) {
                    writeF32(conicWeights[i]);
                }
            }
        }
    }
}

void CommandBuffer::writeTextBlob(const SkTextBlob* blob) {
    // nullptr safe guard
    if (!blob) return;

    // First pass: count total glyphs and runs for bounds check
    uint32_t runCount = 0;
    uint32_t totalGlyphs = 0;
    {
        SkTextBlob::Iter iter(*blob);
        SkTextBlob::Iter::Run run;
        while (iter.next(&run)) {
            runCount++;
            totalGlyphs += run.fGlyphCount;
        }
    }

    // Bounds check: totalGlyphs ≤ kMaxTextBlobGlyphs
    if (totalGlyphs > kMaxTextBlobGlyphs) {
        return;  // Degrade: skip oversized text blob
    }

    writeU32(runCount);

    // Second pass: write each run
    SkTextBlob::Iter iter(*blob);
    SkTextBlob::Iter::Run run;
    while (iter.next(&run)) {
        // fontId: use typeface uniqueID (0 if no typeface)
        uint32_t fontId = run.fFont ? run.fFont->uniqueID() : 0;
        writeU32(fontId);
        writeU32(static_cast<uint32_t>(run.fGlyphCount));

        // Write glyphs (u16 array)
        for (int i = 0; i < run.fGlyphCount; ++i) {
            writeU16(run.fGlyphIndices[i]);
        }

        // Write positions (f32 × 2 per glyph)
        for (int i = 0; i < run.fGlyphCount; ++i) {
            writeF32(run.fPos[i].x());
            writeF32(run.fPos[i].y());
        }
    }
}

// ====== 前向声明 (在 writeImage 之前使用) ======
static CommandBuffer::ImageHash ComputeImageSHA256(const SkImage* image);

/// @brief 序列化图像引用（完整实现，涉及图像槽位管理）。
///
/// 两种模式 (§4.1.4 配置项 1):
///
///   kHashRef 模式:
///     1. 计算图像的 SHA-256 哈希 (32B)
///     2. 若已发送 → 写 flag=0x01 + hash(32B)，返回（客户端从 LRU 缓存取出）
///     3. 若未发送 → 写 flag=0x00 + slot_id(u32) + hash(32B)，标记已发送
///
///   kInline 模式:
///     1. 写 flag=0x00 + slot_id(u32)（不计算哈希，不查重）
///
/// 安全不变量:
///   - hash-ref 使用完整 SHA-256（非截断），256-bit 空间防止恶意碰撞
///   - Compositor 线程调用，仅捕获 sk_sp 引用，不编码
///   - 实际编码由 Worker 线程的 encodePendingImages() 异步完成
///
/// @param image Skia 图像指针（可为 nullptr，安全返回）
// 前向声明: IsHashCryptographicallySecure 在下方定义，此处需要前向声明以供 writeImage 使用
static bool IsHashCryptographicallySecure();
void CommandBuffer::writeImage(const SkImage* image) {
    // 防御: 空指针安全处理
    if (!image) return;

    // 安全检查: DJB2 回退路径不满足抗碰撞不变量，强制 inline 模式
    const bool use_hash_ref =
        (image_mode_ == ImageMode::kHashRef) && IsHashCryptographicallySecure();

    if (use_hash_ref) {
        // hash-ref 模式: 查重 + 去重（仅密码安全哈希可用）
        auto hash = ComputeImageSHA256(image);   // SHA-256, 32B
        if (hasImageHash(hash)) {
            // 已发送: 仅写 32B 引用（客户端从 LRU 缓存取出）
            writeU8(0x01);              // flag: 引用 (非内联)
            writeBlob(hash.bytes, 32);  // 32 字节完整哈希
            return;
        }
        // 首次遇到: 标记已发送，然后走 inline 路径
        markImageHashSent(hash);
        // 注意: inline 路径不写入 hash，避免客户端无法判断是否有 hash 字段
        // hash 仅在 hash-ref 模式（flag=0x01）下使用
    }
    // inline 模式（含 hash-ref 首次遇到和 DJB2 回退路径）
    writeU8(0x00);                      // flag: 内联
    uint32_t slot = reserveImageSlot(image);  // 分配槽位 (O(1), 不编码)
    writeU32(slot);                     // 槽位 ID (命令流中引用)
}

void CommandBuffer::writeSamplingOptions(const SkSamplingOptions& s) {
    // Write useCubic(u8). If cubic: B(f32)+C(f32). Else: filter(u8)+mipmap(u8).
    // Check anisotropy first.
    if (s.isAniso()) {
        // Anisotropic sampling: encode as cubic with special flag or as filter=aniso
        // For MVP, treat anisotropy by writing useCubic=0 and filter=aniso
        writeU8(0);  // useCubic = false
        writeU8(static_cast<uint8_t>(s.filter));
        writeU8(static_cast<uint8_t>(s.mipmap));
    } else if (s.useCubic) {
        writeU8(1);  // useCubic = true
        writeF32(s.cubic.B);
        writeF32(s.cubic.C);
    } else {
        writeU8(0);  // useCubic = false
        writeU8(static_cast<uint8_t>(s.filter));
        writeU8(static_cast<uint8_t>(s.mipmap));
    }
}

void CommandBuffer::writeVertices(const SkVertices* v) {
    // nullptr safe guard
    if (!v) return;

    int vCount = v->vertexCount();
    int iCount = v->indexCount();

    // Bounds check: vertexCount ≤ kMaxVerticesCount
    if (static_cast<uint32_t>(vCount) > kMaxVerticesCount) {
        return;  // Degrade: skip oversized vertices
    }

    // vertexMode(u8): 0=Triangles, 1=TriangleStrip, 2=TriangleFan
    writeU8(static_cast<uint8_t>(v->mode()));   // SkVertices::VertexMode maps directly
    writeU32(static_cast<uint32_t>(vCount));
    writeU32(static_cast<uint32_t>(iCount));
    // SkVertices API: texCoords() and colors() return nullptr if not present
    const SkPoint* texPtr = v->texCoords();
    const SkColor* colorPtr = v->colors();
    writeU8(texPtr ? 1 : 0);
    writeU8(colorPtr ? 1 : 0);

    // Positions: f32 × vertexCount × 2
    const SkPoint* pos = v->positions();
    for (int i = 0; i < vCount; ++i) {
        writeF32(pos[i].x());
        writeF32(pos[i].y());
    }

    // TexCoords (if present): f32 × vertexCount × 2
    if (texPtr) {
        for (int i = 0; i < vCount; ++i) {
            writeF32(texPtr[i].x());
            writeF32(texPtr[i].y());
        }
    }

    // Colors (if present): u8 × vertexCount × 4 (RGBA)
    if (colorPtr) {
        for (int i = 0; i < vCount; ++i) {
            SkColor c = colorPtr[i];
            writeU8(SkColorGetR(c));
            writeU8(SkColorGetG(c));
            writeU8(SkColorGetB(c));
            writeU8(SkColorGetA(c));
        }
    }

    // Indices: u16 × indexCount
    if (iCount > 0) {
        const uint16_t* indices = v->indices();
        for (int i = 0; i < iCount; ++i) {
            writeU16(indices[i]);
        }
    }
}

void CommandBuffer::writeRect(const SkRect& r) {
    // left(f32) + top(f32) + right(f32) + bottom(f32) = 16 bytes LE
    writeF32(r.left());
    writeF32(r.top());
    writeF32(r.right());
    writeF32(r.bottom());
}

void CommandBuffer::writeRRect(const SkRRect& r) {
    // type(u8) + rect(16B, use writeRect) + 4 radii(4×8B=32B) = 49 bytes
    // SkRRect::Type: 0=Empty,1=Rect,2=Oval,3=Simple,4=NinePatch,5=Complex
    writeU8(static_cast<uint8_t>(r.type()));
    writeRect(r.rect());
    // Write all 4 corner radii (each corner: x(f32) + y(f32))
    // Works uniformly for all types (Empty/Rect→0, Oval→w/2,h/2, Simple→same×4, Complex→unique)
    static constexpr SkRRect::Corner kCorners[4] = {
        SkRRect::kUpperLeft_Corner, SkRRect::kUpperRight_Corner,
        SkRRect::kLowerRight_Corner, SkRRect::kLowerLeft_Corner
    };
    for (int i = 0; i < 4; ++i) {
        SkVector rad = r.radii(kCorners[i]);
        writeF32(rad.x());
        writeF32(rad.y());
    }
}

void CommandBuffer::writePoint(const SkPoint& p) {
    // x(f32) + y(f32) = 8 bytes
    writeF32(p.x());
    writeF32(p.y());
}

void CommandBuffer::writeColor4f(const SkColor4f& c) {
    // r(f32) + g(f32) + b(f32) + a(f32) = 16 bytes
    writeF32(c.fR);
    writeF32(c.fG);
    writeF32(c.fB);
    writeF32(c.fA);
}

void CommandBuffer::writeShadowRec(const SkDrawShadowRec& rec) {
    // fZPlaneX(f32) + fZPlaneY(f32) + fZPlaneZ(f32) +
    // fLightPosX(f32) + fLightPosY(f32) + fLightPosZ(f32) +
    // fLightRadius(f32) + fAmbientAlpha(f32) + fSpotAlpha(f32) + fFlags(u32)
    // = 40 bytes
    writeF32(rec.fZPlaneParams.fX);
    writeF32(rec.fZPlaneParams.fY);
    writeF32(rec.fZPlaneParams.fZ);
    writeF32(rec.fLightPos.fX);
    writeF32(rec.fLightPos.fY);
    writeF32(rec.fLightPos.fZ);
    writeF32(rec.fLightRadius);
    // Extract alpha from SkColor (ARGB → alpha only)
    writeF32(static_cast<float>(SkColorGetA(rec.fAmbientColor)) / 255.0f);
    writeF32(static_cast<float>(SkColorGetA(rec.fSpotColor)) / 255.0f);
    writeU32(rec.fFlags);
}

void CommandBuffer::writeM44(const SkM44& m) {
    // 4×4 矩阵 = 16 × f32 = 64 bytes, row-major (行主序)
    for (int r = 0; r < 4; ++r) {
        for (int c = 0; c < 4; ++c) {
            writeF32(m.rc(r, c));
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 图像槽位管理 — §4.1.4 并发模型
//
// Compositor 线程路径: reserveImageSlot() → 捕获 sk_sp 引用 (O(1))
// Worker 线程路径:    encodePendingImages() → encodeToData() (可能阻塞)
// ═══════════════════════════════════════════════════════════════

/// @brief 预留图像槽位（Compositor 线程，O(1)）。
///
/// 仅分配槽位 ID 并捕获 sk_sp 引用，不调用 encodeToData()。
/// sk_sp 构造时递增引用计数，确保 Worker 线程访问时图像仍存活。
/// 槽位 ID 从 0 开始，每次调用递增 (image_slots_.size())。
///
/// @param image Skia 图像指针（调用方持有 sk_sp，此处再增加一个引用）
/// @returns 槽位 ID（在命令流中通过 writeU32 写入）
uint32_t CommandBuffer::reserveImageSlot(const SkImage* image) {
    // 防御: 单帧图像槽位数量限制，防止 OOM
    if (image_slots_.size() >= kMaxImageSlotsPerFrame) {
        // 淘汰最旧的槽位（FIFO），但 slot_id 不复用（使用单调递增计数器）
        image_slots_.erase(image_slots_.begin());
    }
    // 使用单调递增计数器分配 slot_id，避免 FIFO 淘汰后 slot_id 碰撞
    uint32_t slot_id = next_slot_id_++;
    ImageSlot slot;
    slot.id = slot_id;
    slot.image = sk_sp<const SkImage>(image);  // 构造 sk_sp，递增引用计数（线程安全）
    slot.encoded = false;  // 标记为"待编码"
    image_slots_.push_back(slot);
    return slot_id;
}

/// @brief 编码所有待处理图像（Worker 线程调用）。
///
/// 遍历 image_slots_，跳过已编码 (encoded==true) 或空画像 (image==nullptr)。
/// 调用 image->encodeToData(SkEncodedImageFormat::kPNG, 85) 进行编码。
///
/// 编码参数:
///   - 格式: PNG (无损，支持透明度)
///   - 质量: 85 (JPEG/WebP 时使用，PNG 忽略)
///
/// @warning 单张 4K 图像耗时 10-50ms，多张可累计 >200ms。
///          必须在 Worker 线程调用，绝不可阻塞 Compositor 线程
///          （否则触发 Chromium 看门狗崩溃）。
/// @see §4.1.4 并发模型
void CommandBuffer::encodePendingImages() {
    // Worker 线程: 遍历所有未编码的图像槽位
    // 安全: sk_sp<SkImage> 引用计数是线程安全的 (Skia 保证)
    for (auto& slot : image_slots_) {
        if (slot.encoded) continue;  // 已编码，跳过
        if (!slot.image) {
            // 空槽位（图像可能已被释放），标记完成
            slot.encoded = true;
            continue;
        }
        // 实际编码: PNG 无损编码（PNG 忽略 quality 参数，但需要传递以兼容 API）
        sk_sp<SkData> encoded = slot.image->encodeToData(SkEncodedImageFormat::kPNG, 100);
        if (encoded && encoded->size() > 0) {
            const uint8_t* src = static_cast<const uint8_t*>(encoded->data());
            slot.data.assign(src, src + encoded->size());
        }
        slot.encoded = true;
    }
}

/// @brief 将已编码的图像槽位作为 kImageData 命令追加到命令流。
///
/// 每个 slot 生成一个 kImageData 命令:
///   opcode(1B) + payload_len(3B) + slot_id(4B) + data_size(4B) + data(N)
/// 必须在 AssembleFrame 之前调用。
void CommandBuffer::appendImageCommands() {
    // 将图像数据作为 kImageData 命令插入到命令流开头（在所有绘制命令之前），
    // 确保客户端在处理 DRAW_IMAGE 时 slot 数据已就绪。
    // 实现: 先构建图像命令缓冲区，再将其插入到现有命令流之前。

    std::vector<uint8_t> imageCommands;
    for (const auto& slot : image_slots_) {
        if (slot.encoded && !slot.data.empty()) {
            // payload: slot_id(4B) + data_size(4B) + data(N)
            uint32_t payloadLen = 4 + 4 + static_cast<uint32_t>(slot.data.size());

            // 边界检查: payload_len 字段只有 3 字节（24位），最大 16MB
            // 同时遵守 kMaxPayloadBytes (1MB) 命令级上限，与 endCommand 一致
            // 超过上限的图像跳过（防止 payload_len 截断导致客户端解析错位）
            if (payloadLen > 0xFFFFFF || payloadLen > kMaxPayloadBytes) {
                fprintf(stderr, "[CommandBuffer] appendImageCommands: slot %u data too large "
                        "(payloadLen=%u, limit=%u), skipping\n", slot.id, payloadLen, kMaxPayloadBytes);
                continue;
            }

            // 写入命令头: opcode(1B) + payload_len(3B)
            imageCommands.push_back(static_cast<uint8_t>(Opcode::kImageData));
            imageCommands.push_back(static_cast<uint8_t>(payloadLen & 0xFF));
            imageCommands.push_back(static_cast<uint8_t>((payloadLen >> 8) & 0xFF));
            imageCommands.push_back(static_cast<uint8_t>((payloadLen >> 16) & 0xFF));

            // 写入 payload: slot_id(4B) + data_size(4B) + data(N)
            // slot_id (LE u32)
            imageCommands.push_back(static_cast<uint8_t>(slot.id & 0xFF));
            imageCommands.push_back(static_cast<uint8_t>((slot.id >> 8) & 0xFF));
            imageCommands.push_back(static_cast<uint8_t>((slot.id >> 16) & 0xFF));
            imageCommands.push_back(static_cast<uint8_t>((slot.id >> 24) & 0xFF));
            // data_size (LE u32)
            uint32_t dataSize = static_cast<uint32_t>(slot.data.size());
            imageCommands.push_back(static_cast<uint8_t>(dataSize & 0xFF));
            imageCommands.push_back(static_cast<uint8_t>((dataSize >> 8) & 0xFF));
            imageCommands.push_back(static_cast<uint8_t>((dataSize >> 16) & 0xFF));
            imageCommands.push_back(static_cast<uint8_t>((dataSize >> 24) & 0xFF));
            // data
            imageCommands.insert(imageCommands.end(), slot.data.begin(), slot.data.end());

            // 4 字节对齐填充
            size_t totalCmdSize = 4 + payloadLen;
            size_t remainder = totalCmdSize % 4;
            if (remainder != 0) {
                imageCommands.insert(imageCommands.end(), 4 - remainder, 0);
            }
        }
    }

    // 将图像命令插入到命令流开头
    if (!imageCommands.empty()) {
        buffer_.insert(buffer_.begin(), imageCommands.begin(), imageCommands.end());
    }
}

/// @brief 计算完整帧字节数（命令流 + 图像编码数据 + 槽位头开销）。
///
/// 槽位头开销: 每个图像槽位额外 +8 字节 = slot_id(u32) + data_size(u32)。
///
/// @returns 总字节数
size_t CommandBuffer::totalSize() const {
    size_t total = buffer_.size();
    for (const auto& slot : image_slots_) {
        total += slot.data.size() + 8;  // slot_id(u32) + size(u32) 头部
    }
    return total;
}

/// @brief 清空所有状态（帧间复用缓冲区）。
///
/// 效果:
///   - 清空命令流缓冲区（重新 reserve 64KB）
///   - 清空图像槽位列表
///   - 重置状态机 (in_command_=false, current_command_start_=0)
///
/// 注意: 不清空 sent_hashes_（哈希集合跨帧保留，用于 hash-ref 去重）
void CommandBuffer::clear() {
    buffer_.clear();
    buffer_.reserve(65536);  // 预分配避免下帧立即几何增长
    image_slots_.clear();
    next_slot_id_ = 0;  // 重置槽位 ID 计数器
    in_command_ = false;
    current_command_start_ = 0;
}

// ═══════════════════════════════════════════════════════════════
// 图像哈希去重 — §4.1.4 配置项 1 (hash-ref 模式)
//
// 服务端维护已发送图像的 SHA-256 哈希集合 (sent_hashes_)。
// 客户端维护 64MB LRU 缓存 (kImageCacheBytes)。
// 新连接/重连后 sent_hashes_ 为空，客户端缓存失效 → 需重新预热。
// ═══════════════════════════════════════════════════════════════

/// @brief 计算图像的 SHA-256 哈希。
///
/// 安全: 使用完整 256-bit 输出（非截断），防止碰撞攻击。
/// 256-bit 空间的生日界约为 2^128 次操作，计算上不可行。
///
/// 实现策略（按优先级）:
///   1. BoringSSL/OpenSSL: SHA256() 对像素数据直接哈希（最快）
///   2. Fallback: DJB2 哈希（非密码安全，但可用于图像去重）
///
/// @param image Skia 图像（通过 peekPixels 获取像素数据后哈希）
/// @returns 32 字节 SHA-256 哈希
/// @note 哈希输入为像素原始字节，非编码后数据，避免编码开销
static CommandBuffer::ImageHash ComputeImageSHA256(const SkImage* image) {
    CommandBuffer::ImageHash hash{};

    if (!image) {
        std::memset(hash.bytes, 0, 32);
        return hash;
    }

#if defined(USE_BORINGSSL) || defined(USE_OPENSSL)
    // ── BoringSSL / OpenSSL path ──────────────────────────────────
    SkPixmap pixmap;
    if (image->peekPixels(&pixmap)) {
        // 光栅图像: 直接哈希像素数据
        SHA256(static_cast<const uint8_t*>(pixmap.addr()),
               pixmap.computeByteSize(),
               hash.bytes);
    } else {
        // 非光栅图像 (GPU-backed / lazy): 通过 PNG 编码获取字节
        sk_sp<SkData> encoded = image->encodeToData(SkEncodedImageFormat::kPNG, 100);
        if (encoded && encoded->size() > 0) {
            SHA256(static_cast<const uint8_t*>(encoded->data()),
                   encoded->size(),
                   hash.bytes);
        } else {
            std::memset(hash.bytes, 0, 32);
        }
    }
#else
    // ── Fallback: DJB2 hash (非密码安全，用于图像去重) ────────────
    // DJB2: hash = hash * 33 + byte
    // 将 64-bit 哈希扩展为 32 字节（填充低 8 字节，其余置零）
    uint64_t djb2 = 5381;

    SkPixmap pixmap;
    if (image->peekPixels(&pixmap)) {
        const uint8_t* data = static_cast<const uint8_t*>(pixmap.addr());
        size_t len = pixmap.computeByteSize();
        // 对像素数据取样哈希（每 64 字节取 1 字节，避免大图像开销过大）
        size_t step = std::max<size_t>(1, len / 4096);
        for (size_t i = 0; i < len; i += step) {
            djb2 = ((djb2 << 5) + djb2) + data[i];  // djb2 * 33 + byte
        }
    } else {
        // 非光栅图像: 编码为 PNG 后取样哈希
        sk_sp<SkData> encoded = image->encodeToData(SkEncodedImageFormat::kPNG, 100);
        if (encoded && encoded->size() > 0) {
            const uint8_t* data = static_cast<const uint8_t*>(encoded->data());
            size_t len = encoded->size();
            size_t step = std::max<size_t>(1, len / 4096);
            for (size_t i = 0; i < len; i += step) {
                djb2 = ((djb2 << 5) + djb2) + data[i];
            }
        }
    }

    // 将 DJB2 64-bit 哈希写入 bytes[0..7]，其余置零
    std::memset(hash.bytes, 0, 32);
    hash.bytes[0] = static_cast<uint8_t>(djb2 & 0xFF);
    hash.bytes[1] = static_cast<uint8_t>((djb2 >> 8) & 0xFF);
    hash.bytes[2] = static_cast<uint8_t>((djb2 >> 16) & 0xFF);
    hash.bytes[3] = static_cast<uint8_t>((djb2 >> 24) & 0xFF);
    hash.bytes[4] = static_cast<uint8_t>((djb2 >> 32) & 0xFF);
    hash.bytes[5] = static_cast<uint8_t>((djb2 >> 40) & 0xFF);
    hash.bytes[6] = static_cast<uint8_t>((djb2 >> 48) & 0xFF);
    hash.bytes[7] = static_cast<uint8_t>((djb2 >> 56) & 0xFF);
#endif

    return hash;
}

/// @brief O(n) 线性扫描已发送哈希集合。
///
/// n 通常 < 1000（典型网页的去重图像数量），线性扫描足够。
/// 若性能成为瓶颈可替换为 std::unordered_set + 自定义哈希。
/// @brief 检查当前哈希实现是否密码安全。
///
/// 当且仅当编译时链接了 BoringSSL/OpenSSL 时返回 true。
/// DJB2 回退路径不满足安全不变量 I-6（256-bit 抗碰撞），
/// 因此在回退路径下必须强制 inline 模式，禁止 hash-ref 去重。
static bool IsHashCryptographicallySecure() {
#if defined(USE_BORINGSSL) || defined(USE_OPENSSL)
    return true;
#else
    return false;
#endif
}

bool CommandBuffer::hasImageHash(const ImageHash& hash) const {
    for (const auto& h : sent_hashes_) {
        if (h == hash) return true;  // memcmp 32B 比较
    }
    return false;
}

/// @brief 将哈希追加到已发送集合。
///
/// 仅在 hash-ref 模式 + 首次遇到图像时调用。
/// 注意: 不检查重复（调用者应先用 hasImageHash 检查）。
/// 容量控制: 超出 kMaxSentHashes 时移除最旧的一半条目（FIFO 淘汰）。
void CommandBuffer::markImageHashSent(const ImageHash& hash) {
    sent_hashes_.push_back(hash);
    if (sent_hashes_.size() > kMaxSentHashes) {
        // FIFO 淘汰: 移除前半部分最旧的条目
        size_t keep = kMaxSentHashes / 2;
        sent_hashes_.erase(sent_hashes_.begin(), sent_hashes_.begin() + (sent_hashes_.size() - keep));
    }
}

// ═══════════════════════════════════════════════════════════════
// CRC32 — 表驱动 IEEE 802.3 多项式 (§6.2 Trailer)
//
// 多项式: 0xEDB88320 (反射多项式，与 zlib/Python binascii.crc32 一致)
// 校验范围: Header(30B) + CommandStream(N bytes)
// CRC32 值作为帧尾 4 字节 (uint32 LE)，在 AssembleFrame() 中写入。
//
// 安全不变量: CRC32 仅检测意外损坏（网络比特翻转/传输截断），
// 不提供防篡改保护。防篡改由 TLS 1.3 保证（§2.1 威胁模型）。
// ═══════════════════════════════════════════════════════════════

/// @brief 预计算的 CRC32 查找表 (256 × uint32_t = 1024 bytes, L1 友好)。
///
/// 多项式: 0xEDB88320 (IEEE 802.3 反射形式)。
/// 编译期静态初始化，运行期 O(1) 每字节。
static const uint32_t kCrc32Table[256] = {
    0x00000000, 0x77073096, 0xEE0E612C, 0x990951BA,
    0x076DC419, 0x706AF48F, 0xE963A535, 0x9E6495A3,
    0x0EDB8832, 0x79DCB8A4, 0xE0D5E91E, 0x97D2D988,
    0x09B64C2B, 0x7EB17CBD, 0xE7B82D07, 0x90BF1D91,
    0x1DB71064, 0x6AB020F2, 0xF3B97148, 0x84BE41DE,
    0x1ADAD47D, 0x6DDDE4EB, 0xF4D4B551, 0x83D385C7,
    0x136C9856, 0x646BA8C0, 0xFD62F97A, 0x8A65C9EC,
    0x14015C4F, 0x63066CD9, 0xFA0F3D63, 0x8D080DF5,
    0x3B6E20C8, 0x4C69105E, 0xD56041E4, 0xA2677172,
    0x3C03E4D1, 0x4B04D447, 0xD20D85FD, 0xA50AB56B,
    0x35B5A8FA, 0x42B2986C, 0xDBBBC9D6, 0xACBCF940,
    0x32D86CE3, 0x45DF5C75, 0xDCD60DCF, 0xABD13D59,
    0x26D930AC, 0x51DE003A, 0xC8D75180, 0xBFD06116,
    0x21B4F4B5, 0x56B3C423, 0xCFBA9599, 0xB8BDA50F,
    0x2802B89E, 0x5F058808, 0xC60CD9B2, 0xB10BE924,
    0x2F6F7C87, 0x58684C11, 0xC1611DAB, 0xB6662D3D,
    0x76DC4190, 0x01DB7106, 0x98D220BC, 0xEFD5102A,
    0x71B18589, 0x06B6B51F, 0x9FBFE4A5, 0xE8B8D433,
    0x7807C9A2, 0x0F00F934, 0x9609A88E, 0xE10E9818,
    0x7F6A0DBB, 0x086D3D2D, 0x91646C97, 0xE6635C01,
    0x6B6B51F4, 0x1C6C6162, 0x856530D8, 0xF262004E,
    0x6C0695ED, 0x1B01A57B, 0x8208F4C1, 0xF50FC457,
    0x65B0D9C6, 0x12B7E950, 0x8BBEB8EA, 0xFCB9887C,
    0x62DD1DDF, 0x15DA2D49, 0x8CD37CF3, 0xFBD44C65,
    0x4DB26158, 0x3AB551CE, 0xA3BC0074, 0xD4BB30E2,
    0x4ADFA541, 0x3DD895D7, 0xA4D1C46D, 0xD3D6F4FB,
    0x4369E96A, 0x346ED9FC, 0xAD678846, 0xDA60B8D0,
    0x44042D73, 0x33031DE5, 0xAA0A4C5F, 0xDD0D7CC9,
    0x5005713C, 0x270241AA, 0xBE0B1010, 0xC90C2086,
    0x5768B525, 0x206F85B3, 0xB966D409, 0xCE61E49F,
    0x5EDEF90E, 0x29D9C998, 0xB0D09822, 0xC7D7A8B4,
    0x59B33D17, 0x2EB40D81, 0xB7BD5C3B, 0xC0BA6CAD,
    0xEDB88320, 0x9ABFB3B6, 0x03B6E20C, 0x74B1D29A,
    0xEAD54739, 0x9DD277AF, 0x04DB2615, 0x73DC1683,
    0xE3630B12, 0x94643B84, 0x0D6D6A3E, 0x7A6A5AA8,
    0xE40ECF0B, 0x9309FF9D, 0x0A00AE27, 0x7D079EB1,
    0xF00F9344, 0x8708A3D2, 0x1E01F268, 0x6906C2FE,
    0xF762575D, 0x806567CB, 0x196C3671, 0x6E6B06E7,
    0xFED41B76, 0x89D32BE0, 0x10DA7A5A, 0x67DD4ACC,
    0xF9B9DF6F, 0x8EBEEFF9, 0x17B7BE43, 0x60B08ED5,
    0xD6D6A3E8, 0xA1D1937E, 0x38D8C2C4, 0x4FDFF252,
    0xD1BB67F1, 0xA6BC5767, 0x3FB506DD, 0x48B2364B,
    0xD80D2BDA, 0xAF0A1B4C, 0x36034AF6, 0x41047A60,
    0xDF60EFC3, 0xA867DF55, 0x316E8EEF, 0x4669BE79,
    0xCB61B38C, 0xBC66831A, 0x256FD2A0, 0x5268E236,
    0xCC0C7795, 0xBB0B4703, 0x220216B9, 0x5505262F,
    0xC5BA3BBE, 0xB2BD0B28, 0x2BB45A92, 0x5CB30A04,
    0xC2D7FFA7, 0xB5D0CF31, 0x2CD99E8B, 0x5BDEAE1D,
    0x9B64C2B0, 0xEC63F226, 0x756AA39C, 0x026D930A,
    0x9C0906A9, 0xEB0E363F, 0x72076785, 0x05005713,
    0x95BF4A82, 0xE2B87A14, 0x7BB12BAE, 0x0CB61B38,
    0x92D28E9B, 0xE5D5BE0D, 0x7CDCEFB7, 0x0BDBDF21,
    0x86D3D2D4, 0xF1D4E242, 0x68DDB3F8, 0x1FDA836E,
    0x81BE16CD, 0xF6B9265B, 0x6FB077E1, 0x18B74777,
    0x88085AE6, 0xFF0F6A70, 0x66063BCA, 0x11010B5C,
    0x8F659EFF, 0xF862AE69, 0x616BFFD3, 0x166CCF45,
    0xA00AE278, 0xD70DD2EE, 0x4E048354, 0x3903B3C2,
    0xA7672661, 0xD06016F7, 0x4969474D, 0x3E6E77DB,
    0xAED16A4A, 0xD9D65ADC, 0x40DF0B66, 0x37D83BF0,
    0xA9BCAE53, 0xDEBB9EC5, 0x47B2CF7F, 0x30B5FFE9,
    0xBDBDF21C, 0xCABAC28A, 0x53B39330, 0x24B4A3A6,
    0xBAD03605, 0xCDD70693, 0x54DE5729, 0x23D967BF,
    0xB3667A2E, 0xC4614AB8, 0x5D681B02, 0x2A6F2B94,
    0xB40BBE37, 0xC30C8EA1, 0x5A05DF1B, 0x2D02EF8D,
};

/// @brief 计算 CRC32 校验值（表驱动，O(n)）。
///
/// 算法流程:
///   1. crc ^= 0xFFFFFFFF（标准 CRC32 初始化 XOR）
///   2. 逐字节: crc = table[(crc ^ byte) & 0xFF] ^ (crc >> 8)
///   3. crc ^= 0xFFFFFFFF（最终 XOR，产生与 zlib 一致的输出）
///
/// 支持增量计算: 传入上次 crc 结果即可续算（例如分块 CRC）。
///
/// @param data 数据指针
/// @param len  字节数
/// @param crc  初始值（首次计算传 0，增量计算传上次结果）
/// @returns CRC32 校验值
uint32_t ComputeCRC32(const uint8_t* data, size_t len, uint32_t crc) {
    // 防御: 空指针安全 (len=0 时不需要访问 data)
    if (!data && len > 0) return 0;
    crc = crc ^ 0xFFFFFFFF;  // 标准初始化 XOR
    for (size_t i = 0; i < len; ++i) {
        // 表驱动: 索引 = (crc XOR 当前字节) 的低 8 位, 新 crc = 表值 XOR (crc >> 8)
        crc = kCrc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
    }
    return crc ^ 0xFFFFFFFF;  // 最终 XOR（与 zlib 输出一致）
}

// ═══════════════════════════════════════════════════════════════
// 帧头序列化/反序列化 — 手动 Little Endian 布局 (§6.2 Frame Header)
//
// 安全理由: FrameHeader 结构体含 int64_t (timestamp_ms)，编译器可能
// 插入 6 字节 padding（为满足 8 字节对齐）。若直接 memcpy 结构体，
// padding 字节在网络上传输可能导致:
//   (a) 客户端解析到垃圾数据（若客户端使用不同编译器/架构）
//   (b) 信息泄露（padding 可能包含栈残留数据）
// 因此所有字段逐一手动序列化，仅传输 30 字节有效载荷。
// ═══════════════════════════════════════════════════════════════

/// @brief 将 FrameHeader 序列化为 30 字节 Little Endian 缓冲区。
///
/// §6.2 字节布局:
///   [0:1]   version        uint8
///   [1:2]   flags          uint8
///   [2:6]   frame_id       uint32 LE
///   [6:14]  timestamp_ms   int64  LE
///   [14:18] scroll_x       int32  LE
///   [18:22] scroll_y       int32  LE
///   [22:24] viewport_w     uint16 LE
///   [24:26] viewport_h     uint16 LE
///   [26:28] canvas_w       uint16 LE
///   [28:30] canvas_h       uint16 LE
///
/// @param header 要序列化的帧头结构体
/// @param dst    目标缓冲区（调用者保证 ≥ 30 字节）
void SerializeFrameHeader(const FrameHeader& header, uint8_t* dst) {
    dst[0] = header.version;
    dst[1] = header.flags;

    // frame_id: uint32 LE → 4 字节
    dst[2] = static_cast<uint8_t>(header.frame_id & 0xFF);
    dst[3] = static_cast<uint8_t>((header.frame_id >> 8) & 0xFF);
    dst[4] = static_cast<uint8_t>((header.frame_id >> 16) & 0xFF);
    dst[5] = static_cast<uint8_t>((header.frame_id >> 24) & 0xFF);

    // timestamp_ms: int64 LE → 8 字节
    uint64_t ts = static_cast<uint64_t>(header.timestamp_ms);
    for (int i = 0; i < 8; ++i) {
        dst[6 + i] = static_cast<uint8_t>((ts >> (i * 8)) & 0xFF);
    }

    // scroll_x: int32 LE → 4 字节 (有符号，二进制补码)
    uint32_t sx = static_cast<uint32_t>(header.scroll_x);
    dst[14] = static_cast<uint8_t>(sx & 0xFF);
    dst[15] = static_cast<uint8_t>((sx >> 8) & 0xFF);
    dst[16] = static_cast<uint8_t>((sx >> 16) & 0xFF);
    dst[17] = static_cast<uint8_t>((sx >> 24) & 0xFF);

    // scroll_y: int32 LE → 4 字节
    uint32_t sy = static_cast<uint32_t>(header.scroll_y);
    dst[18] = static_cast<uint8_t>(sy & 0xFF);
    dst[19] = static_cast<uint8_t>((sy >> 8) & 0xFF);
    dst[20] = static_cast<uint8_t>((sy >> 16) & 0xFF);
    dst[21] = static_cast<uint8_t>((sy >> 24) & 0xFF);

    // viewport_w: uint16 LE → 2 字节
    dst[22] = static_cast<uint8_t>(header.viewport_w & 0xFF);
    dst[23] = static_cast<uint8_t>((header.viewport_w >> 8) & 0xFF);

    // viewport_h: uint16 LE → 2 字节
    dst[24] = static_cast<uint8_t>(header.viewport_h & 0xFF);
    dst[25] = static_cast<uint8_t>((header.viewport_h >> 8) & 0xFF);

    // canvas_w: uint16 LE → 2 字节
    dst[26] = static_cast<uint8_t>(header.canvas_w & 0xFF);
    dst[27] = static_cast<uint8_t>((header.canvas_w >> 8) & 0xFF);

    // canvas_h: uint16 LE → 2 字节
    dst[28] = static_cast<uint8_t>(header.canvas_h & 0xFF);
    dst[29] = static_cast<uint8_t>((header.canvas_h >> 8) & 0xFF);
}

/// @brief 从 30 字节 Little Endian 缓冲区反序列化 FrameHeader。
///
/// 按 §6.2 字节布局逐字段还原。使用位或移位组合，
/// 不依赖 memcpy 或结构体赋值。
///
/// @param src 源缓冲区（至少 30 字节）
/// @returns 反序列化后的 FrameHeader（所有字段填充完毕）
FrameHeader DeserializeFrameHeader(const uint8_t* src) {
    FrameHeader hdr{};

    hdr.version = src[0];
    hdr.flags   = src[1];

    // frame_id: 4 bytes → uint32 LE
    hdr.frame_id = static_cast<uint32_t>(src[2])
                 | (static_cast<uint32_t>(src[3]) << 8)
                 | (static_cast<uint32_t>(src[4]) << 16)
                 | (static_cast<uint32_t>(src[5]) << 24);

    // timestamp_ms: 8 bytes → int64 LE
    uint64_t ts = 0;
    for (int i = 0; i < 8; ++i) {
        ts |= static_cast<uint64_t>(src[6 + i]) << (i * 8);
    }
    hdr.timestamp_ms = static_cast<int64_t>(ts);

    // scroll_x: 4 bytes → int32 LE
    hdr.scroll_x = static_cast<int32_t>(
        static_cast<uint32_t>(src[14])
        | (static_cast<uint32_t>(src[15]) << 8)
        | (static_cast<uint32_t>(src[16]) << 16)
        | (static_cast<uint32_t>(src[17]) << 24));

    // scroll_y: 4 bytes → int32 LE
    hdr.scroll_y = static_cast<int32_t>(
        static_cast<uint32_t>(src[18])
        | (static_cast<uint32_t>(src[19]) << 8)
        | (static_cast<uint32_t>(src[20]) << 16)
        | (static_cast<uint32_t>(src[21]) << 24));

    // viewport_w: 2 bytes → uint16 LE
    hdr.viewport_w = static_cast<uint16_t>(src[22])
                   | (static_cast<uint16_t>(src[23]) << 8);

    // viewport_h: 2 bytes → uint16 LE
    hdr.viewport_h = static_cast<uint16_t>(src[24])
                   | (static_cast<uint16_t>(src[25]) << 8);

    // canvas_w: 2 bytes → uint16 LE
    hdr.canvas_w = static_cast<uint16_t>(src[26])
                 | (static_cast<uint16_t>(src[27]) << 8);

    // canvas_h: 2 bytes → uint16 LE
    hdr.canvas_h = static_cast<uint16_t>(src[28])
                 | (static_cast<uint16_t>(src[29]) << 8);

    return hdr;
}

// ═══════════════════════════════════════════════════════════════
// 帧组装 — 最终阶段 (§3.1 全局数据流: Finalize → DeliverFrame)
//
// AssembleFrame 将 Header + Commands + CRC32 合并为单个 FrameBuffer，
// 这是 C++ 层对帧的最后一次处理。组装后数据通过 Mojo/pipe 发送到
// Node.js I/O 代理，再经 gzip 压缩 + WebSocket 传输到客户端。
//
// 安全关键: 组装前双重校验 total size ≤ kMaxBytesPerFrame。
// ═══════════════════════════════════════════════════════════════

/// @brief 组装完整帧（Header + CommandStream + CRC32 Trailer）。
///
/// 组装流程:
///   1. 计算 total = kFrameHeaderSize(30) + cmd_size + kFrameTrailerSize(4)
///   2. **安全检查**: 若 total > kMaxBytesPerFrame → 抛出 length_error
///   3. 分配 FrameBuffer (std::make_unique<uint8_t[]>)
///   4. 写入 Header (SerializeFrameHeader)
///   5. 拷贝 CommandStream (memcpy)
///   6. 计算 CRC32 (Header + Commands)，写入尾部 4 字节 (uint32 LE)
///
/// §6.2 Frame 消息布局:
///   Byte 0-29:    Frame Header
///   Byte 30..N-5: Command Stream
///   Byte N-4..N-1: CRC32 (uint32 LE)
///
/// @param header   帧元数据
/// @param commands 已最终化的 CommandBuffer
/// @returns FrameBuffer（拥有完整帧数据的所有权）
/// @throws std::length_error 若 total size > kMaxBytesPerFrame
FrameBuffer AssembleFrame(const FrameHeader& header,
                          const CommandBuffer& commands) {
    size_t cmd_size = commands.commandStreamSize();
    size_t total = kFrameHeaderSize + cmd_size + kFrameTrailerSize;

    // 安全关键: 帧级总字节硬上限检查 (§8.4 安全边界, v1.6 P0 S1)
    if (total > kMaxBytesPerFrame) {
        throw std::length_error("AssembleFrame: total size exceeds MAX_BYTES_PER_FRAME");
    }

    FrameBuffer fb;
    fb.data = std::make_unique<uint8_t[]>(total);
    fb.size = total;

    // 1. 写入帧头（30 字节，手动 LE 序列化）
    SerializeFrameHeader(header, fb.data.get());

    // 2. 拷贝命令流（纯 memcpy，命令流已在 CommandBuffer 中完成序列化）
    if (cmd_size > 0) {
        std::memcpy(fb.data.get() + kFrameHeaderSize, commands.data(), cmd_size);
    }

    // 3. 计算并写入 CRC32 (Header + Command Stream)
    //    CRC 范围: fb.data[0 .. kFrameHeaderSize + cmd_size - 1]
    uint32_t crc = ComputeCRC32(fb.data.get(), kFrameHeaderSize + cmd_size);
    size_t crc_offset = kFrameHeaderSize + cmd_size;
    // CRC32 写入为 uint32 LE
    fb.data[crc_offset]     = static_cast<uint8_t>(crc & 0xFF);         // LSB
    fb.data[crc_offset + 1] = static_cast<uint8_t>((crc >> 8) & 0xFF);
    fb.data[crc_offset + 2] = static_cast<uint8_t>((crc >> 16) & 0xFF);
    fb.data[crc_offset + 3] = static_cast<uint8_t>((crc >> 24) & 0xFF); // MSB

    return fb;
}

}  // namespace garnet
