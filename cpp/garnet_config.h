// garnet_config.h — 编译时常量与硬上限定义
//
// 安全理由: 所有上限在此集中定义，避免分散在代码中的魔法数字。
// 每个常量附带安全理由注释，可审计。
//
// 版本: v1.6 (第二轮安全审计修复版)
//
#ifndef GARNET_GARNET_CONFIG_H_
#define GARNET_GARNET_CONFIG_H_

#include <cstddef>
#include <cstdint>

namespace garnet {

// ═══════════════════════════════════════════════════════════════
// 协议版本
// ═══════════════════════════════════════════════════════════════

// 当前支持的协议版本 (帧头 Byte 0)
// 安全理由: 客户端据此识别不兼容的帧格式并拒绝/请求降级
constexpr uint8_t kProtocolVersion = 0x01;

// 协议标志位 (帧头 Byte 1)
// 安全理由: 位掩码允许逐位定义，防止标志位歧义
constexpr uint8_t kFlagIsKeyframe  = 0x01;  // bit0: 全帧(keyframe) vs 增量帧
constexpr uint8_t kFlagHasFontData = 0x02;  // bit1: 帧内包含字体二进制数据

// ═══════════════════════════════════════════════════════════════
// 帧级硬上限 (v1.6 P0 S1)
// ═══════════════════════════════════════════════════════════════

// 单帧解压后总字节硬上限
// 安全理由: 防止恶意帧耗尽客户端内存。64MB 足够容纳最复杂页面的首帧
// (全屏 4K 图片内联 ≈ 32MB，加其他绘制命令的合理上限)
constexpr size_t kMaxBytesPerFrame = 64 * 1024 * 1024;  // 64 MB

// gzip 压缩后的帧大小上限
// 安全理由: zip bomb 第一层防护 — 压缩数据本身不应超过合理大小。
// 4MB 是 gzip 压缩 64MB 零字节的理论上限
constexpr size_t kMaxCompressedFrame = 4 * 1024 * 1024;  // 4 MB

// gzip 压缩比异常阈值
// 安全理由: zip bomb 第三层防护 — 解压后大小 / 压缩大小 > 此值 → 拒绝。
// 1000:1 远超正常网页帧的压缩比（通常 2:1 ~ 10:1）
constexpr double kMaxCompressionRatio = 1000.0;

// ═══════════════════════════════════════════════════════════════
// 命令级硬上限
// ═══════════════════════════════════════════════════════════════

// 单条命令 payload 最大字节数
// 安全理由: 防止单条命令包含超大 payload 绕过帧级检查。
// 1MB 覆盖最复杂的图像内联场景
constexpr uint32_t kMaxPayloadBytes = 1 * 1024 * 1024;  // 1 MB

// 单帧最大命令数
// 安全理由: 防止命令数耗尽 CPU（每条命令需经历白名单扫描 + 子结构校验）
constexpr uint32_t kMaxCommandsPerFrame = 100000;

// ═══════════════════════════════════════════════════════════════
// 路径/文本子结构上限 (v1.6 深度校验)
// ═══════════════════════════════════════════════════════════════

// drawPath 最大 verb/point 数量
// 安全理由: 防止 drawPath payload 中伪造 count 导致 OOM。
// 100000 个点足够覆盖 SVG 复杂路径，远超正常使用场景
constexpr uint32_t kMaxPathVerbs = 100000;

// drawTextBlob 最大 glyph 数量
// 安全理由: 防止 drawTextBlob payload 中伪造 glyphCount 导致 OOM。
// 50000 glyphs ≈ 500KB 数据，覆盖极限场景（整页 CJK 字符）
constexpr uint32_t kMaxTextBlobGlyphs = 50000;

// drawVertices 最大顶点数
// 安全理由: 防止 drawVertices payload 中伪造 vertexCount 导致 OOM
constexpr uint32_t kMaxVerticesCount = 100000;

// drawAtlas 最大精灵数
// 安全理由: 防止 drawAtlas payload 中伪造 count 导致 OOM
constexpr uint32_t kMaxAtlasCount = 100000;

// ═══════════════════════════════════════════════════════════════
// 图像/字体缓存上限
// ═══════════════════════════════════════════════════════════════

// 客户端图像 LRU 缓存大小
// 安全理由: 限制 hash-ref 模式的图像缓存内存占用
constexpr size_t kImageCacheBytes = 64 * 1024 * 1024;  // 64 MB

// 客户端字体 LRU 缓存大小
// 安全理由: 限制 @font-face 内联字体的缓存内存占用
constexpr size_t kFontCacheBytes = 64 * 1024 * 1024;  // 64 MB

// 单次字体内联传输上限
// 安全理由: 防止恶意 @font-face 传输超大"字体"文件
constexpr size_t kMaxFontInlineBytes = 5 * 1024 * 1024;  // 5 MB

// ═══════════════════════════════════════════════════════════════
// 帧历史/会话上限
// ═══════════════════════════════════════════════════════════════

// 帧历史最大保留时间（毫秒）
// 安全理由: 防止帧历史无限增长耗尽内存。
// 1000ms 覆盖合理的输入延迟（网络RTT + 帧生成）
constexpr int64_t kFrameHistoryMaxAgeMs = 1000;

// 帧历史最大条目数（硬上限）
// 安全理由: 即使时间未到，条目数也需上限
constexpr size_t kFrameHistoryMaxEntries = 1000;

// 白名单连续拒绝阈值 → 触发 request_keyframe
// 安全理由: 避免客户端卡在坏帧上无法恢复。
// 3 帧足够区分"偶发损坏"和"持续损坏"
constexpr uint32_t kConsecutiveRejectThreshold = 3;

// frame_id 跳跃阈值 → 触发 request_keyframe
// 安全理由: 检测服务端可能的帧丢失或重启
constexpr uint32_t kFrameIdJumpThreshold = 1000;

// ═══════════════════════════════════════════════════════════════
// 服务端运行时上限
// ═══════════════════════════════════════════════════════════════

// Chromium 实例最大内存（触发强制重启）
// 安全理由: 防止 Chromium 内存泄漏耗尽服务器资源
constexpr size_t kChromiumMaxMemoryBytes = 2ULL * 1024 * 1024 * 1024;  // 2 GB

// Chromium 启动超时（毫秒）
constexpr int64_t kChromiumStartupTimeoutMs = 60000;  // 60 s

// 页面加载超时（毫秒）
constexpr int64_t kPageLoadTimeoutMs = 30000;  // 30 s

// CDP 命令超时（毫秒）
constexpr int64_t kCdpCommandTimeoutMs = 3000;  // 3 s

// WebSocket 发送缓冲区高水位（触发丢帧）
constexpr size_t kWebSocketHighWaterMark = 1 * 1024 * 1024;  // 1 MB

// 会话空闲超时（毫秒）— 无客户端连接时关闭 Chromium
constexpr int64_t kSessionIdleTimeoutMs = 120000;  // 120 s

// ═══════════════════════════════════════════════════════════════
// 字体格式校验 (v1.6 P1 S4)
// ═══════════════════════════════════════════════════════════════

// SFNT/OpenType Magic 字节白名单
// 安全理由: 仅接受合法字体格式，防止 @font-face 被滥用为数据外泄通道
//   - 0x00010000: TrueType (经典 sfVersion，大端序)
//   - "OTTO":     OpenType CFF
//   - "true":     TrueType (Apple)
//   - "ttcf":     TrueType Collection
//   - "wOF2":     WOFF2
constexpr uint32_t kSfntMagicTrueType   = 0x00010000;  // 大端序: 00 01 00 00
// "OTTO" 作为 uint32 大端 = 0x4F54544F
constexpr uint32_t kSfntMagicOpenType   = 0x4F54544F;
// "true" 作为 uint32 = 0x74727565
constexpr uint32_t kSfntMagicAppleTrue  = 0x74727565;
// "ttcf" 作为 uint32 = 0x74746366
constexpr uint32_t kSfntMagicCollection = 0x74746366;
// "wOF2" = WOFF2 magic: 0x774F4632
constexpr uint32_t kWoff2Magic         = 0x774F4632;

// ═══════════════════════════════════════════════════════════════
// Opcode 范围 (与 frame_constants.h 的枚举同步)
// ═══════════════════════════════════════════════════════════════

// 合法 opcode 范围
constexpr uint8_t kOpcodeMin = 0x01;
constexpr uint8_t kOpcodeMax = 0x7F;

// 非法 opcode（客户端必须拒收）
constexpr uint8_t kOpcodeIllegalMin = 0x80;  // ≥ 0x80 一律非法

// ═══════════════════════════════════════════════════════════════
// 性能基准目标 (Phase 4 — §9.1)
//
// 所有目标值均为 Phase 3 的生产级别指标。Phase 1 目标见设计文档。
// 基准测试运行: node server/benchmark.js
// ═══════════════════════════════════════════════════════════════

// 端到端延迟目标 (点击→画面更新, ms)
constexpr double kTargetE2ELatencyMs = 80.0;       // Phase 3: <80ms

// 帧生成延迟目标 (DrawLayers→DeliverFrame, ms)
constexpr double kTargetFrameGenLatencyMs = 2.0;   // Phase 3: <2ms (Compositor 线程)

// 首帧带宽目标 (gzip 压缩后, bytes)
constexpr size_t kTargetFirstFrameBytes = 1 * 1024 * 1024;   // Phase 3: <1MB

// 增量帧带宽目标 (gzip, bytes)
constexpr size_t kTargetDeltaFrameBytes = 50 * 1024;          // Phase 3: <50KB

// 客户端 CPU 目标 (60fps, M1 同级)
constexpr double kTargetClientCpuPercent = 15.0;  // Phase 3: <15%

// 客户端内存目标 (WASM, bytes)
constexpr size_t kTargetClientMemoryBytes = 128 * 1024 * 1024;  // Phase 3: <128MB

}  // namespace garnet

#endif  // GARNET_GARNET_CONFIG_H_
