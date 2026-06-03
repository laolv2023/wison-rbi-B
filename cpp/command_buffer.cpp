// command_buffer.cpp — CommandBuffer 实现
//
// 包含:
// 1. CommandBuffer 写入/序列化
// 2. CRC32 计算
// 3. 帧序列化/反序列化
// 4. 帧组装
//
// 字节序: 全部 Little Endian
//
#include "command_buffer.h"

#include <algorithm>
#include <cassert>
#include <cstring>
#include <new>
#include <stdexcept>

namespace garnet {

// ═══════════════════════════════════════════════════════════════
// CommandBuffer 构造/析构
// ═══════════════════════════════════════════════════════════════

CommandBuffer::CommandBuffer()
    : image_mode_(ImageMode::kInline)
    , current_command_start_(0)
    , in_command_(false)
{
    buffer_.reserve(65536);  // 预分配 64KB（典型帧）
}

CommandBuffer::CommandBuffer(ImageMode image_mode)
    : image_mode_(image_mode)
    , current_command_start_(0)
    , in_command_(false)
{
    buffer_.reserve(65536);
}

CommandBuffer::~CommandBuffer() = default;

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
// 内部辅助
// ═══════════════════════════════════════════════════════════════

void CommandBuffer::ensureCapacity(size_t additional_bytes) {
    if (buffer_.size() + additional_bytes > buffer_.capacity()) {
        growBuffer(buffer_.size() + additional_bytes);
    }
}

void CommandBuffer::growBuffer(size_t min_capacity) {
    // 增长策略: 1.5× 几何增长，减少分配次数
    size_t new_cap = std::max(buffer_.capacity() * 3 / 2, min_capacity);
    // 不超过帧级硬上限
    if (new_cap > kMaxBytesPerFrame) {
        new_cap = kMaxBytesPerFrame;
    }
    if (buffer_.size() + (min_capacity - buffer_.size()) > kMaxBytesPerFrame) {
        throw std::length_error("CommandBuffer: frame exceeds MAX_BYTES_PER_FRAME");
    }
    buffer_.reserve(new_cap);
}

// ═══════════════════════════════════════════════════════════════
// 命令写入
// ═══════════════════════════════════════════════════════════════

void CommandBuffer::beginCommand(Opcode opcode) {
    if (in_command_) {
        throw std::logic_error("beginCommand called while command in progress");
    }
    if (!IsValidOpcode(static_cast<uint8_t>(opcode))) {
        throw std::invalid_argument("CommandBuffer: invalid opcode");
    }

    current_command_start_ = buffer_.size();

    // 写 opcode + 占位 pay_len（稍后回填）
    ensureCapacity(kCommandHeaderSize);
    buffer_.push_back(static_cast<uint8_t>(opcode));
    buffer_.push_back(0);  // pay_len[0] 占位
    buffer_.push_back(0);  // pay_len[1] 占位
    buffer_.push_back(0);  // pay_len[2] 占位

    in_command_ = true;
}

void CommandBuffer::endCommand() {
    if (!in_command_) {
        throw std::logic_error("endCommand called without beginCommand");
    }

    // 回填 pay_len（3 字节 uint24 LE）
    size_t payload_start = current_command_start_ + kCommandHeaderSize;
    size_t payload_size = buffer_.size() - payload_start;

    if (payload_size > kMaxPayloadBytes) {
        // 回退缓冲区并抛出
        buffer_.resize(current_command_start_);
        in_command_ = false;
        throw std::length_error("CommandBuffer: payload exceeds MAX_PAYLOAD_BYTES");
    }

    // 回填 pay_len 为 3 字节 Little Endian
    buffer_[current_command_start_ + 1] = static_cast<uint8_t>(payload_size & 0xFF);
    buffer_[current_command_start_ + 2] = static_cast<uint8_t>((payload_size >> 8) & 0xFF);
    buffer_[current_command_start_ + 3] = static_cast<uint8_t>((payload_size >> 16) & 0xFF);

    // 4 字节对齐填充（如果当前偏移不是 4 的倍数）
    padToAlignment(4);

    in_command_ = false;
}

void CommandBuffer::writeCommand(Opcode opcode, const uint8_t* payload, uint32_t pay_len) {
    beginCommand(opcode);
    writeBlob(payload, pay_len);
    endCommand();
}

// ═══════════════════════════════════════════════════════════════
// Payload 基本类型写入 (Little Endian)
// ═══════════════════════════════════════════════════════════════

void CommandBuffer::writeU8(uint8_t value) {
    ensureCapacity(1);
    buffer_.push_back(value);
}

void CommandBuffer::writeU16(uint16_t value) {
    ensureCapacity(2);
    buffer_.push_back(static_cast<uint8_t>(value & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
}

void CommandBuffer::writeU24(uint32_t value) {
    ensureCapacity(3);
    buffer_.push_back(static_cast<uint8_t>(value & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
}

void CommandBuffer::writeU32(uint32_t value) {
    ensureCapacity(4);
    buffer_.push_back(static_cast<uint8_t>(value & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
    buffer_.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
}

void CommandBuffer::writeI32(int32_t value) {
    writeU32(static_cast<uint32_t>(value));
}

void CommandBuffer::writeI64(int64_t value) {
    writeU64(static_cast<uint64_t>(value));
}

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

void CommandBuffer::writeF32(float value) {
    uint32_t bits;
    std::memcpy(&bits, &value, sizeof(bits));
    writeU32(bits);
}

void CommandBuffer::writeF64(double value) {
    uint64_t bits;
    std::memcpy(&bits, &value, sizeof(bits));
    ensureCapacity(8);
    writeU64(bits);
}

void CommandBuffer::writeBool(bool value) {
    writeU8(value ? 1 : 0);
}

void CommandBuffer::writeBlob(const uint8_t* data, size_t len) {
    if (len == 0) return;
    ensureCapacity(len);
    buffer_.insert(buffer_.end(), data, data + len);
}

void CommandBuffer::writeBlob(const void* data, size_t len) {
    writeBlob(static_cast<const uint8_t*>(data), len);
}

void CommandBuffer::writeString(const std::string& str) {
    writeU32(static_cast<uint32_t>(str.size()));
    writeBlob(reinterpret_cast<const uint8_t*>(str.data()), str.size());
}

void CommandBuffer::padToAlignment(size_t alignment) {
    size_t remainder = buffer_.size() % alignment;
    if (remainder != 0) {
        size_t pad = alignment - remainder;
        ensureCapacity(pad);
        for (size_t i = 0; i < pad; ++i) {
            buffer_.push_back(0);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Skia 对象序列化 (stub — 实际由 RecordingCanvas 填充细节)
// ═══════════════════════════════════════════════════════════════

// 这些方法在 RecordingCanvas 中被重写或由 RecordingCanvas 内部实现。
// 此处提供基础实现。

void CommandBuffer::writePaint(const SkPaint&) {
    // 由 RecordingCanvas 内部实现 SkPaint 序列化:
    //   color(4) + blendMode(1) + style(1) + strokeWidth(f32) +
    //   strokeMiter(f32) + strokeCap(1) + strokeJoin(1) + antiAlias(1) +
    //   hasShader(1) + hasMaskFilter(1) + hasColorFilter(1) +
    //   hasPathEffect(1) + hasImageFilter(1)
    // 详见设计文档 §4.1.3
}

void CommandBuffer::writePath(const SkPath&) {
    // 由 RecordingCanvas 内部实现 SkPath 序列化:
    //   verbCount(u32) + pointCount(u32) + verbs[] + points[]
}

void CommandBuffer::writeTextBlob(const SkTextBlob*) {
    // 由 RecordingCanvas 内部实现 SkTextBlob 序列化
}

void CommandBuffer::writeImage(const SkImage* image) {
    // 由 RecordingCanvas 内部实现图像序列化
    // 参见设计文档 §4.1.4 writeImage 方法
    if (!image) return;

    if (image_mode_ == ImageMode::kHashRef) {
        auto hash = ComputeImageSHA256(image);
        if (hasImageHash(hash)) {
            writeU8(0x01);       // flag: 引用
            writeBlob(hash.bytes, 32);
            return;
        }
        markImageHashSent(hash);
    }
    writeU8(0x00);               // flag: 内联
    uint32_t slot = reserveImageSlot(image);
    writeU32(slot);              // 槽位 ID
    if (image_mode_ == ImageMode::kHashRef) {
        auto hash = ComputeImageSHA256(image);
        writeBlob(hash.bytes, 32);
    }
}

void CommandBuffer::writeSamplingOptions(const SkSamplingOptions&) {
    // 序列化: useCubic(1) + cubic B(u32)+C(u32) 或 filter(1)+mipmap(1)
}

void CommandBuffer::writeVertices(const SkVertices*) {
    // 序列化: vertexMode(1) + vertexCount(u32) + indexCount(u32) +
    //   hasTexs(1) + hasColors(1) + positions[] + texCoords[] + colors[] + indices[]
}

void CommandBuffer::writeRect(const SkRect&) {
    // left(f32) + top(f32) + right(f32) + bottom(f32) = 16 bytes
}

void CommandBuffer::writeRRect(const SkRRect&) {
    // type(1) + rect(16) + radii[4](32) = 49 bytes
}

void CommandBuffer::writePoint(const SkPoint&) {
    // x(f32) + y(f32) = 8 bytes
}

void CommandBuffer::writeColor4f(const SkColor4f&) {
    // r(f32) + g(f32) + b(f32) + a(f32) = 16 bytes
}

void CommandBuffer::writeShadowRec(const SkDrawShadowRec&) {
    // 由 RecordingCanvas 内部实现
}

void CommandBuffer::writeM44(const SkM44&) {
    // 4×4 矩阵 = 16 × f32 = 64 bytes (v1.6 新增)
}

// ═══════════════════════════════════════════════════════════════
// 图像槽位管理
// ═══════════════════════════════════════════════════════════════

uint32_t CommandBuffer::reserveImageSlot(const SkImage* image) {
    uint32_t slot_id = static_cast<uint32_t>(image_slots_.size());
    ImageSlot slot;
    slot.id = slot_id;
    slot.image = image;
    slot.encoded = false;
    image_slots_.push_back(slot);
    return slot_id;
}

void CommandBuffer::encodePendingImages() {
    // Worker 线程: 遍历所有未编码的图像槽位，调用 image->encodeToData()
    // 将编码结果写入 slot.data
    // 注意: 此处为 stub，实际编码由 Skia API 完成
    for (auto& slot : image_slots_) {
        if (slot.encoded) continue;
        if (!slot.image) {
            slot.encoded = true;
            continue;
        }
        // sk_sp<SkData> encoded = slot.image->encodeToData(SkEncodedImageFormat::kPNG, 85);
        // if (encoded) {
        //     slot.data.assign(encoded->bytes(), encoded->bytes() + encoded->size());
        // }
        slot.encoded = true;
    }
}

size_t CommandBuffer::totalSize() const {
    size_t total = buffer_.size();
    for (const auto& slot : image_slots_) {
        total += slot.data.size() + 8;  // slot_id(u32) + size(u32) + data
    }
    return total;
}

void CommandBuffer::clear() {
    buffer_.clear();
    buffer_.reserve(65536);
    image_slots_.clear();
    in_command_ = false;
    current_command_start_ = 0;
}

// ═══════════════════════════════════════════════════════════════
// 图像哈希去重
// ═══════════════════════════════════════════════════════════════

// 注: ComputeImageSHA256 在实际实现中会调用 SHA-256 哈希函数。
// 此处 stub 返回零哈希。
static CommandBuffer::ImageHash ComputeImageSHA256(const SkImage*) {
    CommandBuffer::ImageHash hash{};
    std::memset(hash.bytes, 0, 32);
    return hash;
}

bool CommandBuffer::hasImageHash(const ImageHash& hash) const {
    for (const auto& h : sent_hashes_) {
        if (h == hash) return true;
    }
    return false;
}

void CommandBuffer::markImageHashSent(const ImageHash& hash) {
    sent_hashes_.push_back(hash);
}

// ═══════════════════════════════════════════════════════════════
// CRC32 (多项式 0xEDB88320, IEEE 802.3)
// ═══════════════════════════════════════════════════════════════

// 预计算 CRC32 查找表
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

uint32_t ComputeCRC32(const uint8_t* data, size_t len, uint32_t crc) {
    crc = crc ^ 0xFFFFFFFF;
    for (size_t i = 0; i < len; ++i) {
        crc = kCrc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
    }
    return crc ^ 0xFFFFFFFF;
}

// ═══════════════════════════════════════════════════════════════
// 帧头序列化/反序列化
// ═══════════════════════════════════════════════════════════════

void SerializeFrameHeader(const FrameHeader& header, uint8_t* dst) {
    dst[0] = header.version;
    dst[1] = header.flags;

    // frame_id: uint32 LE
    dst[2] = static_cast<uint8_t>(header.frame_id & 0xFF);
    dst[3] = static_cast<uint8_t>((header.frame_id >> 8) & 0xFF);
    dst[4] = static_cast<uint8_t>((header.frame_id >> 16) & 0xFF);
    dst[5] = static_cast<uint8_t>((header.frame_id >> 24) & 0xFF);

    // timestamp_ms: int64 LE
    uint64_t ts = static_cast<uint64_t>(header.timestamp_ms);
    for (int i = 0; i < 8; ++i) {
        dst[6 + i] = static_cast<uint8_t>((ts >> (i * 8)) & 0xFF);
    }

    // scroll_x: int32 LE
    uint32_t sx = static_cast<uint32_t>(header.scroll_x);
    dst[14] = static_cast<uint8_t>(sx & 0xFF);
    dst[15] = static_cast<uint8_t>((sx >> 8) & 0xFF);
    dst[16] = static_cast<uint8_t>((sx >> 16) & 0xFF);
    dst[17] = static_cast<uint8_t>((sx >> 24) & 0xFF);

    // scroll_y: int32 LE
    uint32_t sy = static_cast<uint32_t>(header.scroll_y);
    dst[18] = static_cast<uint8_t>(sy & 0xFF);
    dst[19] = static_cast<uint8_t>((sy >> 8) & 0xFF);
    dst[20] = static_cast<uint8_t>((sy >> 16) & 0xFF);
    dst[21] = static_cast<uint8_t>((sy >> 24) & 0xFF);

    // viewport_w: uint16 LE
    dst[22] = static_cast<uint8_t>(header.viewport_w & 0xFF);
    dst[23] = static_cast<uint8_t>((header.viewport_w >> 8) & 0xFF);

    // viewport_h: uint16 LE
    dst[24] = static_cast<uint8_t>(header.viewport_h & 0xFF);
    dst[25] = static_cast<uint8_t>((header.viewport_h >> 8) & 0xFF);

    // canvas_w: uint16 LE
    dst[26] = static_cast<uint8_t>(header.canvas_w & 0xFF);
    dst[27] = static_cast<uint8_t>((header.canvas_w >> 8) & 0xFF);

    // canvas_h: uint16 LE
    dst[28] = static_cast<uint8_t>(header.canvas_h & 0xFF);
    dst[29] = static_cast<uint8_t>((header.canvas_h >> 8) & 0xFF);
}

FrameHeader DeserializeFrameHeader(const uint8_t* src) {
    FrameHeader hdr{};

    hdr.version = src[0];
    hdr.flags   = src[1];

    // frame_id: uint32 LE
    hdr.frame_id = static_cast<uint32_t>(src[2])
                 | (static_cast<uint32_t>(src[3]) << 8)
                 | (static_cast<uint32_t>(src[4]) << 16)
                 | (static_cast<uint32_t>(src[5]) << 24);

    // timestamp_ms: int64 LE
    uint64_t ts = 0;
    for (int i = 0; i < 8; ++i) {
        ts |= static_cast<uint64_t>(src[6 + i]) << (i * 8);
    }
    hdr.timestamp_ms = static_cast<int64_t>(ts);

    // scroll_x: int32 LE
    hdr.scroll_x = static_cast<int32_t>(
        static_cast<uint32_t>(src[14])
        | (static_cast<uint32_t>(src[15]) << 8)
        | (static_cast<uint32_t>(src[16]) << 16)
        | (static_cast<uint32_t>(src[17]) << 24));

    // scroll_y: int32 LE
    hdr.scroll_y = static_cast<int32_t>(
        static_cast<uint32_t>(src[18])
        | (static_cast<uint32_t>(src[19]) << 8)
        | (static_cast<uint32_t>(src[20]) << 16)
        | (static_cast<uint32_t>(src[21]) << 24));

    // viewport_w: uint16 LE
    hdr.viewport_w = static_cast<uint16_t>(src[22])
                   | (static_cast<uint16_t>(src[23]) << 8);

    // viewport_h: uint16 LE
    hdr.viewport_h = static_cast<uint16_t>(src[24])
                   | (static_cast<uint16_t>(src[25]) << 8);

    // canvas_w: uint16 LE
    hdr.canvas_w = static_cast<uint16_t>(src[26])
                 | (static_cast<uint16_t>(src[27]) << 8);

    // canvas_h: uint16 LE
    hdr.canvas_h = static_cast<uint16_t>(src[28])
                 | (static_cast<uint16_t>(src[29]) << 8);

    return hdr;
}

// ═══════════════════════════════════════════════════════════════
// 帧组装
// ═══════════════════════════════════════════════════════════════

FrameBuffer AssembleFrame(const FrameHeader& header,
                          const CommandBuffer& commands) {
    size_t cmd_size = commands.commandStreamSize();
    size_t total = kFrameHeaderSize + cmd_size + kFrameTrailerSize;

    if (total > kMaxBytesPerFrame) {
        throw std::length_error("AssembleFrame: total size exceeds MAX_BYTES_PER_FRAME");
    }

    FrameBuffer fb;
    fb.data = std::make_unique<uint8_t[]>(total);
    fb.size = total;

    // 1. 写帧头
    SerializeFrameHeader(header, fb.data.get());

    // 2. 拷贝命令流
    if (cmd_size > 0) {
        std::memcpy(fb.data.get() + kFrameHeaderSize, commands.data(), cmd_size);
    }

    // 3. 计算并写入 CRC32 (Header + Command Stream)
    uint32_t crc = ComputeCRC32(fb.data.get(), kFrameHeaderSize + cmd_size);
    size_t crc_offset = kFrameHeaderSize + cmd_size;
    fb.data[crc_offset]     = static_cast<uint8_t>(crc & 0xFF);
    fb.data[crc_offset + 1] = static_cast<uint8_t>((crc >> 8) & 0xFF);
    fb.data[crc_offset + 2] = static_cast<uint8_t>((crc >> 16) & 0xFF);
    fb.data[crc_offset + 3] = static_cast<uint8_t>((crc >> 24) & 0xFF);

    return fb;
}

}  // namespace garnet
