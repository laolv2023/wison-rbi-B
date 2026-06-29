# Garnet 模块编译指南

> **目标**: 将 Wison-RBI 的 C++ Garnet 模块集成到 Chromium M143 源码树中编译
> **Chromium 版本**: 143.0.7499.192-1 (Stable: 2025-12-02)
> **仓库**: https://github.com/laolv2023/wison-rbi-B

---

## 1. 环境要求

| 维度 | 最低要求 | 推荐 |
|------|---------|------|
| **OS** | Ubuntu 22.04 / Debian 12 | Ubuntu 22.04 LTS |
| **CPU** | 8 核 | 16 核+ |
| **内存** | 16 GB | 32 GB |
| **磁盘** | 120 GB 可用 | 200 GB SSD |
| **网络** | 可访问 `chromium.googlesource.com` | 翻墙/代理 |
| **编译时间** | ~4 小时（16 核） | ~2 小时（32 核） |

### 1.1 为什么需要这么多资源？

- **磁盘 120GB**: Chromium 源码 ~40GB + 第三方依赖 ~20GB + 编译产物 ~60GB
- **内存 16GB**: Skia 编译峰值 ~8GB + Chromium 链接器 ~4GB + 系统 ~4GB
- **CPU 8 核**: `ninja -j8` 并行编译，低于 4 核会非常慢

---

## 2. 快速开始

### 方式 A: 一键脚本（推荐）

```bash
# 1. 克隆仓库
git clone https://github.com/laolv2023/wison-rbi-B.git
cd wison-rbi-B

# 2. 赋予执行权限
chmod +x scripts/build_chromium.sh

# 3. 一键编译（自动下载源码 + 编译）
bash scripts/build_chromium.sh --run-tests

# 4. 查看编译产物
ls -la /opt/chromium/src/out/Garnet/obj/garnet/
```

### 方式 B: Docker（环境隔离）

```bash
# 1. 克隆仓库
git clone https://github.com/laolv2023/wison-rbi-B.git
cd wison-rbi-B

# 2. 构建镜像
docker compose -f docker/docker-compose.yml build

# 3. 运行编译
docker compose -f docker/docker-compose.yml run --rm chromium-builder --run-tests

# 4. 查看产物
ls -la docker/chromium-build/src/out/Garnet/obj/garnet/
```

### 方式 C: 手动步骤

```bash
# 1. 安装 depot_tools
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git /opt/depot_tools
export PATH="/opt/depot_tools:$PATH"

# 2. 下载 Chromium 源码
mkdir -p /opt/chromium && cd /opt/chromium
fetch --nohooks chromium
cd src
git checkout tags/143.0.7499.192
gclient sync --no-history -D

# 3. 放置 garnet 模块
cp /path/to/wison-rbi-B/cpp/*.h /opt/chromium/src/garnet/
cp /path/to/wison-rbi-B/cpp/*.cpp /opt/chromium/src/garnet/
cp /path/to/wison-rbi-B/cpp/BUILD.gn /opt/chromium/src/garnet/

# 4. 生成构建文件
gn gen out/Garnet --args='is_debug=false is_component_build=false'

# 5. 编译
ninja -C out/Garnet garnet
```

---

## 3. 脚本参数

`build_chromium.sh` 支持以下参数:

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--skip-fetch` | 跳过源码下载（已下载时使用） | 否 |
| `--skip-build` | 跳过编译（仅放置 garnet 模块） | 否 |
| `--run-tests` | 编译后运行测试 | 否 |
| `--jobs N` | 编译并行数 | `$(nproc)` |
| `--chromium-src PATH` | Chromium 源码路径 | `/opt/chromium/src` |
| `--help` | 显示帮助 | — |

### 3.1 常见用法

```bash
# 首次编译（下载源码 + 编译 + 测试）
bash scripts/build_chromium.sh --run-tests

# 已有源码，仅重新放置 garnet 并编译
bash scripts/build_chromium.sh --skip-fetch

# 仅放置 garnet 模块，不编译
bash scripts/build_chromium.sh --skip-fetch --skip-build

# 指定源码路径和并行数
bash scripts/build_chromium.sh --chromium-src /data/chromium/src --jobs 32

# Docker 中运行
docker compose -f docker/docker-compose.yml run --rm chromium-builder --run-tests
docker compose -f docker/docker-compose.yml run --rm chromium-builder --skip-fetch --jobs 16
```

---

## 4. 条件编译机制

Garnet 模块使用条件编译切换 Mock Skia 和真实 Skia:

```
┌─────────────────────────────────────────────────────────────┐
│  garnet_standalone.h                                        │
│                                                             │
│  #ifdef GARNET_STANDALONE  ← 独立编译/测试                  │
│    #include "test_mocks.h"    ← Mock Skia 类型              │
│  #else                      ← Chromium 集成                 │
│    #include "include/core/SkCanvas.h"  ← 真实 Skia          │
│    #include "include/core/SkPath.h"                         │
│    ...                                                      │
│  #endif                                                     │
└─────────────────────────────────────────────────────────────┘
```

| 编译模式 | 宏定义 | Skia 来源 | 用途 |
|---------|--------|----------|------|
| **独立编译** | `GARNET_STANDALONE` | `test_mocks.h`（Mock） | 单元测试、CI |
| **Chromium 集成** | `GARNET_INTEGRATED` | `//skia`（真实） | 生产环境 |

### 4.1 独立编译（测试用）

```bash
# 手动独立编译（不需要 Chromium）
g++ -std=c++20 -DGARNET_STANDALONE -Icpp/ \
    cpp/command_buffer.cpp \
    cpp/layer_recorder.cpp \
    cpp/recording_canvas.cpp \
    cpp/test_runner.cpp \
    -o garnet_tests && ./garnet_tests
```

### 4.2 Chromium 集成编译

`BUILD.gn` 中定义 `GARNET_INTEGRATED` 宏，`garnet_standalone.h` 检测到后自动 include 真实 Skia 头文件:

```gn
# cpp/BUILD.gn
static_library("garnet") {
    defines = [ "GARNET_INTEGRATED" ]
    deps = [ "//skia" ]
    # ...
}
```

---

## 5. BUILD.gn 说明

```gn
static_library("garnet") {
  sources = [
    "command_buffer.cpp",      # 命令缓冲区序列化
    "layer_recorder.cpp",      # 图层录制器
    "recording_canvas.cpp",    # SkCanvas 子类（录制绘制调用）
  ]
  defines = [ "GARNET_INTEGRATED" ]   # 使用真实 Skia
  deps = [ "//skia" ]                 # 依赖 Chromium 内置 Skia
}
```

### 5.1 挂载到 Chromium Compositor（后续步骤）

编译通过后，需要修改 Chromium 的 Compositor 代码挂载 garnet:

```cpp
// 在 //cc/layer_tree_host.cc 的 DidCommit() 中:
#include "garnet/layer_recorder.h"

void LayerTreeHost::DidCommit() {
    // ... 原有逻辑 ...
    if (garnet_recorder_) {
        garnet_recorder_->RecordFrame(root_layer());
    }
}
```

> **注意**: Compositor 挂载点的修改需要在 Chromium 源码树中完成，不在本脚本范围内。
> 参考 `AUDIT_AND_IMPL_PLAN_M143.md` 第 7 节「Compositor 挂载方案」。

---

## 6. 故障排除

### 6.1 源码下载失败

```
fatal: unable to access 'https://chromium.googlesource.com/...'
```

**解决方案**:
```bash
# 使用代理
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890

# 或使用镜像
git config --global url."https://github.com/nicehash/nicern/".insteadOf "https://chromium.googlesource.com/"
```

### 6.2 编译内存不足

```
ninja: fatal: Cannot allocate memory
```

**解决方案**:
```bash
# 减少并行数
bash scripts/build_chromium.sh --jobs 4

# 或增加 swap
sudo fallocate -l 16G /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
```

### 6.3 Skia API 不兼容

```
error: no matching function for call to 'SkCanvas::drawPicture'
```

**原因**: Mock Skia 与真实 Skia M143 的 API 签名可能存在差异。

**解决方案**:
1. 检查 `cpp/test_mocks.h` 中对应函数的签名
2. 对照 `//skia/include/core/SkCanvas.h` 的实际签名
3. 修改 `recording_canvas.cpp` 适配真实 API
4. 参考 `AUDIT_AND_IMPL_PLAN_M143.md` 第 8 节「待验证项 [U-1]~[U-5]」

### 6.4 磁盘空间不足

```bash
# 检查空间
df -h /opt/chromium

# 清理编译产物（保留源码）
rm -rf /opt/chromium/src/out/Garnet

# 清理完整 Chromium 源码
rm -rf /opt/chromium
```

### 6.5 Docker 权限问题

```bash
# 确保 docker 用户在 docker 组
sudo usermod -aG docker $USER

# 重新登录后重试
```

---

## 7. 文件索引

| 文件 | 说明 |
|------|------|
| `scripts/build_chromium.sh` | 一键编译脚本 |
| `docker/Dockerfile.chromium-builder` | Docker 编译环境镜像 |
| `docker/docker-compose.yml` | Docker Compose 配置 |
| `cpp/BUILD.gn` | GN 构建文件（Chromium 集成用） |
| `cpp/garnet_standalone.h` | 条件编译开关 |
| `cpp/garnet_config.h` | 编译时常量与硬上限 |
| `cpp/frame_constants.h` | 帧结构定义 |
| `cpp/command_buffer.h/.cpp` | 命令缓冲区序列化 |
| `cpp/layer_recorder.h/.cpp` | 图层录制器 |
| `cpp/recording_canvas.h/.cpp` | SkCanvas 子类（录制绘制调用） |
| `cpp/test_mocks.h` | Mock Skia 类型（独立编译用） |
| `cpp/test_runner.cpp` | 独立测试运行器 |
| `AUDIT_AND_IMPL_PLAN_M143.md` | 完整审计与实现方案 |

---

## 8. 验证清单

编译完成后，按以下清单验证:

- [ ] `ninja -C out/Garnet garnet` 编译成功
- [ ] `out/Garnet/obj/garnet/` 目录下有 `.o` 文件
- [ ] 独立测试通过: `g++ -DGARNET_STANDALONE ... && ./garnet_tests`
- [ ] `recording_canvas.h` 中的 `onReadPixels()` 返回 false（安全不变量）
- [ ] `command_buffer.cpp` 中的 `MAX_BYTES_PER_FRAME` 等限制值正确
- [ ] `frame_constants.h` 中 `kFrameHeaderSize == 30`

---

## 9. 下一步

1. **Compositor 挂载**: 修改 `cc/layer_tree_host.cc`，在 `DidCommit()` 中调用 `LayerRecorder::RecordFrame()`
2. **帧传输**: 将 garnet 输出的 `FrameBuffer` 通过 WebSocket 发送到客户端
3. **端到端测试**: 启动 Chromium → 访问网页 → 验证帧输出
4. **性能基准**: 测量帧延迟、CPU 占用、内存占用

参考 `AUDIT_AND_IMPL_PLAN_M143.md` 获取完整方案。
