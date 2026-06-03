# Wison-RBI 部署指南 (Phase 5)

> 生产环境部署参考文档。覆盖服务端、客户端和 Chromium 沙箱配置。

## 目录

1. [系统要求](#1-系统要求)
2. [服务端部署](#2-服务端部署)
3. [客户端部署](#3-客户端部署)
4. [TLS 配置](#4-tls-配置)
5. [Chromium 沙箱加固](#5-chromium-沙箱加固)
6. [监控与告警](#6-监控与告警)
7. [故障排查](#7-故障排查)
8. [性能调优](#8-性能调优)

---

## 1. 系统要求

### 服务端

| 资源 | 最低 | 推荐 |
|------|------|------|
| CPU | 4 核 (x86_64) | 8+ 核 |
| 内存 | 8 GB | 16 GB+ (每并发会话 +2GB) |
| 磁盘 | 20 GB | SSD 50 GB+ |
| 操作系统 | Linux (kernel ≥5.4) | Ubuntu 22.04 LTS / Debian 12 |
| Node.js | ≥18.0 | 20.x LTS |
| Chromium | ≥M120 (headless) | 与 CanvasKit 同 Milestone |

### 客户端

| 资源 | 要求 |
|------|------|
| 浏览器 | Chrome/Chromium ≥ M120 (支持 MV3 + WebCodecs) |
| 内存 | ≥512 MB 可用 (WASM heap) |
| GPU | WebGL 2.0 支持 |
| 网络 | 稳定连接，延迟 <100ms RTT 推荐 |

---

## 2. 服务端部署

### 2.1 安装

```bash
# 克隆仓库
git clone https://github.com/laolv2023/wison-rbi-B.git
cd wison-rbi-B/server

# 安装依赖
npm ci --production

# 安装 Chromium
# Ubuntu/Debian:
sudo apt-get install -y chromium-browser

# 或使用 npx 安装特定版本:
npx @puppeteer/browsers install chromium@latest
```

### 2.2 配置

```bash
# 环境变量 (.env 或直接在 shell 中设置)
export PORT=3000
export CHROMIUM_PATH=/usr/bin/chromium
export MAX_SESSIONS=4

# TLS (生产环境必须)
export WISON_TLS_ENABLED=1
export WISON_TLS_CERT=/etc/ssl/certs/wison-rbi-fullchain.pem
export WISON_TLS_KEY=/etc/ssl/private/wison-rbi-privkey.pem

# 日志级别 (DEBUG/INFO/WARN/ERROR)
export LOG_LEVEL=INFO
```

### 2.3 启动

```bash
# 直接启动
node server.js

# 使用 systemd (推荐)
sudo cp deploy/wison-rbi.service /etc/systemd/system/
sudo systemctl enable --now wison-rbi
```

### 2.4 systemd 单元文件

```ini
# /etc/systemd/system/wison-rbi.service
[Unit]
Description=Wison-RBI Browser Isolation Server
After=network.target

[Service]
Type=simple
User=wison-rbi
WorkingDirectory=/opt/wison-rbi/server
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=CHROMIUM_PATH=/usr/bin/chromium
Environment=WISON_TLS_ENABLED=1
Environment=WISON_TLS_CERT=/etc/ssl/certs/wison-rbi-fullchain.pem
Environment=WISON_TLS_KEY=/etc/ssl/private/wison-rbi-privkey.pem
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

---

## 3. 客户端部署

### 3.1 Chrome 扩展 (MV3) 安装

```bash
cd wison-rbi-B/client
npm ci --production
```

**加载扩展:**

1. 打开 `chrome://extensions`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `client/` 目录

### 3.2 配置扩展

修改 `client/index.js` 中的 `CONFIG.SERVER_URL`:

```javascript
const CONFIG = Object.freeze({
    SERVER_URL: 'wss://your-server.example.com:3000',
    // ...
});
```

### 3.3 企业部署 (GPO)

可通过 Chrome 策略 `ExtensionInstallForcelist` 强制安装:

```json
{
  "ExtensionInstallForcelist": [
    "<extension-id>;https://clients2.google.com/service/update2/crx"
  ]
}
```

---

## 4. TLS 配置

### 4.1 证书生成

```bash
# 使用 Let's Encrypt (推荐)
sudo certbot certonly --standalone -d wison-rbi.example.com

# 证书路径
# 完整链: /etc/letsencrypt/live/wison-rbi.example.com/fullchain.pem
# 私钥:   /etc/letsencrypt/live/wison-rbi.example.com/privkey.pem
```

### 4.2 自签名证书 (测试用)

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj "/CN=localhost"
```

### 4.3 mTLS (双向认证, 可选)

设置 `WISON_TLS_CA` 环境变量启用客户端证书验证:

```bash
export WISON_TLS_CA=/etc/ssl/certs/client-ca.pem
```

---

## 5. Chromium 沙箱加固

### 5.1 推荐启动参数

```bash
chromium \
  --headless=new \
  --no-sandbox=false \          # 绝不为 false
  --disable-gpu \               # 无头模式通常不需要 GPU
  --disable-dev-shm-usage \     # 避免 /dev/shm 空间不足
  --disable-setuid-sandbox \
  --max_old_space_size=2048 \   # V8 堆上限 (MB)
  --disable-background-networking \
  --disable-sync \
  --disable-default-apps \
  --no-first-run \
  --remote-debugging-port=0     # CDP 端口由管理器动态分配
```

### 5.2 网络隔离 (可选)

```bash
# 使用 network namespace 隔离 Chromium 实例
ip netns add wison-session-1
ip netns exec wison-session-1 chromium --headless=new ...
```

---

## 6. 监控与告警

### 6.1 健康检查

```bash
# 基础健康检查
curl https://localhost:3000/health
# → {"status":"ok","sessions":2,"uptime":3600.5,"tls":true}

# 完整指标
curl https://localhost:3000/metrics
# → { uptime_seconds, counters, gauges, histograms }
```

### 6.2 告警规则

| 规则 | 条件 | 严重级别 |
|------|------|----------|
| 高帧丢弃率 | 丢弃/发送 > 10% | WARN |
| CRC 失败异常 | 失败/发送 > 5% | CRITICAL |
| 会话饱和 | 活跃 ≥ 4/4 | WARN |
| 高频背压 | >5 次/分钟 | WARN |

### 6.3 日志审计

- 会话创建/销毁: 含 sessionId, client IP
- 帧发送: frameId, compressedSize, commandCount
- 输入事件: 不含页面语义，仅坐标/按键类型
- 安全事件: CRC 失败, opcode 拒绝, zip bomb 防护触发

---

## 7. 故障排查

| 症状 | 可能原因 | 解决 |
|------|---------|------|
| 客户端白屏 | CanvasKit 加载失败 | 检查 CDN/本地路径，确认 MIME 类型 |
| 连接立即断开 | TLS 证书无效 | 检查证书路径，确认客户端信任 CA |
| 画面不更新 | 帧被丢弃 | 检查 `MAX_COMPRESSED_FRAME`、网络带宽 |
| Chromium 频繁重启 | OOM | 增加服务器内存 / 降低 `MAX_SESSIONS` |
| 增量帧异常 | frame_id 不连续 | 检查是否触发 `request_keyframe` |
| 字体显示错乱 | 字体 Magic 校验失败 | 检查 `font_validator.js` 日志 |

### 诊断命令

```bash
# 检查 Chromium 进程
ps aux | grep chromium

# 检查端口监听
ss -tlnp | grep 3000

# 检查日志
journalctl -u wison-rbi -f

# 运行基准测试
cd server && node benchmark.js
```

---

## 8. 性能调优

### 8.1 并发优化

```bash
# 增加 Chromium 实例数
export MAX_SESSIONS=8

# 调整 Node.js 内存
node --max-old-space-size=4096 server.js
```

### 8.2 网络优化

- 启用 TCP BBR: `sysctl -w net.ipv4.tcp_congestion_control=bbr`
- 调整 somaxconn: `sysctl -w net.core.somaxconn=4096`
- WebSocket 压缩: 帧已在应用层 gzip 压缩，不启用 WS permessage-deflate

### 8.3 基准测试

```bash
cd server
node benchmark.js --iterations=500

# 预期结果 (Phase 3 目标):
#   帧组装: <2ms (medium 帧)
#   gzip 压缩: 压缩比 10-50%
#   首帧带宽: <1MB (1MB raw → gzip)
#   增量帧带宽: <50KB (1KB raw → gzip)
#   CRC32: >500 MB/s
```

---

> **部署清单**:
> - [ ] 服务端安装 Node.js 20.x + Chromium M120+
> - [ ] TLS 证书配置并验证
> - [ ] systemd 服务单元创建并启用
> - [ ] 客户端扩展加载并配置 SERVER_URL
> - [ ] 健康检查端点可访问
> - [ ] 基准测试通过
> - [ ] 告警规则配置
