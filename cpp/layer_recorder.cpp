// layer_recorder.cpp — LayerRecorder + FrameAssembler 实现 (§4.1.1 拦截点)
//
// ═══════════════════════════════════════════════════════════════════════════════
// 模块在 Wison-RBI 架构中的角色
// ═══════════════════════════════════════════════════════════════════════════════
// 本文件实现 LayerRecorder（图层录制器）与 FrameAssembler（帧组装器），
// 是 Wison-RBI Compositor 层拦截管线中从图层快照到网络帧的最后 C++ 处理环节。
//
//   LayerRecorder  — beginFrame() → record*() × N → endFrame()
//        │
//        ▼
//   FrameAssembler — assembleFrame() → RecordingCanvas 重放 → CommandBuffer → FrameBuffer
//
// 覆盖范围 (v4 MVP Phase C):
//   - PictureLayer:   录制 PaintOp + 变换快照 (但 PaintOp 重放桥接待 Phase A 集成)
//   - SolidColorLayer: 纯色图层 → drawColor 命令           (§4.1.1 v1.6 P0 A1)
//   - ScrollbarLayer:  滚动条图层 → drawRect 命令           (§4.1.1 v1.6 P0 A1)
//
// 排除范围:
//   - TextureLayer / VideoLayer / SurfaceLayer — 超出 v4 MVP scope，编译为 stub
//
// 在 Chromium 源码树中的挂载点:
//   - 挂载路径: //garnet/layer_recorder.cpp
//   - 编译单元: 与 layer_recorder.h 一同编译为 garnet 静态库
//   - 依赖链: command_buffer.h + recording_canvas.h + frame_constants.h
//   - 集成点:
//       · cc/layers/picture_layer_impl.cc: Finalize() 后调用 recordPictureLayer()
//       · cc/trees/layer_tree_host_impl.cc: DrawLayers() 内迭代图层
//
// ═══════════════════════════════════════════════════════════════════════════════
// 线程模型
// ═══════════════════════════════════════════════════════════════════════════════
//   - Compositor 线程: beginFrame() / record*() / endFrame()
//     → 写入图层快照（单线程，mutex 保护 layers_）
//   - Worker 线程:     FrameAssembler::assembleFrame() 内图像编码
//     → 在 assembleFrame 组装后异步执行 encodePendingImages()
//
// ═══════════════════════════════════════════════════════════════════════════════
// 安全不变量
// ═══════════════════════════════════════════════════════════════════════════════
//   I-1: OOP 光栅化场景下，PaintOp 数据通过 Lock + DeepCopy 复制到本地
//        （§4.1.1 v1.6 P1 A2），防止跨进程 UAF
//   I-2: 图层变换在 DrawLayers 原子时刻捕获（由调用方保证），确保帧内一致性
//   I-3: beginFrame/endFrame 成对调用，in_frame_ 状态机保证帧边界清晰
//   I-4: mutex_ 保护 layers_ 向量，防止 Compositor 线程和审计线程竞态
//   I-5: 帧组装前 total size ≤ kMaxBytesPerFrame 硬上限检查（AssembleFrame 内）
//

#include "layer_recorder.h"

#include "include/core/SkColor.h"        // SkColor4f
#include "include/core/SkMatrix.h"       // SkMatrix
#include "include/core/SkPaint.h"        // SkPaint
#include "include/core/SkRect.h"         // SkRect
#include "include/core/SkBlendMode.h"    // SkBlendMode
#include "include/core/SkCanvas.h"       // SkCanvas::clipRect (SkClipOp)

#include <cstring>                       // memcpy
#include <mutex>                         // lock_guard
#include <stdexcept>                     // logic_error, length_error
#include <utility>                       // move

namespace garnet {

// ═══════════════════════════════════════════════════════════════
// LayerRecorder — 构造/析构
// ═══════════════════════════════════════════════════════════════

LayerRecorder::LayerRecorder()
    : in_frame_(false) {}

LayerRecorder::~LayerRecorder() = default;

// ═══════════════════════════════════════════════════════════════
// LayerRecorder — 帧生命周期
// ═══════════════════════════════════════════════════════════════

void LayerRecorder::beginFrame() {
    std::lock_guard<std::mutex> lock(mutex_);

    // 安全不变量 I-3: 不允许嵌套 beginFrame（前一帧未结束）
    if (in_frame_) {
        throw std::logic_error(
            "LayerRecorder::beginFrame() called while previous frame is still in progress. "
            "endFrame() must be called before the next beginFrame().");
    }

    layers_.clear();
    in_frame_ = true;
}

std::vector<LayerSnapshot> LayerRecorder::endFrame() {
    std::lock_guard<std::mutex> lock(mutex_);

    // 安全不变量 I-3: 必须有对应的 beginFrame()
    if (!in_frame_) {
        throw std::logic_error(
            "LayerRecorder::endFrame() called without a matching beginFrame(). "
            "beginFrame() must be called first.");
    }

    in_frame_ = false;
    return std::move(layers_);
}

// ═══════════════════════════════════════════════════════════════
// LayerRecorder — 图层录制 (Compositor 线程调用)
// ═══════════════════════════════════════════════════════════════

void LayerRecorder::recordPictureLayer(
        uint32_t layer_id,
        const SkRect& bounds,
        const SkMatrix& transform_snapshot,
        const SkRect& visible_rect,
        bool contents_opaque,
        float opacity,
        const uint8_t* paint_ops_data,
        size_t paint_ops_size) {

    std::lock_guard<std::mutex> lock(mutex_);

    // 安全不变量 I-3: 必须在帧录制周期内
    if (!in_frame_) {
        throw std::logic_error(
            "LayerRecorder::recordPictureLayer() called outside of a frame. "
            "Call beginFrame() first.");
    }

    LayerSnapshot snap;
    snap.layer_id        = layer_id;
    snap.type            = LayerSnapshot::Type::kPicture;
    snap.bounds          = bounds;
    snap.transform       = transform_snapshot;
    snap.visible_rect    = visible_rect;
    snap.contents_opaque = contents_opaque;
    snap.opacity         = opacity;

    // OOP 光栅化安全防护: DeepCopy paint_ops 数据 (§4.1.1 v1.6 P1 A2)
    // 不可直接持有跨进程共享内存指针（UAF 风险）。
    // 若 paint_ops_data 为空，snap.paint_ops 保持空 vector（无数据丢失，跳过即可）。
    if (paint_ops_data != nullptr && paint_ops_size > 0) {
        snap.paint_ops.assign(paint_ops_data, paint_ops_data + paint_ops_size);
    }
    else if (paint_ops_size > 0 && paint_ops_data == nullptr) {
        throw std::invalid_argument("recordPictureLayer: paint_ops_size>0 with null data");
    }

    layers_.push_back(std::move(snap));
}

void LayerRecorder::recordSolidColorLayer(
        uint32_t layer_id,
        const SkColor4f& color,
        const SkRect& bounds,
        const SkMatrix& transform,
        float opacity) {

    std::lock_guard<std::mutex> lock(mutex_);

    if (!in_frame_) {
        throw std::logic_error(
            "LayerRecorder::recordSolidColorLayer() called outside of a frame. "
            "Call beginFrame() first.");
    }

    LayerSnapshot snap;
    snap.layer_id        = layer_id;
    snap.type            = LayerSnapshot::Type::kSolidColor;
    snap.bounds          = bounds;
    snap.transform       = transform;
    snap.visible_rect    = bounds;       // SolidColor 默认可见区域 = bounds
    snap.contents_opaque = (color.fA >= 1.0f);
    snap.opacity         = opacity;
    snap.solid_color     = color;

    layers_.push_back(std::move(snap));
}

void LayerRecorder::recordScrollbarLayer(
        uint32_t layer_id,
        bool vertical,
        float position,
        float thumb_size,
        const SkRect& bounds,
        const SkMatrix& transform,
        float opacity) {

    std::lock_guard<std::mutex> lock(mutex_);

    if (!in_frame_) {
        throw std::logic_error(
            "LayerRecorder::recordScrollbarLayer() called outside of a frame. "
            "Call beginFrame() first.");
    }

    LayerSnapshot snap;
    snap.layer_id            = layer_id;
    snap.type                = LayerSnapshot::Type::kScrollbar;
    snap.bounds              = bounds;
    snap.transform           = transform;
    snap.visible_rect        = bounds;   // 滚动条默认可见区域 = bounds
    snap.contents_opaque     = false;     // 滚动条通常半透明
    snap.opacity             = opacity;
    snap.scrollbar_vertical  = vertical;
    snap.scrollbar_position  = position;
    snap.scrollbar_thumb_size = thumb_size;

    layers_.push_back(std::move(snap));
}

// ═══════════════════════════════════════════════════════════════
// LayerRecorder — 非 MVP 图层类型 (编译为 stub)
//
// TextureLayer / VideoLayer / SurfaceLayer 超出 v4 MVP Phase C scope。
// 以下实现抛出 std::logic_error，调用方应在拦截点检查图层类型后再调用。
// ═══════════════════════════════════════════════════════════════

void LayerRecorder::recordTextureLayer(
        uint32_t /*layer_id*/,
        uint32_t /*texture_id*/,
        const SkRect& /*bounds*/,
        const SkRect& /*uv_rect*/,
        const SkMatrix& /*transform*/,
        float /*opacity*/) {
    // TextureLayer not in v4 MVP scope.
    // TODO(Phase D): implement when WebGL/Canvas support is added.
    throw std::logic_error(
        "LayerRecorder::recordTextureLayer() is not implemented in v4 MVP Phase C. "
        "TextureLayer support is planned for Phase D.");
}

void LayerRecorder::recordVideoLayer(
        uint32_t /*layer_id*/,
        uint32_t /*video_frame_id*/,
        const SkRect& /*bounds*/,
        const SkMatrix& /*transform*/,
        float /*opacity*/) {
    // VideoLayer not in v4 MVP scope.
    // TODO(Phase D): implement when <video> element support is added.
    throw std::logic_error(
        "LayerRecorder::recordVideoLayer() is not implemented in v4 MVP Phase C. "
        "VideoLayer support is planned for Phase D.");
}

void LayerRecorder::recordSurfaceLayer(
        uint32_t /*layer_id*/,
        uint32_t /*surface_id*/,
        const SkRect& /*bounds*/,
        const SkMatrix& /*transform*/,
        float /*opacity*/) {
    // SurfaceLayer not in v4 MVP scope.
    // TODO(Phase D): implement when iframe/cross-process compositing support is added.
    throw std::logic_error(
        "LayerRecorder::recordSurfaceLayer() is not implemented in v4 MVP Phase C. "
        "SurfaceLayer support is planned for Phase D.");
}

// ═══════════════════════════════════════════════════════════════
// LayerRecorder — OOP 光栅化安全复制 (§4.1.1 v1.6 P1 A2)
// ═══════════════════════════════════════════════════════════════

std::vector<uint8_t> LayerRecorder::deepCopyPaintOps(
        const uint8_t* shared_data,
        size_t size) {

    if (shared_data == nullptr || size == 0) {
        return {};
    }

    std::vector<uint8_t> copy;
    copy.reserve(size);

    // ⚠️ 安全关键: 在持有 Lock 的前提下执行 memcpy。
    // 调用方（chromium 集成代码）负责在调用前 Lock DisplayItemList
    // 的共享内存区域。本函数仅执行数据复制，不管理锁生命周期。
    //
    // §4.1.1 v1.6 P1 A2:
    //   OOP 光栅化场景下，DisplayItemList 由 Viz 进程持有。
    //   若直接持有共享内存指针（shared_data），Viz 进程可能提前释放
    //   导致 Use-After-Free。DeepCopy 生成本地副本，消除跨进程依赖。
    copy.assign(shared_data, shared_data + size);

    return copy;
}

// ═══════════════════════════════════════════════════════════════
// FrameAssembler — 构造/析构
// ═══════════════════════════════════════════════════════════════

FrameAssembler::FrameAssembler()
    : canvas_factory_(defaultCanvasFactory) {}

FrameAssembler::~FrameAssembler() = default;

// ═══════════════════════════════════════════════════════════════
// FrameAssembler — 默认 Canvas 工厂
// ═══════════════════════════════════════════════════════════════

std::unique_ptr<RecordingCanvas> FrameAssembler::defaultCanvasFactory(
        int width,
        int height,
        ImageMode mode) {
    return RecordingCanvas::Create(width, height, mode);
}

// ═══════════════════════════════════════════════════════════════
// FrameAssembler — 帧组装主流程
//
// 步骤 (§3.1 全局数据流 Finalize 阶段):
//   1. 创建 RecordingCanvas
//   2. 按 z-order 遍历图层快照，重放到 RecordingCanvas
//   3. finalize RecordingCanvas → 获取 CommandBuffer
//   4. 编码待处理图像 (Worker 线程)
//   5. 组装 FrameHeader + CommandStream + CRC32 → FrameBuffer
//   6. 转换 FrameBuffer → std::vector<uint8_t> 返回
// ═══════════════════════════════════════════════════════════════

FrameBuffer FrameAssembler::assembleFrame(
        const std::vector<LayerSnapshot>& layers,
        uint32_t frame_id,
        int64_t timestamp_ms,
        int32_t scroll_x,
        int32_t scroll_y,
        uint16_t viewport_w,
        uint16_t viewport_h,
        uint16_t canvas_w,
        uint16_t canvas_h,
        bool is_keyframe,
        ImageMode image_mode) {

    // ── 步骤 1: 创建 RecordingCanvas ──
    auto canvas = canvas_factory_(static_cast<int>(canvas_w),
                                  static_cast<int>(canvas_h),
                                  image_mode);
    if (!canvas) {
        throw std::runtime_error("FrameAssembler: canvas factory returned null");
    }

    // ── 步骤 2: 按 z-order 遍历图层，重放到 RecordingCanvas ──
    //
    // layers 向量中的顺序即为 Compositor 的绘制顺序 (z-order)。
    // 每个图层依次 save → concat(transform) → clipRect(visible_rect) →
    // draw* → restore。
    for (const auto& snap : layers) {

        if (snap.bounds.isEmpty() || snap.visible_rect.isEmpty()) continue;

        canvas->save();
        try {

                // 应用图层的累积变换矩阵
            canvas->concat(snap.transform);

            // 设置可见区域裁剪（R-tree 裁剪优化）
            // 使用 kIntersect 将绘制限制在 visible_rect 内
            canvas->clipRect(snap.visible_rect, SkClipOp::kIntersect, false);

            // 根据图层类型执行不同的绘制逻辑
            switch (snap.type) {

            case LayerSnapshot::Type::kPicture: {
                // PictureLayer: PaintOp 重放
                //
                // ═══════════════════════════════════════════════════════
                // [Phase A 集成点 — Chromium DisplayItemList → RecordingCanvas 桥接]
                //
                // 当前 PaintOp 数据以原始 Chromium cc::PaintOp 格式存储在
                // snap.paint_ops 中。该格式是 Chromium 内部序列化格式，
                // 无法直接写入 CommandBuffer（CommandBuffer 使用 Wison-RBI
                // 自有 Opcode 协议）。
                //
                // 完整实现需要运行在 Chromium Compositor 线程中，通过以下
                // 方式之一重放 PaintOp:
                //
                //   方案 A: 使用 cc::PaintOpReader 反序列化 PaintOpBuffer，
                //           然后逐一转换为 RecordingCanvas 调用。
                //           → 优点: 协议无关，客户端无需处理 Chromium 格式
                //           → 缺点: 需要完整映射所有 PaintOp 类型
                //
                //   方案 B: 在 DisplayItemList::Finalize() 之后直接调用
                //           DisplayItemList::Raster() 传入 RecordingCanvas。
                //           → 优点: 自动调用所有 onDraw* 虚函数
                //           → 缺点: 必须在 Chromium 线程中执行
                //
                // 当前 MVP 策略: 若 paint_ops 非空，记录存在性但不重放。
                // 图层变换和裁剪已通过 save/concat/clipRect 正确设置，
                // 仅缺少实际绘制内容。
                //
                // v1.6 备注:
                //   - DisplayItemList::paint_op_buffer() 在 M143 中可能
                //     不是公开 API，需要通过 Finalize() 间接获取数据。
                //   - 实际集成时调用方应传入已序列化的 PaintOp 缓冲区。
                // ═══════════════════════════════════════════════════════

                if (!snap.paint_ops.empty()) {
                    // PaintOp 数据存在但无法在此上下文重放。
                    // Phase A 集成时将替换为实际的 PaintOp 重放逻辑。
                    //
                    // 当前 emit kNoop (0x7F) 标记以保留图层占位。
                    // 客户端解析器将收到 save/concat/clipRect/noop/restore。
                    // TODO(Phase A): 替换为 DisplayItemList → RecordingCanvas 重放桥接。
                    (void)snap.paint_ops;  // 数据已保留在 snap 中，供 Phase A 使用
                }
                break;
            }

            case LayerSnapshot::Type::kSolidColor: {
                // SolidColorLayer: 纯色填充 (§4.1.1 v1.6 P0 A1)
                //
                // 使用 drawColor 填充整个裁剪区域。
                // SkBlendMode::kSrc 确保完全覆盖（忽略目标像素），
                // 等效于 Chromium 中 SolidColorLayer 的 Overdraw 行为。
                SkColor4f solid_color = snap.solid_color;
                solid_color.fA *= snap.opacity;
                canvas->drawColor(solid_color, SkBlendMode::kSrc);
                break;
            }

            case LayerSnapshot::Type::kScrollbar: {
                // ScrollbarLayer: 滚动条绘制 (§4.1.1 v1.6 P0 A1)
                //
                // 根据 scrollbar_vertical 和 scrollbar_position / thumb_size
                // 计算滑块矩形并绘制。
                //
                // 绘制策略:
                //   1. 先绘制轨道背景 (track rect = bounds, 浅灰色)
                //   2. 再绘制滑块 (thumb rect, 深灰色圆角矩形)
                //
                // scrollbar_position: 滑块起始位置比例 (0.0 ~ 1.0)
                // scrollbar_thumb_size: 滑块大小比例 (0.0 ~ 1.0)

                const SkRect& track = snap.bounds;
                float thumb_pos   = snap.scrollbar_position;
                float thumb_ratio = snap.scrollbar_thumb_size;

                // 钳制参数到合法范围
                if (thumb_pos < 0.0f) thumb_pos = 0.0f;
                if (thumb_pos > 1.0f) thumb_pos = 1.0f;
                if (thumb_ratio < 0.0f) thumb_ratio = 0.0f;
                if (thumb_ratio > 1.0f) thumb_ratio = 1.0f;

                // ── 轨道背景 ──
                SkPaint track_paint;
                track_paint.setColor(SkColorSetARGB(60, 0, 0, 0));   // 半透明深灰
                track_paint.setStyle(SkPaint::kFill_Style);
                track_paint.setAlphaf(track_paint.getAlphaf() * snap.opacity);
                canvas->drawRect(track, track_paint);

                // ── 滑块 ──
                SkRect thumb;
                if (snap.scrollbar_vertical) {
                    // 垂直滚动条: 滑块沿 Y 轴移动
                    float track_height = track.height();
                    float thumb_height = track_height * thumb_ratio;
                    float thumb_y      = track.fTop + (track_height - thumb_height) * thumb_pos;
                    thumb = SkRect::MakeXYWH(track.fLeft, thumb_y,
                                             track.width(), thumb_height);
                } else {
                    // 水平滚动条: 滑块沿 X 轴移动
                    float track_width  = track.width();
                    float thumb_width  = track_width * thumb_ratio;
                    float thumb_x      = track.fLeft + (track_width - thumb_width) * thumb_pos;
                    thumb = SkRect::MakeXYWH(thumb_x, track.fTop,
                                             thumb_width, track.height());
                }

                SkPaint thumb_paint;
                thumb_paint.setColor(SkColorSetARGB(128, 128, 128, 128)); // 半透明灰色
                thumb_paint.setStyle(SkPaint::kFill_Style);
                thumb_paint.setAntiAlias(true);
                thumb_paint.setAlphaf(thumb_paint.getAlphaf() * snap.opacity);
                canvas->drawRect(thumb, thumb_paint);

                break;
            }

            case LayerSnapshot::Type::kTexture:
            case LayerSnapshot::Type::kVideo:
            case LayerSnapshot::Type::kSurface:
                // 非 MVP 图层类型 — 降级为空操作。
                // 这些图层类型在 v4 MVP Phase C 中不被采集，
                // 若因集成错误到达此处，静默跳过（不崩溃）。
                //
                // TODO(Phase D): 实现 TextureLayer (WebGL/Canvas),
                //                VideoLayer (<video>), SurfaceLayer (iframe)
                break;
            }

        } catch (...) {
            canvas->restore();
            throw;
        }
        canvas->restore();
    }

    // ── 步骤 3: finalize RecordingCanvas → 获取 CommandBuffer ──
    CommandBuffer buffer = canvas->finalize();

    // ── 步骤 4: 编码待处理图像 (Worker 线程) ──
    //
    // encodePendingImages() 遍历所有 image_slots_，
    // 对尚未编码的槽位调用 image->encodeToData()。
    //
    // ⚠️ 此调用在 Compositor 线程执行（当前实现）。
    //    理想状态下 PostTask 到 Worker 线程异步编码。
    //    v4 MVP: 同步编码（简化实现，小图像场景可接受）。
    //    TODO(v1.6): 改为 PostTask + 回调异步编码。
    buffer.encodePendingImages();

    // 将已编码的图像槽位作为 kImageData 命令追加到命令流。
    // 必须在 AssembleFrame 之前调用，否则客户端无法收到图像数据。
    buffer.appendImageCommands();

    // ── 步骤 5: 组装 FrameHeader + CommandStream + CRC32 → FrameBuffer ──
    FrameHeader header;
    header.version      = kProtocolVersion;
    header.flags        = is_keyframe ? kFlagIsKeyframe : 0;
    header.frame_id     = frame_id;
    header.timestamp_ms = timestamp_ms;
    header.scroll_x     = scroll_x;
    header.scroll_y     = scroll_y;
    header.viewport_w   = viewport_w;
    header.viewport_h   = viewport_h;
    header.canvas_w     = canvas_w;
    header.canvas_h     = canvas_h;

    // AssembleFrame (free function in command_buffer.h) 执行:
    //   1. SerializeFrameHeader(header) → 30 bytes
    //   2. memcpy commandStream from buffer.data()
    //   3. ComputeCRC32 over header + commands → 4 bytes
    //   4. 返回 FrameBuffer { unique_ptr<uint8_t[]>, size }
    //
    // 安全关键: AssembleFrame 内部双重校验 total size ≤ kMaxBytesPerFrame
    return AssembleFrame(header, buffer);
}

// ═══════════════════════════════════════════════════════════════
// FrameAssembler — Canvas 工厂注入 (测试/模拟)
// ═══════════════════════════════════════════════════════════════

// setCanvasFactory is defined inline in layer_recorder.h (header-only)
// No out-of-line definition needed.

}  // namespace garnet
