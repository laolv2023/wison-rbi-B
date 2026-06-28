// recording_canvas.cpp — 录制 SkCanvas 实现（拦截所有绘制调用，序列化而非光栅化）
//
// ═══════════════════════════════════════════════════════════════════════════════
// 模块在 Wison-RBI 架构中的角色
// ═══════════════════════════════════════════════════════════════════════════════
// 本文件是 RecordingCanvas 的完整实现，对应 recording_canvas.h 中声明的所有
// 方法。它是 Wison-RBI Compositor 拦截的核心组件（§4.1.2），负责将 Skia 绘制
// 调用捕获并序列化为 CommandBuffer 中的协议兼容字节序列。
//
// 覆盖范围 (v4 MVP):
//   - 状态管理:   save / restore / saveLayer          (Opcode 0x01-0x0F)
//   - 变换:       concat / translate / scale / rotate / concat44 (0x10-0x1F)
//   - 裁剪:       clipRect / clipRRect / clipPath      (0x20-0x2F)
//   - 形状绘制:   rect / rrect / drrect / oval / arc / path / points (0x30-0x3F)
//   - 图像绘制:   image / imageRect / lattice / atlas / patch /
//                 edgeAAQuad / edgeAAImageSet           (0x40-0x4F)
//   - 文本绘制:   textBlob / glyphRunList              (0x50-0x5F)
//   - 其他绘制:   paint / color / shadow / vertices /
//                 drawable(NOOP) / annotation           (0x60-0x6F)
//   - 非 PictureLayer: SolidColorLayer + ScrollbarLayer (v3 scope)
//
// 排除范围:
//   - ImageFilter / MaskFilter / ColorFilter — v4 暂不支持
//   - 复杂 shader — v4 暂不支持
//   - WebGL / Video — TextureLayer/VideoLayer/SurfaceLayer 降级为 NOOP
//   - 复杂图层类型 — 超出 v3 scope
//
// 在 Chromium 源码树中的挂载点:
//   - 挂载路径: //garnet/recording_canvas.cpp
//   - 编译依赖: command_buffer.h + Skia 头文件
//   - 集成点: FrameAssembler::assembleFrame() 中通过工厂方法 Create() 创建
//
// ═══════════════════════════════════════════════════════════════════════════════
// 安全不变量
// ═══════════════════════════════════════════════════════════════════════════════
//   I-1: 所有公有方法首先检查 recording_ 标志，防止 finalized 后的 use-after-finalize
//   I-2: 图像数据通过 writeImage() 集中处理 — 仅捕获 sk_sp 引用，不编码
//   I-3: Save/Restore 深度跟踪 (save_depth_) — 录制时一致性检查
//   I-4: drawAtlas / drawVertices 子结构上界校验 (kMaxAtlasCount / kMaxVerticesCount)
//

#include "recording_canvas.h"

#include "include/core/SkColorPriv.h"       // SkColorGetR, SkColorGetG, SkColorGetB, SkColorGetA
#include "include/core/SkMatrix.h"         // SkMatrix::operator[]
#include "include/core/SkImage.h"          // SkImage (完整类型)
#include "include/core/SkGlyphRunList.h"   // SkGlyphRunList iteration
#include "include/core/SkRSXform.h"        // SkRSXform::fSCos, fSSin, fTX, fTY
#include "include/core/SkDrawShadowRec.h"  // SkDrawShadowRec full type
#include "include/core/SkSamplingOptions.h"
#include "include/core/SkVertices.h"
#include "include/core/SkTextBlob.h"
#include "include/core/SkPath.h"
#include "include/core/SkRRect.h"
#include "include/core/SkRect.h"
#include "include/core/SkM44.h"
#include "include/core/SkData.h"
#include "include/core/SkBlendMode.h"

#include <cstdio>

namespace garnet {

// ═══════════════════════════════════════════════════════════════
// 工厂方法 + 生命周期
// ═══════════════════════════════════════════════════════════════

/// @brief 工厂方法: 创建 RecordingCanvas 实例。
///
/// Phase 3 实现: 内部创建最小 SkBitmap (1×1, kN32_SkColorType) 作为
/// SkCanvas 的 device，满足 SkCanvas 构造要求但不产生光栅化开销。
std::unique_ptr<RecordingCanvas> RecordingCanvas::Create(
        int width, int height, ImageMode image_mode) {
    SkBitmap device;
    device.allocPixels(SkImageInfo::Make(1, 1,
        kN32_SkColorType, kPremul_SkAlphaType));
    device.eraseColor(SK_ColorTRANSPARENT);

    // SkCanvas 构造函数需要 SkBitmap&（非 const），传递 device
    return std::unique_ptr<RecordingCanvas>(
        new RecordingCanvas(width, height, image_mode, device));
}

/// @brief 私有构造函数。
///
/// 将最小化 device 传递给 SkCanvas 基类，初始化所有成员。
RecordingCanvas::RecordingCanvas(int width, int height,
                                 ImageMode image_mode,
                                 const SkBitmap& device)
    : SkCanvas(device)
    , buffer_(image_mode)
    , width_(width)
    , height_(height)
    , image_mode_(image_mode)
    , recording_(true)
    , finalized_(false)
    , save_depth_(0) {}

/// @brief 完成录制，返回填充完毕的 CommandBuffer。
CommandBuffer RecordingCanvas::finalize() {
    // FIX-H5: verify save/restore balance
    if (save_depth_ != 0) {
        fprintf(stderr, "[RecordingCanvas] WARNING: finalize() with save_depth_=%d "
                "(unbalanced save/restore)\n", save_depth_);
    }
    recording_ = false;
    finalized_ = true;  // FIX-C2: prevent use-after-move via commandBuffer()
    return std::move(buffer_);
}

// ═══════════════════════════════════════════════════════════════
// 状态管理 — Opcode 0x01-0x0F
// ═══════════════════════════════════════════════════════════════

int RecordingCanvas::save() {
    safeCommand(Opcode::kSave, [&]() {
        save_depth_++;
    });
    return save_depth_;  // Return save count as SkCanvas API requires
}

void RecordingCanvas::restore() {
    safeCommand(Opcode::kRestore, [&]() {
        save_depth_--;
    });
}

int RecordingCanvas::saveLayer(const SkRect* bounds, const SkPaint* paint) {
    // Protocol: bounds_presence(1B) + [bounds(16B)] + paint_presence(1B) + [paint(N)]
    // When presence=0, the field is omitted entirely (no zero-fill).
    safeCommand(Opcode::kSaveLayer, [&]() {
        save_depth_++;
        // bounds presence byte + conditional rect (omitted when absent)
        buffer_.writeU8(bounds ? 1 : 0);
        if (bounds) {
            buffer_.writeRect(*bounds);
        }
        // paint presence byte + conditional paint (omitted when absent)
        buffer_.writeU8(paint ? 1 : 0);
        if (paint) {
            buffer_.writePaint(*paint);
        }
    });
    return save_depth_;
}

// ═══════════════════════════════════════════════════════════════
// 变换 — Opcode 0x10-0x1F
// ═══════════════════════════════════════════════════════════════

void RecordingCanvas::concat(const SkMatrix& matrix) {
    safeCommand(Opcode::kConcat, [&]() {
        // SkMatrix 9 个 f32 值，行主序 (SkMatrix::operator[] 或 SkMatrix::get9)
        // 直接通过 operator[] 按 row-major 索引写入
        for (int i = 0; i < 9; ++i) {
            buffer_.writeF32(matrix[i]);
        }
    });
}

void RecordingCanvas::translate(SkScalar dx, SkScalar dy) {
    safeCommand(Opcode::kTranslate, [&]() {
        buffer_.writeF32(dx);
        buffer_.writeF32(dy);
    });
}

void RecordingCanvas::scale(SkScalar sx, SkScalar sy) {
    safeCommand(Opcode::kScale, [&]() {
        buffer_.writeF32(sx);
        buffer_.writeF32(sy);
    });
}

void RecordingCanvas::rotate(SkScalar radians) {
    safeCommand(Opcode::kRotate, [&]() {
        buffer_.writeF32(radians);
    });
}

void RecordingCanvas::concat44(const SkM44& matrix) {
    safeCommand(Opcode::kConcat44, [&]() {
        buffer_.writeM44(matrix);
    });
}

// ═══════════════════════════════════════════════════════════════
// 裁剪 — Opcode 0x20-0x2F
// ═══════════════════════════════════════════════════════════════

void RecordingCanvas::clipRect(const SkRect& rect, SkClipOp op, bool doAA) {
    safeCommand(Opcode::kClipRect, [&]() {
        buffer_.writeRect(rect);
        buffer_.writeU8(op == SkClipOp::kIntersect ? 0 : 1);
        buffer_.writeU8(doAA ? 1 : 0);
    });
}

void RecordingCanvas::clipRRect(const SkRRect& rrect, SkClipOp op, bool doAA) {
    safeCommand(Opcode::kClipRRect, [&]() {
        buffer_.writeRRect(rrect);
        buffer_.writeU8(op == SkClipOp::kIntersect ? 0 : 1);
        buffer_.writeU8(doAA ? 1 : 0);
    });
}

void RecordingCanvas::clipPath(const SkPath& path, SkClipOp op, bool doAA) {
    // FIX: 与 drawPath 一致的边界检查，防止 writePath 静默跳过导致协议错位
    if (static_cast<uint32_t>(path.countVerbs()) > kMaxPathVerbs ||
        static_cast<uint32_t>(path.countPoints()) > kMaxPathPoints) {
        fprintf(stderr, "[RecordingCanvas] clipPath: verbCount=%d or pointCount=%d "
                "exceeds limits (verbs=%u, points=%u), emitting NOOP\n",
                path.countVerbs(), path.countPoints(), kMaxPathVerbs, kMaxPathPoints);
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    safeCommand(Opcode::kClipPath, [&]() {
        buffer_.writePath(path);
        buffer_.writeU8(op == SkClipOp::kIntersect ? 0 : 1);
        buffer_.writeU8(doAA ? 1 : 0);
    });
}

// ═══════════════════════════════════════════════════════════════
// 形状绘制 — Opcode 0x30-0x3F
// ═══════════════════════════════════════════════════════════════

void RecordingCanvas::drawRect(const SkRect& rect, const SkPaint& paint) {
    safeCommand(Opcode::kDrawRect, [&]() {
        buffer_.writeRect(rect);
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawRRect(const SkRRect& rrect, const SkPaint& paint) {
    safeCommand(Opcode::kDrawRRect, [&]() {
        buffer_.writeRRect(rrect);
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawDRRect(const SkRRect& outer, const SkRRect& inner,
                                  const SkPaint& paint) {
    safeCommand(Opcode::kDrawDRRect, [&]() {
        buffer_.writeRRect(outer);
        buffer_.writeRRect(inner);
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawOval(const SkRect& oval, const SkPaint& paint) {
    safeCommand(Opcode::kDrawOval, [&]() {
        buffer_.writeRect(oval);
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawArc(const SkRect& oval, SkScalar startAngle,
                               SkScalar sweepAngle, bool useCenter,
                               const SkPaint& paint) {
    safeCommand(Opcode::kDrawArc, [&]() {
        buffer_.writeRect(oval);
        buffer_.writeF32(startAngle);
        buffer_.writeF32(sweepAngle);
        buffer_.writeU8(useCenter ? 1 : 0);
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawPath(const SkPath& path, const SkPaint& paint) {
    // FIX-H3: early bounds check on verb/point count
    if (static_cast<uint32_t>(path.countVerbs()) > kMaxPathVerbs ||
        static_cast<uint32_t>(path.countPoints()) > kMaxPathPoints) {
        fprintf(stderr, "[RecordingCanvas] drawPath: verbCount=%d or pointCount=%d "
                "exceeds limits (verbs=%u, points=%u)\n",
                path.countVerbs(), path.countPoints(), kMaxPathVerbs, kMaxPathPoints);
        return;
    }
    safeCommand(Opcode::kDrawPath, [&]() {
        buffer_.writePath(path);
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawPoints(SkCanvas::PointMode mode, size_t count,
                                  const SkPoint pts[], const SkPaint& paint) {
    // FIX-C1: null check on pts before iterating
    if (count > 0 && pts == nullptr) {
        fprintf(stderr, "[RecordingCanvas] drawPoints: count=%zu but pts is null, "
                "emitting NOOP\n", count);
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    // FIX-H3: bounds check on count
    if (count > kMaxPointsCount) {
        fprintf(stderr, "[RecordingCanvas] drawPoints: count=%zu exceeds "
                "kMaxPointsCount=%u\n", count, kMaxPointsCount);
        return;
    }
    safeCommand(Opcode::kDrawPoints, [&]() {
        // 编码 PointMode: 0=Points, 1=Lines, 2=Polygon
        uint8_t mode_byte = 0;
        switch (mode) {
            case SkCanvas::kPoints_PointMode:  mode_byte = 0; break;
            case SkCanvas::kLines_PointMode:   mode_byte = 1; break;
            case SkCanvas::kPolygon_PointMode: mode_byte = 2; break;
            default:                           mode_byte = 0; break;
        }
        buffer_.writeU8(mode_byte);
        buffer_.writeU32(static_cast<uint32_t>(count));
        for (size_t i = 0; i < count; ++i) {
            buffer_.writePoint(pts[i]);
        }
        buffer_.writePaint(paint);
    });
}

// ═══════════════════════════════════════════════════════════════
// 图像绘制 — Opcode 0x40-0x4F
// ═══════════════════════════════════════════════════════════════

void RecordingCanvas::drawImage(const SkImage* image,
                                 SkScalar left, SkScalar top,
                                 const SkSamplingOptions& sampling,
                                 const SkPaint* paint) {
    // FIX-R9a: null image check
    if (image == nullptr) {
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    safeCommand(Opcode::kDrawImage, [&]() {
        buffer_.writeImage(image);
        buffer_.writeF32(left);
        buffer_.writeF32(top);
        buffer_.writeSamplingOptions(sampling);
        buffer_.writeU8(paint ? 1 : 0);
        if (paint) {
            buffer_.writePaint(*paint);
        }
    });
}

void RecordingCanvas::drawImageRect(const SkImage* image,
                                     const SkRect& src, const SkRect& dst,
                                     const SkSamplingOptions& sampling,
                                     const SkPaint* paint,
                                     SrcRectConstraint constraint) {
    // FIX-R9a: null image check
    if (image == nullptr) {
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    safeCommand(Opcode::kDrawImageRect, [&]() {
        buffer_.writeImage(image);
        buffer_.writeRect(src);
        buffer_.writeRect(dst);
        buffer_.writeSamplingOptions(sampling);
        buffer_.writeU8(paint ? 1 : 0);
        if (paint) {
            buffer_.writePaint(*paint);
        }
        buffer_.writeU8(static_cast<uint8_t>(constraint));
    });
}

void RecordingCanvas::drawImageLattice(const SkImage* image,
                                        const SkCanvas::Lattice& lattice,
                                        const SkRect& dst, SkFilterMode filter,
                                        const SkPaint* paint) {
    // FIX-R9a: null image check
    if (image == nullptr) {
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    // FIX-R8a: lattice count bounds check
    if (lattice.fXCount < 0 || lattice.fYCount < 0 ||
        static_cast<uint32_t>(lattice.fXCount) > kMaxLatticeCount ||
        static_cast<uint32_t>(lattice.fYCount) > kMaxLatticeCount) {
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    safeCommand(Opcode::kDrawImageLattice, [&]() {
        buffer_.writeImage(image);
        // 简化 lattice 序列化: 写入 x/y 分区计数 + bounds 标志
        buffer_.writeU32(static_cast<uint32_t>(lattice.fXCount));
        buffer_.writeU32(static_cast<uint32_t>(lattice.fYCount));
        // fBounds 是指向 SkIRect* 的指针，写入其存在性标志
        buffer_.writeU8(lattice.fBounds ? 1 : 0);
        if (lattice.fBounds) {
            // 写入 bounds 矩形 (4×i32)
            buffer_.writeI32(lattice.fBounds->fLeft);
            buffer_.writeI32(lattice.fBounds->fTop);
            buffer_.writeI32(lattice.fBounds->fRight);
            buffer_.writeI32(lattice.fBounds->fBottom);
        }
        // 写入分区数组数据 (fXDivs + fYDivs)
        if (lattice.fXDivs && lattice.fXCount > 0) {
            for (int i = 0; i < lattice.fXCount; ++i) {
                buffer_.writeI32(lattice.fXDivs[i]);
            }
        }
        if (lattice.fYDivs && lattice.fYCount > 0) {
            for (int i = 0; i < lattice.fYCount; ++i) {
                buffer_.writeI32(lattice.fYDivs[i]);
            }
        }
        buffer_.writeRect(dst);
        buffer_.writeU8(static_cast<uint8_t>(filter));
        buffer_.writeU8(paint ? 1 : 0);
        if (paint) {
            buffer_.writePaint(*paint);
        }
    });
}

void RecordingCanvas::drawAtlas(const SkImage* atlas,
                                 const SkRSXform xform[],
                                 const SkRect tex[],
                                 const SkColor colors[],
                                 int count, SkBlendMode mode,
                                 const SkSamplingOptions& sampling,
                                 const SkRect* cullRect,
                                 const SkPaint* paint) {
    // FIX-R9a: null atlas check
    if (atlas == nullptr) {
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    // FIX-H1: early negative count check (prevents wrap to large uint32)
    // FIX: 与 null 检查一致，写入 NOOP 保持 SAVE/RESTORE 平衡
    if (count < 0) {
        fprintf(stderr, "[RecordingCanvas] drawAtlas: negative count=%d, emitting NOOP\n", count);
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }

    // 边界检查: count ≤ kMaxAtlasCount (100,000)
    // FIX: 与 null 检查一致，写入 NOOP 保持 SAVE/RESTORE 平衡
    if (static_cast<uint32_t>(count) > kMaxAtlasCount) {
        fprintf(stderr, "[RecordingCanvas] drawAtlas: count=%d exceeds kMaxAtlasCount=%u, emitting NOOP\n",
                count, kMaxAtlasCount);
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }

    // FIX-C1: null check on xform and tex before iterating
    if (count > 0 && (xform == nullptr || tex == nullptr)) {
        fprintf(stderr, "[RecordingCanvas] drawAtlas: count=%d but xform=%p tex=%p, "
                "emitting NOOP\n", count, static_cast<const void*>(xform),
                static_cast<const void*>(tex));
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }

    safeCommand(Opcode::kDrawAtlas, [&]() {
        buffer_.writeImage(atlas);
        buffer_.writeU32(static_cast<uint32_t>(count));

        for (int i = 0; i < count; ++i) {
            // 序列化 RSXform: 4×f32
            buffer_.writeF32(xform[i].fSCos);
            buffer_.writeF32(xform[i].fSSin);
            buffer_.writeF32(xform[i].fTx);
            buffer_.writeF32(xform[i].fTy);
            // 序列化纹理矩形
            buffer_.writeRect(tex[i]);
            // 序列化颜色: SkColor (ARGB uint32) → 4×f32 rgba
            if (colors) {
                SkColor c = colors[i];
                buffer_.writeF32(SkColorGetR(c) / 255.0f);
                buffer_.writeF32(SkColorGetG(c) / 255.0f);
                buffer_.writeF32(SkColorGetB(c) / 255.0f);
                buffer_.writeF32(SkColorGetA(c) / 255.0f);
            } else {
                // 透明色 (rgba = 0,0,0,0)
                buffer_.writeF32(0.0f);  // r
                buffer_.writeF32(0.0f);  // g
                buffer_.writeF32(0.0f);  // b
                buffer_.writeF32(0.0f);  // a
            }
        }

        buffer_.writeU8(static_cast<uint8_t>(mode));
        buffer_.writeSamplingOptions(sampling);
        buffer_.writeU8(cullRect ? 1 : 0);
        if (cullRect) {
            buffer_.writeRect(*cullRect);
        }
        buffer_.writeU8(paint ? 1 : 0);
        if (paint) {
            buffer_.writePaint(*paint);
        }
    });
}

void RecordingCanvas::drawPatch(const SkPoint cubics[12],
                                 const SkColor colors[4],
                                 const SkPoint texCoords[4],
                                 SkBlendMode mode,
                                 const SkPaint& paint) {
    // FIX-C1: null check on cubics, colors, texCoords before iterating
    if (cubics == nullptr || colors == nullptr || texCoords == nullptr) {
        fprintf(stderr, "[RecordingCanvas] drawPatch: null pointer(s) cubics=%p colors=%p "
                "texCoords=%p, emitting NOOP\n",
                static_cast<const void*>(cubics), static_cast<const void*>(colors),
                static_cast<const void*>(texCoords));
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }

    safeCommand(Opcode::kDrawPatch, [&]() {
        // 12 个控制点
        for (int i = 0; i < 12; ++i) {
            buffer_.writePoint(cubics[i]);
        }
        // 4 个颜色 (SkColor → SkColor4f)
        for (int i = 0; i < 4; ++i) {
            SkColor c = colors[i];
            buffer_.writeF32(SkColorGetR(c) / 255.0f);
            buffer_.writeF32(SkColorGetG(c) / 255.0f);
            buffer_.writeF32(SkColorGetB(c) / 255.0f);
            buffer_.writeF32(SkColorGetA(c) / 255.0f);
        }
        // 4 个纹理坐标
        for (int i = 0; i < 4; ++i) {
            buffer_.writePoint(texCoords[i]);
        }

        buffer_.writeU8(static_cast<uint8_t>(mode));
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawEdgeAAQuad(const SkRect& rect,
                                      const SkPoint clip[4],
                                      SkCanvas::QuadAAFlags aaFlags,
                                      const SkColor4f& color,
                                      SkBlendMode mode) {
    // FIX-C1: null check on clip before looping 4 points
    if (clip == nullptr) {
        fprintf(stderr, "[RecordingCanvas] drawEdgeAAQuad: clip is null, emitting NOOP\n");
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }

    safeCommand(Opcode::kDrawEdgeAAQuad, [&]() {
        buffer_.writeRect(rect);
        for (int i = 0; i < 4; ++i) {
            buffer_.writePoint(clip[i]);
        }
        buffer_.writeU32(static_cast<uint32_t>(aaFlags));
        buffer_.writeColor4f(color);
        buffer_.writeU8(static_cast<uint8_t>(mode));
    });
}

void RecordingCanvas::drawEdgeAAImageSet(
        const SkCanvas::ImageSetEntry set[], int count,
        const SkPoint dstClips[],
        const SkMatrix preViewMatrices[],
        const SkSamplingOptions& sampling,
        const SkPaint* paint,
        SrcRectConstraint constraint) {
    // FIX-C1: null check on set before iterating
    if (count > 0 && set == nullptr) {
        fprintf(stderr, "[RecordingCanvas] drawEdgeAAImageSet: count=%d but set is null, "
                "emitting NOOP\n", count);
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }

    // count upper bound check
    if (static_cast<uint32_t>(count) > kMaxImageSetCount) {
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }

    safeCommand(Opcode::kDrawEdgeAAImageSet, [&]() {
        buffer_.writeU32(static_cast<uint32_t>(count));

        for (int i = 0; i < count; ++i) {
            buffer_.writeImage(set[i].fImage.get());
            buffer_.writeRect(set[i].fSrcRect);
            buffer_.writeRect(set[i].fDstRect);
            buffer_.writeF32(set[i].fAlpha);
            buffer_.writeU32(static_cast<uint32_t>(set[i].fAAFlags));
        }

        // 可选的 dstClips: 每个条目 4 个点 = 4×2×f32
        buffer_.writeU8(dstClips ? 1 : 0);
        if (dstClips) {
            for (int i = 0; i < count; ++i) {
                for (int j = 0; j < 4; ++j) {
                    buffer_.writePoint(dstClips[i * 4 + j]);
                }
            }
        }

        // 可选的 preViewMatrices: 每个条目 9×f32 (row-major)
        buffer_.writeU8(preViewMatrices ? 1 : 0);
        if (preViewMatrices) {
            for (int i = 0; i < count; ++i) {
                for (int j = 0; j < 9; ++j) {
                    buffer_.writeF32(preViewMatrices[i][j]);
                }
            }
        }

        buffer_.writeSamplingOptions(sampling);
        buffer_.writeU8(paint ? 1 : 0);
        if (paint) {
            buffer_.writePaint(*paint);
        }
        buffer_.writeU8(static_cast<uint8_t>(constraint));
    });
}

// ═══════════════════════════════════════════════════════════════
// 文本绘制 — Opcode 0x50-0x5F
// ═══════════════════════════════════════════════════════════════

void RecordingCanvas::drawTextBlob(const SkTextBlob* blob,
                                    SkScalar x, SkScalar y,
                                    const SkPaint& paint) {
    // FIX-C1: null check on blob
    if (blob == nullptr) {
        fprintf(stderr, "[RecordingCanvas] drawTextBlob: blob is null, emitting NOOP\n");
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }

    // FIX: 与 drawGlyphRunList 一致的边界检查，防止 writeTextBlob 静默跳过导致协议错位
    // writeTextBlob 内部有 totalGlyphs > kMaxTextBlobGlyphs 的早返回，
    // 但此时 opcode 已写入 buffer，会导致客户端反序列化错位
    {
        uint32_t totalGlyphs = 0;
        SkTextBlob::Iter iter(*blob);
        SkTextBlob::Iter::Run run;
        while (iter.next(&run)) {
            totalGlyphs += static_cast<uint32_t>(run.fGlyphCount);
        }
        if (totalGlyphs > kMaxTextBlobGlyphs) {
            fprintf(stderr, "[RecordingCanvas] drawTextBlob: totalGlyphs=%u exceeds limit %u, emitting NOOP\n",
                    totalGlyphs, kMaxTextBlobGlyphs);
            safeCommand(Opcode::kNoop, [&]() {});
            return;
        }
    }

    // FIX-H6: TODO — font_id is always 0 (default system font).
    // A proper font registry with unique font_id assignment should be implemented.
    safeCommand(Opcode::kDrawTextBlob, [&]() {
        buffer_.writeF32(x);
        buffer_.writeF32(y);
        buffer_.writeTextBlob(blob);
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawGlyphRunList(const SkGlyphRunList& glyphRunList,
                                        const SkPaint& paint) {
    // Bounds check: run count ≤ kMaxGlyphRuns, total glyph count ≤ kMaxTextBlobGlyphs
    if (static_cast<uint32_t>(glyphRunList.size()) > kMaxGlyphRuns) {
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    // Pre-check total glyph count to prevent OOM
    uint32_t totalGlyphs = 0;
    for (auto it = glyphRunList.begin(); it != glyphRunList.end(); ++it) {
        totalGlyphs += static_cast<uint32_t>((*it).fGlyphCount);
    }
    if (totalGlyphs > kMaxTextBlobGlyphs) {
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    safeCommand(Opcode::kDrawGlyphRunList, [&]() {
        buffer_.writeU32(static_cast<uint32_t>(glyphRunList.size()));

        // 通过 begin()/end() 迭代器遍历每个 glyph run
        for (auto it = glyphRunList.begin(); it != glyphRunList.end(); ++it) {
            const auto& run = *it;

            // FIX-H6: TODO — font_id is always 0, meaning default system font.
            // A proper font registry should be integrated to assign unique font IDs,
            // with font data transmitted via kFontData opcode for inline transfer.
            // Currently the font is implicitly resolved by the client.
            uint32_t font_id = 0;
            // 注: SkGlyphRun::fFont 在不同 Skia 版本中字段名/类型可能不同，
            //     此处写入占位 ID，实际字体通过 kFontData opcode 内联传输
            buffer_.writeU32(font_id);

            // glyph 数量
            // 防御: 如果 fGlyphs 或 fPositions 为空，将 glyph_count 设为 0，
            // 避免写入非零 count 但缺少 glyph/position 数据导致协议反序列化错位
            uint32_t glyph_count = (run.fGlyphs && run.fPositions)
                ? static_cast<uint32_t>(run.fGlyphCount)
                : 0;
            buffer_.writeU32(glyph_count);

            // glyph 索引 (uint16_t[])
            if (run.fGlyphs && glyph_count > 0) {
                for (uint32_t gi = 0; gi < glyph_count; ++gi) {
                    buffer_.writeU16(run.fGlyphs[gi]);
                }
            }

            // 位置 (f32 × 2)
            if (run.fPositions && glyph_count > 0) {
                for (uint32_t pi = 0; pi < glyph_count; ++pi) {
                    buffer_.writeF32(run.fPositions[pi].fX);
                    buffer_.writeF32(run.fPositions[pi].fY);
                }
            }
        }

        buffer_.writePaint(paint);
    });
}

// ═══════════════════════════════════════════════════════════════
// 其他绘制 — Opcode 0x60-0x6F
// ═══════════════════════════════════════════════════════════════

void RecordingCanvas::drawPaint(const SkPaint& paint) {
    safeCommand(Opcode::kDrawPaint, [&]() {
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawColor(SkColor4f color, SkBlendMode mode) {
    safeCommand(Opcode::kDrawColor, [&]() {
        buffer_.writeColor4f(color);
        buffer_.writeU8(static_cast<uint8_t>(mode));
    });
}

void RecordingCanvas::drawShadow(const SkPath& path,
                                  const SkDrawShadowRec& rec) {
    safeCommand(Opcode::kDrawShadow, [&]() {
        buffer_.writePath(path);
        buffer_.writeShadowRec(rec);
    });
}

void RecordingCanvas::drawVertices(const SkVertices* vertices,
                                    SkBlendMode mode,
                                    const SkPaint& paint) {
    // FIX-R9b: null vertices check
    if (vertices == nullptr) {
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }
    // 边界检查: vertexCount ≤ kMaxVerticesCount (100,000)
    // FIX: 与 null 检查一致，超大 vertices 也写入 NOOP，保持 SAVE/RESTORE 平衡
    int vc = vertices->vertexCount();
    if (vc < 0 || static_cast<uint32_t>(vc) > kMaxVerticesCount) {
        fprintf(stderr, "[RecordingCanvas] drawVertices: vertexCount=%d exceeds kMaxVerticesCount=%u, emitting NOOP\n",
                vc, kMaxVerticesCount);
        safeCommand(Opcode::kNoop, [&]() {});
        return;
    }

    safeCommand(Opcode::kDrawVerticesObject, [&]() {
        buffer_.writeVertices(vertices);
        buffer_.writeU8(static_cast<uint8_t>(mode));
        buffer_.writePaint(paint);
    });
}

void RecordingCanvas::drawDrawable(SkDrawable* /*drawable*/,
                                    const SkMatrix* /*matrix*/) {
    // SkDrawable 不可序列化 — 降级为 NOOP (0x7F)
    fprintf(stderr, "[RecordingCanvas] drawDrawable: SkDrawable is not serializable, emitting NOOP\n");
    safeCommand(Opcode::kNoop, [&]() {
        // no payload
    });
}

void RecordingCanvas::drawAnnotation(const SkRect& rect, const char key[],
                                      SkData* value) {
    safeCommand(Opcode::kDrawAnnotation, [&]() {
        buffer_.writeRect(rect);
        // 写入 key 字符串 (长度前缀 + UTF-8)
        if (key) {
            buffer_.writeString(std::string(key));
        } else {
            buffer_.writeU32(0);  // 空字符串
        }
        // 写入 value blob
        if (value && value->size() > 0) {
            buffer_.writeU32(static_cast<uint32_t>(value->size()));
            buffer_.writeBlob(value->data(), value->size());
        } else {
            buffer_.writeU32(0);
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// 非 PictureLayer 图层采集 — v3 scope
// ═══════════════════════════════════════════════════════════════

void RecordingCanvas::recordSolidColorLayer(const SkColor4f& color,
                                             const SkRect& bounds) {
    // 通过 drawColor + clipRect 的模式序列化纯色图层
    // 先 clipRect 再 drawColor，确保颜色仅影响图层边界内
    safeCommand(Opcode::kClipRect, [&]() {
        buffer_.writeRect(bounds);
        buffer_.writeU8(0);  // SkClipOp::kIntersect
        buffer_.writeU8(0);  // doAA = false
    });

    safeCommand(Opcode::kDrawColor, [&]() {
        buffer_.writeColor4f(color);
        buffer_.writeU8(static_cast<uint8_t>(SkBlendMode::kSrcOver));
    });
}

void RecordingCanvas::recordTextureLayer(uint32_t /*texture_id*/,
                                          const SkRect& /*bounds*/,
                                          const SkRect& /*uv_rect*/) {
    // v3 排除: GPU 纹理无法序列化，降级为 NOOP
    fprintf(stderr, "[RecordingCanvas] recordTextureLayer: GPU textures not supported in v3, emitting NOOP\n");
    safeCommand(Opcode::kNoop, [&]() {
        // no payload
    });
}

void RecordingCanvas::recordVideoLayer(uint32_t /*video_frame_id*/,
           const SkRect& /*bounds*/) {
    // v3 排除: 视频帧通过媒体通道独立传输，此处序列化为 NOOP
    fprintf(stderr, "[RecordingCanvas] recordVideoLayer: video layers not supported in v3, emitting NOOP\n");
    safeCommand(Opcode::kNoop, [&]() {
        // no payload
    });
}

void RecordingCanvas::recordSurfaceLayer(uint32_t /*surface_id*/,
                                          const SkRect& /*bounds*/) {
    // v3 排除: 跨进程合成表面无法在此层级捕获
    fprintf(stderr, "[RecordingCanvas] recordSurfaceLayer: surface layers not supported in v3, emitting NOOP\n");
    safeCommand(Opcode::kNoop, [&]() {
        // no payload
    });
}

void RecordingCanvas::recordScrollbarLayer(bool vertical, float position,
                                            float thumb_size,
                                            const SkRect& bounds) {
    // 使用专用 kDrawScrollbar opcode，避免与 kDrawRect 的 Paint 负载冲突
    // 负载格式: rect(16B) + vertical(1B) + position(f32) + thumb_size(f32) = 25B
    safeCommand(Opcode::kDrawScrollbar, [&]() {
        buffer_.writeRect(bounds);
        buffer_.writeU8(vertical ? 1 : 0);
        buffer_.writeF32(position);
        buffer_.writeF32(thumb_size);
    });
}

}  // namespace garnet
