# Wison-RBI

## 基于 Chromium Compositor 层拦截的浏览器隔离系统

> **代码版本**: v1.6 (基于设计方案 v1.6 第二轮安全审计修复版)
> **状态**: 生产级实现

Wison-RBI 是一个浏览器隔离（Browser Isolation）系统，通过在 Chromium Compositor 层拦截绘制命令，使客户端浏览器不必执行任何远程 HTML/CSS/JavaScript，仅接收经过安全校验的 Skia 绘制命令。

### 与 Cloudflare NVR 的关键区别

| 维度 | Cloudflare NVR | Wison-RBI |
|------|---------------|-----------|
| 拦截层级 | Skia API | Compositor 层 (cc::DisplayItemList/PaintOp) |
| Chromium 修改范围 | ~15 个文件 | 1-2 个文件 + 独立 RecordingCanvas |
| 客户端引擎 | 专有 WASM | CanvasKit WASM (开源标准 Skia) |
| 增量更新 | 未公开 | R-tree 空间索引驱动 |
| 可审计性 | 闭源 | 全链路开源 |

---

## 项目结构

```
wison-rbi/
├── cpp/                          # C++ Chromium 补丁层
│   ├── garnet_config.h           # 编译时常量、硬上限定义
│   ├── frame_constants.h         # 帧头结构体、opcode 枚举、协议常量
│   ├── command_buffer.h          # CommandBuffer 声明
│   ├── command_buffer.cpp        # CommandBuffer 实现 (序列化/CRC32)
│   ├── recording_canvas.h        # RecordingCanvas 声明 (31个方法)
│   └── layer_recorder.h          # LayerRecorder + FrameAssembler
├── server/                       # Node.js 服务端
│   ├── package.json
│   ├── config.js                 # 运行时配置常量
│   ├── server.js                 # 入口: WebSocket + 会话路由
│   ├── session.js                # 会话管理 + frame_id 计数器
│   ├── io_proxy.js               # CDP 输入代理 (HID→CDP)
│   ├── chromium_manager.js       # Chromium 进程池管理
│   ├── frame_builder.js          # 帧组装 + CRC32 + gzip
│   └── font_validator.js         # SFNT/WOFF2 Magic 校验
├── client/                       # Chrome 扩展 (MV3) 客户端
│   ├── package.json
│   ├── manifest.json             # MV3 扩展清单
│   ├── rules.json                # declarativeNetRequest 规则
│   ├── background.js             # Service Worker (MV3)
│   ├── index.html                # 入口页面
│   ├── index.js                  # 主控制器: 帧处理 + HID
│   ├── command_validator.js      # 命令白名单 + 深度校验
│   ├── protocol.js               # 协议常量
│   ├── utils.js                  # CRC32, gzip, 日志
│   ├── font_registry.js          # 客户端字体 LRU
│   └── image_cache.js            # 图像 LRU 缓存
├── protocol/
│   └── opcodes.md                # Opcode 完整定义
└── README.md
```

---

## 快速开始

### 前置条件

- **服务端**: Node.js ≥ 18, Chromium (headless)
- **客户端**: Chrome/Chromium ≥ 120 (支持 MV3), CanvasKit WASM

### 安装

```bash
# 服务端
cd server
npm install

# 客户端
cd client
npm install
```

### 启动

```bash
# 服务端 (默认端口 3000)
cd server
CHROMIUM_PATH=/usr/bin/chromium PORT=3000 node server.js

# 客户端 — 在 Chrome 中加载扩展:
# 1. 打开 chrome://extensions
# 2. 启用"开发者模式"
# 3. "加载已解压的扩展程序" → 选择 client/ 目录
```

---

## 安全模型

### 三条核心不变量

1. **客户端收到的每个字节**只能是：合法 Skia 绘制命令（经白名单校验）或帧元数据（frame_id, scroll, viewport）
2. **客户端发出的每个字节**只能是：原始 HID 事件或帧引用（frame_id，不含页面语义）
3. **所有页面内容**仅在服务端 Chromium 沙箱内执行，不向客户端传输 HTML/CSS/JS

### 威胁模型

| 威胁 | 对策 |
|------|------|
| 恶意网页 | Chromium 沙箱隔离；客户端不接触原始内容 |
| 信道中间人 | TLS 1.3 + 命令格式校验 + CRC32 |
| 服务端被入侵 | 客户端命令白名单 + 参数范围校验 |
| 侧信道攻击 | readPixels 禁用；±1ms 渲染抖动 (Phase 2) |
| gzip zip bomb | 三层防护: 压缩大小/流式解压/压缩比异常检测 |

---

## 关键安全实现

### CommandValidator（客户端命令白名单）

- **Opcode 白名单**: 0x01-0x7F 合法，≥0x80 一律拒绝
- **Payload 硬上限**: 单命令 ≤ 1MB
- **帧级硬上限**: 全帧 ≤ 64MB (v1.6 P0 S1)
- **Save/Restore 配对**: 深度计数平衡验证
- **Payload 子结构深度校验**: 防止 count 伪造导致的 OOM
- **连续拒绝 ≥3 帧** → 自动 request_keyframe

### 字体格式校验 (v1.6 P1 S4)

仅接受 SFNT (TrueType/OpenType/Collection) 或 WOFF2 格式。Magic 字节白名单:
- `0x00010000` — TrueType
- `OTTO` — OpenType CFF
- `true` — TrueType (Apple)
- `ttcf` — TrueType Collection
- `wOF2` — WOFF2

校验失败 → 替换为 CanvasKit 回退字体 (font_id=0)

---

## 协议

### 帧格式（二进制）

```
[30B Header] [N B CommandStream] [4B CRC32]

CRC32: Header + CommandStream，多项式 0xEDB88320 (IEEE 802.3)
```

### 命令格式

```
[1B Opcode] [3B PayloadLength (uint24 LE)] [N B Payload]

4 字节对齐
```

详见 [protocol/opcodes.md](protocol/opcodes.md)

---

## 性能指标

| 指标 | Phase 1 目标 | 实现策略 |
|------|-------------|---------|
| 端到端延迟 | <150ms | 异步 CDP + 流水线化 |
| 帧生成延迟 | <5ms | Compositor 线程录制 + Worker 线程编码 |
| 带宽 (首帧) | <3MB gzip | 原生 zlib + hash-ref 去重 |
| 客户端 CPU | <30% @60fps | requestAnimationFrame 调度 |
| 客户端内存 | <256MB | 字体 LRU(64MB) + 图像 LRU(64MB) |

---

## License

MIT
