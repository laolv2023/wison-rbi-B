// garnet_standalone.h — 条件编译开关
//
// 控制是否使用 Mock Skia 类型（独立编译/测试）还是真实 Skia 头文件（Chromium 集成）。
//
// 用法:
//   - 独立编译/测试: 定义 GARNET_STANDALONE 宏（默认）
//     → 包含 test_mocks.h，使用 Mock Skia 类型
//   - Chromium 集成: 不定义 GARNET_STANDALONE 宏（定义 GARNET_INTEGRATED）
//     → 包含真实 Skia 头文件，使用 Chromium 源码树中的 Skia
//
// 在 Chromium 源码树中编译时，BUILD.gn 中定义 GARNET_INTEGRATED，
// 自动切换到真实 Skia 头文件。
//
// 在独立编译/测试时，编译命令中添加 -DGARNET_STANDALONE，
// 自动切换到 test_mocks.h。
//
#ifndef GARNET_STANDALONE_SWITCH_H_
#define GARNET_STANDALONE_SWITCH_H_

// 默认: 独立编译模式（使用 Mock Skia）
// 在 Chromium BUILD.gn 中定义 GARNET_INTEGRATED 即可切换到真实 Skia
#ifndef GARNET_STANDALONE
  #ifndef GARNET_INTEGRATED
  #define GARNET_STANDALONE
  #endif
#endif

#ifdef GARNET_STANDALONE
// ── 独立编译模式: 使用 Mock Skia 类型 ──
// test_mocks.h 提供所有需要的 Skia 类型的 Mock 定义
#include "test_mocks.h"
#else
// ── Chromium 集成模式: 使用真实 Skia 头文件 ──
// 包含所有 garnet 模块需要的 Skia 头文件
#include "include/core/SkBlendMode.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkColor.h"
#include "include/core/SkColorPriv.h"
#include "include/core/SkData.h"
#include "include/core/SkDrawShadowRec.h"
#include "include/core/SkGlyphRunList.h"
#include "include/core/SkImage.h"
#include "include/core/SkM44.h"
#include "include/core/SkMatrix.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPath.h"
#include "include/core/SkPathEffect.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkPoint.h"
#include "include/core/SkRRect.h"
#include "include/core/SkRect.h"
#include "include/core/SkRefCnt.h"
#include "include/core/SkRSXform.h"
#include "include/core/SkSamplingOptions.h"
#include "include/core/SkShader.h"
#include "include/core/SkTextBlob.h"
#include "include/core/SkVertices.h"
#include "include/core/SkBitmap.h"
#include "include/core/SkDrawable.h"
#include "include/core/SkRegion.h"
#endif  // GARNET_STANDALONE

#endif  // GARNET_STANDALONE_SWITCH_H_
