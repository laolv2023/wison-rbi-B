# Wison-RBI 全面技术文档

> **版本**: v1.6 (第二轮安全审计修复版, 2026-06-03)
> **状态**: 生产级实现
> **许可**: MIT

---

## 目录

1. [系统概述](#1-系统概述)
2. [项目结构](#2-项目结构)
3. [架构设计](#3-架构设计)
4. [通信协议规范](#4-通信协议规范)
5. [服务端详解](#5-服务端详解)
6. [客户端详解](#6-客户端详解)
7. [安全模型](#7-安全模型)
8. [性能模型](#8-性能模型)
9. [部署运维](#9-部署运维)
10. [C++ Chromium 补丁层](#10-c-chromium-补丁层)
11. [API 参考](#11-api-参考)
12. [配置参考](#12-配置参考)
13. [开发指南](#13-开发指南)

---

## 1. 系统概述

### 1.1 定位

Wison-RBI 是一个 **浏览器隔离（Browser Isolation）** 系统。它通过在 Chromium Compositor 层拦截绘制命令，使客户端浏览器不必执行任何远程 HTML/CSS/JavaScript，仅接收经过安全校验的 Skia 绘制命令。

### 1.2 核心原理

```
传统网络浏览:
  客户端浏览器 ← HTTP → Web 服务器
  ↑ 客户端执行所有 HTML/CSS/JS
  
Wison-RBI:
  客户端 ← WebSocket(二进制帧) ← 服务端 Chromium ← HTTP → Web 服务器
  ↑ 客户端仅执行 Skia 绘制命令（不含 HTML/CSS/JS）
```

### 1.3 与 Cloudflare NVR 的关键区别

| 维度 | Cloudflare NVR | Wison-RBI |
|------|---------------|-----------|
| 拦截层级 | Skia API | Compositor 层 (cc::DisplayItemList/PaintOp) |
| Chromium 修改范围 | ~15 个文件 | 1-2 个文件 + 独立 RecordingCanvas |
| 客户端引擎 | 专有 WASM | CanvasKit WASM (开源标准 Skia) |
| 增量更新 | 未公开 | R-tree 空间索引驱动 |
| 可审计性 | 闭源 | 全链路开源 |

---

## 2. 项目结构

```
wison-rbi-B/
├── cpp/                          # C++ Chromium 补丁层 (7774行)
│   ├── garnet_config.h           # 编译时常量、硬上限定义 (393行)
│   ├── frame_constants.h         # 帧头结构体、opcode 枚举、协议常量 (235行)
│   ├── command_buffer.h          # CommandBuffer 声明 (601行)
│   ├── command_buffer.cpp        # CommandBuffer 实现 (序列化/CRC32, 1530行)
│   ├── recording_canvas.h        # RecordingCanvas 声明 (31个方法, 420行)
│   ├── recording_canvas.cpp      # RecordingCanvas 实现 (896行)
│   ├── layer_recorder.h          # LayerRecorder + FrameAssembler 声明 (321行)
│   ├── layer_recorder.cpp        # LayerRecorder + FrameAssembler 实现 (544行)
│   ├── test_mocks.h              # Mock Skia 类型 (测试用, 1050行)
│   ├── test_runner.cpp           # C++ 测试运行器 (120项集成测试, 1785行)
│   └── TEST_PLAN.md              # C++ 测试方案文档 (226行)
├── server/                       # Node.js 服务端 (4093行)
│   ├── package.json              # v1.6.0, 依赖: ws/uuid/chrome-remote-interface
│   ├── config.js                 # 运行时配置常量 (Object.freeze, 168行)
│   ├── server.js                 # 入口: WebSocket + 会话路由 + 健康检查 (796行)
│   ├── session.js                # 会话管理 + frame_id 计数器 + 帧历史 (385行)
│   ├── io_proxy.js               # CDP 输入代理 (HID→CDP, 566行)
│   ├── chromium_manager.js       # Chromium 进程池管理 + 崩溃恢复 (566行)
│   ├── frame_builder.js          # 帧组装 + CRC32 + gzip + 图像去重 (656行)
│   ├── font_validator.js         # SFNT/WOFF2 Magic 校验 (191行)
│   ├── metrics.js                # 指标收集 + 告警 (counter/gauge/histogram, 396行)
│   └── benchmark.js              # 性能基准测试工具 (369行)
├── client/                       # Chrome 扩展 (MV3) 客户端 (5227行)
│   ├── package.json              # v1.6.0, 依赖: canvaskit-wasm/socket.io-client
│   ├── manifest.json             # MV3 扩展清单 (95行)
│   ├── rules.json                # declarativeNetRequest 规则 (34行)
│   ├── background.js             # Service Worker - 请求拦截 (211行)
│   ├── index.html                # 入口页面 (152行)
│   ├── index.js                  # 主控制器: 帧处理 + HID + CanvasKit (2413行)
│   ├── command_validator.js      # 命令白名单 + 9层深度校验 (870行)
│   ├── protocol.js               # 协议常量 (与C++/server三端一致, 307行)
│   ├── utils.js                  # CRC32, gzip解压, 日志, 背压 (528行)
│   ├── font_registry.js          # 客户端字体 LRU (64MB, Magic校验, 323行)
│   └── image_cache.js            # 图像 LRU 缓存 (64MB, SHA-256去重, 243行)
├── protocol/
│   └── opcodes.md                # Opcode 完整定义 (0x01-0x7F, 含0x73 DRAW_SCROLLBAR)
├── tests/                        # Node.js 测试套件 (200+ 用例, 2747行)
│   ├── index.test.mjs            # 单元+集成测试 (340行)
│   ├── advanced.test.mjs         # 协议层/会话/集成测试 (1519行)
│   ├── extended.test.mjs         # 补充集成测试 (420行)
│   └── fuzz.test.mjs             # 对抗性 Fuzzing 测试 (468行)
├── docs/
│   └── Wison-RBI-技术文档.md      # 本文档 (v1.6)
├── DEPLOYMENT.md                 # 部署指南 (Phase 5)
├── AUDIT_AND_IMPL_PLAN_M143.md   # C++ 审计与实现方案 (Chromium M143)
└── README.md
```

---

## 3. 架构设计

### 3.1 系统整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                      客户端 (Chrome 扩展 MV3)                  │
│                                                              │
│  ┌─────────┐   ┌──────────────┐   ┌────────────┐            │
│  │ WebSocket│ → │CommandValidator│ → │ CanvasKit  │            │
│  │ 接收帧   │   │  9层安全校验   │   │  Skia 渲染  │            │
│  └─────────┘   └──────────────┘   └────────────┘            │
│       ↑                                               │       │
│  ┌─────────┐                                   ┌──────┴────┐ │
│  │  HID 事件│ ← 鼠标/键盘/滚轮 ← User            │  <canvas> │ │
│  └─────────┘                                   └───────────┘ │
└──────────────────────────────────────────────────────────────┘
                          ↕ TLS 1.3 + WebSocket
┌──────────────────────────────────────────────────────────────┐
│                      服务端 (Node.js)                         │
│                                                              │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐             │
│  │ WebSocket │  │   Session   │  │  ChromiumPool │             │
│  │  Server   │  │   Manager   │  │  进程池管理    │             │
│  └──────────┘  └────────────┘  └──────────────┘             │
│       ↑              ↑                 ↑                     │
│  ┌────┴──────┐ ┌────┴──────┐  ┌───────┴────────┐            │
│  │FrameBuilder│ │ InputProxy │  │  Chromium 实例   │            │
│  │帧组装+gzip │ │ CDP 注入   │  │  headless=new   │            │
│  └───────────┘ └───────────┘  └────────────────┘            │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 数据流

#### 下行流（服务端 → 客户端）：绘制帧

```
Chromium Compositor 产出 PaintOp List
  → CommandBuffer 序列化 (C++ 层)
  → FrameAssembler 组帧 (Node.js)
  → CRC32 校验码计算
  → gzip 压缩（三层 zip bomb 防护）
  → WebSocket 二进制帧发送
  → 客户端解压 + CRC 校验
  → CommandValidator 9层白名单校验
  → CanvasKit SkSurface 渲染
```

#### 上行流（客户端 → 服务端）：用户输入

```
用户物理输入 (鼠标/键盘/滚轮)
  → 客户端 HID 事件捕获
  → WebSocket JSON 消息 (不含页面语义)
  → InputProxy 坐标转换 (canvas px → CSS px, 方案B scroll锚定)
  → CDP Input.dispatchMouseEvent / Input.dispatchKeyEvent
  → Chromium 页面响应
```

### 3.3 核心设计原则

1. **Compositor 层拦截** — 在 Chromium 渲染管线的 Compositor 层记录 PaintOp，而非 Skia API 层，大幅减少 Chromium 源码修改量
2. **纵深防御** — 服务端沙箱 + TLS 加密 + 客户端白名单，攻击者即使完全控制服务端，客户端仍然安全
3. **最小信息暴露** — 客户端仅发送原始 HID 事件，不传输页面语义；服务端仅发送 Skia 绘制命令，不传输 HTML/CSS/JS
4. **Fail-Closed** — 任何校验失败 → 丢弃整帧，不尝试部分渲染或修复
5. **开源可审计** — 全链路代码开源，协议规范公开

---

## 4. 通信协议规范

### 4.1 帧格式（二进制）

```
┌──────────┬──────────────────────┬────────────┐
│  30B     │       N bytes        │    4B      │
│  Header  │   CommandStream      │   CRC32    │
└──────────┴──────────────────────┴────────────┘
```

**CRC32 覆盖范围**: Header (30B) + CommandStream (N bytes)
**CRC32 多项式**: `0xEDB88320` (IEEE 802.3，与 zlib 兼容)

### 4.2 帧头结构 (30 字节, Little Endian)

| 偏移 | 大小 | 字段 | 类型 | 说明 |
|------|------|------|------|------|
| 0 | 1 | version | uint8 | 协议版本，当前 `0x01` |
| 1 | 1 | flags | uint8 | 标志位掩码 |
| 2 | 4 | frame_id | uint32 LE | 单调递增帧 ID |
| 6 | 8 | timestamp_ms | int64 LE | 帧生成时间戳 (Unix ms) |
| 14 | 4 | scroll_x | int32 LE | 页面水平滚动偏移 (CSS px) |
| 18 | 4 | scroll_y | int32 LE | 页面垂直滚动偏移 (CSS px) |
| 22 | 2 | viewport_w | uint16 LE | CSS 视口宽度 |
| 24 | 2 | viewport_h | uint16 LE | CSS 视口高度 |
| 26 | 2 | canvas_w | uint16 LE | 物理画布宽度 (= viewportW × dpr) |
| 28 | 2 | canvas_h | uint16 LE | 物理画布高度 (= viewportH × dpr) |

### 4.3 帧头标志位

| Bit | 常量 | 含义 |
|-----|------|------|
| 0 | `FLAG_IS_KEYFRAME (0x01)` | 关键帧（需清空画布后重放全部命令） |
| 1 | `FLAG_HAS_FONT_DATA (0x02)` | 帧内含字体数据 (FONT_DATA 命令) |
| 2 | `FLAG_HAS_DIRTY_RECTS (0x04)` | 帧内含脏区域矩形列表 (Phase 4 R-tree) |

### 4.4 命令格式

```
┌──────┬──────────┬─────────────────┬──────────┐
│ 1B   │   3B     │    N bytes      │  0-3B    │
│Opcode│ PayLen   │    Payload      │  Padding │
│      │ uint24 LE│                 │ (4B对齐) │
└──────┴──────────┴─────────────────┴──────────┘
```

- **Opcode**: 1 字节，范围 `0x01-0x7F` 合法，`≥0x80` 拒绝
- **PayLen**: 3 字节小端序 uint24，最大 1MB
- **Payload**: 变长，4 字节边界对齐（填充 0x00）

### 4.5 Opcode 分配表

| 范围 | 类别 | 说明 |
|------|------|------|
| `0x00` | 保留 | 空操作标记 |
| `0x01-0x0F` | 状态管理 | save, restore, saveLayer |
| `0x10-0x1F` | 变换 | translate, scale, rotate, concat, concat44 |
| `0x20-0x2F` | 裁剪 | clipRect, clipRRect, clipPath |
| `0x30-0x3F` | 形状绘制 | rect, rrect, oval, arc, path, points, region |
| `0x40-0x4F` | 图像绘制 | image, imageRect, lattice, atlas, patch, edgeAA |
| `0x50-0x5F` | 文本绘制 | textBlob, glyphRunList |
| `0x60-0x6F` | 其他绘制 | paint, color, shadow, vertices, annotation |
| `0x70-0x7F` | 扩展 | fontData, imageData, setMatrix, noop |
| `0x80-0xFF` | **非法** | 客户端必须拒收 |

### 4.6 完整 Opcode 列表

| Opcode | 名称 | Payload 格式 | 说明 |
|--------|------|-------------|------|
| `0x01` | SAVE | 无 | 保存当前绘制状态 |
| `0x02` | RESTORE | 无 | 恢复之前保存的状态 |
| `0x03` | SAVE_LAYER | bounds(16B) + paint(N) | 创建新图层 |
| `0x10` | CONCAT | matrix(9×f32=36B) | 应用 3x3 变换矩阵 |
| `0x11` | TRANSLATE | dx(f32) + dy(f32) = 8B | 平移 |
| `0x12` | SCALE | sx(f32) + sy(f32) = 8B | 缩放 |
| `0x13` | ROTATE | radians(f32) = 4B | 旋转 |
| `0x14` | CONCAT44 | matrix(16×f32=64B) | 应用 4x4 变换矩阵 |
| `0x20` | CLIP_RECT | rect(16B) + op(u8) + doAA(u8) = 18B | 矩形裁剪 |
| `0x21` | CLIP_RRECT | rrect(49B) + op(u8) + doAA(u8) = 51B | 圆角矩形裁剪 |
| `0x22` | CLIP_PATH | path(N) + op(u8) + doAA(u8) | 路径裁剪 |
| `0x30` | DRAW_RECT | rect(16B) + paint(N) | 绘制矩形 |
| `0x31` | DRAW_RRECT | rrect(49B) + paint(N) | 绘制圆角矩形 |
| `0x32` | DRAW_DRRECT | outer(49B) + inner(49B) + paint(N) | 绘制双圆角矩形 |
| `0x33` | DRAW_OVAL | rect(16B) + paint(N) | 绘制椭圆 |
| `0x34` | DRAW_ARC | oval(16B) + start(f32) + sweep(f32) + useCenter(u8) + paint(N) | 绘制圆弧 |
| `0x35` | DRAW_PATH | verbCount(u32) + pointCount(u32) + verbs[] + points[] + paint(N) | 绘制路径 |
| `0x36` | DRAW_POINTS | mode(u8) + count(u32) + pts[count×8B] + paint(N) | 绘制点集 |
| `0x37` | DRAW_REGION | region(N) + paint(N) | 绘制区域 |
| `0x40` | DRAW_IMAGE | flag(u8) + [hash(32B) 或 slot+size+data(N)] + x(f32) + y(f32) | 绘制图像 |
| `0x41` | DRAW_IMAGE_RECT | 同上 + src(16B) + dst(16B) | 绘制图像矩形区域 |
| `0x42` | DRAW_IMAGE_LATTICE | image(N) + lattice(N) + dst(16B) + filter(u8) | 九宫格图像 |
| `0x43` | DRAW_ATLAS | count(u32) + xforms[] + tex[] + colors[] + ... | 精灵图集 |
| `0x44` | DRAW_PATCH | cubics(48B) + colors(16B) + texCoords(16B) + ... | 网格渐变 |
| `0x45` | DRAW_EDGE_AA_QUAD | rect(16B) + clip(16B) + aaFlags(u8) + color(16B) + mode(u8) | 抗锯齿四边形 |
| `0x46` | DRAW_EDGE_AA_IMAGE_SET | count(u32) + entries[] + dstClips[] + ... | 抗锯齿图像集合 |
| `0x50` | DRAW_TEXT_BLOB | x(f32) + y(f32) + glyphCount(u32) + glyphs[N×2B] + positions[N×8B] + paint(N) | 文本渲染 |
| `0x51` | DRAW_GLYPH_RUN_LIST | runs(N) + paint(N) | 字形串列表 |
| `0x60` | DRAW_PAINT | paint(N) | 填充整个画布 |
| `0x61` | DRAW_COLOR | r(u8) + g(u8) + b(u8) + a(u8) + mode(u8) = 5B | 纯色填充 |
| `0x62` | DRAW_SHADOW | path(N) + shadowRec(N) | 阴影 |
| `0x63` | DRAW_VERTICES_OBJECT | mode(u8) + vertexCount(u32) + indexCount(u32) + positions[] + ... | 顶点网格 |
| `0x64` | DRAW_DRAWABLE | 跳过 (noop) | Drawable 不可序列化 |
| `0x65` | DRAW_ANNOTATION | rect(16B) + key(N) + value(N) | 调试注释 |
| `0x70` | FONT_DATA | fontId(u32) + size(u32) + data[N] | 字体内联传输 |
| `0x71` | IMAGE_DATA | slotId(u32) + size(u32) + data[N] | 图像内联数据 |
| `0x72` | SET_MATRIX | matrix(9×f32=36B) | 设置全局矩阵 |
| `0x7F` | NOOP | 无 | 空操作 |

### 4.7 Payload 编码细节

- 所有多字节值采用 **Little Endian** 字节序
- `f32` 使用 IEEE 754 单精度浮点
- 命令流以 **4 字节对齐**（不足位填充 `0x00`）
- Path verbs 编码: `0=moveTo, 1=lineTo, 2=quadTo, 3=conicTo, 4=cubicTo, 5=close`
- 图像 flag: `0x00=内联传输, 0x01=hash 引用`

### 4.8 客户端 → 服务端 JSON 消息

| 消息类型 | 方向 | 用途 |
|----------|------|------|
| `{ type: "ready", url: "..." }` | C→S | 通知服务端加载目标 URL |
| `{ type: "viewport", width, height, dpr }` | C→S | 更新视口尺寸 |
| `{ type: "io", ... }` | C→S | HID 输入事件 |
| `{ type: "request_keyframe" }` | C→S | 请求关键帧（恢复同步） |

---

## 5. 服务端详解

### 5.1 模块总览

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口/编排器 | `server.js` | WebSocket 服务、消息路由、帧路由、健康检查 |
| 会话管理 | `session.js` | 会话生命周期、frame_id 单调计数器、帧历史 |
| 帧组装 | `frame_builder.js` | 帧头序列化、CRC32 计算、gzip 压缩 |
| 输入代理 | `io_proxy.js` | HID→CDP 坐标转换、事件注入 |
| 进程管理 | `chromium_manager.js` | Chromium 实例池、崩溃恢复 |
| 字体校验 | `font_validator.js` | SFNT/WOFF2 Magic 白名单 |
| 监控 | `metrics.js` | Counter/Gauge/Histogram、/health、/metrics |
| 配置 | `config.js` | 所有常量的单一事实来源 |

### 5.2 WisonRBIServer — 入口点

```javascript
class WisonRBIServer {
    constructor(options)
    // 参数:
    //   options.port         — HTTP/WS 端口 (默认 3000)
    //   options.chromiumPath — Chromium 路径
    //   options.maxSessions  — 最大并发会话 (默认 4)
    //   options.tlsCert      — TLS 证书路径
    //   options.tlsKey       — TLS 私钥路径
    //   options.tlsCa        — mTLS CA 路径 (可选)

    async start()  // 启动服务器
    async stop()   // 优雅关闭
}
```

**消息路由处理流程:**

```
客户端 WebSocket 消息
  → _handleMessage()
    ├─ type=ready   → _handleReady()    → InputProxy.navigate()
    ├─ type=viewport → InputProxy.updateViewport()
    ├─ type=io      → InputProxy.handleIOEvent()
    └─ type=request_keyframe → 设置 has_pending_keyframe_request
```

**帧路由:**

```
Chromium CDP → sendFrame(meta, commandStream)
  → assembleFrame()       → 30B Header + CommandStream + 4B CRC32
  → font_validator()      → 字体 Magic 校验
  → compressFrame()       → gzip 压缩 + 三层 zip bomb 防护
  → ws.send(binaryFrame)  → WebSocket 发送
```

### 5.3 Session — 会话管理

```javascript
class Session {
    constructor(sessionId, options)
    // 关键属性:
    //   sessionId           — UUID v4
    //   frameHistory        — Map<frameId, FrameMeta>
    //   chromium            — ChromiumInstance 引用
    //   socket              — WebSocket 引用

    nextFrameId()                  // 分配单调递增 frame_id
    get currentFrameId()           // 当前 frame_id（不递增）
    recordFrame(meta)              // 记录帧元数据到历史
    getNearestFrameMeta(frameId)   // 查找最近帧（坐标转换）
    resetFrameIdCounter()          // 重置计数器（重启检测）
    close()                        // 关闭会话，释放资源
}
```

**FrameMeta 记录结构:**

```typescript
interface FrameMeta {
    frameId: number;      // 帧 ID
    timestampMs: number;  // 时间戳 (Unix ms)
    scrollX: number;      // 页面滚动 X (CSS px)
    scrollY: number;      // 页面滚动 Y (CSS px)
    viewportW: number;    // CSS 视口宽度
    viewportH: number;    // CSS 视口高度
    canvasW: number;      // 物理画布宽度
    canvasH: number;      // 物理画布高度
}
```

### 5.4 FrameBuilder — 帧组装

```javascript
// 核心函数
function serializeFrameHeader(meta) → Buffer  // 30B 帧头
function assembleFrame(meta, commandStream) → Buffer  // 完整帧
async function compressFrame(frame) → Buffer  // gzip 压缩帧

// CRC32 (IEEE 802.3, 多项式 0xEDB88320)
function computeCRC32(buf, seed = 0) → number

// 图像去重 (Phase 4)
class ImageHashRegistry
    register(bytes) → { hash, isNew }
    lookup(hash) → Buffer | null
```

**gzip 压缩三层 zip bomb 防护:**

1. **第一层**: 压缩后大小 ≤ 4MB (`MAX_COMPRESSED_FRAME`)
2. **第二层**: 解压后大小 ≤ 64MB (`MAX_BYTES_PER_FRAME`)
3. **第三层**: 压缩比异常检测 ≤ 1000:1 (`MAX_COMPRESSION_RATIO`)

### 5.5 InputProxy — 输入代理

```javascript
class InputProxy {
    constructor(cdpClient, session)

    async updateViewport(width, height, dpr)  // 更新视口
    async navigate(url)                       // 导航到 URL
    async handleIOEvent(event)                // 处理 HID 事件
    onFrameGenerated(frameMeta)               // 帧生成回调

    // 内部方法
    _canvasToPage(canvasX, canvasY, frameId) → {pageX, pageY}
    _sendCommand(method, params)              // CDP 命令发送
}
```

**输入事件类型白名单:**
- `mousemove`, `mousedown`, `mouseup`
- `wheel`
- `keydown`, `keyup`

**坐标转换公式（方案 B — scroll 锚定）:**

```
pageX = (canvasX / dpr) + scrollX
pageY = (canvasY / dpr) + scrollY
```

### 5.6 ChromiumManager — 进程管理

```javascript
class ChromiumPool {
    constructor(options)
    // options:
    //   executablePath — Chromium 执行文件路径
    //   maxInstances   — 最大实例数 (默认 4)

    async acquire() → ChromiumInstance
    release(instance)
    shutdown()
}

class ChromiumInstance {
    async start()     // 启动 Chromium 子进程 + CDP 连接
    async stop()      // SIGTERM → (5s) → SIGKILL
    get cdpClient()   // CDP 客户端引用
}
```

**Chromium 启动参数策略:**
- `--headless=new` — 新版 headless 模式
- `--disable-gpu` — headless 下不需要 GPU
- `--disable-dev-shm-usage` — 避免 Docker /dev/shm 空间不足
- `--no-sandbox` — **仅开发环境** (`GARNET_UNSAFE_NO_SANDBOX=1`)
- 沙箱在生产环境强制保持启用

**崩溃恢复:** 指数退避策略 (1s → 2s → 4s → … → 30s max)

### 5.7 FontValidator — 字体格式校验

```javascript
function validateFontData(fontData) → { valid, format?, reason? }
function validateFontBatch(fonts) → { safe, rejected }
```

**Magic 字节白名单（大端序）:**

| Magic | 值 | 格式 |
|-------|------|------|
| `0x00010000` | TrueType | .ttf |
| `0x4F54544F` ("OTTO") | OpenType CFF | .otf |
| `0x74727565` ("true") | TrueType (Apple) | .ttf |
| `0x74746366` ("ttcf") | TrueType Collection | .ttc |
| `0x774F4632` ("wOF2") | WOFF2 | .woff2 |

明确拒绝: WOFF v1 (`"wOFF" = 0x774F4646`)、EOT、SVG 字体

### 5.8 Metrics — 监控指标

```javascript
class MetricsRegistry {
    counter(name, labels)       // Counter: 单调递增
    setGauge(name, value, labels) // Gauge: 瞬时值
    observe(name, valueMs, labels) // Histogram: 延迟分布
    snapshot() → object         // 完整快照
}

// 预定义指标
const metrics = {
    SESSIONS_ACTIVE,          // 活跃会话数 (Gauge)
    SESSIONS_TOTAL,           // 总会话数 (Counter)
    FRAMES_SENT,              // 已发送帧数 (Counter)
    FRAMES_DROPPED,           // 丢弃帧数 (Counter)
    WS_CONNECTIONS,           // WebSocket 连接数 (Counter)
    WS_BACKPRESSURE,          // 背压事件数 (Counter)
    WS_ERRORS,                // WebSocket 错误数 (Counter)
    FRAME_BUILD_LATENCY,      // 帧组装延迟 (Histogram)
    SECURITY_CRC_FAILS,       // CRC 失败数 (Counter)
    SECURITY_OPCODE_REJECTS,  // Opcode 拒绝数 (Counter)
    SECURITY_ZIPBOMB,         // Zip bomb 拦截数 (Counter)
}

// HTTP 端点
GET /metrics  → JSON 完整指标快照
GET /health   → JSON 健康检查 + 告警摘要
```

**告警规则:**

| 规则 | 条件 | 级别 |
|------|------|------|
| 高帧丢弃率 | 丢弃/发送 > 10% | WARN |
| CRC 失败异常 | 失败/发送 > 5% | CRITICAL |
| 会话饱和 | 活跃 ≥ 上限 | WARN |
| 高频背压 | > 5 次/分钟 | WARN |

---

## 6. 客户端详解

### 6.1 模块总览

| 模块 | 文件 | 职责 |
|------|------|------|
| 主控制器 | `index.js` | CanvasKit 初始化、帧处理、HID 捕获、视口管理 |
| 命令校验 | `command_validator.js` | 9层安全白名单 + 深度校验 |
| 协议常量 | `protocol.js` | 所有协议常量的客户端版 |
| 工具函数 | `utils.js` | CRC32、gzip 安全解压、日志、抖动 |
| 字体管理 | `font_registry.js` | CanvasKit 字体 LRU 缓存 |
| 图像缓存 | `image_cache.js` | 图像 SHA-256 hash 引用 LRU |
| Service Worker | `background.js` | HTTP 请求拦截 + 重定向 |

### 6.2 初始化流程

```
init()
  1. 解析 URL 参数 → targetUrl
  2. 设置 Canvas 初始尺寸 × devicePixelRatio
  3. 加载 CanvasKit WASM (异步)
  4. 创建 SkSurface + 获取 SkCanvas
  5. 初始化 CommandValidator (安全门禁)
  6. 初始化 FontRegistry (回退字体 font_id=0)
  7. 初始化 ImageCache (LRU, 64MB)
  8. 建立 WebSocket 连接
  9. 注册 HID 事件捕获器
  10. 注册视口 resize 监听 (150ms 防抖)
  11. 启动 requestAnimationFrame 渲染循环
```

### 6.3 帧接收流水线

```
handleFrame(compressedFrame)
  1. decompressWithProtection()  → 三层 zip bomb 防护解压
  2. validateFrameCRC()          → CRC32 完整性校验
  3. parseFrameHeader()          → 解析 30B 帧头
  4. 版本检查                    → version != PROTOCOL.VERSION → 丢弃
  5. extractCommandStream()      → 提取命令流
  6. validator.validate()        → 9 层白名单校验
  7. 渲染调度                    → requestAnimationFrame
  8. renderFrame()               → CanvasKit 逐命令重放
```

### 6.4 CommandValidator — 9层纵深防御

```javascript
class CommandValidator {
    validate(commandsBuffer) → {
        valid: boolean,
        commandCount?: number,
        rejectOffset?: number,
        rejectReason?: string,
        shouldRequestKeyframe?: boolean
    }
}
```

**9 层校验（由外到内）:**

| 层 | 校验内容 | 威胁模型 |
|----|----------|----------|
| L1 | Opcode 白名单 (0x01-0x7F) | 攻击者发送非法 opcode |
| L2 | Payload 大小 ≤ 1MB | 单命令超大 payload OOM |
| L3 | 帧级总字节 ≤ 64MB | 恶意帧耗尽内存 |
| L4 | Save/Restore 深度配对 | 栈不平衡导致溢出 |
| L5 | Payload 子结构深度校验 | count 字段伪造 OOM |
| L6 | 缓冲区边界检查 | 越界读取 |
| L7 | 对齐填充全零校验 | 填充字节含隐藏数据 |
| L8 | 命令数量 ≤ 100,000 | 海量微小命令 CPU 耗尽 |
| L9 | Paint Shader 子结构校验 | 内嵌数据绕过检查 |

**连续拒绝策略:**
- 连续拒绝 ≥ 3 帧 → 发送 `request_keyframe`
- 拒绝计数器在每次校验通过时归零

**子结构上限:**

| 子结构 | 上限 | 防护 |
|--------|------|------|
| Path verbs | 100,000 | 防止恶意 path 分配巨型数组 |
| TextBlob glyphs | 50,000 | 防止伪造 glyphCount OOM |
| Vertices count | 100,000 | 防止伪造 vertexCount OOM |
| Atlas count | 100,000 | 防止伪造 count OOM |

### 6.5 字体注册表 (FontRegistry)

```javascript
class FontRegistry {
    constructor(canvasKit, options)
    // options.maxBytes — 最大缓存 (默认 64MB)

    registerFont(fontId, fontData) → boolean
    getTypeface(fontId) → SkTypeface | null
    invalidate(fontId)              // 失效字体
    get stats()                     // 缓存统计
}
```

- font_id=0 固定为 CanvasKit 内置默认字体，永不驱逐
- 注册前必须通过 Magic 白名单校验
- LRU 驱逐基于单调递增 accessCounter

### 6.6 图像缓存 (ImageCache)

```javascript
class ImageCache {
    constructor(options)
    // options.maxBytes — 最大缓存 (默认 64MB)

    has(hexHash) → boolean
    get(hexHash) → ArrayBuffer | null
    put(hexHash, imageData)
    clear()
    get stats()  // { entryCount, currentBytes, maxBytes, usage }
}
```

- 哈希引用模式: 服务端发送 SHA-256 哈希替代完整图像数据
- LRU 驱逐策略，单条 > 64MB 拒绝缓存
- 服务端重启时 `clear()` 清空所有条目
- 碰撞安全: SHA-256 的 2^128 生日攻击复杂度

### 6.7 工具函数 (utils.js)

```javascript
// CRC32 (IEEE 802.3)
function computeCRC32(data, seed = 0) → number

// gzip 安全解压
async function decompressWithProtection(compressed) → ArrayBuffer

// 帧解析辅助
function parseFrameHeader(frameBuffer) → FrameHeader
function validateFrameCRC(frameBuffer) → boolean
function extractCommandStream(frameBuffer) → ArrayBuffer

// 审计日志
function auditLog(level, event, meta?)

// 侧信道防御 (Phase 2)
function randomJitter() → number    // ±1ms 随机抖动
async function randomJitterAsync()  // 异步版
```

**日志级别:**

| 级别 | 用途 |
|------|------|
| `DEBUG` | 详细调试信息 |
| `INFO` | 正常操作事件 |
| `WARN` | 可恢复的异常 |
| `ERROR` | 不可恢复的错误 |

### 6.8 Chrome 扩展架构 (MV3)

#### manifest.json 安全策略

```json
{
    "content_security_policy": {
        "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src wss://*:*"
    }
}
```

- `script-src 'self'` — 仅加载扩展自带脚本
- `'wasm-unsafe-eval'` — CanvasKit WASM 所需
- `object-src 'self'` — 禁止嵌入插件
- `connect-src wss://` — 仅允许加密 WebSocket

#### 请求拦截 (双通道)

1. **declarativeNetRequest (DNR) 静态规则** — 主拦截通道
   - `rules.json`: 匹配所有 `http://`/`https://` 导航，重定向到 `index.html?url=XXX`
   - Priority: 1（低于例外站点的 Priority: 100）
   
2. **tabs.onUpdated 动态兜底** — 备用拦截通道
   - 处理 DNR 无法覆盖的边缘情况
   - 放行规则: 跳过 `chrome-extension://` URL 和 `wison-rbi-bypass` 标记

#### 例外站点管理

- 用户可通过 `chrome.storage.local` 配置例外域名白名单
- 每个例外域名生成一条 DNR `allow` 规则（ID 1000-1999, priority 100）
- 响应 `chrome.storage.onChanged` 实时更新

---

## 7. 安全模型

### 7.1 三条核心不变量

1. **不变量 1**: 客户端收到的每个字节只能是合法 Skia 绘制命令（经白名单校验）或帧元数据（frame_id, scroll, viewport）
2. **不变量 2**: 客户端发出的每个字节只能是原始 HID 事件或帧引用（frame_id，不含页面语义）
3. **不变量 3**: 所有页面内容仅在服务端 Chromium 沙箱内执行，不向客户端传输 HTML/CSS/JS

### 7.2 威胁模型与对策

| 威胁 | 对策 |
|------|------|
| 恶意网页 | Chromium 沙箱隔离；客户端不接触原始内容 |
| 信道中间人 | TLS 1.3 (AEAD 套件) + CRC32 完整性校验 |
| 服务端被入侵 | 客户端命令白名单 + 9层深度校验 |
| 侧信道攻击 | readPixels 禁用；±1ms 渲染抖动 (Phase 2) |
| gzip zip bomb | 三层纵深防护：压缩大小/流式解压/压缩比 |
| DoS (超大帧) | 帧级 64MB 硬上限 |
| DoS (海量命令) | 单帧最多 100,000 条命令 |
| 字体二进制外泄 | SFNT/WOFF2 Magic 白名单 |
| 图像缓存投毒 | SHA-256 hash 引用 (2^128 碰撞不可行) |
| 进程崩溃循环 | 指数退避重启 (1s→2s→4s→…→30s) |

### 7.3 安全审计关键点

#### 服务端安全审计

- [ ] Chromium 沙箱是否保持启用（非 `GARNET_UNSAFE_NO_SANDBOX`）
- [ ] TLS 1.3 是否启用（生产环境）
- [ ] CDP 端口是否仅绑定 localhost
- [ ] 压缩炸弹三层防护是否完整
- [ ] 字体 Magic 白名单是否仅包含 SFNT/WOFF2
- [ ] WebSocket payload 上限是否为 64MB

#### 客户端安全审计

- [ ] CommandValidator 9层校验是否全部启用
- [ ] Opcode 白名单是否覆盖所有 0x01-0x7F 值
- [ ] 子结构深度校验是否检查所有 count 字段
- [ ] readPixels 是否确实禁用
- [ ] CSP 是否限制 wss:// 连接
- [ ] 浏览器快捷键（Ctrl+T/W/N/Q/R）是否被拦截

### 7.4 纵深防御层次

```
第 1 层: Chromium 进程沙箱 (OS 级隔离)
第 2 层: TLS 1.3 信道加密 (防窃听/篡改)
第 3 层: CRC32 完整性校验 (传输错误检测)
第 4 层: gzip zip bomb 三层防护 (防数据膨胀)
第 5 层: CommandValidator 9层白名单校验 (防恶意命令)
第 6 层: CanvasKit WASM 沙箱 (浏览器级隔离)
第 7 层: CSP 资源限制 (防第三方代码注入)
```

---

## 8. 性能模型

### 8.1 性能指标

| 指标 | Phase 1 目标 | 实现策略 |
|------|-------------|---------|
| 端到端延迟 | < 150ms | 异步 CDP + 流水线化 |
| 帧生成延迟 | < 5ms | Compositor 线程录制 + Worker 线程编码 |
| 帧组装延迟 (1MB) | < 2ms | 预计算 CRC32 表 + Buffer 零拷贝 |
| gzip 压缩延迟 (1MB) | < 10ms | 原生 zlib (C 实现) |
| 带宽 (首帧) | < 3MB gzip | 原生 zlib + hash-ref 去重 |
| 增量帧带宽 | < 50KB | R-tree 脏区域 + hash-ref |
| 客户端 CPU | < 30% @60fps | requestAnimationFrame 调度 |
| 客户端内存 | < 256MB | 字体 LRU (64MB) + 图像 LRU (64MB) |

### 8.2 CRC32 性能

- 预计算 256 条目查找表 (1KB)
- O(n) 时间复杂度，逐字节查表
- 64MB 帧 CRC32 耗时约 15ms (Node.js)
- 浏览器 WASM 实现更快（~5ms for 64MB）

### 8.3 gzip 压缩比

| 场景 | 解压大小 | gzip 大小 | 压缩比 |
|------|----------|-----------|--------|
| 纯文本页面 | 500KB | ~80KB | ~6:1 |
| 混合图文页面 | 3MB | ~400KB | ~7.5:1 |
| 纯色大图 | 8MB | ~8MB | ~1:1 |
| 空白页面 | <1KB | ~20B | — |

### 8.4 图像去重效果 (Phase 4)

- hash-ref 模式节省增量帧带宽: 60-80%
- 典型场景: 页面滚动时，已渲染图像仅发送 32B 哈希
- SHA-256 计算开销: ~1ms/MB (服务端)

---

## 9. 部署运维

### 9.1 系统要求

#### 服务端

| 资源 | 最低 | 推荐 |
|------|------|------|
| CPU | 4 核 x86_64 | 8+ 核 |
| 内存 | 8 GB | 16 GB+ (每并发 +2GB) |
| 磁盘 | 20 GB | SSD 50 GB+ |
| 操作系统 | Linux (kernel ≥5.4) | Ubuntu 22.04 LTS |
| Node.js | ≥18.0 | 20.x LTS |
| Chromium | ≥M120 | 与 CanvasKit 同 Milestone |

#### 客户端

| 资源 | 要求 |
|------|------|
| 浏览器 | Chrome/Chromium ≥ M120 (MV3) |
| 内存 | ≥512 MB 可用 |
| GPU | WebGL 2.0 |
| 网络 | 延迟 < 100ms RTT (推荐) |

### 9.2 快速安装

```bash
# 克隆仓库
git clone https://github.com/laolv2023/wison-rbi.git
cd wison-rbi

# 服务端
cd server
npm ci --production
# 安装 Chromium
sudo apt-get install -y chromium-browser

# 客户端
cd client
npm ci --production
```

### 9.3 启动

```bash
# 服务端
cd server
export PORT=3000
export CHROMIUM_PATH=/usr/bin/chromium
export WISON_TLS_ENABLED=1
export WISON_TLS_CERT=/path/to/fullchain.pem
export WISON_TLS_KEY=/path/to/privkey.pem
node server.js

# 客户端 (在 Chrome 中加载扩展)
# 1. chrome://extensions
# 2. 启用开发者模式
# 3. 加载已解压的扩展程序 → client/
```

### 9.4 systemd 服务

```ini
[Unit]
Description=Wison-RBI Browser Isolation Server
After=network.target

[Service]
Type=simple
User=wison-rbi
WorkingDirectory=/opt/wison-rbi/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
LimitNOFILE=65536
LimitNPROC=4096

# 安全加固
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/tmp
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

### 9.5 TLS 配置

```bash
# Let's Encrypt
sudo certbot certonly --standalone -d wison-rbi.example.com

# 环境变量
export WISON_TLS_CERT=/etc/letsencrypt/live/wison-rbi.example.com/fullchain.pem
export WISON_TLS_KEY=/etc/letsencrypt/live/wison-rbi.example.com/privkey.pem

# 可选 mTLS
export WISON_TLS_CA=/etc/ssl/certs/client-ca.pem
```

### 9.6 健康检查

```bash
# 基础健康
curl https://localhost:3000/health
# → {"status":"ok","sessions":2,"uptime":3600.5,"tls":true}

# 完整指标
curl https://localhost:3000/metrics
```

### 9.7 性能调优

| 参数 | 默认值 | 调优建议 |
|------|--------|----------|
| `MAX_SESSIONS` | 4 | 根据 CPU 核心数调整 (建议 N-2) |
| `CHROMIUM_MAX_MEMORY_BYTES` | 2GB | 根据可用内存调整 |
| `WS_HIGH_WATER_MARK` | 1MB | 根据网络带宽调整 |
| `FRAME_HISTORY_MAX_AGE_MS` | 3000 | 根据网络延迟调整 |
| `SESSION_IDLE_TIMEOUT_MS` | 120000 | 根据用户行为调整 |

---

## 10. C++ Chromium 补丁层

### 10.1 在 Chromium 源码树中的挂载点

```
//garnet/
├── garnet_config.h        # 编译时常量 (零 Chromium 头文件依赖)
├── frame_constants.h      # 帧头结构体 + Opcode 枚举
├── command_buffer.h       # CommandBuffer 声明
├── command_buffer.cpp     # 序列化 + CRC32 实现
├── recording_canvas.h     # RecordingCanvas (31个方法)
└── layer_recorder.h       # LayerRecorder + FrameAssembler
```

### 10.2 garnet_config.h — 编译时常量

```cpp
namespace garnet {

// 协议版本
constexpr uint8_t kProtocolVersion = 0x01;

// 帧级硬上限
constexpr size_t kMaxBytesPerFrame = 64 * 1024 * 1024;     // 64MB
constexpr size_t kMaxCompressedFrame = 4 * 1024 * 1024;     // 4MB
constexpr double kMaxCompressionRatio = 1000.0;             // 1000:1

// 命令级硬上限
constexpr uint32_t kMaxPayloadBytes = 1 * 1024 * 1024;      // 1MB
constexpr uint32_t kMaxCommandsPerFrame = 100000;

// 子结构上限
constexpr uint32_t kMaxPathVerbs = 100000;
constexpr uint32_t kMaxTextBlobGlyphs = 50000;
constexpr uint32_t kMaxVerticesCount = 100000;
constexpr uint32_t kMaxAtlasCount = 100000;

// 缓存上限
constexpr size_t kImageCacheBytes = 64 * 1024 * 1024;       // 64MB
constexpr size_t kFontCacheBytes = 64 * 1024 * 1024;        // 64MB
constexpr size_t kMaxFontInlineBytes = 5 * 1024 * 1024;     // 5MB

// 字体 Magic
constexpr uint32_t kSfntMagicTrueType = 0x00010000;
constexpr uint32_t kSfntMagicOpenType = 0x4F54544F;         // 'OTTO'
constexpr uint32_t kSfntMagicAppleTrue = 0x74727565;        // 'true'
constexpr uint32_t kSfntMagicCollection = 0x74746366;       // 'ttcf'
constexpr uint32_t kWoff2Magic = 0x774F4632;               // 'wOF2'

// CRC32
constexpr uint32_t kCrc32Polynomial = 0xEDB88320;

}  // namespace garnet
```

### 10.3 frame_constants.h — 协议常量

```cpp
namespace garnet {

// 帧结构
constexpr size_t kFrameHeaderSize = 30;
constexpr size_t kFrameTrailerSize = 4;
constexpr size_t kCommandHeaderSize = 4;

// 帧头结构体（30 字节有效载荷，手动序列化）
struct FrameHeader {
    uint8_t  version;
    uint8_t  flags;
    uint32_t frame_id;
    int64_t  timestamp_ms;
    int32_t  scroll_x;
    int32_t  scroll_y;
    uint16_t viewport_w;
    uint16_t viewport_h;
    uint16_t canvas_w;
    uint16_t canvas_h;
};

// 标志位
constexpr uint8_t kFlagIsKeyframe  = 0x01;
constexpr uint8_t kFlagHasFontData = 0x02;
constexpr uint8_t kFlagHasDirtyRects = 0x04;

// Opcode 枚举
enum class Opcode : uint8_t {
    SAVE = 0x01, RESTORE = 0x02, SAVE_LAYER = 0x03,
    CONCAT = 0x10, TRANSLATE = 0x11, SCALE = 0x12, ROTATE = 0x13, CONCAT44 = 0x14,
    CLIP_RECT = 0x20, CLIP_RRECT = 0x21, CLIP_PATH = 0x22,
    DRAW_RECT = 0x30, DRAW_RRECT = 0x31, DRAW_DRRECT = 0x32,
    DRAW_OVAL = 0x33, DRAW_ARC = 0x34, DRAW_PATH = 0x35,
    DRAW_POINTS = 0x36, DRAW_REGION = 0x37,
    DRAW_IMAGE = 0x40, DRAW_IMAGE_RECT = 0x41, DRAW_IMAGE_LATTICE = 0x42,
    DRAW_ATLAS = 0x43, DRAW_PATCH = 0x44,
    DRAW_EDGE_AA_QUAD = 0x45, DRAW_EDGE_AA_IMAGE_SET = 0x46,
    DRAW_TEXT_BLOB = 0x50, DRAW_GLYPH_RUN_LIST = 0x51,
    DRAW_PAINT = 0x60, DRAW_COLOR = 0x61, DRAW_SHADOW = 0x62,
    DRAW_VERTICES_OBJECT = 0x63, DRAW_DRAWABLE = 0x64, DRAW_ANNOTATION = 0x65,
    FONT_DATA = 0x70, IMAGE_DATA = 0x71, SET_MATRIX = 0x72,
    NOOP = 0x7F,
};

// 校验函数
inline bool IsValidOpcode(uint8_t op) {
    return op >= 0x01 && op <= 0x7F;
}

}  // namespace garnet
```

### 10.4 关键实现细节

- **FrameHeader 手动序列化**: 因 int64_t 字段可能导致编译器插入 6 字节 padding，禁止直接 memcpy，必须通过 `SerializeFrameHeader()` / `DeserializeFrameHeader()` 逐字段序列化
- **CommandBuffer 实现**: 提供 `beginCommand(opcode)` / `writePayload(data, len)` / `endCommand()` 三段式 API，自动处理 uint24 LE payLen 回填和 4 字节对齐
- **CRC32**: 预计算 256 条目查找表，IEEE 802.3 反射多项式算法
- **RecordingCanvas**: 包装 SkCanvas 的 31 个绘制方法，将调用序列化为 PaintOp 流

---

## 11. API 参考

### 11.1 服务端 API

#### WisonRBIServer

```typescript
class WisonRBIServer {
    constructor(options?: {
        port?: number;           // 默认 3000
        chromiumPath?: string;   // Chromium 路径
        maxSessions?: number;    // 默认 4
        tlsCert?: string;        // TLS 证书路径
        tlsKey?: string;         // TLS 私钥路径
        tlsCa?: string;          // mTLS CA 路径
    });
    
    async start(): Promise<void>;
    async stop(): Promise<void>;
}
```

#### Session

```typescript
class Session {
    constructor(sessionId: string, options?: {
        frameHistoryMaxAgeMs?: number;     // 默认 3000
        frameHistoryMaxEntries?: number;   // 默认 1000
        idleTimeoutMs?: number;            // 默认 120000
    });
    
    nextFrameId(): number;
    get currentFrameId(): number;
    recordFrame(meta: FrameMeta): void;
    getNearestFrameMeta(frameId: number): FrameMeta | null;
    resetFrameIdCounter(): void;
    close(): void;
}
```

#### FrameBuilder

```typescript
function serializeFrameHeader(meta: {
    version?: number;
    flags?: number;
    frameId: number;
    timestampMs: number;
    scrollX: number;
    scrollY: number;
    viewportW: number;
    viewportH: number;
    canvasW: number;
    canvasH: number;
    isKeyframe?: boolean;
    hasFontData?: boolean;
}): Buffer;

function assembleFrame(meta: object, commandStream: Buffer): Buffer;
async function compressFrame(frame: Buffer): Promise<Buffer>;
function computeCRC32(buf: Buffer, seed?: number): number;

class ImageHashRegistry {
    register(bytes: Buffer): { hash: string; isNew: boolean };
    lookup(hash: string): Buffer | null;
}
```

#### InputProxy

```typescript
class InputProxy {
    constructor(cdpClient: CDP.Client, session: Session);
    
    async updateViewport(width: number, height: number, dpr?: number): Promise<void>;
    async navigate(url: string): Promise<void>;
    async handleIOEvent(event: {
        type: 'mousemove' | 'mousedown' | 'mouseup' | 'wheel' | 'keydown' | 'keyup';
        x: number;
        y: number;
        frameId: number;
        button?: number;
        deltaX?: number;
        deltaY?: number;
        key?: string;
        code?: string;
    }): Promise<void>;
    onFrameGenerated(frameMeta: FrameMeta): void;
}
```

#### FontValidator

```typescript
function validateFontData(fontData: Buffer): {
    valid: boolean;
    format?: string;
    reason?: string;
};

function validateFontBatch(fonts: Array<{fontId: number; data: Buffer}>): {
    safe: Array<{fontId: number; data: Buffer}>;
    rejected: Array<{fontId: number; reason: string}>;
};
```

### 11.2 客户端 API

#### CommandValidator

```typescript
class CommandValidator {
    constructor();
    validate(commandsBuffer: ArrayBuffer): {
        valid: boolean;
        commandCount?: number;
        rejectOffset?: number;
        rejectReason?: string;
        shouldRequestKeyframe?: boolean;
    };
}
```

#### FontRegistry

```typescript
class FontRegistry {
    constructor(canvasKit: object, options?: {
        maxBytes?: number;  // 默认 64MB
    });
    
    registerFont(fontId: number, fontData: ArrayBuffer): boolean;
    getTypeface(fontId: number): SkTypeface | null;
    invalidate(fontId: number): void;
    get stats(): { entryCount: number; currentBytes: number; maxBytes: number };
}
```

#### ImageCache

```typescript
class ImageCache {
    constructor(options?: {
        maxBytes?: number;  // 默认 64MB
    });
    
    has(hexHash: string): boolean;
    get(hexHash: string): ArrayBuffer | null;
    put(hexHash: string, imageData: ArrayBuffer): void;
    clear(): void;
    get stats(): { entryCount: number; currentBytes: number; maxBytes: number; usage: number };
}
```

#### 工具函数

```typescript
function computeCRC32(data: Uint8Array | ArrayBuffer, seed?: number): number;
async function decompressWithProtection(compressed: ArrayBuffer): Promise<ArrayBuffer>;
function parseFrameHeader(frameBuffer: ArrayBuffer): FrameHeader;
function validateFrameCRC(frameBuffer: ArrayBuffer): boolean;
function extractCommandStream(frameBuffer: ArrayBuffer): ArrayBuffer;
function auditLog(level: string, event: string, meta?: object): void;
function randomJitter(): number;
```

---

## 12. 配置参考

### 12.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | HTTP/WebSocket 监听端口 |
| `CHROMIUM_PATH` | `chromium` | Chromium 可执行文件路径 |
| `MAX_SESSIONS` | `4` | 最大并发会话数 |
| `WISON_TLS_ENABLED` | `0` | 是否启用 TLS |
| `WISON_TLS_CERT` | — | TLS 证书路径 |
| `WISON_TLS_KEY` | — | TLS 私钥路径 |
| `WISON_TLS_CA` | — | mTLS CA 路径 |
| `LOG_LEVEL` | `INFO` | 日志级别 (DEBUG/INFO/WARN/ERROR) |
| `GARNET_UNSAFE_NO_SANDBOX` | — | 禁用 Chromium 沙箱 (仅开发环境) |

### 12.2 配置常量 (config.js / garnet_config.h)

| 常量 | 值 | 说明 |
|------|------|------|
| `PROTOCOL_VERSION` | `0x01` | 协议版本号 |
| `MAX_BYTES_PER_FRAME` | `64MB` | 单帧解压后大小硬上限 |
| `MAX_COMPRESSED_FRAME` | `4MB` | gzip 压缩后大小硬上限 |
| `MAX_COMPRESSION_RATIO` | `1000:1` | gzip 压缩比异常阈值 |
| `MAX_PAYLOAD_BYTES` | `1MB` | 单命令 payload 硬上限 |
| `MAX_COMMANDS_PER_FRAME` | `100,000` | 单帧命令数硬上限 |
| `MAX_PATH_VERBS` | `100,000` | Path verb/point 上限 |
| `MAX_TEXT_BLOB_GLYPHS` | `50,000` | TextBlob 字形数上限 |
| `MAX_VERTICES_COUNT` | `100,000` | Vertices 顶点数上限 |
| `MAX_ATLAS_COUNT` | `100,000` | Atlas 精灵数上限 |
| `IMAGE_CACHE_BYTES` | `64MB` | 图像缓存总容量 |
| `FONT_CACHE_BYTES` | `64MB` | 字体缓存总容量 |
| `MAX_FONT_INLINE_BYTES` | `5MB` | 内联字体单文件上限 |
| `FRAME_HISTORY_MAX_AGE_MS` | `3000` | 帧历史保留时间 |
| `FRAME_HISTORY_MAX_ENTRIES` | `1000` | 帧历史最大条目 |
| `CONSECUTIVE_REJECT_THRESHOLD` | `3` | 连续拒绝触发 request_keyframe |
| `FRAME_ID_JUMP_THRESHOLD` | `1000` | frame_id 跳跃检测阈值 |
| `CHROMIUM_STARTUP_TIMEOUT_MS` | `60000` | Chromium 启动超时 |
| `PAGE_LOAD_TIMEOUT_MS` | `30000` | 页面加载超时 |
| `CDP_COMMAND_TIMEOUT_MS` | `3000` | CDP 命令超时 |
| `SESSION_IDLE_TIMEOUT_MS` | `120000` | 会话空闲超时 |
| `CHROMIUM_MAX_MEMORY_BYTES` | `2GB` | Chromium 实例内存上限 |
| `WS_HIGH_WATER_MARK` | `1MB` | WebSocket 发送缓冲区高水位 |
| `FRAME_HEADER_SIZE` | `30` | 帧头固定字节数 |
| `FRAME_TRAILER_SIZE` | `4` | 帧尾 CRC32 字节数 |
| `COMMAND_HEADER_SIZE` | `4` | 命令头字节数 |
| `COMMAND_ALIGNMENT` | `4` | 命令对齐粒度 |
| `CRC32_POLYNOMIAL` | `0xEDB88320` | CRC32 IEEE 802.3 多项式 |

---

## 13. 开发指南

### 13.1 本地开发

```bash
# 服务端 (开发模式，带 Inspector)
cd server
node --inspect server.js

# 运行测试
node --test tests/

# 运行性能基准
node benchmark.js --iterations=100 --warmup=10
```

### 13.2 协议变更流程

当需要添加新 opcode 时，必须同步更新以下位置:

1. `cpp/frame_constants.h` — 添加枚举值
2. `client/protocol.js` — 添加 `OPCODE` 条目 + 常量子结构上限
3. `protocol/opcodes.md` — 更新 opcode 文档
4. `server/config.js` — 如需新的上限常量
5. `client/command_validator.js` — 添加子结构深度校验逻辑
6. `cpp/recording_canvas.h` — 添加对应的绘制方法

**原则**: 所有数值常量必须是三端一致的「单一事实来源」。

### 13.3 安全审计检查单

在每次发版前完成:

- [ ] 确认无新的硬编码魔法数字（必须在 config.js/garnet_config.h 中定义）
- [ ] 确认 CommandValidator 覆盖所有 opcode 的子结构校验
- [ ] 确认 Chromium 沙箱在非开发环境下保持启用
- [ ] 确认 TLS 1.3 配置未降级
- [ ] 运行 `npm test` 全部通过
- [ ] 运行 `node benchmark.js` 性能未退化
- [ ] 审查 CSP 配置未放宽
- [ ] 确认字体 Magic 白名单仅包含 SFNT/WOFF2

### 13.4 依赖项

#### 服务端

| 依赖 | 版本 | 用途 |
|------|------|------|
| `chrome-remote-interface` | ^0.33.1 | CDP 客户端 |
| `uuid` | ^9.0.1 | 会话 ID 生成 |
| `ws` | ^8.16.0 | WebSocket 服务器 |

#### 客户端

| 依赖 | 版本 | 用途 |
|------|------|------|
| `canvaskit-wasm` | ^0.39.1 | Skia WASM 渲染引擎 |
| `socket.io-client` | ^4.7.4 | WebSocket 客户端 |

### 13.5 贡献指南

1. Fork 仓库
2. 创建功能分支 (`git checkout -b feat/my-feature`)
3. 提交变更 (`git commit -m 'feat: add my feature'`)
4. 推送到分支 (`git push origin feat/my-feature`)
5. 创建 Pull Request

**提交规范**: 遵循 [Conventional Commits](https://www.conventionalcommits.org/)

---

## 附录

### A. 术语表

| 术语 | 说明 |
|------|------|
| RBI | Remote Browser Isolation，远程浏览器隔离 |
| Compositor | Chromium 渲染管线中的合成器线程 |
| PaintOp | Skia 绘制操作的结构化表示 |
| CanvasKit | Skia 图形库的 WebAssembly 移植 |
| CDP | Chrome DevTools Protocol |
| HID | Human Interface Device，人机输入设备 |
| MV3 | Chrome 扩展 Manifest V3 |
| CSP | Content Security Policy，内容安全策略 |
| mTLS | Mutual TLS，双向 TLS 认证 |
| DNR | Declarative Net Request，声明式网络请求 |
| LRU | Least Recently Used，最近最少使用缓存策略 |
| SFNT | Spline Font，TrueType/OpenType 的底层容器格式 |
| WOFF2 | Web Open Font Format 2.0，Brotli 压缩的 Web 字体格式 |
| CRC32 | 32位循环冗余校验码 |

### B. 参考资料

- [Skia 图形库](https://skia.org/)
- [CanvasKit WASM](https://www.npmjs.com/package/canvaskit-wasm)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Chrome Extension MV3](https://developer.chrome.com/docs/extensions/mv3/)
- [WebSocket Protocol (RFC 6455)](https://datatracker.ietf.org/doc/html/rfc6455)
- [IEEE 802.3 CRC32](https://en.wikipedia.org/wiki/Cyclic_redundancy_check)
- [SFNT 文件格式](https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6.html)
- [WOFF2 规范](https://www.w3.org/TR/WOFF2/)
