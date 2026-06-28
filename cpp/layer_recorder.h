// layer_recorder.h — Chromium cc 层拦截点 (图层录制 + 帧组装)
//
// ═══════════════════════════════════════════════════════════════════════════════
// 模块在 Wison-RBI 架构中的角色
// ═══════════════════════════════════════════════════════════════════════════════
// LayerRecorder 和 FrameAssembler 是 Wison-RBI 在 Chromium Compositor 层
// 的两个拦截组件（§4.1.1 拦截点），共同完成从图层树到网络帧的转换。
//
// ┌── LayerRecorder (图层录制器) ──────────────────────────────┐
// │                                                             │
// │  拦截点 1: DisplayItemList::Finalize() 之后                 │
// │    → 收集 PictureLayer 的完整 PaintOp 列表 (+ R-tree 索引) │
// │    → 路径: PictureLayerImpl → DisplayItemList              │
// │            → LayerRecorder::recordPictureLayer()            │
// │                                                             │
// │  拦截点 2: LayerTreeHostImpl::DrawLayers() 内               │
// │    → 遍历所有活跃图层，捕获每层的矩阵变换 + 图层快照         │
// │    → 路径: DrawLayers()                                    │
// │            → LayerRecorder::recordLayerTransform()          │
// │            → 非 PictureLayer 图层采集 (v1.6 P0 A1)         │
// └─────────────────────────────────────────────────────────────┘
//                              │
//                              ▼
// ┌── FrameAssembler (帧组装器) ────────────────────────────────┐
// │                                                             │
// │  从 LayerRecorder 收集的图层快照中，通过 RecordingCanvas     │
// │  重放所有 PaintOp，生成 CommandBuffer + 帧元数据。           │
// │  最终调用 AssembleFrame() 输出 FrameBuffer (§3.1 Finalize)   │
// └─────────────────────────────────────────────────────────────┘
//
// 在 Chromium 源码树中的挂载点:
//   - 挂载路径: //garnet/layer_recorder.h + layer_recorder.cc
//   - 集成修改点:
//       · cc/layers/picture_layer_impl.cc: Finalize() 后调用 recordPictureLayer()
//       · cc/trees/layer_tree_host_impl.cc: DrawLayers() 内迭代图层
//       · cc/trees/layer_tree_host_impl.cc: SubmitNonPictureLayers() (v1.6 P0 A1)
//   - 编译依赖: command_buffer.h + recording_canvas.h
//
// ═══════════════════════════════════════════════════════════════════════════════
// 线程模型
// ═══════════════════════════════════════════════════════════════════════════════
//   - Compositor 线程: beginFrame() / recordPictureLayer() / endFrame()
//     → 写入 PaintOp + 变换快照（单线程，mutex 保护 layers_）
//   - Worker 线程:     图像编码 (EncodePendingImages)
//     → 在 FrameAssembler 组装后异步执行
//
// ═══════════════════════════════════════════════════════════════════════════════
// v1.6 变更
// ═══════════════════════════════════════════════════════════════════════════════
//   - P0 A1: SubmitNonPictureLayers 采集 SolidColor/Texture/Video/Surface/Scrollbar
//   - P1 A3: 图层变换快照从 UpdateRasterSource 移至 DrawLayers 捕获
//            （原因: CSS animation 可能在两次调用间更新变换矩阵）
//   - P1 A2: OOP 光栅化场景 Lock + DeepCopy 防护
//   - P0 A4: frame_id 使用 compositor_frame_seq_ 自定义单调计数器
//
// ═══════════════════════════════════════════════════════════════════════════════
// 安全不变量
// ═══════════════════════════════════════════════════════════════════════════════
//   I-1: OOP 光栅化场景下，所有 PaintOp 数据通过 Lock + DeepCopy 从 Viz 进程
//        复制到本地（§4.1.1 v1.6 P1 A2），防止跨进程 UAF
//   I-2: 图层变换在 DrawLayers 原子时刻捕获，确保帧内变换一致性
//   I-3: beginFrame/endFrame 成对调用，保证帧边界清晰
//   I-4: mutex_ 保护 layers_ 向量，防止 Compositor 线程和审计线程竞态
#ifndef GARNET_LAYER_RECORDER_H_
#define GARNET_LAYER_RECORDER_H_

#include "command_buffer.h"
#include "recording_canvas.h"

#include <memory>
#include <vector>
#include <mutex>

namespace garnet {

/// @brief 单个图层的信息快照（v1.6 P1 A3: 在 DrawLayers 时捕获）。
///
/// 在 DrawLayers 阶段捕获的理由:
///   - CSS animation / scroll-linked animation 可能在 UpdateRasterSource
///     和 DrawLayers 之间更新变换矩阵
///   - DrawLayers 是 Compositor 帧提交的原子时刻，所有活跃变换已最终确定
///
/// 非 PictureLayer 图层 (§4.1.1 v1.6 P0 A1):
///   - SolidColorLayer: 纯色背景 → 包含 solid_color
///   - TextureLayer:    WebGL/Canvas → 包含 texture_id + uv_rect
///   - VideoLayer:      <video> → 包含 video_frame_id
///   - SurfaceLayer:    iframe/跨进程 → 包含 surface_id
///   - ScrollbarLayer:  滚动条 → 包含 scrollbar 位置/方向
struct LayerSnapshot {
    uint32_t layer_id;         ///< 图层唯一标识 (cc::Layer::id())
    SkRect bounds;             ///< 图层边界矩形
    SkMatrix transform;        ///< 累积变换矩阵（DrawLayers 时刻捕获）
    SkRect visible_rect;       ///< 可见区域（用于 R-tree 裁剪）
    bool contents_opaque;      ///< 内容是否完全不透明
    float opacity;             ///< 图层透明度 (0.0~1.0)

    /// @brief 图层类型枚举。
    ///
    /// PictureLayer 经过 DisplayItemList::Finalize() 采集 PaintOp。
    /// 其他 5 种类型不经过 DisplayItemList，需在 DrawLayers 阶段单独采集。
    enum class Type : uint8_t {
        kPicture,     ///< PictureLayer (标准 CSS 绘制内容)
        kSolidColor,  ///< SolidColorLayer (纯色背景)
        kTexture,     ///< TextureLayer (WebGL Canvas / 2D Canvas)
        kVideo,       ///< VideoLayer (<video> 元素)
        kSurface,     ///< SurfaceLayer (iframe / 跨进程合成)
        kScrollbar,   ///< ScrollbarLayer (滚动条)
    };
    Type type;  ///< 图层类型

    /// @brief PictureLayer 特有: PaintOp 序列化数据。
    ///
    /// @warning OOP 光栅化时此数据通过 Lock + DeepCopy 从 Viz 进程复制。
    ///          不可直接持有跨进程共享内存指针（UAF 风险，§4.1.1 v1.6 P1 A2）。
    std::vector<uint8_t> paint_ops;

    // ── 非 PictureLayer 特有数据 (v1.6 P0 A1) ──
    SkColor4f solid_color;       ///< SolidColorLayer: 填充色
    uint32_t  texture_id;        ///< TextureLayer: GPU 纹理 ID
    SkRect    uv_rect;           ///< TextureLayer: UV 坐标矩形
    uint32_t  video_frame_id;    ///< VideoLayer: 视频帧 ID
    uint32_t  surface_id;        ///< SurfaceLayer: 合成表面 ID
    bool      scrollbar_vertical; ///< ScrollbarLayer: 是否垂直
    float     scrollbar_position; ///< ScrollbarLayer: 位置 (0.0~1.0)
    float     scrollbar_thumb_size; ///< ScrollbarLayer: 滑块大小比例
};

// ═══════════════════════════════════════════════════════════════
// LayerRecorder — 帧级图层录制器 (§4.1.1 拦截点 1 + 2)
//
// 职责: 在 Compositor 线程的两个拦截点收集图层快照。
// 生命周期: beginFrame() → record*() × N → endFrame()
// ═══════════════════════════════════════════════════════════════

/// @brief 图层录制器 — 收集一帧中所有图层的快照。
///
/// 线程: Compositor 线程单线程调用（mutex_ 提供额外保护）。
class LayerRecorder {
public:
    LayerRecorder();
    ~LayerRecorder();

    /// @brief 开始新的帧录制周期。
    ///
    /// 效果: 清空 layers_ 列表，设置 in_frame_=true。
    /// @throws std::logic_error 若上一帧尚未结束（in_frame_==true）
    void beginFrame();

    /// @brief 结束当前帧录制，返回所有图层快照。
    ///
    /// @returns 本帧收集的所有图层快照（移动语义）
    /// @throws std::logic_error 若未调用 beginFrame()
    std::vector<LayerSnapshot> endFrame();

    // ═══════════════════════════════════════════════════════════
    // 图层录制 (Compositor 线程调用)
    // ═══════════════════════════════════════════════════════════

    /// @brief 录制 PictureLayer（拦截点 1: DisplayItemList::Finalize() 之后调用）。
    ///
    /// §4.1.1 拦截点 1: 当一个图层的绘制内容准备好时，
    /// DisplayItemList::Finalize() 被调用。此时 PaintOpBuffer 包含
    /// 该图层的完整绘制命令（全图层，非瓦片裁剪子集）。
    ///
    /// @param layer_id         图层 ID
    /// @param bounds           图层边界
    /// @param transform_snapshot 当前变换矩阵快照
    /// @param visible_rect     可见区域
    /// @param contents_opaque  内容是否不透明
    /// @param opacity          图层透明度
    /// @param paint_ops_data   PaintOp 序列化数据指针
    /// @param paint_ops_size   PaintOp 数据字节数
    void recordPictureLayer(uint32_t layer_id,
                            const SkRect& bounds,
                            const SkMatrix& transform_snapshot,
                            const SkRect& visible_rect,
                            bool contents_opaque,
                            float opacity,
                            const uint8_t* paint_ops_data,
                            size_t paint_ops_size);

    /// @brief 录制 SolidColorLayer（拦截点 2, v1.6 P0 A1 新增）。
    ///
    /// §4.1.1: 非 PictureLayer 采集。SolidColorLayer 不含 PaintOp，
    /// 仅包含填充色。客户端将序列化为 drawColor 命令。
    void recordSolidColorLayer(uint32_t layer_id, const SkColor4f& color,
                               const SkRect& bounds, const SkMatrix& transform,
                               float opacity);

    /// @brief 录制 TextureLayer（WebGL/Canvas 纹理）。
    void recordTextureLayer(uint32_t layer_id, uint32_t texture_id,
                            const SkRect& bounds, const SkRect& uv_rect,
                            const SkMatrix& transform, float opacity);

    /// @brief 录制 VideoLayer（<video> 帧快照）。
    void recordVideoLayer(uint32_t layer_id, uint32_t video_frame_id,
                          const SkRect& bounds, const SkMatrix& transform,
                          float opacity);

    /// @brief 录制 SurfaceLayer（iframe/跨进程合成表面）。
    void recordSurfaceLayer(uint32_t layer_id, uint32_t surface_id,
                            const SkRect& bounds, const SkMatrix& transform,
                            float opacity);

    /// @brief 录制 ScrollbarLayer（滚动条）。
    void recordScrollbarLayer(uint32_t layer_id, bool vertical,
                              float position, float thumb_size,
                              const SkRect& bounds, const SkMatrix& transform,
                              float opacity);

    // ═══════════════════════════════════════════════════════════
    // OOP 光栅化安全复制 — v1.6 P1 A2
    // ═══════════════════════════════════════════════════════════

    /// @brief 从跨进程共享内存区 DeepCopy PaintOp 数据。
    ///
    /// 安全理由 (§4.1.1 v1.6 P1 A2):
    ///   当 --garnet-raster-mode=record-only 且 OOP 光栅化启用时，
    ///   DisplayItemList 由 Viz 进程持有。若直接持有共享内存指针，
    ///   Viz 进程可能提前释放导致 Use-After-Free。
    ///
    ///   本方法执行 Lock + memcpy 复制，返回本地拥有的 std::vector 副本。
    ///   复制在 Lock 保护下完成，确保数据一致性。
    ///
    /// @param shared_data 跨进程共享内存指针
    /// @param size        数据字节数
    /// @returns 本地拥有的 DeepCopy 副本
    std::vector<uint8_t> deepCopyPaintOps(const uint8_t* shared_data,
                                          size_t size);

private:
    std::vector<LayerSnapshot> layers_;  ///< 本帧图层快照列表
    std::mutex mutex_;                   ///< 保护 layers_（Compositor 线程写入）

    bool in_frame_;                      ///< 帧录制状态标志
};

// ═══════════════════════════════════════════════════════════════
// FrameAssembler — 组装完整帧 (§4.1.1 帧汇总)
//
// 从 LayerRecorder 收集的图层快照中，通过 RecordingCanvas
// 重放所有 PaintOp，生成 CommandBuffer + 帧元数据。
// 最终输出 FrameBuffer → Node.js I/O 代理 → WebSocket → 客户端。
//
// 工作流程 (§3.1 全局数据流 Finalize 阶段):
//   1. 接收 LayerRecorder::endFrame() 返回的图层快照列表
//   2. 创建 RecordingCanvas (通过 CanvasFactory)
//   3. 按 z-order 遍历图层，重放 PaintOp 到 RecordingCanvas
//   4. 附加 layer 元数据 → save/translate/clip/opacity 命令
//   5. RecordingCanvas::finalize() → 获取 CommandBuffer
//   6. 组装 FrameHeader + CommandStream + CRC32 → FrameBuffer
// ═══════════════════════════════════════════════════════════════

/// @brief 帧组装器 — 将图层快照转换为可传输的帧字节缓冲区。
///
/// 线程: Compositor 线程调用（重放 PaintOp 需在 Compositor 线程）。
class FrameAssembler {
public:
    FrameAssembler();
    ~FrameAssembler();

    /// @brief 组装一帧（完整流程）。
    ///
    /// 步骤:
    ///   1. 创建 RecordingCanvas (通过 canvas_factory_)
    ///   2. 遍历 layers，按 z-order 重放 PaintOp
    ///   3. 对每个图层应用矩阵变换 (save/translate/concat/clip/opacity)
    ///   4. finalize RecordingCanvas → 获取 CommandBuffer
    ///   5. 组装 FrameHeader + Commands + CRC32 → FrameBuffer
    ///
    /// @param layers        图层快照列表（来自 LayerRecorder::endFrame()）
    /// @param frame_id      帧序号（compositor_frame_seq_，§7 帧元数据）
    /// @param timestamp_ms  Unix 毫秒时间戳
    /// @param scroll_x      页面滚动 X (px), §7.3 坐标转换
    /// @param scroll_y      页面滚动 Y (px)
    /// @param viewport_w    CSS 视口宽度 (px), §6.3 viewport 消息
    /// @param viewport_h    CSS 视口高度 (px)
    /// @param canvas_w      物理画布宽度 = viewport_w × dpr
    /// @param canvas_h      物理画布高度 = viewport_h × dpr
    /// @param is_keyframe   是否全帧（true）或增量帧（false）
    /// @param image_mode    图像传输模式
    ///
    /// @returns 组装后的完整帧字节缓冲区
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

    /// @brief RecordingCanvas 工厂类型别名。
    ///
    /// 签名: (int width, int height, ImageMode) → unique_ptr<RecordingCanvas>
    using CanvasFactory = std::function<std::unique_ptr<RecordingCanvas>(int, int, ImageMode)>;

    /// @brief 设置 RecordingCanvas 工厂（用于测试注入/模拟）。
    ///
    /// 单元测试中可注入 MockRecordingCanvas 以验证序列化输出。
    ///
    /// @param factory 返回 RecordingCanvas 实例的可调用对象
    void setCanvasFactory(CanvasFactory factory) { canvas_factory_ = std::move(factory); }

private:
    CanvasFactory canvas_factory_;  ///< RecordingCanvas 工厂（可注入）

    /// @brief 默认工厂: 创建标准 RecordingCanvas。
    ///
    /// 调用 RecordingCanvas::Create(width, height, mode)。
    static std::unique_ptr<RecordingCanvas> defaultCanvasFactory(
        int width, int height, ImageMode mode);
};

}  // namespace garnet

#endif  // GARNET_LAYER_RECORDER_H_
