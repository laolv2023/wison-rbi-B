// ============================================================================
// background.js — Wison-RBI Service Worker (Chrome Extension MV3)
// ============================================================================
//
// 角色（Role）：
//   - 作为 Chrome 扩展的后台 Service Worker，在扩展生命周期内持续运行
//   - 通过 declarativeNetRequest 静态规则 + tabs.update 动态兜底 拦截 HTTP 请求
//   - 将所有非例外站点的导航请求重定向到 RBI 沙箱页面
//   - 管理用户配置的例外站点白名单（通过 chrome.storage API）
//
// 安全不变量（Security Invariants）：
//   - 本 Service Worker 不读取、不修改、不注入任何页面内容
//   - 仅操作导航 URL 的重定向，不拦截子资源请求（由 rules.json 限定 resourceTypes）
//   - 自扩展页面（chrome-extension://）绝不拦截，防止无限重定向循环
//   - 带有 wison-rbi-bypass 标记的 URL 放行，防止已重定向页面再次触发
//   - 例外域名通过 storage.local 管理，添加时进行严格的正则格式校验
//   - 消息处理中的域名输入经过 trim().toLowerCase() 和正则过滤
//   - 动态规则 ID 范围锁定在 [1000, 1999]，避免与静态规则冲突
//   - 所有异步操作错误均通过 console.debug/error 记录，不抛出未捕获异常
//
// MV3 架构约束：
//   - webRequestBlocking 已移除，主拦截依赖 declarativeNetRequest
//   - Service Worker 可能被浏览器随时终止，不能依赖内存状态
//   - tabs.update 作为 DNR 静态规则未命中时的动态兜底方案
//   - 声明周期事件（onInstalled / onStartup）负责初始化动态规则
//
// 职责:
//   1. 通过 declarativeNetRequest + tabs.update 拦截 HTTP 请求
//   2. 将用户重定向到 RBI 沙箱页面
//   3. 管理例外站点（通过 storage API）
//
// MV3 限制:
//   - webRequestBlocking 已移除，依赖 declarativeNetRequest
//   - tabs.update 作为动态重定向的兜底方案
//
// 安全:
//   - 不读取/修改页面内容
//   - 仅操作 URL 重定向
//

'use strict';

const EXTENSION_PAGE = chrome.runtime.getURL('index.html');
const EXTENSION_ID = chrome.runtime.id;

// ── 监听标签页更新，确保重定向生效 ──
//
// 设计原理：
//   declarativeNetRequest（DNR）是 MV3 优先推荐的重定向机制，但存在以下局限：
//   1. DNR 规则对某些边缘情况（如 about:blank、javascript: URL）不适用
//   2. DNR 规则的 URL 过滤模式有限（不支持动态正则替换）
//   tabs.update 作为兜底方案，确保尽可能多的情况被拦截
//
// 防护逻辑：
//   - 仅在 URL 变化时触发（!changeInfo.url → return）
//   - 不拦截扩展自页面（chrome-extension://），防止重定向死循环
//   - 放行带有 bypass 标记的 URL（避免已重定向页面再次触发）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 仅在 URL 变化且不是扩展页面时触发
    if (!changeInfo.url) return;
    if (changeInfo.url.startsWith('chrome-extension://')) return;
    if (changeInfo.url.includes('wison-rbi-bypass')) return;

    // 构建重定向 URL —— 目标页面为扩展内置的 index.html
    // 原始 URL 作为查询参数传递，由 index.js 解析后在隔离环境中加载
    const redirectUrl = `${EXTENSION_PAGE}?url=${encodeURIComponent(changeInfo.url)}`;

    // 更新标签页 —— catch 处理执行失败的情况
    // 典型失败场景：受保护页面（chrome://、edge://等）不允许扩展导航
    chrome.tabs.update(tabId, { url: redirectUrl }).catch(err => {
        // 可能因为权限不足而失败 — 此时依赖 declarativeNetRequest 规则
        console.debug('[wison-rbi] tabs.update fallback failed:', err.message);
    });
});

// ── 例外站点管理 ──
//
// 设计原理：
//   用户可通过 storage API 配置不需要 RBI 隔离的站点的域名白名单
//   每个例外域名生成一条 DNR 动态规则（priority=100，高于静态规则的 priority=1）
//   规则使用 'allow' 动作放行匹配的导航请求，防止被重定向
//
// 规则 ID 策略：
//   动态规则 ID 范围：[1000, 1999]（共 1000 条可用）
//   静态规则 ID 范围：[1, 999]（避免冲突）
//   每次更新时先清空所有动态规则（ID 1000-1999），再重新添加
//
// 安全：
//   - 域名来自用户配置，需经过格式校验后才生成规则
//   - 规则限制 resourceTypes 为 main_frame 和 sub_frame，不放过子资源请求
async function updateExcludedDomains() {
    try {
        // 从 storage.local 读取例外域名列表
        const result = await chrome.storage.local.get(['excludedDomains']);
        const excludedDomains = result.excludedDomains || [];

        // 无例外域名时：清空所有动态规则
        if (excludedDomains.length === 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: Array.from({ length: 1000 }, (_, i) => 1000 + i),
            });
            return;
        }

        // 将每个域名转换为一条 DNR 'allow' 规则
        const rules = excludedDomains.map((domain, i) => ({
            id: 1000 + i,               // 动态规则 ID（1000-1999）
            priority: 100,              // 高于静态规则的 priority: 1，确保优先执行
            action: { type: 'allow' },  // 放行，不重定向
            condition: {
                urlFilter: `*://*.${domain}/*`,  // 匹配该域名及其子域名
                resourceTypes: ['main_frame', 'sub_frame'],  // 仅限导航请求
            },
        }));

        // 原子操作：先删除旧规则，再添加新规则
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: Array.from({ length: 1000 }, (_, i) => 1000 + i),
            addRules: rules,
        });
    } catch (err) {
        console.error('[wison-rbi] Failed to update dynamic rules:', err);
    }
}

// ── 初始化与生命周期 ──
//
// onInstalled：扩展安装或更新时触发
//   - 首次安装、Chrome 在线更新扩展时均触发
//   - 在此恢复动态规则（Service Worker 可能在空闲时终止）
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[wison-rbi] Extension installed');
    await updateExcludedDomains();
});

// onStartup：浏览器启动时触发（在 Service Worker 注册后）
//   - 确保每次浏览器启动后动态规则都处于正确状态
chrome.runtime.onStartup.addListener(async () => {
    console.log('[wison-rbi] Extension started');
    await updateExcludedDomains();
});

// storage.onChanged：监听例外域名配置变更
//   - 用户在扩展弹出窗口或选项页修改例外站点时实时触发
//   - 仅监听 local storage 区域的 excludedDomains 键
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.excludedDomains) {
        updateExcludedDomains();
    }
});

// ── 消息处理 ──
//
// 支持的消息类型（由扩展弹出窗口或选项页面发送）：
//   1. getExcludedDomains  — 获取当前例外域名列表
//   2. addExcludedDomain   — 添加一个例外域名（含格式校验）
//   3. removeExcludedDomain — 从例外列表移除一个域名
//
// 安全措施：
//   - addExcludedDomain 中强制 String 转换 + trim + toLowerCase
//   - 正则校验：仅通过符合 RFC 1035 格式的域名（字母/数字/连字符/点）
//   - 防止路径注入、特殊字符注入、空字符串
//   - 异步响应通过 return true 告知 Chrome 保持消息通道开启
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'getExcludedDomains':
            // 从 storage.local 读取，直接回传
            chrome.storage.local.get(['excludedDomains'], (result) => {
                sendResponse({ domains: result.excludedDomains || [] });
            });
            return true;  // 保持消息通道开启，等待异步 sendResponse

        case 'addExcludedDomain':
            // 读取、校验、去重后写入 storage
            chrome.storage.local.get(['excludedDomains'], async (result) => {
                // 强制转字符串并标准化
                const domain = String(message.domain || '').trim().toLowerCase();
                // 域名格式校验：仅允许字母、数字、连字符、点（防止注入特殊字符）
                if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)) {
                    sendResponse({ success: false, error: 'Invalid domain format' });
                    return;
                }
                const domains = result.excludedDomains || [];
                // 去重检查：避免重复添加
                if (!domains.includes(domain)) {
                    domains.push(domain);
                    await chrome.storage.local.set({ excludedDomains: domains });
                }
                sendResponse({ success: true });
            });
            return true;  // 异步响应

        case 'removeExcludedDomain':
            // 过滤移除指定域名后写回 storage
            chrome.storage.local.get(['excludedDomains'], async (result) => {
                const domains = (result.excludedDomains || [])
                    .filter(d => d !== message.domain);
                await chrome.storage.local.set({ excludedDomains: domains });
                sendResponse({ success: true });
            });
            return true;

        default:
            // 未知消息类型 —— 返回错误，不保持通道开启
            sendResponse({ error: 'Unknown message type' });
            return false;
    }
});
