// recording_canvas.h — 录制 SkCanvas（拦截所有绘制调用，序列化而非光栅化）
//
// ═══════════════════════════════════════════════════════════════════════════════
// 模块在 Wison-RBI 架构中的角色
// ═══════════════════════════════════════════════════════════════════════════════
// RecordingCanvas 是 Wison-RBI Compositor 拦截的核心组件（§4.1.2），
// 负责将 Skia 绘制调用捕获并序列化为 CommandBuffer 中的协议兼容字节序列。
//
// 继承关系:
//   Phase 3: SkCanvas 直接子类化（本文档当前状态）
//     RecordingCanvas : public SkCanvas
//     参考: SkPictureRecorder::SkPictureCanvas（Chromium 内置录制器）
//
//   Phase 1/2: SkNWayCanvas 子类化（历史过渡方案，已废弃）
//     原因: 多路广播 Canvas 维护空子 Canvas 列表，产生额外虚函数调度开销
//
// 在 Chromium 源码树中的挂载点:
//   - 挂载路径: //garnet/recording_canvas.h + recording_canvas.cc
//   - 调用方: FrameAssembler（创建 RecordingCanvas 实例并重放 PaintOp）
//   - 编译依赖: command_buffer.h + Skia 头文件
//   - 集成点: FrameAssembler::assembleFrame() 中通过工厂方法 Create() 创建
//
// Phase 3 切换理由 (§4.1.2):
//   - SkNWayCanvas 是多路广播 Canvas，设计目的是将绘制调用转发给多个子 Canvas
//   - RecordingCanvas 仅需捕获命令，不需要广播语义
//   - SkCanvas 直接子类化更简洁高效，不依赖 NWayCanvas 内部实现细节
//   - 构造函数通过 SkBitmap 创建最小化 device (1×1, kRGBA_8888)，
//     满足 SkCanvas 构造要求但不产生实际光栅化开销
//
// ═══════════════════════════════════════════════════════════════════════════════
// 安全不变量
// ═══════════════════════════════════════════════════════════════════════════════
//   I-1: onReadPixels() 虚函数重写返回 false — 绝对禁止像素回读
//        （§2.2 不变量 1: 客户端仅接收绘制命令，非像素数据）
//   I-2: 所有图像数据通过 writeImage() 集中处理 — 支持 hash-ref 去重 + 槽位机制
//   I-3: 字体数据通过 kFontData opcode 内联传输 — 须经 SFNT/WOFF2 Magic 校验
//        （garnet_config.h §8.4 v1.6 P1 S4）
//   I-4: Save/Restore 深度跟踪 (save_depth_) — 录制时一致性检查
//
// OOP 光栅化 UAF 防护 (v1.6 P1 A2):
//   - 当 DisplayItemList 由 Viz 进程持有时，RecordingCanvas 通过
//     Lock + DeepCopy 复制所有 PaintOp 参数，不持有跨进程悬空引用。
//
#ifndef GARNET_RECORDING_CANVAS_H_
#define GARNET_RECORDING_CANVAS_H_

#include "command_buffer.h"

#include <stdexcept>

// Skia 实际头文件路径 (Chromium 源码树):
#include "include/core/SkCanvas.h"
#include "include/core/SkBitmap.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPath.h"
#include "include/core/SkTextBlob.h"
#include "include/core/SkImage.h"
#include "include/core/SkVertices.h"
#include "include/core/SkM44.h"
#include "include/core/SkRRect.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkGlyphRunList.h"
#include "include/core/SkDrawShadowRec.h"
#include "include/core/SkSamplingOptions.h"
#include "include/core/SkRSXform.h"
#include "include/core/SkDrawable.h"
#include "include/core/SkRegion.h"
#include "include/core/SkData.h"

namespace garnet {

/// @brief 录制用 SkCanvas 子类 — 序列化所有绘制调用，不执行实际光栅化。
///
/// Phase 3: 从 SkNWayCanvas 切换为 SkCanvas 直接子类化 (§4.1.2)。
/// Phase 1/2 曾使用 SkNWayCanvas 以利用其现成虚函数覆盖。
/// Phase 3 移除多路广播开销，直接继承 SkCanvas。
///
/// 工作流程:
///   1. Create(width, height, image_mode) → 创建实例 + 最小 device
///   2. 作为 FrameAssembler 重放 PaintOp 的目标 Canvas
///   3. 所有 onDraw* 虚函数将参数序列化到 CommandBuffer
///   4. finalize() → 返回填充完毕的 CommandBuffer
///   5. RecordingCanvas 实例不再可用（recording_ = false）
class RecordingCanvas : public SkCanvas {
public:
    /// @brief 工厂方法: 创建 RecordingCanvas 实例。
    ///
    /// Phase 3 实现: 内部创建最小 SkBitmap (1×1, kRGBA_8888) 作为
    /// SkCanvas 的 device，满足 SkCanvas 构造要求但不产生光栅化开销。
    /// 所有 onDraw* 虚函数被重写为序列化而非光栅化。
    ///
    /// @param width      物理画布宽度 (px)
    /// @param height     物理画布高度 (px)
    /// @param image_mode 图像传输模式（kInline 默认，kHashRef 去重）
    /// @returns 独占所有权的 RecordingCanvas 实例
    static std::unique_ptr<RecordingCanvas> Create(
        int width, int height,
        ImageMode image_mode = ImageMode::kInline);

    /// @brief 完成录制，返回填充完毕的 CommandBuffer。
    ///
    /// 调用后此 RecordingCanvas 进入"已完成"状态 (recording_=false)，
    /// 不可再用于录制。CommandBuffer 通过移动语义转移所有权。
    ///
    /// @returns 包含所有序列化命令的 CommandBuffer
    CommandBuffer finalize();

    /// @brief 是否正在录制中。
    /// @returns true 若处于录制状态 (recording_==true)
    bool isRecording() const { return recording_; }

    /// @brief 获取当前 CommandBuffer 的只读引用（调试/审计用途）。
    ///
    /// @returns CommandBuffer 的 const 引用
    const CommandBuffer& commandBuffer() const { return buffer_; }

    // ═══════════════════════════════════════════════════════════
    // 状态管理 — Opcode 0x01-0x0F (§4.1.2 RecordingCanvas 实现)
    //
    // 对应 SkCanvas 的状态栈操作。每次 save/restore 均序列化
    // 为对应 opcode 的命令，客户端在 CanvasKit 上重放。
    // ═══════════════════════════════════════════════════════════

    /// @brief 保存当前画布状态（矩阵 + 裁剪），opcode 0x01。
    int save() override;

    /// @brief 恢复最近保存的画布状态，opcode 0x02。
    void restore() override;

    /// @brief 保存图层（可选 bounds + paint），opcode 0x03。
    ///
    /// @param bounds 图层边界（可为 nullptr）
    /// @param paint  图层 Paint（可为 nullptr）
    int saveLayer(const SkRect* bounds, const SkPaint* paint) override;

    // ═══════════════════════════════════════════════════════════
    // 变换 — Opcode 0x10-0x1F (§4.1.2 变换捕获)
    //
    // 所有变换操作序列化为 Matrix 命令。Phase 3 支持 SkM44
    // 4×4 矩阵 (opcode 0x14, v1.6 新增)，支持 CSS 3D 变换。
    // ═══════════════════════════════════════════════════════════

    /// @brief 连接 3×3 变换矩阵，opcode 0x10。
    /// @param matrix SkMatrix (9 × f32 = 36 bytes)
    void concat(const SkMatrix& matrix) override;

    /// @brief 平移，opcode 0x11。
    /// @param dx X 方向位移 (SkScalar = float)
    /// @param dy Y 方向位移
    void translate(SkScalar dx, SkScalar dy) override;

    /// @brief 缩放，opcode 0x12。
    /// @param sx X 方向缩放因子
    /// @param sy Y 方向缩放因子
    void scale(SkScalar sx, SkScalar sy) override;

    /// @brief 旋转，opcode 0x13。
    /// @param radians 旋转弧度（逆时针为正）
    void rotate(SkScalar radians) override;

    /// @brief 连接 4×4 变换矩阵，opcode 0x14 (v1.6 新增)。
    ///
    /// 序列化格式: 16 × f32 = 64 bytes (行主序)。
    /// 替代 Phase 1/2 的 3×3 矩阵，支持 CSS transform: matrix3d。
    ///
    /// @param matrix SkM44 4×4 矩阵
    void concat44(const SkM44& matrix) override;

    // ═══════════════════════════════════════════════════════════
    // 裁剪 — Opcode 0x20-0x2F
    // ═══════════════════════════════════════════════════════════

    /// @brief 矩形裁剪，opcode 0x20。
    /// @param rect 裁剪矩形
    /// @param op   裁剪操作（intersect/difference）
    /// @param doAA 是否抗锯齿
    void clipRect(const SkRect& rect, SkClipOp op, bool doAA) override;

    /// @brief 圆角矩形裁剪，opcode 0x21。
    void clipRRect(const SkRRect& rrect, SkClipOp op, bool doAA) override;

    /// @brief 路径裁剪，opcode 0x22。
    void clipPath(const SkPath& path, SkClipOp op, bool doAA) override;

    // ═══════════════════════════════════════════════════════════
    // 形状绘制 — Opcode 0x30-0x3F (§4.1.2 onDraw* 拦截)
    //
    // 每个方法序列化: opcode + 形状参数 + SkPaint。
    // @{

    void drawRect(const SkRect& rect, const SkPaint& paint) override;
    void drawRRect(const SkRRect& rrect, const SkPaint& paint) override;
    void drawDRRect(const SkRRect& outer, const SkRRect& inner,
                    const SkPaint& paint);
    void drawOval(const SkRect& oval, const SkPaint& paint) override;
    void drawArc(const SkRect& oval, SkScalar startAngle,
                 SkScalar sweepAngle, bool useCenter,
                 const SkPaint& paint);
    void drawPath(const SkPath& path, const SkPaint& paint) override;
    void drawPoints(SkCanvas::PointMode mode, size_t count,
                    const SkPoint pts[], const SkPaint& paint);
    /// @}

    // ═══════════════════════════════════════════════════════════
    // 图像绘制 — Opcode 0x40-0x4F (§4.1.4 图像序列化)
    //
    // 图像数据通过 writeImage() → reserveImageSlot() 延迟编码。
    // Compositor 线程仅捕获 sk_sp 引用，Worker 线程异步编码。
    // @{

    /// @brief 绘制图像，opcode 0x40。
    /// @param image    Skia 图像（通过 writeImage 序列化，仅捕获引用）
    /// @param left     左上角 X
    /// @param top      左上角 Y
    /// @param sampling 采样选项
    /// @param paint    可选 Paint
    void drawImage(const SkImage* image, SkScalar left, SkScalar top,
                   const SkSamplingOptions& sampling = {},
                   const SkPaint* paint = nullptr);

    /// @brief 绘制图像到矩形区域 (src→dst)，opcode 0x41。
    void drawImageRect(const SkImage* image, const SkRect& src,
                       const SkRect& dst, const SkSamplingOptions& sampling = {},
                       const SkPaint* paint = nullptr,
                       SrcRectConstraint constraint = kStrict_SrcRectConstraint);

    /// @brief 九宫格图像绘制，opcode 0x42。
    void drawImageLattice(const SkImage* image,
                          const SkCanvas::Lattice& lattice,
                          const SkRect& dst, SkFilterMode filter,
                          const SkPaint* paint = nullptr);

    /// @brief 纹理图集绘制（精灵批处理），opcode 0x43。
    ///
    /// 边界检查: count ≤ kMaxAtlasCount (100,000)。
    void drawAtlas(const SkImage* atlas, const SkRSXform xform[],
                   const SkRect tex[], const SkColor colors[],
                   int count, SkBlendMode mode,
                   const SkSamplingOptions& sampling = {},
                   const SkRect* cullRect = nullptr,
                   const SkPaint* paint = nullptr);

    /// @brief 9-patch 补丁绘制，opcode 0x44。
    void drawPatch(const SkPoint cubics[12], const SkColor colors[4],
                   const SkPoint texCoords[4], SkBlendMode mode,
                   const SkPaint& paint);

    /// @brief 带 AA 的四边形绘制，opcode 0x45。
    void drawEdgeAAQuad(const SkRect& rect, const SkPoint clip[4],
                        SkCanvas::QuadAAFlags aaFlags,
                        const SkColor4f& color, SkBlendMode mode);

    /// @brief 批量图像 + AA 四边形，opcode 0x46。
    void drawEdgeAAImageSet(const SkCanvas::ImageSetEntry set[], int count,
                            const SkPoint dstClips[],
                            const SkMatrix preViewMatrices[],
                            const SkSamplingOptions& sampling,
                            const SkPaint* paint,
                            SrcRectConstraint constraint);
    /// @}

    // ═══════════════════════════════════════════════════════════
    // 文本绘制 — Opcode 0x50-0x5F (v1.6 字体内联传输)
    //
    // 文本通过 SkTextBlob 序列化（glyph 列表 + 位置 + 字体引用）。
    // 字体数据通过 kFontData opcode 内联传输，须经 SFNT/WOFF2
    // Magic 白名单校验 (§8.4 v1.6 P1 S4)。
    // @{

    /// @brief 绘制文本块，opcode 0x50。
    ///
    /// @param blob  SkTextBlob（glyph 列表 + 位置 + 字体引用）
    /// @param x     基线起点 X
    /// @param y     基线起点 Y
    /// @param paint 文本 Paint
    void drawTextBlob(const SkTextBlob* blob, SkScalar x, SkScalar y,
                      const SkPaint& paint);

    /// @brief 绘制字形运行列表，opcode 0x51。
    void drawGlyphRunList(const SkGlyphRunList& glyphRunList,
                          const SkPaint& paint);
    /// @}

    // ═══════════════════════════════════════════════════════════
    // 其他绘制 — Opcode 0x60-0x6F
    // @{

    /// @brief 用 Paint 填充整个画布，opcode 0x60。
    void drawPaint(const SkPaint& paint) override;

    /// @brief 用纯色填充整个画布，opcode 0x61。
    void drawColor(SkColor4f color, SkBlendMode mode = SkBlendMode::kSrcOver) override;

    /// @brief 绘制阴影，opcode 0x62。
    void drawShadow(const SkPath& path, const SkDrawShadowRec& rec) override;

    /// @brief 绘制顶点对象，opcode 0x63。
    ///
    /// 边界检查: vertexCount ≤ kMaxVerticesCount (100,000)。
    void drawVertices(const SkVertices* vertices, SkBlendMode mode,
                      const SkPaint& paint);

    /// @brief 绘制 SkDrawable，opcode 0x64。
    ///
    /// @warning SkDrawable 不可序列化 — 此调用降级为 kNoop (opcode 0x7F)。
    ///          客户端将跳过此命令，不会在 Canvas 上执行任何绘制。
    void drawDrawable(SkDrawable* drawable, const SkMatrix* matrix = nullptr) override;

    /// @brief 绘制注解，opcode 0x65。
    void drawAnnotation(const SkRect& rect, const char key[], SkData* value) override;
    /// @}

    // ═══════════════════════════════════════════════════════════
    // 安全约束 — §2.2 安全不变量
    // ═══════════════════════════════════════════════════════════

    /// @brief 绝对禁止像素回读 — 安全不变量 I-1。
    ///
    /// 安全理由 (§2.2 不变量 1): 客户端收到的每一个字节只能是
    /// 合法的 Skia 绘制命令或帧元数据。像素回读将破坏此不变量，
    /// 允许客户端推断页面视觉内容。
    ///
    /// @warning SkCanvas::readPixels() 是非虚函数，内部调用此虚函数。
    ///          在 Chromium 源码树集成时必须使用以下覆盖签名:
    ///          bool onReadPixels(const SkPixmap& dst, int x, int y) override { return false; }
    ///
    /// @returns 始终 false（拒绝所有读像素请求）
    bool onReadPixels(const SkPixmap& dst, int x, int y) override { return false; }

    // ═══════════════════════════════════════════════════════════
    // 非 PictureLayer 图层采集 — v1.6 P0 A1
    //
    // 以下方法采集不经过 DisplayItemList 的图层类型:
    //   - SolidColorLayer: 纯色背景 → 序列化为 drawColor 命令
    //   - TextureLayer:    WebGL/Canvas → 采集 GPU 纹理快照
    //   - VideoLayer:      <video> → 通过媒体通道独立传输（Phase 2）
    //   - SurfaceLayer:    iframe/跨进程 → 采集合成表面快照
    //   - ScrollbarLayer:  滚动条 → 采集位置 + 样式
    //
    // 这些图层在 DrawLayers 阶段由 FrameAssembler 遍历采集
    // （参见 §4.1.1 拦截点 2 + layer_recorder.h）。
    // ═══════════════════════════════════════════════════════════

    /// @brief 采集 SolidColorLayer（纯色背景）。
    /// @param color  填充色 (SkColor4f)
    /// @param bounds 图层边界
    void recordSolidColorLayer(const SkColor4f& color, const SkRect& bounds);

    /// @brief 采集 TextureLayer（WebGL/Canvas 纹理）。
    /// @param texture_id GPU 纹理 ID
    /// @param bounds     图层边界
    /// @param uv_rect    UV 坐标矩形
    void recordTextureLayer(uint32_t texture_id, const SkRect& bounds,
                            const SkRect& uv_rect);

    /// @brief 采集 VideoLayer（<video> 帧快照）。
    /// @param video_frame_id 视频帧 ID
    /// @param bounds         图层边界
    void recordVideoLayer(uint32_t video_frame_id, const SkRect& bounds);

    /// @brief 采集 SurfaceLayer（iframe/跨进程合成表面）。
    /// @param surface_id 合成表面 ID
    /// @param bounds     图层边界
    void recordSurfaceLayer(uint32_t surface_id, const SkRect& bounds);

    /// @brief 采集 ScrollbarLayer（滚动条）。
    /// @param vertical   是否垂直滚动条
    /// @param position   滚动条位置 (0.0 ~ 1.0)
    /// @param thumb_size 滑块大小比例
    /// @param bounds     图层边界
    void recordScrollbarLayer(bool vertical, float position,
                              float thumb_size, const SkRect& bounds);

private:
    /// @brief 私有构造函数（通过工厂方法 Create() 创建）。
    ///
    /// 创建最小化 SkBitmap (1×1, kN32_SkColorType) 作为 device，
    /// 传递给 SkCanvas 基类构造函数。该 device 仅用于满足
    /// SkCanvas 的 API 契约，所有 onDraw* 虚函数均已重写，
    /// 不会向其写入实际像素。
    ///
    /// @param width      物理画布宽度 (px)
    /// @param height     物理画布高度 (px)
    /// @param image_mode 图像传输模式
    RecordingCanvas(int width, int height, ImageMode image_mode,
                    const SkBitmap& device);

    // v4: Exception-safe command wrapper (§4.1.2)
    template<typename F>
    void safeCommand(garnet::Opcode opcode, F&& writeFunc) {
        if (!recording_ || finalized_) return;
        buffer_.beginCommand(opcode);
        try {
            writeFunc();
            buffer_.endCommand();
        } catch (...) {
            // On exception during write, reset command state
            // TODO: CommandBuffer should expose abortCommand() for proper cleanup
            // Currently endCommand() handles in_command_ reset
            buffer_.endCommand();
            throw;
        }
    }

    CommandBuffer buffer_;     ///< 序列化命令缓冲区（录制目标）
    int width_;                ///< 物理画布宽度
    int height_;               ///< 物理画布高度
    ImageMode image_mode_;     ///< 图像传输模式
    bool recording_;           ///< 录制状态标志
    bool finalized_ = false;   ///< 最终化状态标志（防止 use-after-finalize）
    SkBitmap minimal_device_;  ///< 1×1 最小 device，仅用于满足 SkCanvas 构造

    /// @brief Save/Restore 深度跟踪。
    ///
    /// 用于录制时的一致性检查: 录制结束时 save_depth_ 应为 0，
    /// 否则说明 save/restore 不匹配，CommandBuffer 可能包含未关闭的状态。
    int save_depth_;
};

}  // namespace garnet

#endif  // GARNET_RECORDING_CANVAS_H_
