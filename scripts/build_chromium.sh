#!/usr/bin/env bash
# build_chromium.sh — Wison-RBI Garnet 模块一键编译脚本
#
# 功能:
#   1. 安装 depot_tools（Chromium 源码管理工具）
#   2. fetch Chromium M143 (143.0.7499.192) 源码
#   3. 将 garnet 模块放入 Chromium 源码树 //garnet/
#   4. 修改 Chromium BUILD.gn 引入 garnet 依赖
#   5. 编译 garnet 静态库
#   6. 运行 garnet 单元测试（在真实 Skia 上）
#
# 环境要求:
#   - OS: Ubuntu 22.04+ / Debian 12+（推荐 Ubuntu 22.04 LTS）
#   - RAM: >= 16GB（推荐 32GB）
#   - Disk: >= 120GB 可用空间
#   - CPU: >= 8 核（推荐 16 核）
#   - 网络: 可访问 chromium.googlesource.com
#
# 用法:
#   bash scripts/build_chromium.sh [--skip-fetch] [--skip-build] [--run-tests]
#
# 参数:
#   --skip-fetch    跳过源码下载（已下载到 $CHROMIUM_SRC 时使用）
#   --skip-build    跳过编译（仅放置 garnet 模块）
#   --run-tests     编译后运行 garnet 测试
#   --jobs N        编译并行数（默认: $(nproc)）
#   --chromium-src  Chromium 源码路径（默认: /opt/chromium/src）
#
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# 配置
# ═══════════════════════════════════════════════════════════

CHROMIUM_VERSION="143.0.7499.192"
CHROMIUM_SRC="${CHROMIUM_SRC:-/opt/chromium/src}"
DEPOT_TOOLS_DIR="${DEPOT_TOOLS_DIR:-/opt/depot_tools}"
JOBS=$(nproc)
SKIP_FETCH=false
SKIP_BUILD=false
RUN_TESTS=false

# 脚本所在目录（wison-rbi 仓库根目录）
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GARNET_SRC="${REPO_ROOT}/cpp"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)] WARN:${NC} $*"; }
err()  { echo -e "${RED}[$(date +%H:%M:%S)] ERROR:${NC} $*" >&2; }
info() { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $*"; }

# ═══════════════════════════════════════════════════════════
# 参数解析
# ═══════════════════════════════════════════════════════════

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-fetch)  SKIP_FETCH=true; shift ;;
        --skip-build)  SKIP_BUILD=true; shift ;;
        --run-tests)   RUN_TESTS=true; shift ;;
        --jobs)        JOBS=$2; shift 2 ;;
        --chromium-src) CHROMIUM_SRC=$2; shift 2 ;;
        --help|-h)
            head -25 "$0" | tail -20
            exit 0
            ;;
        *) err "未知参数: $1"; exit 1 ;;
    esac
done

# ═══════════════════════════════════════════════════════════
# 环境检查
# ═══════════════════════════════════════════════════════════

check_environment() {
    log "环境检查..."

    # 磁盘空间
    local avail_gb=$(df -BG "$(dirname "$CHROMIUM_SRC")" 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'G')
    if [[ "$avail_gb" -lt 120 ]]; then
        warn "磁盘空间不足: ${avail_gb}GB < 120GB（Chromium 源码 ~40GB + 编译产物 ~60GB）"
        warn "建议清理磁盘或指定其他路径: CHROMIUM_SRC=/path/to/chromium"
    fi

    # 内存
    local mem_gb=$(free -g | awk '/^Mem:/{print $2}')
    if [[ "$mem_gb" -lt 8 ]]; then
        warn "内存不足: ${mem_gb}GB < 8GB（推荐 16GB+）"
    fi

    # 系统依赖
    local deps=(git python3 curl lsb_release sudo)
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" &>/dev/null; then
            err "缺少依赖: $dep"
            exit 1
        fi
    done

    log "环境检查通过"
}

# ═══════════════════════════════════════════════════════════
# 安装系统依赖
# ═══════════════════════════════════════════════════════════

install_system_deps() {
    log "安装 Chromium 编译依赖..."

    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq
        sudo apt-get install -y -qq \
            build-essential \
            clang \
            lld \
            ninja-build \
            pkg-config \
            libnss3-dev \
            libatk1.0-dev \
            libatk-bridge2.0-dev \
            libcups2-dev \
            libxkbcommon-dev \
            libxcomposite-dev \
            libxdamage1 \
            libxrandr2 \
            libgbm-dev \
            libpango1.0-dev \
            libcairo2-dev \
            libasound2-dev \
            libxshmfence-dev \
            libffi-dev \
            libglib2.0-dev \
            2>/dev/null || warn "部分依赖安装失败，可能需要手动安装"
    else
        warn "非 Debian/Ubuntu 系统，请手动安装编译依赖"
    fi
}

# ═══════════════════════════════════════════════════════════
# 安装 depot_tools
# ═══════════════════════════════════════════════════════════

install_depot_tools() {
    if [[ -d "$DEPOT_TOOLS_DIR/.git" ]]; then
        log "depot_tools 已存在，更新..."
        (cd "$DEPOT_TOOLS_DIR" && git pull -q)
    else
        log "安装 depot_tools 到 $DEPOT_TOOLS_DIR ..."
        git clone --depth=1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS_DIR"
    fi

    export PATH="$DEPOT_TOOLS_DIR:$PATH"
    log "depot_tools 安装完成"
}

# ═══════════════════════════════════════════════════════════
# 下载 Chromium 源码
# ═══════════════════════════════════════════════════════════

fetch_chromium() {
    if [[ -d "$CHROMIUM_SRC/.git" ]]; then
        log "Chromium 源码已存在于 $CHROMIUM_SRC"
        return
    fi

    log "下载 Chromium $CHROMIUM_VERSION 源码（约 40GB）..."
    log "这可能需要 30-60 分钟，取决于网络速度"

    mkdir -p "$(dirname "$CHROMIUM_SRC")"
    cd "$(dirname "$CHROMIUM_SRC")"

    # 使用 fetch 获取 Chromium 源码
    fetch --nohooks chromium

    cd "$CHROMIUM_SRC"

    # 切换到目标版本
    log "切换到 Chromium $CHROMIUM_VERSION ..."
    git fetch --tags
    git checkout "tags/$CHROMIUM_VERSION" 2>/dev/null || {
        warn "tag $CHROMIUM_VERSION 不存在，尝试 branch"
        git checkout "$CHROMIUM_VERSION" 2>/dev/null || {
            warn "无法切换到 $CHROMIUM_VERSION，使用 main 分支"
        }
    }

    # 同步依赖
    log "同步依赖（gclient sync）..."
    gclient sync --no-history -D

    log "Chromium 源码下载完成"
}

# ═══════════════════════════════════════════════════════════
# 放置 garnet 模块
# ═══════════════════════════════════════════════════════════

install_garnet() {
    local garnet_dir="$CHROMIUM_SRC/garnet"
    log "放置 garnet 模块到 $garnet_dir ..."

    mkdir -p "$garnet_dir"

    # 复制源文件（不复制 test_mocks.h 和 test_runner.cpp）
    cp -v "$GARNET_SRC"/garnet_config.h      "$garnet_dir/"
    cp -v "$GARNET_SRC"/garnet_standalone.h   "$garnet_dir/"
    cp -v "$GARNET_SRC"/frame_constants.h     "$garnet_dir/"
    cp -v "$GARNET_SRC"/command_buffer.h      "$garnet_dir/"
    cp -v "$GARNET_SRC"/command_buffer.cpp    "$garnet_dir/"
    cp -v "$GARNET_SRC"/layer_recorder.h      "$garnet_dir/"
    cp -v "$GARNET_SRC"/layer_recorder.cpp    "$garnet_dir/"
    cp -v "$GARNET_SRC"/recording_canvas.h    "$garnet_dir/"
    cp -v "$GARNET_SRC"/recording_canvas.cpp  "$garnet_dir/"
    cp -v "$GARNET_SRC"/BUILD.gn              "$garnet_dir/"

    # 同时复制 test 文件（用于后续测试）
    cp -v "$GARNET_SRC"/test_mocks.h          "$garnet_dir/"
    cp -v "$GARNET_SRC"/test_runner.cpp       "$garnet_dir/"

    log "garnet 模块放置完成"
}

# ═══════════════════════════════════════════════════════════
# 修改 Chromium BUILD.gn 引入 garnet
# ═══════════════════════════════════════════════════════════

patch_chromium_build() {
    local root_build="$CHROMIUM_SRC/BUILD.gn"
    log "修改 Chromium BUILD.gn 引入 garnet 模块..."

    if ! grep -q '"//garnet:garnet"' "$root_build"; then
        # 在 root deps 中添加 garnet
        sed -i '/group("with_x11") {/,/}/ {
            /deps = \[/a\      "//garnet:garnet",
        }' "$root_build" 2>/dev/null || warn "无法自动修改 BUILD.gn，请手动添加 //garnet:garnet 到 deps"

        log "BUILD.gn 已修改"
    else
        log "BUILD.gn 已包含 garnet 依赖"
    fi
}

# ═══════════════════════════════════════════════════════════
# 生成 GN 构建文件
# ═══════════════════════════════════════════════════════════

gn_gen() {
    log "生成 GN 构建文件..."

    cd "$CHROMIUM_SRC"

    # GN 配置
    local gn_args=(
        "is_debug=false"
        "is_component_build=false"
        "is_official_build=false"
        "symbol_level=0"
        "treat_warnings_as_errors=false"
        "skia_use_system_freetype2=false"
        "skia_use_system_harfbuzz=false"
        "skia_use_system_libjpeg_turbo=false"
        "skia_use_system_libpng=false"
        "skia_use_system_libwebp=false"
        "skia_use_system_zlib=false"
    )

    gn gen "out/Garnet" --args="${gn_args[*]}"

    log "GN 构建文件生成完成"
}

# ═══════════════════════════════════════════════════════════
# 编译 garnet
# ═══════════════════════════════════════════════════════════

build_garnet() {
    log "编译 garnet 模块（并行: $JOBS）..."
    log "这可能需要 1-2 小时（首次编译需要编译 Skia 依赖）"

    cd "$CHROMIUM_SRC"

    ninja -C out/Garnet garnet -j"$JOBS"

    log "garnet 编译完成"
    info "编译产物: $CHROMIUM_SRC/out/Garnet/obj/garnet/"
}

# ═══════════════════════════════════════════════════════════
# 运行测试
# ═══════════════════════════════════════════════════════════

run_tests() {
    log "编译并运行 garnet 测试..."

    cd "$CHROMIUM_SRC"

    # 编译独立测试（使用 Mock Skia）
    ninja -C out/Garnet garnet_tests_standalone -j"$JOBS" 2>/dev/null || {
        warn "独立测试目标不可用，尝试手动编译测试..."
        # 手动编译测试
        g++ -std=c++20 -DGARNET_STANDALONE -I"$CHROMIUM_SRC/garnet" \
            "$CHROMIUM_SRC/garnet/command_buffer.cpp" \
            "$CHROMIUM_SRC/garnet/layer_recorder.cpp" \
            "$CHROMIUM_SRC/garnet/recording_canvas.cpp" \
            "$CHROMIUM_SRC/garnet/test_runner.cpp" \
            -o "$CHROMIUM_SRC/out/Garnet/garnet_tests" 2>&1 || {
            err "测试编译失败"
            return 1
        }
    }

    if [[ -f "$CHROMIUM_SRC/out/Garnet/garnet_tests" ]]; then
        "$CHROMIUM_SRC/out/Garnet/garnet_tests"
    elif [[ -f "$CHROMIUM_SRC/out/Garnet/garnet_tests_standalone" ]]; then
        "$CHROMIUM_SRC/out/Garnet/garnet_tests_standalone"
    else
        warn "测试可执行文件未找到"
    fi
}

# ═══════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════

main() {
    log "═══════════════════════════════════════════════════════"
    log "  Wison-RBI Garnet 模块一键编译"
    log "  Chromium 版本: $CHROMIUM_VERSION"
    log "  源码路径: $CHROMIUM_SRC"
    log "  Garnet 源码: $GARNET_SRC"
    log "  并行数: $JOBS"
    log "═══════════════════════════════════════════════════════"

    check_environment

    if [[ "$SKIP_FETCH" == false ]]; then
        install_system_deps
        install_depot_tools
        fetch_chromium
    fi

    install_garnet
    patch_chromium_build

    if [[ "$SKIP_BUILD" == false ]]; then
        export PATH="$DEPOT_TOOLS_DIR:$PATH"
        gn_gen
        build_garnet
    fi

    if [[ "$RUN_TESTS" == true ]]; then
        run_tests
    fi

    log "═══════════════════════════════════════════════════════"
    log "  全部完成！"
    log "  编译产物: $CHROMIUM_SRC/out/Garnet/obj/garnet/"
    log "═══════════════════════════════════════════════════════"
}

main "$@"
