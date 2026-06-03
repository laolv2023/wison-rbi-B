// recording_canvas.h — 录制 SkCanvas（拦截所有绘制调用）
//
// RecordingCanvas 直接继承 SkCanvas（v1.6 P2 A5 → Phase 3 切换）。
// 重写所有 onDraw* 虚函数，将调用参数序列化到 CommandBuffer 中，
// 而不是执行实际光栅化。
//
// Phase 3 切换理由 (§4.1.2):
//   - SkNWayCanvas 是多路广播 Canvas，维护空子 Canvas 列表产生
//     额外虚函数调度开销。
//   - RecordingCanvas 仅需捕获命令，不需要广播语义。
//   - SkCanvas 直接子类化（参考 SkPictureRecorder::SkPictureCanvas）
//     更简洁高效，且不依赖 NWayCanvas 的内部实现细节。
//   - 构造函数通过 SkBitmap 创建最小化 device，满足 SkCanvas
//     构造要求，但不产生实际光栅化开销。
//
// 安全不变量:
//   - onReadPixels() 虚函数重写返回 false，绝对禁止像素回读
//   - 所有图像数据通过 writeImage() 集中处理（支持 hash-ref 去重）
//   - 字体数据通过 @font-face 机制内联传输，须经 SFNT/WOFF2 Magic 校验
//
// OOP 光栅化 UAF 防护 (v1.6 P1 A2):
//   - 当 DisplayItemList 由 Viz 进程持有时，RecordingCanvas 通过 Lock + DeepCopy
//     复制所有 PaintOp 参数，不持有跨进程悬空引用。
//
// 注意: 这是头文件声明，完整实现需 Chromium 源码树中的 Skia 依赖。
//       此处提供完整的接口定义和序列化逻辑注释。
//
#ifndef GARNET_RECORDING_CANVAS_H_
#define GARNET_RECORDING_CANVAS_H_

#include "command_buffer.h"

// Skia 实际头文件路径 (Chromium 源码树):
// #include "include/core/SkCanvas.h"
// #include "include/core/SkBitmap.h"
// #include "include/core/SkPaint.h"
// #include "include/core/SkPath.h"
// #include "include/core/SkTextBlob.h"
// #include "include/core/SkImage.h"
// #include "include/core/SkVertices.h"
// #include "include/core/SkM44.h"
// #include "include/core/SkRRect.h"

namespace garnet {

// Phase 3: 从 SkNWayCanvas 切换为 SkCanvas 直接子类化。
// Phase 1/2 使用 SkNWayCanvas 以利用其现成虚函数覆盖。
// Phase 3 移除多路广播开销，直接继承 SkCanvas。
class RecordingCanvas /* : public SkCanvas */ {
public:
    // 工厂方法：创建 RecordingCanvas
    // Phase 3: 内部创建最小 SkBitmap (1×1) 作为 SkCanvas 的 device，
    //          满足 SkCanvas 构造要求，但不产生实际光栅化开销。
    //          所有 onDraw* 虚函数被重写为序列化而非光栅化。
    // @param width  物理画布宽度
    // @param height 物理画布高度
    // @param image_mode 图像传输模式
    static std::unique_ptr<RecordingCanvas> Create(
        int width, int height,
        ImageMode image_mode = ImageMode::kInline);

    // 完成录制，返回包含所有命令的 CommandBuffer
    // 调用后此 RecordingCanvas 不可再使用
    CommandBuffer finalize();

    // 是否正在录制中
    bool isRecording() const { return recording_; }

    // 获取当前录制的 CommandBuffer 引用（只读，用于调试/审计）
    const CommandBuffer& commandBuffer() const { return buffer_; }

    // ═══════════════════════════════════════════════════════════
    // 状态管理 (Opcode 0x01-0x0F)
    // ═══════════════════════════════════════════════════════════

    void save();
    void restore();
    // saveLayer: 序列化 bounds + paint → opcode 0x03
    void saveLayer(const SkRect* bounds, const SkPaint* paint);

    // ═══════════════════════════════════════════════════════════
    // 变换 (Opcode 0x10-0x1F)
    // ═══════════════════════════════════════════════════════════

    void concat(const SkMatrix& matrix);
    void translate(SkScalar dx, SkScalar dy);
    void scale(SkScalar sx, SkScalar sy);
    void rotate(SkScalar radians);
    void concat44(const SkM44& matrix);  // v1.6 新增 (opcode 0x14)

    // ═══════════════════════════════════════════════════════════
    // 裁剪 (Opcode 0x20-0x2F)
    // ═══════════════════════════════════════════════════════════

    void clipRect(const SkRect& rect, SkClipOp op, bool doAA);
    void clipRRect(const SkRRect& rrect, SkClipOp op, bool doAA);
    void clipPath(const SkPath& path, SkClipOp op, bool doAA);

    // ═══════════════════════════════════════════════════════════
    // 形状绘制 (Opcode 0x30-0x3F)
    // ═══════════════════════════════════════════════════════════

    void drawRect(const SkRect& rect, const SkPaint& paint);
    void drawRRect(const SkRRect& rrect, const SkPaint& paint);
    void drawDRRect(const SkRRect& outer, const SkRRect& inner,
                    const SkPaint& paint);
    void drawOval(const SkRect& oval, const SkPaint& paint);
    void drawArc(const SkRect& oval, SkScalar startAngle,
                 SkScalar sweepAngle, bool useCenter,
                 const SkPaint& paint);
    void drawPath(const SkPath& path, const SkPaint& paint);
    void drawPoints(SkCanvas::PointMode mode, size_t count,
                    const SkPoint pts[], const SkPaint& paint);

    // ═══════════════════════════════════════════════════════════
    // 图像绘制 (Opcode 0x40-0x4F)
    // ═══════════════════════════════════════════════════════════

    void drawImage(const SkImage* image, SkScalar left, SkScalar top,
                   const SkSamplingOptions& sampling = {},
                   const SkPaint* paint = nullptr);
    void drawImageRect(const SkImage* image, const SkRect& src,
                       const SkRect& dst, const SkSamplingOptions& sampling = {},
                       const SkPaint* paint = nullptr,
                       SrcRectConstraint constraint = kStrict_SrcRectConstraint);
    void drawImageLattice(const SkImage* image,
                          const SkCanvas::Lattice& lattice,
                          const SkRect& dst, SkFilterMode filter,
                          const SkPaint* paint = nullptr);
    void drawAtlas(const SkImage* atlas, const SkRSXform xform[],
                   const SkRect tex[], const SkColor colors[],
                   int count, SkBlendMode mode,
                   const SkSamplingOptions& sampling = {},
                   const SkRect* cullRect = nullptr,
                   const SkPaint* paint = nullptr);
    void drawPatch(const SkPoint cubics[12], const SkColor colors[4],
                   const SkPoint texCoords[4], SkBlendMode mode,
                   const SkPaint& paint);
    void drawEdgeAAQuad(const SkRect& rect, const SkPoint clip[4],
                        SkCanvas::QuadAAFlags aaFlags,
                        const SkColor4f& color, SkBlendMode mode);
    void drawEdgeAAImageSet(const SkCanvas::ImageSetEntry set[], int count,
                            const SkPoint dstClips[],
                            const SkMatrix preViewMatrices[],
                            const SkSamplingOptions& sampling,
                            const SkPaint* paint,
                            SrcRectConstraint constraint);

    // ═══════════════════════════════════════════════════════════
    // 文本绘制 (Opcode 0x50-0x5F)
    // ═══════════════════════════════════════════════════════════

    void drawTextBlob(const SkTextBlob* blob, SkScalar x, SkScalar y,
                      const SkPaint& paint);
    void drawGlyphRunList(const SkGlyphRunList& glyphRunList,
                          const SkPaint& paint);

    // ═══════════════════════════════════════════════════════════
    // 其他绘制 (Opcode 0x60-0x6F)
    // ═══════════════════════════════════════════════════════════

    void drawPaint(const SkPaint& paint);
    void drawColor(SkColor4f color, SkBlendMode mode = SkBlendMode::kSrcOver);
    void drawShadow(const SkPath& path, const SkDrawShadowRec& rec);
    void drawVertices(const SkVertices* vertices, SkBlendMode mode,
                      const SkPaint& paint);
    void drawDrawable(SkDrawable* drawable, const SkMatrix* matrix = nullptr);
    void drawAnnotation(const SkRect& rect, const char key[], SkData* value);

    // ═══════════════════════════════════════════════════════════
    // 安全约束
    // ═══════════════════════════════════════════════════════════

    // 绝对禁止像素回读（虚函数重写 — Chromium 集成时须为 onReadPixels）
    // 安全理由: 防止客户端/服务端通过读取画布像素推断页面内容
    // ⚠️ 注意: SkCanvas::readPixels() 是非虚函数，内部调用此虚函数。
    //          在 Chromium 源码树集成时必须使用以下签名:
    //    bool onReadPixels(const SkPixmap& dst, int x, int y) override { return false; }
    //          本头文件中的声明仅作接口文档用途。
    bool onReadPixels(const SkPixmap&, int, int) { return false; }

    // ═══════════════════════════════════════════════════════════
    // 非 PictureLayer 图层采集 (v1.6 P0 A1)
    // ═══════════════════════════════════════════════════════════

    // 采集非 PictureLayer 的图层数据:
    //   - SolidColorLayer: 填充色
    //   - TextureLayer:   纹理引用 + UV 坐标
    //   - VideoLayer:     视频帧数据（Phase 2 限制为静态快照）
    //   - SurfaceLayer:   Surface 引用
    //   - ScrollbarLayer: 滚动条位置 + 样式
    //
    // 这些图层不经过 DisplayItemList，需单独采集。
    void recordSolidColorLayer(const SkColor4f& color, const SkRect& bounds);
    void recordTextureLayer(uint32_t texture_id, const SkRect& bounds,
                            const SkRect& uv_rect);
    void recordVideoLayer(uint32_t video_frame_id, const SkRect& bounds);
    void recordSurfaceLayer(uint32_t surface_id, const SkRect& bounds);
    void recordScrollbarLayer(bool vertical, float position,
                              float thumb_size, const SkRect& bounds);

private:
    // Phase 3 构造函数:
    //   创建最小化 SkBitmap (1×1, kRGBA_8888) 作为 device，
    //   将其传递给 SkCanvas 基类构造函数。该 device 仅用于
    //   满足 SkCanvas 的 API 契约，RecordingCanvas 的所有
    //   onDraw* 虚函数均已重写，不会向其写入实际像素。
    //
    //   Chromium 源码树集成时签名:
    //     RecordingCanvas(SkBitmap device, int width, int height,
    //                     ImageMode image_mode);
    RecordingCanvas(int width, int height, ImageMode image_mode);

    CommandBuffer buffer_;
    int width_;
    int height_;
    ImageMode image_mode_;
    bool recording_;

    // Phase 3: SkCanvas 需要的最小 device（不产生光栅化开销）
    // SkBitmap minimal_device_;  // 1×1, kRGBA_8888, 仅用于满足 SkCanvas 构造

    // Save/Restore 深度跟踪（用于录音时的一致性检查）
    int save_depth_;
};

}  // namespace garnet

#endif  // GARNET_RECORDING_CANVAS_H_
