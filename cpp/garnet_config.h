// garnet_config.h — 编译时常量与硬上限定义（安全配置集中管理）
//
// ═══════════════════════════════════════════════════════════════════════════════
// 模块在 Wison-RBI 架构中的角色
// ═══════════════════════════════════════════════════════════════════════════════
// 本文件集中定义 Wison-RBI 的所有编译时常量、硬上限和性能基准，
// 是整个项目的安全配置管理中心。任何安全相关的数值边界必须在此文件中
// 定义且有对应的安全理由注释，禁止分散在代码中的魔法数字。
//
// 在 Chromium 源码树中的挂载点:
//   - 挂载路径: //garnet/garnet_config.h
//   - 依赖: 零外部依赖（仅 <cstddef>/<cstdint>）
//   - 被 frame_constants.h / command_buffer.h 等所有 garnet 模块 include
//
// 设计原则 (§1 设计原则):
//   "每一处设计决策必须可追溯至一个可审计的安全/性能理由"
//   每个常量必须附带:
//     1. 安全/性能理由
//     2. 数值来源（理论推导或经验测量）
//     3. 关联的设计文档章节
//
// ═══════════════════════════════════════════════════════════════════════════════
// 安全不变量
// ═══════════════════════════════════════════════════════════════════════════════
//   I-1: 帧级硬上限 kMaxBytesPerFrame = 64MB — 防恶意帧 OOM (§8.4)
//   I-2: zip bomb 三层防护: 压缩大小 ≤ 4MB + 解压大小 ≤ 64MB + 压缩比 ≤ 1000:1
//   I-3: 命令级独立上限 — kMaxPayloadBytes=1MB, kMaxCommandsPerFrame=100000
//   I-4: 子结构上限 — Path/TextBlob/Vertices/Atlas 各有限制 (§8.4 深度校验)
//   I-5: 字体 Magic 白名单 — 仅接受 SFNT/WOFF2 合法格式 (§8.4 v1.6 P1 S4)
//   I-6: 会话超时 — kSessionIdleTimeoutMs=120s, 防止资源泄漏
//
// 版本: v1.6 (第二轮安全审计修复版, 2026-06-03)
#ifndef GARNET_GARNET_CONFIG_H_
#define GARNET_GARNET_CONFIG_H_

#include <cstddef>
#include <cstdint>

namespace garnet {

// ═══════════════════════════════════════════════════════════════
// 协议版本 — §6.2 Frame Header Byte 0
// ═══════════════════════════════════════════════════════════════

/// @brief 当前支持的协议版本 (v1.6)。
///
/// 安全理由: 客户端根据 version 字段识别不兼容的帧格式，
/// 可拒绝解析或请求服务端降级。version 字段位于帧头 Byte 0，
/// 允许在不破坏二进制兼容性的前提下演进协议（§6.2 v1.6 变更）。
constexpr uint8_t kProtocolVersion = 0x01;

/// @brief 帧头标志位掩码 (Byte 1)。
///
/// 安全理由: 位掩码允许逐位定义标志，防止标志位歧义或重叠。
/// 每个 bit 独立含义，客户端通过位运算检查。
constexpr uint8_t kFlagIsKeyframe  = 0x01;  ///< bit0: 全帧(keyframe) vs 增量帧
constexpr uint8_t kFlagHasFontData = 0x02;  ///< bit1: 帧内包含 @font-face 二进制数据
constexpr uint8_t kFlagHasDirtyRects = 0x04; ///< bit2: 帧头后跟随脏区域矩形列表 (Phase 4 R-tree)

// ═══════════════════════════════════════════════════════════════
// 帧级硬上限 — §8.4 安全边界 (v1.6 P0 S1)
//
// 威胁模型 (§2.1 恶意网页): 攻击者可能构造包含海量数据或高压缩比
// (zip bomb) 的恶意帧。以下三层防护构成纵深防御:
// ═══════════════════════════════════════════════════════════════

/// @brief 单帧解压后总字节硬上限: 64 MB。
///
/// 安全理由: 防止恶意帧耗尽客户端内存。64MB 覆盖最极端场景:
///   - 全屏 4K 图像内联: ~32MB (4096×2160×4 像素)
///   - 其余绘制命令 + 文本: ~32MB
/// 超出此上限的帧一律拒绝（§8.4 安全边界）。
///
/// 校验点: growBuffer() (写入时) + AssembleFrame() (组装时) 双重检查。
constexpr size_t kMaxBytesPerFrame = 64 * 1024 * 1024;  // 64 MB

/// @brief gzip 压缩后帧大小硬上限: 4 MB。
///
/// 安全理由: zip bomb 第一层防线 — 压缩数据本身不应超过合理大小。
/// 4MB 是 gzip 压缩 64MB 零字节的理论上限。
/// 客户端 WebSocket message 接收前即检查此值。
///
/// 校验点: Node.js I/O 代理层，接收消息时检查。
constexpr size_t kMaxCompressedFrame = 4 * 1024 * 1024;  // 4 MB

/// @brief gzip 压缩比异常阈值: 1000:1。
///
/// 安全理由: zip bomb 第三层防线 — 防超高压缩比的恶意载荷。
/// 1000:1 远超正常网页帧压缩比（通常 2:1 ~ 10:1）。
/// 例如: 1KB 压缩数据解压出 >1MB → 触发拒绝。
///
/// 校验点: 客户端流式解压过程中逐步检查输出大小。
constexpr double kMaxCompressionRatio = 1000.0;

// ═══════════════════════════════════════════════════════════════
// 命令级硬上限 — §8.4 安全边界
//
// 威胁模型: 攻击者可能尝试用单条超大命令绕过帧级检查，
// 或用海量小命令耗尽 CPU。以下独立上限防止此类攻击。
// ═══════════════════════════════════════════════════════════════

/// @brief 单条命令 payload 最大字节数: 1 MB。
///
/// 安全理由: 防止单条命令包含超大 payload 绕过帧级总字节检查。
/// 1MB 覆盖最复杂的图像内联场景（完整 PNG 编码的 4K 图像）。
///
/// 校验点: endCommand() 回填 pay_len 前检查 (§8.4 命令级上限)。
constexpr uint32_t kMaxPayloadBytes = 1 * 1024 * 1024;  // 1 MB

/// @brief 单帧最大命令数: 100,000。
///
/// 安全理由: 防止攻击者发送海量微小命令耗尽客户端 CPU。
/// 每条命令需经历白名单扫描 + 子结构校验，100K 条命令时
/// 客户端解析开销约 5-10ms（M1 同级设备）。
///
/// 校验点: 客户端 CommandValidator 命令循环计数器。
constexpr uint32_t kMaxCommandsPerFrame = 100000;

// ═══════════════════════════════════════════════════════════════
// 路径/文本子结构上限 — v1.6 深度校验 (§8.4)
//
// 威胁模型: 攻击者可能在 payload 中伪造 count 字段（例如
// verbCount=UINT32_MAX），导致解析器尝试分配天文数字内存。
// 以下子结构上限在解析每条命令后立即检查。
// ═══════════════════════════════════════════════════════════════

/// @brief drawPath 最大 verb/point 数量: 100,000。
///
/// 安全理由: 防止 drawPath payload 中伪造 count 导致 OOM。
/// 100,000 个点足够覆盖 SVG 复杂路径（如详细地图轮廓）。
constexpr uint32_t kMaxPathVerbs = 100000;

/// @brief drawPath 最大点数量: 300,000。
///
/// 安全理由: 防止 drawPath payload 中伪造 pointCount 导致 OOM。
/// 每个 verb 最多产生 3 个点 (cubicTo)，因此 pointCount 上限为 verbCount 的 3 倍。
/// 300,000 个点足够覆盖 SVG 复杂路径（如详细地图轮廓）。
constexpr uint32_t kMaxPathPoints = 300000;

/// @brief drawTextBlob 最大 glyph 数量: 50,000。
///
/// 安全理由: 防止 drawTextBlob payload 中伪造 glyphCount 导致 OOM。
/// 50,000 glyphs ≈ 500KB 数据，覆盖极限场景（整页 CJK 字符）。
constexpr uint32_t kMaxTextBlobGlyphs = 50000;

/// @brief 渐变 shader 最大颜色停止点数: 16。
///
/// 安全理由: Skia asAGradient 使用栈上数组 SkColor[16]，超过 16 会被截断。
/// FIX-R34: 原为硬编码 16，现提取为命名常量，与 client protocol.js MAX_GRADIENT_COLORS 对齐。
constexpr uint32_t kMaxGradientStops = 16;

/// @brief drawGlyphRunList 最大 run 数量: 256。
///
/// 安全理由: 防止伪造 glyphRunList.size() 导致过多 run 迭代。
/// 典型网页文本渲染通常 < 10 runs，256 足够覆盖复杂排版。
constexpr uint32_t kMaxGlyphRuns = 256;

/// @brief drawVertices 最大顶点数: 100,000。
///
/// 安全理由: 防止 drawVertices payload 中伪造 vertexCount 导致 OOM。
constexpr uint32_t kMaxVerticesCount = 100000;

/// @brief drawAtlas 最大精灵数: 100,000。
///
/// 安全理由: 防止 drawAtlas payload 中伪造 count 导致 OOM。
constexpr uint32_t kMaxAtlasCount = 100000;

/// @brief drawImageLattice 最大分区数: 10,000。
///
/// 安全理由: 防止伪造 fXCount/fYCount 导致 OOM。
constexpr uint32_t kMaxLatticeCount = 10000;

/// @brief drawEdgeAAImageSet 最大图像集大小: 10,000。
///
/// 安全理由: 防止伪造 count 导致 OOM。
constexpr uint32_t kMaxImageSetCount = 10000;

/// @brief 单帧最大图像槽位数量: 10,000。
///
/// 安全理由: 防止单帧内 image_slots_ 无界增长导致 OOM。
/// 典型网页单帧图像数 < 100，10,000 足够覆盖复杂场景。
constexpr uint32_t kMaxImageSlotsPerFrame = 10000;

/// @brief 无效图像槽位 ID（哨兵值）。
///
/// 当 image_slots_.size() >= kMaxImageSlotsPerFrame 时，reserveImageSlot()
/// 返回此值。调用方将此值写入命令流，客户端检测到后跳过该图像绘制
/// （graceful degradation），而非尝试查找不存在的槽位数据。
constexpr uint32_t kInvalidImageSlotId = 0xFFFFFFFF;

// ═══════════════════════════════════════════════════════════════
// 图像/字体缓存上限 — §4.1.4 配置项 1 (hash-ref 模式)
// ═══════════════════════════════════════════════════════════════

/// @brief 客户端图像 LRU 缓存大小: 64 MB。
///
/// 安全理由: 限制 hash-ref 模式下客户端图像缓存内存占用。
/// 64MB 可缓存约 50-200 张典型网页图像（PNG/JPEG）。
///
/// 使用场景: 客户端根据图像 SHA-256 哈希索引 LRU 缓存，
/// 命中时仅需 32B 哈希引用而非完整图像数据。
constexpr size_t kImageCacheBytes = 64 * 1024 * 1024;  // 64 MB

/// @brief 服务端已发送图像哈希集合最大容量: 100,000。
///
/// 安全理由: sent_hashes_ 跨帧保留用于 hash-ref 去重，无上限可导致
/// 长期运行后内存无限增长。100,000 条 SHA-256 哈希 ≈ 3.2MB 内存，
/// 超出时移除最旧的一半条目（FIFO 淘汰策略）。
constexpr size_t kMaxSentHashes = 100000;

/// @brief 客户端字体 LRU 缓存大小: 64 MB。
///
/// 安全理由: 限制 @font-face 内联字体的缓存内存占用。
/// 64MB 可缓存约 50-100 个典型 CJK 字体文件。
constexpr size_t kFontCacheBytes = 64 * 1024 * 1024;  // 64 MB

/// @brief 单次字体内联传输上限: 5 MB。
///
/// 安全理由: 防止恶意 @font-face 传输超大"字体"文件。
/// 5MB 覆盖完整 CJK 字体子集化后的典型大小（Google Fonts 子集化策略）。
/// 配合 SFNT/WOFF2 Magic 校验形成纵深防御（§8.4 v1.6 P1 S4）。
constexpr size_t kMaxFontInlineBytes = 5 * 1024 * 1024;  // 5 MB

// ═══════════════════════════════════════════════════════════════
// 帧历史/会话上限 — §7 帧元数据与输入同步
// ═══════════════════════════════════════════════════════════════

/// @brief 帧历史最大保留时间: 3000 ms。
///
/// 安全理由: 防止帧历史无限增长耗尽内存。
/// 3000ms 覆盖跨洲网络延迟（RTT 300-500ms）+ 帧生成 + jitter buffer 余量。
/// 与 server/config.js 和 client/protocol.js 保持一致。
///
/// 关联: §7.2 时序图，§7.5 降级策略。
constexpr int64_t kFrameHistoryMaxAgeMs = 3000;

/// @brief 帧历史最大条目数（硬上限）: 1000。
///
/// 安全理由: 即使时间未到（如 1000ms 内高频 1000+ 帧），
/// 条目数也需硬上限。1000 帧 @60fps = ~16.7s 数据。
constexpr size_t kFrameHistoryMaxEntries = 1000;

// ═══════════════════════════════════════════════════════════════
// R-tree 增量帧 (Phase 4 — §4.1.1 增量更新)
//
// 脏区域矩形格式: x(f32) + y(f32) + w(f32) + h(f32) = 16 字节/矩形
// 存储位置: 帧头之后、CommandStream 之前（仅当 FLAG_HAS_DIRTY_RECTS 置位）
// 布局: [count(2B uint16 LE)] [rect0(16B)] [rect1(16B)] ...
// ═══════════════════════════════════════════════════════════════

/// @brief R-tree 增量帧: 脏区域矩形条目大小（字节）。
constexpr size_t kDirtyRectEntrySize = 16;  // x(f32) + y(f32) + w(f32) + h(f32)

/// @brief R-tree 增量帧: 单帧最大脏区域矩形数。
///
/// 安全理由: 防止攻击者伪造超大 count 导致 OOM。
/// 64 个矩形足以覆盖复杂页面变动（典型页面变动 <10 个矩形）。
constexpr uint16_t kMaxDirtyRects = 64;

/// @brief 白名单连续拒绝阈值: 3 帧 → 触发 request_keyframe。
///
/// 安全理由: 避免客户端卡在坏帧上无法恢复。
/// 3 帧足够区分"偶发损坏"（1-2 帧）和"持续损坏"（≥3 帧）。
/// 触发后客户端向服务端请求全帧 (keyframe) 重置增量状态。
constexpr uint32_t kConsecutiveRejectThreshold = 3;

/// @brief frame_id 跳跃阈值: 1000 → 触发 request_keyframe。
///
/// 安全理由: 检测服务端可能的帧丢失或重启。
/// 若收到的 frame_id 比上次 > 1000，说明可能有大量帧丢失
/// 或服务端重启导致 compositor_frame_seq_ 归零。
constexpr uint32_t kFrameIdJumpThreshold = 1000;

// ═══════════════════════════════════════════════════════════════
// 服务端运行时上限 — §9.1 阶段划分 (Phase 3 生产级目标)
// ═══════════════════════════════════════════════════════════════

/// @brief Chromium 实例最大内存: 2 GB → 触发强制重启。
///
/// 安全理由: 防止 Chromium 内存泄漏耗尽服务器资源。
/// 每个 Chromium 实例典型占用 200-500MB（含 GPU 纹理），
/// 2GB 上限为异常泄漏留出余量。
constexpr size_t kChromiumMaxMemoryBytes = 2ULL * 1024 * 1024 * 1024;  // 2 GB

/// @brief Chromium 启动超时: 60 s。
constexpr int64_t kChromiumStartupTimeoutMs = 60000;

/// @brief 页面加载超时: 30 s。
constexpr int64_t kPageLoadTimeoutMs = 30000;

/// @brief CDP 命令超时: 3 s。
constexpr int64_t kCdpCommandTimeoutMs = 3000;

/// @brief WebSocket 发送缓冲区高水位: 1 MB → 触发丢帧。
///
/// 安全理由: 当客户端消费慢于服务端产出时，限制积压。
/// 超过 1MB 积压则丢弃非关键帧（增量帧），仅保留最新 keyframe。
constexpr size_t kWebSocketHighWaterMark = 1 * 1024 * 1024;  // 1 MB

/// @brief 会话空闲超时: 120 s — 无客户端连接时关闭 Chromium。
///
/// 安全理由: 防止孤立 Chromium 实例无限占用资源。
constexpr int64_t kSessionIdleTimeoutMs = 120000;

// ═══════════════════════════════════════════════════════════════
// 字体格式校验 — §8.4 安全边界 (v1.6 P1 S4)
//
// 威胁模型: @font-face 机制从网页传输字体数据到客户端。
// 攻击者可能通过 @font-face 传输任意二进制数据（伪装为字体），
// 绕过内容检查。以下 Magic 字节白名单确保仅接受合法字体格式。
// ═══════════════════════════════════════════════════════════════

/// @brief SFNT/TrueType Classic Magic: 0x00010000 (大端序)。
///
/// 字节序列: [00 01 00 00] (大端)。kSfntMagicTrueType 存储时
/// 需注意主机字节序。校验时以网络字节序（大端）比较。
constexpr uint32_t kSfntMagicTrueType   = 0x00010000;

/// @brief OpenType CFF Magic: "OTTO" = 0x4F54544F。
constexpr uint32_t kSfntMagicOpenType   = 0x4F54544F;

/// @brief TrueType Apple Magic: "true" = 0x74727565。
constexpr uint32_t kSfntMagicAppleTrue  = 0x74727565;

/// @brief TrueType Collection Magic: "ttcf" = 0x74746366。
constexpr uint32_t kSfntMagicCollection = 0x74746366;

/// @brief WOFF2 Magic: "wOF2" = 0x774F4632。
///
/// 安全: WOFF2 是 W3C 标准 Web 字体格式，Brotli 压缩。
/// 客户端需解压后校验内部 SFNT 结构。
constexpr uint32_t kWoff2Magic         = 0x774F4632;

// ═══════════════════════════════════════════════════════════════
// Opcode 范围 — 与 frame_constants.h 的 IsValidOpcode 同步
// ═══════════════════════════════════════════════════════════════

/// @brief 合法 opcode 最小/最大值: 0x01 / 0x7F。
///
/// 客户端使用此范围进行白名单边界检查（§5.6 命令白名单扫描器）。
constexpr uint8_t kOpcodeMin = 0x01;
constexpr uint8_t kOpcodeMax = 0x7F;

/// @brief 非法 opcode 起始值: 0x80 — 一律拒收。
///
/// 服务端不应产生 ≥0x80 的 opcode（beginCommand() 已拦截），
/// 客户端收到此类 opcode 应视为协议攻击尝试并记录安全日志。
constexpr uint8_t kOpcodeIllegalMin = 0x80;

// ═══════════════════════════════════════════════════════════════
// 性能基准目标 — §9.1 阶段划分 (Phase 3 生产级别指标)
//
// 所有目标值均为 Phase 3 的生产级别指标。Phase 1 目标见设计文档。
// 基准测试运行: node server/benchmark.js
// ═══════════════════════════════════════════════════════════════

/// @brief 端到端延迟目标: <80ms (点击→画面更新)。
///
/// 分解: 输入传输 ~5ms + Chromium 渲染 ~15ms + 帧生成 ~2ms +
///        gzip 压缩 ~5ms + 网络传输 ~20ms + 客户端解码 ~10ms +
///        CanvasKit 重放 ~5ms + 显示 ~2ms + 余量。
constexpr double kTargetE2ELatencyMs = 80.0;

/// @brief 帧生成延迟目标: <2ms (DrawLayers → DeliverFrame)。
///
/// Compositor 线程完成录制 + 序列化的时间预算。
/// 图像编码和 gzip 压缩不在 Compositor 线程执行（异步 Worker 线程）。
constexpr double kTargetFrameGenLatencyMs = 2.0;

/// @brief 首帧带宽目标: <1MB (gzip 压缩后)。
///
/// 全帧 (keyframe) 包含完整页面内容。设计目标: 压缩后 <1MB，
/// 覆盖典型复杂网页（文字 + SVG + 少量图像）。
constexpr size_t kTargetFirstFrameBytes = 1 * 1024 * 1024;

/// @brief 增量帧带宽目标: <50KB (gzip 压缩后)。
///
/// 增量帧仅含变化的绘制命令（通过 R-tree 空间索引裁剪）。
/// 50KB 覆盖典型页面交互（滚动/悬停/小动画）。
constexpr size_t kTargetDeltaFrameBytes = 50 * 1024;

/// @brief 客户端 CPU 目标: <15% (M1 同级, 60fps)。
///
/// 包括 CanvasKit 绘制 + 命令解析 + 缓存查找的 CPU 时间。
constexpr double kTargetClientCpuPercent = 15.0;

/// @brief 客户端内存目标: <128MB (WASM 堆 + 图像/字体缓存)。
constexpr size_t kTargetClientMemoryBytes = 128 * 1024 * 1024;

}  // namespace garnet

#endif  // GARNET_GARNET_CONFIG_H_
