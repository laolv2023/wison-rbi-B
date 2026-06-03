// background.js — Wison-RBI Service Worker (MV3)
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
// 当 declarativeNetRequest 静态规则未命中时，使用 tabs.update 兜底
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 仅在 URL 变化且不是扩展页面时触发
    if (!changeInfo.url) return;
    if (changeInfo.url.startsWith('chrome-extension://')) return;
    if (changeInfo.url.includes('wison-rbi-bypass')) return;

    // 构建重定向 URL
    const redirectUrl = `${EXTENSION_PAGE}?url=${encodeURIComponent(changeInfo.url)}`;

    // 更新标签页
    chrome.tabs.update(tabId, { url: redirectUrl }).catch(err => {
        // 可能因为权限不足而失败 — 此时依赖 declarativeNetRequest 规则
        console.debug('[wison-rbi] tabs.update fallback failed:', err.message);
    });
});

// ── 例外站点管理 ──
// 用户可通过 storage API 配置不需要 RBI 隔离的站点

async function updateExcludedDomains() {
    try {
        const result = await chrome.storage.local.get(['excludedDomains']);
        const excludedDomains = result.excludedDomains || [];

        if (excludedDomains.length === 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: Array.from({ length: 1000 }, (_, i) => 1000 + i),
            });
            return;
        }

        const rules = excludedDomains.map((domain, i) => ({
            id: 1000 + i,
            priority: 100,
            action: { type: 'allow' },
            condition: {
                urlFilter: `*://*.${domain}/*`,
                resourceTypes: ['main_frame', 'sub_frame'],
            },
        }));

        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: Array.from({ length: 1000 }, (_, i) => 1000 + i),
            addRules: rules,
        });
    } catch (err) {
        console.error('[wison-rbi] Failed to update dynamic rules:', err);
    }
}

// ── 初始化 ──
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[wison-rbi] Extension installed');
    await updateExcludedDomains();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('[wison-rbi] Extension started');
    await updateExcludedDomains();
});

// 监听 storage 变化，动态更新例外域名规则
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.excludedDomains) {
        updateExcludedDomains();
    }
});

// ── 消息处理 ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'getExcludedDomains':
            chrome.storage.local.get(['excludedDomains'], (result) => {
                sendResponse({ domains: result.excludedDomains || [] });
            });
            return true;  // 异步响应

        case 'addExcludedDomain':
            chrome.storage.local.get(['excludedDomains'], async (result) => {
                const domain = String(message.domain || '').trim().toLowerCase();
                // 域名格式校验：仅允许字母、数字、连字符、点（防止注入特殊字符）
                if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)) {
                    sendResponse({ success: false, error: 'Invalid domain format' });
                    return;
                }
                const domains = result.excludedDomains || [];
                if (!domains.includes(domain)) {
                    domains.push(domain);
                    await chrome.storage.local.set({ excludedDomains: domains });
                }
                sendResponse({ success: true });
            });
            return true;

        case 'removeExcludedDomain':
            chrome.storage.local.get(['excludedDomains'], async (result) => {
                const domains = (result.excludedDomains || [])
                    .filter(d => d !== message.domain);
                await chrome.storage.local.set({ excludedDomains: domains });
                sendResponse({ success: true });
            });
            return true;

        default:
            sendResponse({ error: 'Unknown message type' });
            return false;
    }
});
