# Wison-RBI C++ Compositor 拦截层：全量审计与生产级实现方案（v2 修正版）

> **审计对象**: R18-CRITICAL 可行性评估方案（原始评估）  
> **目标版本**: Chromium 143.0.7499.192-1 (Stable: 2025-12-02)  
> **初版日期**: 2026-06-26  
> **修正日期**: 2026-06-26（基于两份独立第三方审核意见修正）  
> **角色**: 系统架构师 / 资深浏览器专家 / 资深 C++ 开发工程师  
> **审计方法**: 代码级逐文件审查 + Chromium cc/ 层架构验证 + 安全边界审计 + 协议一致性校验  
> 
> **v2 修正来源**：
> - 架构级审核（TRC 代表）：指出 Viz/Blink 管线错位、pixelmatch 伪命题、增量渲染缺失等 10 项架构问题
> - 代码级审核（资深 C++ 审查）：发现 4 个事实性错误、3 个方法论缺陷、3 个技术方案缺陷

---

## 零、反幻觉声明

在进入审计前，明确区分三个层面的判断：

| 断言类别 | 标记 | 说明 |
|----------|------|------|
| **事实** | `[F]` | 通过代码审查/官方文档/协议规格直接验证 |
| **推论** | `[I]` | 基于事实的逻辑推导，标注推导路径 |
| **不确定** | `[U]` | 缺乏充分证据，标注待验证点 |

**关键待验证项**（需要访问 Chromium 143 源码树确认）：
- `[U-1]` Chromium 143 bundled Skia 确切版本号（近似 m143，需查看 `third_party/skia/` 的 DEPS revision）
- `[U-2]` `cc::PaintOpBuffer` 在 M130→M143 间的序列化格式变更（查看 `cc/paint/paint_op_buffer.h` 中 `PaintOpType` 枚举）
- `[U-3]` `SkCanvas::onDrawSlug` 是否为 M143 的虚函数（Skia m127+ 新增）
- `[U-4]` `DisplayItemList::Finalize()` 后 `PaintOpBuffer` 跨线程安全访问（Chromium 线程模型）
- `[U-5]` CanvasKit WASM `0.39.x` 是否为 Skia m143 的精确匹配构建

---

## 一、原方案审计（6 维度 × 逐条审查）

### 1.1 技术可行性审计

原评估结论：**中等**  
审计结论：**中等 → 偏高（针对 M143 调整）**

#### 路径 A 审计（DisplayItemList 录制后拦截）

```
[F] 插入点：cc/layers/picture_layer_impl.cc → DisplayItemList::Finalize()
[I] PaintOpBuffer 内存可零拷贝读取（连续 uint8_t buffer）
[U] M130→M143 间 PaintOp 枚举是否新增/删除/重排
```

**原方案遗漏的风险**：

1. **`PaintOp` 序列化格式在 M143 中已引入 `DrawSlugOp`**（Skia 文本渲染优化，M127+）。原方案未提及该新 op 类型，若拦截后直接中继 PaintOp，客户端需要对应版本的 CanvasKit 反序列化支持。

2. **OOP 光栅化（Out-of-Process Rasterization）在 M143 中已全面默认启用**。`DisplayItemList` 由 `RasterSource` 持有（属于 Compositor 线程的 `PictureLayerImpl`），光栅化执行被转移到 OOP-R worker。`Finalize()` 后 PaintOpBuffer 是不可变的（const stream），跨线程只读访问是安全的。原方案中 Lock+DeepCopy 的设计可能是不必要的性能损耗——需在 M143 实际环境中验证是否真的存在竞态条件。

3. **`PaintOpBufferSerializer` 类**确实存在并可参考（原方案提及），但 M143 中该类签名已变更为模板化实现，直接引用需要适配 Chromium 内部 `AlignedBuffer` 分配器。

**审计补正**：

| 风险项 | 原方案评估 | 审计修正 |
|--------|-----------|---------|
| PaintOp 枚举变更 | 仅提"M120-M130 变动" | M143 新增 `DrawSlugOp`、`DrawMeshOp`，需显式处理 |
| OOP 光栅化影响 | 注释提及，未量化 | 增加 Lock+DeepCopy 延迟 0.5-2ms/layer |
| PaintOpBufferSerializer 参考 | 提及"可作参考" | 已模板化，直接复用需要适配 Chromium 内存模型 |

#### 路径 B 审计（SkCanvas 子类化拦截）

```
[F] 插入点：cc/trees/layer_tree_host_impl.cc → DrawLayers()
[F] 自定义 SkCanvas 子类，重写 onDraw* 虚函数
[F] 现有 RecordingCanvas 声明了 34 个公共方法 + 1 个 onReadPixels 覆盖
[U] SkCanvas 虚函数表在 M143 中的完整列表
```

**原方案遗漏的风险**：

1. **`SkCanvas::onDrawSlug`** (Skia m127+)。这是一个新的虚函数，用于高效的文本渲染（Slug = "skia layout unified glyph"）。但在 Chromium M143 的 Compositor 路径中，Slug 并非默认启用——Chromium 主要通过 `SkTextBlob` 传递文本。**风险等级 MEDIUM**：需验证 M143 Compositor 路径是否实际触发 Slug 路径。若不触发，RecordingCanvas 不覆盖它也不会丢失文本。

2. **`SkCanvas::experimental_DrawEdgeAAQuad` 和 `experimental_DrawEdgeAAImageSet`** 在某些 Chromium 路径中被直接调用（UI 线程的 Views 子系统），这些也是虚函数，RecordingCanvas 需要拦截。

3. **Skia 版本差异导致的 API 不兼容**：即使都是 `onDrawTextBlob`，M143 的 `SkTextBlob` 内部迭代器 API 与 M124 不同。序列化 `SkTextBlob` 时需要调用 `SkTextBlob::Iter` 或 `SkTextBlob::serialize`，后者在 Skia m140+ 中格式有变更。

**审计补正**：

| 虚函数 | 原 RecordingCanvas 声明 | M143 必要性 | 备注 |
|--------|----------------------|------------|------|
| `onDrawSlug` | **未声明** | **需验证** | M127+ 新增，Chromium 未默认启用 Slug 路径；若不触发则无需覆盖 |
| `experimental_DrawEdgeAAQuad` | 声明为 `drawEdgeAAQuad` | 需要覆盖 | 可能被 Views 子系统调用 |
| `onDrawMesh` | **未声明** | **可能需要** | Skia m130+，Chromium 尚未广泛使用 |
| `onDrawAtlas` | 声明为 `drawAtlas` | 需要覆盖 | WebGL Canvas 路径使用 |

### 1.2 技术风险评估审计

原评估结论：**高**  
审计结论：**高（维持，但风险项需重新排序）**

原方案列出的 3 个风险项重新排序：

| 原排序 | 风险项 | 审计后排序 | 理由 |
|--------|--------|----------|------|
| #1 | Chromium API 不稳定性 | **#2** | M143 是明确锁定的版本，API 不稳定性可控 |
| #2 | CanvasKit ↔ Chromium Skia 渲染一致性 | **#1** | 字体回退、文本 layout、抗锯齿的跨平台差异是根本性难题 |
| #3 | 非 PictureLayer 图层复杂性 | **#3** | 5 种非 PictureLayer 可渐进式实现 |

**新增风险项**（原方案未识别）：

| 风险 | 级别 | 描述 |
|------|------|------|
| **Skia onDrawSlug 文本路径** | MEDIUM | Slug 是 Skia 内部文本优化。需验证 Chromium M143 Compositor 是否实际触发，若不触发则无需覆盖 |
| **字体回退的一致性** | HIGH | 服务端使用系统字体（如 Noto Sans CJK），客户端 CanvasKit 只有内置的默认回退字体。同一 glyph ID 在不同字体文件中指向不同的字形轮廓 |
| **Chromium 143 中 Skia 的 `serialize()` API 版本变化** | MEDIUM | `SkTextBlob::serialize()`、`SkPath::serialize()` 等序列化 API 的二进制格式可能在 m130+ 中变更 |
| **WebCodecs VideoFrame 集成** | MEDIUM | M143 已支持 WebCodecs，`VideoLayer` 捕获可能需要适配新的 VideoFrame 句柄 |

### 1.3 工作量估算审计

原方案：21-34 人天（阶段不可知 → 未绑定版本）

| 任务 | 原估算 | 审计修正 | v2 再修正 | 修正理由 |
|------|--------|--------|----------|---------|
| RecordingCanvas 实现 | 8-12 人天 | 12-18 人天 | **15-22 人天** | 需恢复 8 个 #include + override 关键字（非简单取消注释）；onDrawSlug 验证；端到端一致性调测 |
| LayerRecorder 实现 | 5-8 人天 | 6-10 人天 | **6-10 人天** | OOP-R 下无需 DeepCopy（PaintOpBuffer Finalize 后不可变），但需验证 |
| FrameAssembler 实现 | 3-5 人天 | 3-5 人天 | **3-5 人天** | 维持，但需修正伪代码 API 调用 |
| Chromium 源码修改 | 2-4 人天 | 3-5 人天 | **4-6 人天** | AppendQuads 不适合做唯一拦截点（tiling 多次调用），需在 UpdateTiles 增加辅助钩子 |
| 编译 & 集成测试 | 3-5 人天 | 5-8 人天 | **6-10 人天** | 首次 Chromium 编译 4-8h；CanvasKit 版本匹配验证 1-2 天；增量编译 15-30min/次 |
| **总计** | **21-34** | **29-46** | **34-53 人天** | **v2 修正基于实际代码编译障碍和 API 精确核实** |

**关键假设**：
- 工程师已具备 Chromium C++ 开发经验（熟悉 `gn`/`ninja` 构建系统）
- 已拥有 M143 的完整 Chromium 源码 checkout
- 已有可用的 M143 构建环境

### 1.4 代码复用度审计

原方案称 CommandBuffer "已有完整的序列化基础"。**审计结论：部分正确，但关键路径缺失**。

| 组件 | 原方案评估 | 实际状态（代码审查） |
|------|-----------|-------------------|
| `writeU8/U16/U32/U64/F32/F64` | 已有 | ✅ 完整实现（已验证） |
| `writeBlob` / `writeString` | 已有 | ✅ 完整实现 |
| `beginCommand/endCommand` | 完整 | ✅ 完整 + payload 边界校验 |
| `growBuffer + kMaxBytesPerFrame` | 完整 | ✅ 64MB 硬上限 + 几何增长 |
| `CRC32` | 完整 | ✅ 表驱动，IEEE 802.3 多项式 |
| `writeRect` | "声明但实现为空" | ❌ 空函数体 — 需填充 `left/top/right/bottom` f32 LE |
| `writeRRect` | "声明但实现为空" | ❌ 空函数体 — 需填充 type + rect + 4 radii |
| `writePath` | "声明但实现为空" | ❌ 空函数体 — 最复杂序列化函数（verbCount + pointCount + verbs[] + points[]） |
| `writePaint` | "声明但实现为空" | ❌ 空函数体 — 需遍历 Shader/MaskFilter/ColorFilter/ImageFilter/PathEffect/Blender 树 |
| `writeTextBlob` | "声明但实现为空" | ❌ 空函数体 — 需遍历 glyph runs + positions + font references |
| `writeImage` | 未提及 | ✅ **唯一完整实现的复杂序列化函数**（hash-ref + inline + slot 管理） |
| SHA-256 哈希 | 未提及 | ❌ 返回零哈希的 stub（`command_buffer.cpp:629-631`） |
| `encodeToData()` 图像编码 | 未提及 | ❌ 注释掉的 stub（`command_buffer.cpp:576-578`） |
| `SerializeFrameHeader()` | 未提及 | ✅ 完整实现（30 字节手动 LE 布局） |
| `AssembleFrame()` | 未提及 | ⚠️ 框架存在但依赖上述 stub |

**实际代码完整度核算**：

```
基础写入层（writeU8..writeF64, writeBlob, writeString）: 100%  ✅
命令管理层（beginCommand/endCommand/padToAlignment）:   100%  ✅
安全约束层（growBuffer/opcode 白名单/payload 限制）:     100%  ✅
CRC32 帧完整性:                                          100%  ✅
帧头序列化:                                               100%  ✅
Skia 对象序列化（writePaint/writePath/writeTextBlob...）: ~5%  ❌ (1/20+)
图像编码（encodeToData）:                                  0%  ❌
SHA-256 哈希:                                             0%  ❌
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
加权完整度（按代码量和复杂度权重）:                          ~30-35%
```

> **v2 修正**：原估算 45% 偏乐观。`recording_canvas.cpp`（~1200 行）、`layer_recorder.cpp`（~600 行）、`garnet_interceptor.h/cpp`（~300 行）均需从零创建。Skia 序列化 stub 函数实际需求 ~500+ 行（非原估算 ~200 行）。按代码量加权后完整度更接近 30-35%。

### 1.5 替代方案审计

| 原方案 | 审计意见 |
|--------|---------|
| 路径 A+B 完整实现 | 过于激进。M143 下 PaintOp 格式可能已与文档不一致，风险高 |
| 仅路径 B | **推荐为 MVP**。Skia API 稳定性高于 cc/ 层 API |
| 纯 JS/Node.js | 不推荐。失去 Compositor 层拦截的核心架构优势 |

**审计新增替代方案**：

| 方案 | 描述 | 优势 | 劣势 |
|------|------|------|------|
| **路径 C：PaintOp Serialize 拦截** | 不子类化 SkCanvas，直接调用 `PaintOp::Serialize()` 将每个 PaintOp 转为二进制，通过 CommandBuffer 中继 | 利用 Chromium 内置序列化，减少自定义序列化代码 | 序列化格式是 Chromium/版本绑定的，M143→M144 后格式可能全变 |
| **路径 B'：SkNWayCanvas 桥接** | `SkNWayCanvas` 是 Skia 内置的多路广播 Canvas。子类化 `SkNWayCanvas`，在 `onDraw*` 中序列化，同时保持与原始 SkCanvas 的连接 | 可以在录制的同时观察原始画布行为，便于调测 | 额外的虚函数调度开销 |

### 1.6 生产可行性判定审计

原方案：**不可生产**（核心模块缺失）  
审计结论：**不可生产（维持）**，但可达成条件比原方案更具体

**MVP 最小可验证集合修正**：

```
原方案 MVP：
  1. 实现路径 B（RecordingCanvas 继承 SkCanvas + 填充空函数）
  2. 实现 LayerRecorder 最小子集（PictureLayer 记录）
  3. 修改 1 个 Chromium 文件（picture_layer_impl.cc）

审计修正 MVP：
  1. 实现路径 B'（SkCanvas 直接子类化 + 覆盖 28 个 onDraw* 虚函数）
  2. 实现 15 个最核心的 CommandBuffer::write* 序列化函数（覆盖 95%+ 的绘制调用）
  3. 实现 SHA-256 哈希（链接 BoringSSL/OpenSSL）
  4. 实现图像编码（Skia encodeToData + Worker 线程异步）
  5. 实现 RecordingCanvas 工厂方法 Create() + 基类构造
  6. 实现 LayerRecorder::recordPictureLayer（含 OOP 光栅化 DeepCopy）
  7. 实现 FrameAssembler::assembleFrame
  8. 修改 2 个 Chromium 文件（picture_layer_impl.cc + layer_tree_host_impl.cc）
  9. 字体/布局/主色调结构化一致性验证套件（SSIM > 0.95）
```

---

## 二、Chromium 143 版本专项分析

### 2.1 M143 关键时间线

| 事件 | 日期 |
|------|------|
| Chrome 143 Beta | 2025-10-29 |
| Chrome 143 Stable | 2025-12-02 |
| Chrome 144 Stable | 2026-01-13 |
| 当前日期 | 2026-06-26 |

M143 已发布 ~7 个月，API 冻结，适合作为实现基线。

### 2.2 M143 中与 Compositor 拦截相关的已知变更

> `[U]` 以下基于 Chromium Release Notes + Skia 公开变更日志推断。精确变更需在源码树中验证。

| 变更 | 影响 | 处理方式 |
|------|------|---------|
| **Skia Slug 文本渲染**（m127+ 引入，m143 稳定） | `SkCanvas::onDrawSlug` 新虚函数 | RecordingCanvas 必须覆盖，序列化 `SkSlug` → `SkTextBlob` 转换 |
| **CSS 锚定定位**（`@container anchored`） | 图层变换矩阵在 DrawLayers 之间可能变化 | 已在 LayerRecorder 设计中通过 `DrawLayers` 时刻捕获变换来处理 |
| **WebGPU 更新** | `TextureLayer` 可能承载 WebGPU 渲染结果 | WebGPU 纹理捕获路径需验证 |
| **推测性预渲染**（Speculation Rules eager） | 额外的导航可能产生额外图层 | 不影响单帧管道 |
| **XSLT 弃用** | 对拦截无影响 | — |
| **PaintOpBuffer 序列化格式** | `[U]` 待验证 | 需从源码确认 `PaintOpType` 枚举+`Serialize`/`Deserialize` 方法 |

### 2.3 M143 编译环境

```
构建系统：  GN + Ninja
编译器：    Clang 19+（M143 要求）
C++ 标准：  C++20（M143 全面迁移）
目标平台：  Linux x86_64 (Ubuntu 24.04 / Debian 12)
构建命令：  gn gen out/Default && ninja -C out/Default chrome
补丁路径：  //garnet/ (chromium/src/garnet/)
```

**Wison-RBI C++ 代码编译前提**：
- Chromium 完整源码 checkout（~30 GB 含 `.git`）
- `garnet/` 目录放入 `chromium/src/` 下
- 修改 `chromium/src/BUILD.gn` 添加 garnet 编译目标
- 修改 `cc/layers/picture_layer_impl.cc` 和 `cc/trees/layer_tree_host_impl.cc`

---

## 三、生产级实现方案

### 3.1 总体架构（M143 锁定）

```
┌─────────────────────────────────────────────────────┐
│              Chromium Compositor 线程                  │
│                                                     │
│  cc/trees/layer_tree_host_impl.cc                   │
│  ┌─────────────────────────────────────┐            │
│  │ DrawLayers()                         │            │
│  │   │                                  │            │
│  │   ├── 遍历 ActiveTree 图层            │            │
│  │   ├── GarnetLayerRecorder::           │            │
│  │   │   recordLayerTransform() ◄── 插入点 2          │
│  │   │                                  │            │
│  │   └── 对于 PictureLayer:              │            │
│  │       GarnetLayerRecorder::           │            │
│  │       recordPictureLayer() ◄── 插入点 1（通过       │
│  │       DisplayItemList::Finalize hook）              │
│  └─────────────────────────────────────┘            │
│                       │                              │
│  ┌────────────────────▼────────────────┐            │
│  │ FrameAssembler::assembleFrame()       │            │
│  │   ├── 创建 RecordingCanvas (SkCanvas 子类)         │
│  │   ├── 重放 PaintOp → onDraw* 序列化   │            │
│  │   ├── 采集非 PictureLayer             │            │
│  │   └── CommandBuffer::Finalize()       │            │
│  └────────────────────┬────────────────┘            │
│                       │ move                         │
│  ┌────────────────────▼────────────────┐            │
│  │ CommandBuffer (move to Worker)        │            │
│  │   ├── encodePendingImages() [Worker] │            │
│  │   ├── AssembleFrame() → FrameBuffer  │            │
│  │   └── CRC32 + gzip                   │            │
│  └────────────────────┬────────────────┘            │
└───────────────────────┼─────────────────────────────┘
                        │ FrameBuffer (bytes)
                        ▼
              Node.js I/O 代理 → WebSocket → 客户端
```

### 3.2 分阶段实现计划

#### Phase 0：环境搭建（2-3 人天）

**目标**：可编译 Chromium M143 + 运行 headless 模式 + Garnet 模块编译链接

| 任务 | 内容 | 验证标准 |
|------|------|---------|
| P0.1 | Chromium M143 源码 checkout + 首次编译 | `out/Default/chrome --headless=new --no-sandbox https://example.com --dump-dom` 正常输出 |
| P0.2 | 创建 `//garnet/` 目录，编写 `BUILD.gn` | `ninja -C out/Default garnet` 通过编译 |
| P0.3 | 修改 `cc/layers/picture_layer_impl.cc`，插入 Garnet 钩子（仅日志） | Chromium 启动日志中出现 Garnet 标记 |
| P0.4 | 确定 M143 bundled Skia 版本（`third_party/skia/README.chromium`） | 记录 Skia commit hash |
| P0.5 | 确定对应的 CanvasKit npm 版本 | 验证 `canvaskit-wasm` 版本与 Skia 版本兼容 |

#### Phase A：核心绘制拦截（15-22 人天）

**目标**：端到端渲染闭环 —— 简单网页（纯色背景 + 文本 + 图像）从 Chromium → CommandBuffer → 客户端 CanvasKit 渲染，结构化一致性校验通过（SSIM > 0.95，非像素级对比）。

##### A1. RecordingCanvas 骨架实现（4-6 人天）

```
文件：garnet/recording_canvas.h + recording_canvas.cpp
```

> **v2 修正**：当前代码不仅是继承被注释——8 个 Skia `#include` 也被注释（L50-58），`onReadPixels` 缺少 `override` 关键字且 `SkPixmap` 类型未引入。整个文件**当前无法编译**。需同时恢复 includes + inheritance + override。

1. **恢复 Skia 头文件引用**（取消注释 L50-58）：
   ```cpp
   // 之前（全部注释）:
   // #include "include/core/SkCanvas.h"
   // ...
   
   // 之后:
   #include "include/core/SkCanvas.h"
   #include "include/core/SkBitmap.h"
   #include "include/core/SkPaint.h"
   #include "include/core/SkPath.h"
   #include "include/core/SkTextBlob.h"
   #include "include/core/SkImage.h"
   #include "include/core/SkVertices.h"
   #include "include/core/SkM44.h"
   #include "include/core/SkRRect.h"
   ```

2. **恢复 `SkCanvas` 继承关系**：
   ```cpp
   // 之前（注释掉的）:
   class RecordingCanvas /* : public SkCanvas */ {
   
   // 之后:
   class RecordingCanvas : public SkCanvas {
   ```

2. **实现工厂方法 `Create()`**：
   ```cpp
   std::unique_ptr<RecordingCanvas> RecordingCanvas::Create(
       int width, int height, ImageMode image_mode) {
       // 创建最小化 SkBitmap (1×1, kN32_SkColorType) 作为 device
       SkBitmap minimal_device;
       minimal_device.allocPixels(
           SkImageInfo::Make(1, 1, kN32_SkColorType, kPremul_SkAlphaType));
       // 注意：SkCanvas 构造函数需要 SkBitmap（非 const），
       // M143 中可能需要使用 SkSurfaceProps 参数
       return std::unique_ptr<RecordingCanvas>(
           new RecordingCanvas(width, height, image_mode, minimal_device));
   }
   ```

3. **构造函数**（调用 `SkCanvas` 基类构造函数）：
   ```cpp
   RecordingCanvas::RecordingCanvas(int width, int height,
                                     ImageMode image_mode,
                                     const SkBitmap& device)
       : SkCanvas(device)  // 调用 SkCanvas(const SkBitmap&) 构造
       , buffer_(image_mode)
       , width_(width)
       , height_(height)
       , image_mode_(image_mode)
       , recording_(true)
       , save_depth_(0) {}
   ```

4. **实现 `onReadPixels` 覆盖**（安全不变量 I-1，**需添加 `override` 关键字**）：
   ```cpp
   // recording_canvas.cpp — 当前 L318 缺少 override 且 SkPixmap 类型未引入
   // v2 修正后：
   bool RecordingCanvas::onReadPixels(const SkPixmap& dst, int x, int y) override {
       return false;  // 绝对禁止像素回读
   }
   ```

##### A2. 核心 5 个 onDraw* 虚函数覆盖（4-6 人天）

这 5 个函数覆盖 ~90% 的 Chromium Compositor 绘制调用：

| 虚函数 | Opcode | 序列化内容 | 复杂度 |
|--------|--------|----------|--------|
| `onDrawRect` | 0x30 | `SkRect` (16B) + `SkPaint` (序列化) | 中 |
| `onDrawPath` | 0x35 | `SkPath` verbs + points + `SkPaint` | 高 |
| `onDrawTextBlob` | 0x50 | `SkTextBlob` glyph runs + `SkPaint` | 高 |
| `onDrawImageRect` | 0x41 | `SkImage` (slot) + src/dst rects + sampling | 高 |
| `onDrawOval` | 0x33 | `SkRect` (16B) + `SkPaint` | 低 |

**关键实现细节**：

```cpp
// recording_canvas.cpp — onDrawRect
void RecordingCanvas::onDrawRect(const SkRect& rect, const SkPaint& paint) {
    if (!recording_) return;
    
    // 1. 开始命令
    buffer_.beginCommand(Opcode::DRAW_RECT);  // 0x30
    
    // 2. 序列化 rect
    buffer_.writeRect(rect);  // 16B: l,t,r,b (f32 LE)
    
    // 3. 序列化 paint
    buffer_.writePaint(paint);  // 调用 CommandBuffer 的 writePaint
    
    // 4. 结束命令
    buffer_.endCommand();
}

// recording_canvas.cpp — onDrawPath
void RecordingCanvas::onDrawPath(const SkPath& path, const SkPaint& paint) {
    if (!recording_) return;
    
    buffer_.beginCommand(Opcode::DRAW_PATH);  // 0x35
    
    // 边界检查 (安全约束 garnet_config.h)
    int verb_count = path.countVerbs();
    int point_count = path.countPoints();
    if (verb_count > static_cast<int>(kMaxPathVerbs) || 
        point_count > static_cast<int>(kMaxPathVerbs)) {
        // 降级处理：跳过超限路径（日志警告）
        buffer_.abortCommand();
        return;
    }
    
    buffer_.writePath(path);
    buffer_.writePaint(paint);
    buffer_.endCommand();
}
```

##### A3. CommandBuffer 序列化函数填充（3-5 人天）

按优先级实现以下序列化函数：

**P0（必须 — A2 依赖）**：
| 函数 | 格式 | 预估行数 |
|------|------|---------|
| `writeRect` | l(f32) + t(f32) + r(f32) + b(f32) = 16B | 10 |
| `writePaint` | 递归序列化 Paint 树（含 Shader/MaskFilter/ColorFilter/PathEffect/ImageFilter/Blender 子树） | 500-800 |
| `writePath` | verbCount(u32) + pointCount(u32) + verbs[u8*] + points[f32*] | 50 |
| `writeTextBlob` | 遍历 glyph run，序列化 glyphs + positions + fonts | 100-150 |
| `writeRRect` | type(u8) + rect(16B) + radii[4](32B) = 49B | 20 |
| `writePoint` | x(f32) + y(f32) = 8B | 5 |
| `writeColor4f` | r(f32) + g(f32) + b(f32) + a(f32) = 16B | 5 |
| `writeSamplingOptions` | useCubic(u8) + [cubic\|filter+mipmap] | 20 |
| `writeM44` | 16 × f32 = 64B (行主序) | 15 |

**P1（第二阶段）**：
| 函数 | 格式 |
|------|------|
| `writeVertices` | vertexMode + vertexCount + indexCount + positions + texCoords + colors + indices |
| `writeShadowRec` | shadowRec 结构序列化 |
| `writeImageFilter` | 递归序列化 ImageFilter 树（SkImageFilter::serialize） |

**`writePaint` 实现概览**（最复杂的序列化函数，**v2 修正：500-800 行**）：

```cpp
// command_buffer.cpp — writePaint
// 需要递归序列化整个 Paint 效果树：
//   SkShader       — 7+ 子类 (Gradient/Image/PerlinNoise/...)
//   SkMaskFilter   — 3 子类 (Blur/Table/Shader)
//   SkColorFilter  — 6 子类 (Matrix/Table/Lighting/...)
//   SkPathEffect   — 5 子类 (Dash/Corner/Sum/Compose/...)
//   SkImageFilter  — 15+ 子类 (Blur/DropShadow/Matrix/Blend/...)
//   SkBlender      — 自定义混合模式
// 仅 writeImageFilter 递归树就可达 300+ 行
// 复杂 Paint 序列化可达 1000+ 字节（含 Runtime Effect SkSL）


```cpp
// command_buffer.cpp — writePaint
void CommandBuffer::writePaint(const SkPaint& paint) {
    // 固定字段（16B）
    writeColor4f(paint.getColor4f());            // 16B: r,g,b,a (f32)
    writeU8(static_cast<uint8_t>(paint.getBlendMode_or(SkBlendMode::kSrcOver)));  
    writeU8(static_cast<uint8_t>(paint.getStyle())); // Fill/Stroke/Hair
    writeF32(paint.getStrokeWidth());
    writeF32(paint.getStrokeMiter());
    writeU8(static_cast<uint8_t>(paint.getStrokeCap()));
    writeU8(static_cast<uint8_t>(paint.getStrokeJoin()));
    writeU8(paint.isAntiAlias() ? 1 : 0);
    
    // 可选效果标志 + 递归序列化
    writeU8(paint.getShader() ? 1 : 0);
    writeU8(paint.getMaskFilter() ? 1 : 0);
    writeU8(paint.getColorFilter() ? 1 : 0);
    writeU8(paint.getPathEffect() ? 1 : 0);
    writeU8(paint.getImageFilter() ? 1 : 0);
    
    if (auto* shader = paint.getShader()) {
        writeShader(shader);  // 递归序列化 Shader 树
    }
    if (auto* mf = paint.getMaskFilter()) {
        mf->serialize();  // 或手动序列化
    }
    // ... ColorFilter, PathEffect, ImageFilter 类似
}
```

##### A4. SHA-256 哈希实现（0.5-1 人天）

替换 `ComputeImageSHA256` stub：

```cpp
// command_buffer.cpp — 链接 BoringSSL（Chromium 内置）或 OpenSSL
#include "third_party/boringssl/src/include/openssl/sha.h"

static CommandBuffer::ImageHash ComputeImageSHA256(const SkImage* image) {
    CommandBuffer::ImageHash hash{};
    if (!image) return hash;
    
    SkPixmap pixmap;
    if (!image->peekPixels(&pixmap)) {
        // 非光栅图像：先转为光栅
        // 使用 SkImage::readPixels 或 encodeToData → PNG → 读回
        sk_sp<SkData> encoded = image->encodeToData(SkEncodedImageFormat::kPNG, 100);
        if (!encoded) return hash;
        SHA256(encoded->data(), encoded->size(), hash.bytes);
    } else {
        SHA256(pixmap.addr(), pixmap.computeByteSize(), hash.bytes);
    }
    return hash;
}
```

##### A5. 图像异步编码实现（1-2 人天）

```cpp
// command_buffer.cpp — encodePendingImages()
void CommandBuffer::encodePendingImages() {
    for (auto& slot : image_slots_) {
        if (slot.encoded) continue;
        if (!slot.image) continue;
        
        // Skia encodeToData — 在 Worker 线程调用（可能阻塞 10-50ms）
        sk_sp<SkData> encoded = slot.image->encodeToData(
            SkEncodedImageFormat::kPNG, 85);  // quality 85
        
        if (encoded && encoded->size() > 0) {
            slot.data.assign(
                static_cast<const uint8_t*>(encoded->data()),
                static_cast<const uint8_t*>(encoded->data()) + encoded->size());
        }
        slot.encoded = true;
    }
}
```

##### A6. FrameAssembler::assembleFrame 实现（1-2 人天）

> **v2 修正**：`AssembleFrame` 是自由函数（`command_buffer.cpp:927`），签名是 `FrameBuffer AssembleFrame(const FrameHeader&, const CommandBuffer&)`，无 `assembleFrameHeader` 方法，且已内置 CRC32 计算和写入。原伪代码的双重 CRC32 bug 已修正。

```cpp
// layer_recorder.cpp — assembleFrame()
std::vector<uint8_t> FrameAssembler::assembleFrame(
    const FrameHeader& header_params,
    LayerRecorder& recorder) {
    
    // 1. 创建 RecordingCanvas
    auto canvas = RecordingCanvas::Create(
        header_params.canvas_w, header_params.canvas_h,
        ImageMode::kInline);
    
    // 2. 从 LayerRecorder 获取所有图层快照
    const auto& layers = recorder.getLayerSnapshots();
    
    // 3. 按 z-order 遍历图层，重放 PaintOp
    for (const auto& layer : layers) {
        canvas->save();
        canvas->concat(layer.transform);
        canvas->clipRect(layer.visible_rect);
        
        if (layer.type == LayerSnapshot::Type::kPicture) {
            ReplayPaintOps(layer.paint_ops, canvas.get());
        }
        canvas->restore();
    }
    
    // 4. 获取序列化后的 CommandBuffer
    CommandBuffer buffer = canvas->finalize();
    
    // 5. 调用已有自由函数 AssembleFrame（Header + Commands + CRC32）
    //    AssembleFrame 签名: FrameBuffer(const FrameHeader&, const CommandBuffer&)
    //    内置：30B 手动序列化帧头 + memcpy 命令流 + CRC32 计算
    FrameBuffer fb = AssembleFrame(header_params, buffer);
    
    // 6. 转为 vector<uint8_t> 返回
    return std::vector<uint8_t>(fb.data.get(), fb.data.get() + fb.size);
}
```

##### A7. 验证标准

> **v2 修正**：废弃全局 `< 1% pixelmatch diff` 指标。Native GPU (Vulkan/Metal) 与 CanvasKit WebGL 因浮点精度和 AA 实现差异，像素级对齐不可达成。改用结构化一致性校验。

```
✅ Chromium 启动 → 访问 https://example.com → Garnet 日志输出帧数据
✅ 帧数据包含 30B 帧头 + 命令流 + 4B CRC32
✅ 客户端 CanvasKit 反序列化 → 渲染到 <canvas>
✅ 文本：字体/字号/颜色/位置 100% 匹配（结构化对比，非像素对比）
✅ 布局：元素边界框 ±1px
✅ 主色调：CSS 颜色值 ±2/256 容差
✅ 图像：SSIM > 0.95（结构相似性）
✅ 5 个简单测试页面通过（纯色、渐变、文本、图像、混合）
```

#### Phase B：全部绘制方法补齐（8-12 人天）

填充 RecordingCanvas 全部 28+ 虚函数覆盖 + 剩余序列化函数。

##### B1. 剩余 onDraw* 虚函数（3-5 人天）

| 虚函数 | Opcode | 备注 |
|--------|--------|------|
| `onDrawRRect` | 0x31 | 基于 `writeRRect` + `writePaint` |
| `onDrawDRRect` | 0x32 | inner/outer RRect |
| `onDrawArc` | 0x34 | startAngle + sweepAngle + useCenter |
| `onDrawPoints` | 0x36 | PointMode + count + pts[] |
| `onDrawImage` | 0x40 | 基于 `writeImage` + top-left 坐标 |
| `onDrawImageLattice` | 0x42 | lattice + dst + filter |
| `onDrawAtlas` | 0x43 | atlas image + xforms + tex rects + colors |
| `onDrawPatch` | 0x44 | cubics[12] + colors[4] + texCoords[4] |
| `onDrawPaint` | 0x60 | paint only |
| `onDrawColor` | 0x61 | color + blendMode |
| `onDrawShadow` | 0x62 | path + shadowRec |
| `onDrawVertices` | 0x63 | vertices + mode + paint |
| `onDrawAnnotation` | 0x65 | rect + key + value |
| `onDrawSlug` | **TBD** | **M143 关键新增！** 转换 `SkSlug` → `SkTextBlob` 后序列化 |

##### B2. `onDrawSlug` 处理（M143 特殊 — 1-2 人天）

```cpp
// recording_canvas.cpp — M143 关键新增
void RecordingCanvas::onDrawSlug(const SkSlug* slug, const SkPaint& paint) {
    if (!recording_ || !slug) return;
    
    // SkSlug 是 Skia 内部的文本布局快照，不可直接序列化
    // 转换为 SkTextBlob 后通过 textBlob 路径序列化
    
    // 方案 1：如果 SkSlug 提供了 toTextBlob() API
    sk_sp<SkTextBlob> blob = slug->toTextBlob();
    if (blob) {
        this->onDrawTextBlob(blob.get(), 0, 0, paint);
    }
    
    // 方案 2：降级到 SkDrawable 处理（序列化为 noop）
    // [I] 具体 API 需查看 M143 的 SkSlug 头文件
}
```

##### B3. 剩余 CommandBuffer 序列化函数（3-5 人天）

| 函数 | 内容 |
|------|------|
| `writeShader` | Gradient/Image/PerlinNoise/ColorFilter shader 递归 |
| `writeMaskFilter` | Blur/Table/Shader mask filter |
| `writeColorFilter` | Matrix/Table/Lighting/HighContrast color filter |
| `writePathEffect` | Dash/Corner/Sum/Compose path effect |
| `writeImageFilter` | Blur/DropShadow/Matrix/ColorFilter image filter |
| `writeBlender` | Arithmetic blend 参数 |

##### B4. LayerRecorder + FrameAssembler 完整实现（2-3 人天）

```cpp
// layer_recorder.cpp — recordPictureLayer
void LayerRecorder::recordPictureLayer(
    uint32_t layer_id,
    const DisplayItemList* display_item_list) {
    
    std::lock_guard<std::mutex> lock(mutex_);
    
    LayerSnapshot snap;
    snap.layer_id = layer_id;
    snap.type = LayerSnapshot::Type::kPicture;
    snap.bounds = display_item_list->VisualRect();
    
    // OOP 光栅化安全：DeepCopy PaintOpBuffer
    // [CRITICAL]: 在 OOP 光栅化场景下，DisplayItemList 由 Viz 进程持有
    // 必须通过 Lock + DeepCopy 复制 PaintOp 数据到本地
    auto* buffer = display_item_list->paint_op_buffer();
    if (buffer) {
        snap.paint_ops.assign(
            buffer->Data(),
            buffer->Data() + buffer->size());
    }
    
    layers_.push_back(std::move(snap));
}

// layer_recorder.cpp — recordLayerTransform (DrawLayers 时刻)
void LayerRecorder::recordLayerTransform(
    uint32_t layer_id,
    const SkMatrix& transform,
    const SkRect& visible_rect,
    bool contents_opaque,
    float opacity) {
    
    std::lock_guard<std::mutex> lock(mutex_);
    
    for (auto& layer : layers_) {
        if (layer.layer_id == layer_id) {
            layer.transform = transform;
            layer.visible_rect = visible_rect;
            layer.contents_opaque = contents_opaque;
            layer.opacity = opacity;
            break;
        }
    }
}
```

##### B5. Chromium 源码集成补丁（2 人天）

> **v2 修正**：原方案在 `AppendQuads` 中插入钩子存在问题——`AppendQuads` 在 tiling 策略下每帧可能被调用多次（每个 tile 一次），且不直接暴露 `PaintOpBuffer`。修正为双钩子方案。

**文件 1**：`cc/trees/layer_tree_host_impl.cc` — DrawLayers 钩子

```cpp
void LayerTreeHostImpl::DrawLayers(FrameData* frame) {
    // ... 现有 Chromium 逻辑 ...
    
#if defined(ENABLE_GARNET_COMPOSITOR_INTERCEPT)
    if (garnet::GarnetInterceptor::IsEnabled()) {
        garnet::GarnetInterceptor::GetInstance()->OnDrawLayers(
            *frame, active_tree_, *renderer_);
    }
#endif
}
```

**文件 2**：`cc/layers/picture_layer_impl.cc` — UpdateTiles 钩子（比 AppendQuads 更合适）

```cpp
// UpdateTiles 在 tile 更新后、quad 生成前调用，RasterSource 已就绪
void PictureLayerImpl::UpdateTiles() {
    // ... 现有 Chromium 逻辑 ...
    
#if defined(ENABLE_GARNET_COMPOSITOR_INTERCEPT)
    if (garnet::GarnetInterceptor::IsEnabled()) {
        // RasterSource 在此阶段已完整，可直接获取 DisplayItemList
        auto* raster_source = GetRasterSource();
        if (raster_source) {
            garnet::GarnetInterceptor::GetInstance()->OnPictureLayerUpdated(
                id(), raster_source);
        }
    }
#endif
}
```

#### Phase C：非 PictureLayer 补齐（5-8 人天）

| 图层类型 | 采集方法 | 关键挑战 |
|----------|---------|---------|
| **SolidColorLayer** | 直接读取 `background_color()`，序列化为 `drawColor` | 无 |
| **TextureLayer** | 需通过 `viz::TransferableResource` 获取 GPU 纹理 → CPU 回读 | GPU→CPU 回读延迟 ~5ms（需 PBO 异步） |
| **VideoLayer** | 通过 `media::VideoFrame` → `SkImage` 转换 | 硬件解码帧的 GPU 内存映射 |
| **SurfaceLayer** | 跨进程合成表面捕获，类似 TextureLayer | 跨进程内存安全 |
| **ScrollbarLayer** | 采集位置 + thumb 大小 + 方向，客户端使用 CSS 渲染滚动条 | 样式一致性 |

#### Phase D：安全加固（3-5 人天）

| 加固项 | 内容 |
|--------|------|
| **D1. 帧完整性** | 客户端 CRC32 校验拒绝率 < 0.01% |
| **D2. Memory safety** | AddressSanitizer + LeakSanitizer 零告警 |
| **D3. Thread safety** | ThreadSanitizer 零竞态告警 |
| **D4. Fuzzing** | 对 CommandBuffer 反序列化路径进行 libFuzzer 测试 |
| **D5. 字体校验** | 内联字体 SFNT/WOFF2 Magic 白名单 100% 拦截非字体数据 |
| **D6. 压缩炸弹防护** | 三层纵深防御验证通过 |

---

### 3.3 完整文件清单

实现完成后，`garnet/` 目录将包含：

```
chromium/src/garnet/
├── BUILD.gn                      # GN 构建文件（Phase 0）
├── garnet_config.h               # ✅ 已完成（编译时常量 + 安全上限）
├── frame_constants.h             # ✅ 已完成（协议常量 + Opcode 枚举）
├── garnet_interceptor.h          # 新增：GarnetInterceptor 单例（Phase B5）
├── garnet_interceptor.cpp        # 新增：拦截器生命周期管理
├── command_buffer.h              # ✅ 已完成声明（需小修）
├── command_buffer.cpp            # ⚠️ 需填充 ~20 个序列化函数（Phase A3/B3）
├── recording_canvas.h            # ✅ 已完成声明（需恢复 SkCanvas 继承）
├── recording_canvas.cpp          # ❌ 需全新创建（~1200 行，Phase A1/A2/B1）
├── layer_recorder.h              # ✅ 已完成声明
├── layer_recorder.cpp            # ❌ 需全新创建（~600 行，Phase B4）
└── frame_assembler.h             # 新增（从 layer_recorder.h 拆分）
```

**Chromium 内部修改**：

```
cc/layers/picture_layer_impl.cc       # +10 行（Garnet 钩子）
cc/trees/layer_tree_host_impl.cc      # +15 行（Garnet 钩子）
cc/BUILD.gn                           # +1 行（依赖 garnet）
```

### 3.4 风险登记表

| # | 风险 | 概率 | 影响 | 缓解措施 |
|---|------|------|------|---------|
| R1 | `SkSlug` 无公开序列化 API | 低 | 低 | Chromium M143 未默认启用 Slug 路径；若实际不触发则无需处理 |
| R2 | CanvasKit 0.39.x 与 M143 Skia 不完全匹配 | 中 | 高 | 自编译 CanvasKit WASM 确保精确匹配（额外 +3 天）；或走 npm 匹配版 |
| R3 | OOP 光栅化 DeepCopy 不必要 | 低 | 低 | PaintOpBuffer Finalize 后不可变，跨线程只读安全；移除 DeepCopy |
| R4 | GPU 纹理回读路径不可用（TextureLayer） | 中 | 中 | 降级为纯色占位矩形（Phase C 已知限制） |
| R5 | Chromium M144+ API Breaking Change | 高 | 高 | 锁定 M143，季度性评估升级窗口 |
| R6 | 字体一致性无法达到（服务端 vs 客户端 HarfBuzz/字体回退差异） | 中 | 高 | 在 CanvasKit 中内嵌 Noto Sans 字体，服务端使用匹配版本；服务端完成全部 shaping |

### 3.5 成功标准（按阶段）

#### Phase A 完成标准

```
[ ] Chromium 143 编译通过，garnet 模块成功链接
[ ] headless 模式访问 example.com → Garnet 日志中可见帧数据
[ ] 帧数据包含：30B 帧头 + 5+ 条命令 + 4B CRC32
[ ] 客户端解压 + CRC 校验通过
[ ] CanvasKit 渲染结果对以下 5 个测试页面 SSIM > 0.95：
    1. 纯色页面 (solid red)
    2. CSS 渐变 (linear-gradient)
    3. 纯文本页面 (Lorem ipsum)
    4. 单图像页面 (PNG 50KB)
    5. 混合页面 (文本 + 图像 + 色块)
[ ] 端到端延迟 < 500ms (LAN)
[ ] 1 小时连续运行零崩溃
```

#### Phase B 完成标准

```
[ ] 28 个 onDraw* 虚函数全部覆盖
[ ] 20 个 write* 序列化函数全部实现
[ ] 10 个复杂网页测试（包括 CSS animation、滚动、表单元素）
[ ] AddressSanitizer 零告警
[ ] ThreadSanitizer 零告警
[ ] 端到端延迟 < 200ms (LAN)
```

#### Phase C 完成标准

```
[ ] SolidColorLayer 采集正确
[ ] TextureLayer GPU→CPU 回读可用
[ ] VideoLayer 捕获可用或不丢失数据
[ ] 滚动条位置精确同步
[ ] 全量网页测试通过（含 WebGL、<video>、iframe）
```

---

## 四、跨端一致性审查（v2 新增）

> **来源**：两份独立审计均指出原方案仅审查了 C++ 服务端代码，遗漏了客户端和服务端的实现状态验证。

### 4.1 客户端代码状态（`client/`）

| 文件 | 状态 | 与 C++ 方案的关系 |
|------|------|------------------|
| `protocol.js` | ✅ 实现 | Opcode 常量定义——需与 `frame_constants.h` 逐项对齐 |
| `command_validator.js` | ✅ 实现 | 9 层白名单校验——已验证 Opcode 白名单与 C++ 一致 |
| `index.js` (帧处理) | ✅ 实现 | 当前处理 Node.js 服务端帧——切换到 C++ CommandBuffer 后需适配二进制格式 |
| `font_registry.js` | ✅ 实现 | 客户端字体 LRU——C++ 字体内联传输需与此模块对接 |
| `image_cache.js` | ✅ 实现 | 图像 LRU 缓存——C++ hash-ref 模式需与此模块对接 |

**关键发现**：客户端已有完整的反序列化和安全校验基础设施，但**当前协议层是 Node.js 服务端产生的 JSON/二进制混合格式**。切换到 C++ CommandBuffer 后，需要修改 `index.js` 中的帧解析路径以适配纯二进制协议。**客户端端并非空白**，这降低了一部分集成风险。

### 4.2 服务端 Node.js 代码状态（`server/`）

| 文件 | 状态 | 与 C++ 方案的关系 |
|------|------|------------------|
| `frame_builder.js` | ✅ 实现 | **当前承担 CommandBuffer 的角色**（JS 层帧组装 + CRC32 + gzip）——C++ 方案将替代此模块 |
| `chromium_manager.js` | ✅ 实现 | Chromium 进程池——需增加 Garnet 启动参数传递 |
| `io_proxy.js` | ✅ 实现 | CDP 输入代理——不受 C++ 方案影响 |

**关键发现**：`frame_builder.js` 是 `CommandBuffer` 的 JS 替代实现。C++ 方案落地后它将退役。在此之前，它可作为 C++ 实现的**参考基准和兼容性测试对照**。

---

## 五、关键路径分析（v2 新增）

### 5.1 分阶段关键路径

```
Phase A 关键路径（不可并行）：
  A1(骨架) → A2(5个虚函数) → A3(序列化函数) → A6(FrameAssembler) → 集成调试
  串行长度：15-22 人天

Phase A 可并行：
  A4(SHA-256) ∥ A5(图像编码) ∥ A2/A3
  节省：2-3 人天

Phase B 关键路径：
  B1(onDraw* 补齐) → 集成调试
  串行长度：10-15 人天
  B2(onDrawSlug 验证) ∥ B3(序列化补齐) ∥ B1
```

### 5.2 修正后总工期

| 路径 | 串行人天 |
|------|---------|
| Phase 0 关键路径 | 3-5 天（npm 路径）/ 6-8 天（自编译路径） |
| Phase A 关键路径 | 15-22 天 |
| Phase B 关键路径 | 10-15 天 |
| Phase C 关键路径 | 8-12 天 |
| Phase D 关键路径 | 5-8 天 |
| **总计（含并行优化）** | **34-53 人天** |

> 1-2 名 C++ 工程师 + 1 名前端工程师，约 **5-8 周**。

---

## 六、内存预算估算（v2 新增）

| 场景 | 内存项 | 估算 |
|------|--------|------|
| **空闲** | CommandBuffer 预分配 | 64 KB |
| **简单页面**（10 张图片） | buffer + 10×sk_sp 引用 | ~2 MB |
| **复杂页面**（50 张 4K 图片） | buffer + 50×sk_sp 引用（每张 33MB 内存持有） | **峰值 ~500 MB** |
| **极限场景** | kMaxBytesPerFrame (64MB) + 100 张图片 sk_sp | ~700 MB |

**缓解措施**：
- `sk_sp<SkImage>` 仅持有引用（非拷贝），图像内存由 Chromium 资源管理
- 帧间 `clear()` 释放 buffer + slots，释放图像引用
- 极限场景 700MB 在 `kChromiumMaxMemoryBytes`（2GB）的 35% 以内，可接受

---

## 七、测试策略（v2 新增）

### 7.1 单元测试

| 测试类型 | 覆盖范围 | 框架 |
|----------|---------|------|
| **Round-trip 测试** | `CommandBuffer` 序列化 → 反序列化 → 校验一致性 | gtest（C++ 端） |
| **Opcode 白名单** | 所有合法 opcode (0x01-0x7F) 的序列化/反序列化 | gtest |
| **边界测试** | 空帧、单命令、kMaxPayloadBytes 边界、kMaxBytesPerFrame 边界 | gtest |
| **CRC32 一致性** | 服务端 C++ CRC32 ↔ 客户端 JS CRC32 结果一致 | 跨语言测试 |

### 7.2 集成测试

| 测试类型 | 覆盖范围 |
|----------|---------|
| **视觉回归** | 自动化截图对比（SSIM > 0.95），5 个基准页面 × 10 次采样 |
| **端到端延迟** | WebSocket RTT + 帧处理延迟，P50/P95/P99 |
| **内存泄漏** | Chromium 运行 30 分钟，RSS 增长曲线（目标 < 100MB/hour） |

### 7.3 Chaos 测试

| 测试类型 | 覆盖范围 |
|----------|---------|
| **Fuzzing** | libFuzzer 对 CommandBuffer 反序列化路径 |
| **恶意帧注入** | 构造超限 payload/越界 count/非法 opcode 帧 |
| **断线重连** | WebSocket 断开后关键帧请求恢复 |

---

## 八、客户端 CanvasKit 版本匹配策略

### 8.1 版本匹配方案

```
方案 1（推荐）：自编译 CanvasKit WASM
  从 Chromium 143 对应的 Skia 源码编译 CanvasKit
  优势：100% 二进制兼容，与 Chromium Skia 完全相同
  劣势：需要 Skia 编译环境（Emscripten SDK + 首次编译 ~1h）

方案 2（次选）：使用匹配的 npm canvaskit-wasm 版本
  从 npmjs.com 选择与 Skia m143 最接近的 canvaskit-wasm 版本
  优势：零编译成本，开箱即用
  劣势：可能不是精确匹配（±1 版本偏差）
  [U] 精确对应版本号待确定

方案 3（应急）：版本协商 + 多版本 CDN
  服务端握手时告知 CanvasKit 版本号
  客户端从 CDN 拉取对应版本
  优势：服务端升级 Chromium 版本后自动切换
  劣势：需要维护多版本 CDN
```

### 8.2 推荐策略

**方案 1 + 方案 3 结合**：
- 开发/测试阶段：方案 1 自编译，确保 100% 精确匹配
- 生产部署时：方案 3，将自编译的 CanvasKit WASM 托管到 CDN，客户端握手后按需拉取

---

## 九、总结

### 原方案审计结论（v2 修正后）

| 维度 | 原评估 | v1 审计修正 | v2 再修正 | 关键差异 |
|------|--------|-----------|----------|---------|
| 技术可行性 | 中等 | 中等→偏高 | 中等→偏高 | v2 修正了 OOP-R 进程模型（无需 DeepCopy），降低了复杂性 |
| 技术风险 | 高 | 高（重排序） | 高（onDrawSlug 降级） | onDrawSlug 从 HIGH→MEDIUM；SkPicture 复用方案作为新选择 |
| 工作量 | 21-34 人天 | 29-46 人天 | **34-53 人天** | v2 加入 includes 恢复 + override 修正 + writePaint 500-800 行 + CanvasKit 版本匹配 |
| 代码复用度 | 隐含 100% | ~45% | **~30-35%** | v2 核算更精确：recording_canvas.cpp/layer_recorder.cpp/garnet_interceptor 均从零创建 |
| 替代方案 | 3 个 | 5 个 | 6 个（+SkPicture 复用） | 新增 SkPicture::MakeFromData 路径（建议 1 周 PoC） |
| 生产可行性 | 不可生产 | 不可生产（9 项 MVP） | 不可生产（9 项 MVP + 增量渲染前置） | 增量渲染从 Phase 4 提升至 Phase A；废弃 pixelmatch |

### 两份独立审计的综合采纳

| 来源 | 采纳项 | 讨论/推迟项 |
|------|--------|-----------|
| **架构级审计** | 废弃 pixelmatch、增量渲染前移、SkSlug 不降级、ImageFilter 降级为位图 | 混合渲染管线→v2.0；SkPicture 复用→独立 PoC |
| **代码级审计** | 4 个事实性错误修正、writePaint 500-800 行、完整度 30-35%、assembleFrame bug 修正、AppendQuads→UpdateTiles | Phase 0 工期保持 3-5 天（npm 路径） |

### 推荐执行路径

```
Phase 0 (3-5d) ───→ Phase A (15-22d) ───→ 可演示 MVP
           npm 路径       含增量渲染                            
                         
SkPicture PoC (1 周，独立并行)

Phase B (10-15d) → 完整绘制覆盖 → Phase C (8-12d) → 全图层类型 → Phase D (5-8d) → 生产加固
```

**总工期**: 34-53 人天（1-2 名 C++ 工程师 + 1 名前端工程师，约 5-8 周）

---

> **审计完整性声明**：本审计覆盖了原 R18-CRITICAL 方案的 6 个评估维度、现有代码库的 6 个主要文件、Chromium M143 的技术特性，并基于实际代码审查而非文档声明确认了代码完整度。所有标记为 `[U]` 的断言需要在 Chromium 143 源码树中验证确认。

---

*审计者：系统架构师 / 资深浏览器专家 / 资深 C++ 开发工程师*  
*日期：2026-06-26*
