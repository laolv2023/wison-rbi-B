// layer_recorder.h — Chromium cc 层拦截点
//
// LayerRecorder 在 Chromium Compositor 的两个关键位置挂载:
//
// 拦截点 1: DisplayItemList::Finalize() 之后
//   → 收集 PictureLayer 的完整 PaintOp 列表 (+ R-tree 空间索引)
//   → 路径: PictureLayerImpl → DisplayItemList → LayerRecorder::recordPictureLayer()
//
// 拦截点 2: LayerTreeHostImpl::DrawLayers() 内
//   → 遍历所有活跃图层，捕获每层的矩阵变换 + PaintOp
//   → 路径: DrawLayers() → LayerRecorder::recordLayerTransform()
//
// v1.6 变更:
//   - P0 A1: 新增 SubmitNonPictureLayers 采集 SolidColor/Texture/Video/Surface/Scrollbar
//   - P1 A3: 图层变换快照从 UpdateRasterSource 移至 DrawLayers 捕获
//   - P1 A2: OOP 光栅化场景 Lock + DeepCopy 防护
//
// 线程模型:
//   - Compositor 线程: 写入 PaintOp + 变换
//   - Worker 线程:    图像编码 (EncodePendingImages)
//
// 注意: 这是头文件，实际集成到 Chromium 源码树需要修改:
//   - cc/layers/picture_layer_impl.cc: Finalize() 后调用 recordPictureLayer()
//   - cc/trees/layer_tree_host_impl.cc: DrawLayers() 内迭代图层
//
#ifndef GARNET_LAYER_RECORDER_H_
#define GARNET_LAYER_RECORDER_H_

#include "command_buffer.h"
#include "recording_canvas.h"

#include <memory>
#include <vector>
#include <mutex>

namespace garnet {

// 单个图层的信息快照（v1.6 P1 A3: 在 DrawLayers 时捕获）
struct LayerSnapshot {
    uint32_t layer_id;
    SkRect bounds;        // 图层边界
    SkMatrix transform;   // 累积变换矩阵（从 DrawLayers 捕获，非 UpdateRasterSource）
    SkRect visible_rect;  // 可见区域
    bool contents_opaque;
    float opacity;

    // 图层类型
    enum class Type : uint8_t {
        kPicture,
        kSolidColor,
        kTexture,
        kVideo,
        kSurface,
        kScrollbar,
    };
    Type type;

    // PictureLayer 特有: PaintOp 列表
    // 注意: OOP 光栅化时此数据通过 Lock + DeepCopy 从 Viz 进程复制
    std::vector<uint8_t> paint_ops;

    // 非 PictureLayer 特有数据 (v1.6 P0 A1)
    SkColor4f solid_color;      // SolidColorLayer
    uint32_t  texture_id;       // TextureLayer
    SkRect    uv_rect;          // TextureLayer
    uint32_t  video_frame_id;   // VideoLayer
    uint32_t  surface_id;       // SurfaceLayer
    bool      scrollbar_vertical; // ScrollbarLayer
    float     scrollbar_position;
    float     scrollbar_thumb_size;
};

// ═══════════════════════════════════════════════════════════════
// LayerRecorder — 帧级图层录制器
// ═══════════════════════════════════════════════════════════════

class LayerRecorder {
public:
    LayerRecorder();
    ~LayerRecorder();

    // 开始新的帧录制周期
    void beginFrame();

    // 结束当前帧录制，返回帧中所有图层的快照
    std::vector<LayerSnapshot> endFrame();

    // ═══════════════════════════════════════════════════════════
    // 图层录制 (Compositor 线程调用)
    // ═══════════════════════════════════════════════════════════

    // 录制 PictureLayer（拦截点 1）
    // 在 DisplayItemList::Finalize() 之后调用
    void recordPictureLayer(uint32_t layer_id,
                            const SkRect& bounds,
                            const SkMatrix& transform_snapshot,
                            const SkRect& visible_rect,
                            bool contents_opaque,
                            float opacity,
                            const uint8_t* paint_ops_data,
                            size_t paint_ops_size);

    // 录制非 PictureLayer（拦截点 2，v1.6 P0 A1 新增）
    void recordSolidColorLayer(uint32_t layer_id, const SkColor4f& color,
                               const SkRect& bounds, const SkMatrix& transform,
                               float opacity);
    void recordTextureLayer(uint32_t layer_id, uint32_t texture_id,
                            const SkRect& bounds, const SkRect& uv_rect,
                            const SkMatrix& transform, float opacity);
    void recordVideoLayer(uint32_t layer_id, uint32_t video_frame_id,
                          const SkRect& bounds, const SkMatrix& transform,
                          float opacity);
    void recordSurfaceLayer(uint32_t layer_id, uint32_t surface_id,
                            const SkRect& bounds, const SkMatrix& transform,
                            float opacity);
    void recordScrollbarLayer(uint32_t layer_id, bool vertical,
                              float position, float thumb_size,
                              const SkRect& bounds, const SkMatrix& transform,
                              float opacity);

    // ═══════════════════════════════════════════════════════════
    // OOP 光栅化安全复制 (v1.6 P1 A2)
    // ═══════════════════════════════════════════════════════════

    // 从跨进程共享内存区 DeepCopy PaintOp 数据
    // 返回本地拥有的副本（防止 Viz 进程提前释放导致 UAF）
    std::vector<uint8_t> deepCopyPaintOps(const uint8_t* shared_data,
                                          size_t size);

private:
    std::vector<LayerSnapshot> layers_;
    std::mutex mutex_;  // 保护 layers_（Compositor 线程写入）

    bool in_frame_;
};

// ═══════════════════════════════════════════════════════════════
// FrameAssembler — 组装完整帧
//
// 从 LayerRecorder 收集的图层快照中，通过 RecordingCanvas
// 重放所有 PaintOp，生成 CommandBuffer + 帧元数据。
// ═══════════════════════════════════════════════════════════════

class FrameAssembler {
public:
    FrameAssembler();
    ~FrameAssembler();

    // 组装一帧
    // @param layers        图层快照列表（来自 LayerRecorder）
    // @param frame_id      帧序号（compositor_frame_seq_）
    // @param timestamp_ms  时间戳
    // @param scroll_x      页面滚动 X
    // @param scroll_y      页面滚动 Y
    // @param viewport_w    CSS 视口宽度
    // @param viewport_h    CSS 视口高度
    // @param canvas_w      物理画布宽度
    // @param canvas_h      物理画布高度
    // @param is_keyframe   是否全帧
    // @param image_mode    图像传输模式
    //
    // @return 组装后的完整帧字节缓冲区
    FrameBuffer assembleFrame(
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
        ImageMode image_mode = ImageMode::kInline);

    // 设置 RecordingCanvas 工厂（用于测试注入）
    using CanvasFactory = std::function<std::unique_ptr<RecordingCanvas>(int, int, ImageMode)>;
    void setCanvasFactory(CanvasFactory factory) { canvas_factory_ = std::move(factory); }

private:
    CanvasFactory canvas_factory_;

    // 默认工厂：创建 RecordingCanvas
    static std::unique_ptr<RecordingCanvas> defaultCanvasFactory(
        int width, int height, ImageMode mode);
};

}  // namespace garnet

#endif  // GARNET_LAYER_RECORDER_H_
