/**
 * Temu 数据采集 - background.js v5.0
 * 职责：Manifest V3 Service Worker 保活 + popup/content 消息中转
 */

// ─── Service Worker 保活 ──────────────────────────────────
// MV3 的 SW 会在 30s 无活动后被浏览器挂起，用 alarm 定期唤醒

// 扩展首次安装/更新时注册保活 alarm。MV3 SW 长时间空闲会被浏览器挂起，
// 挂起后丢失 popupPorts 引用，popup 就收不到进度推送。周期性 alarm 触发 onAlarm 就足以
// 让浏览器把 SW 唤醒（函数体留空即可，不需要干实事）。
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // 每 24 秒触发
});

// keepAlive 闹钟的消费端：触发即满足唤醒条件，不需要做其他事。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // 只是唤醒，不做任何事
  }
});

// ─── 消息中转（content.js → popup）────────────────────────
// MV3 中 content script 无法直接向 popup 发消息
// content.js 调用 chrome.runtime.sendMessage → background 收到 → 转给所有 port

const popupPorts = new Set();
const BACKEND_BASE_URL = 'http://192.168.31.71:8000';
const TEMU_TAB_QUERY = { url: '*://*.temu.com/*' };

/**
 * popup 打开时会建立一条长连接（port.name === 'popup'），SW 保留引用用于"主动推送"。
 * popup 关闭时连接断开，自动从 set 里移除，防止内存里挂着无效 port 反复抛 "Attempting to use
 * a disconnected port" 错误。
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'popup') {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));
  }
});

/**
 * 全局消息路由。背景页同时承担 3 类消息的中转：
 *   1. progressActions：content.js 的进度推送 → 广播给所有已连接的 popup port；
 *   2. backendActions：content.js 要调后端 HTTP 接口 → 走 fetch（放在 SW 避免跨域/CORS 问题）；
 *   3. controlActions：popup 的控制指令 → 定位 Temu 标签页并 sendMessage 过去。
 * 异步分支必须 return true 保持 sendResponse 通道打开，否则 Chrome 会立刻关闭端口。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content.js 发来的进度通知 → 转发给 popup
  const progressActions = [
    'stateSync',
    'navigate',
    'listingProgress',
    'clickMore',
    'manualLoadMoreClicked',
    'autoLoadMoreClicked',
    'filtered',
    'detailDone',
    'relatedAutoScrolling',
    'relatedNeedsManualScroll',
    'relatedQueued',
    'windControlTriggered',
    'done',
  ];

  if (progressActions.includes(msg.action)) {
    popupPorts.forEach(port => {
      try { port.postMessage(msg); } catch (_) {}
    });
    return false;
  }

  const backendActions = ['backendStartRun', 'backendUploadBatch', 'backendFinishRun'];

  if (backendActions.includes(msg.action)) {
    handleBackendAction(msg)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  // popup 发来的控制指令 → 转发给当前 Temu 标签页
  const controlActions = [
    'start',
    'stop',
    'getState',
    'getData',
    'clearAll',
    'setConfig',
    'triggerLoadMoreNow',
    'setWorkflowState',
  ];

  if (controlActions.includes(msg.action)) {
    forwardControlAction(msg).then(sendResponse);
    return true; // 异步
  }
});

/**
 * 把 popup 的控制消息（start/stop/getState 等）转发给 Temu 的 content script。
 * 流程：findTemuTab → chrome.tabs.sendMessage → 翻译 lastError 为中文可读错误。
 * 这里把 lastError 识别成几种用户场景（没注入脚本/跨域/页面刷新中），帮助用户自己排障。
 * @param {Record<string, unknown>} msg
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function forwardControlAction(msg) {
  const tab = await findTemuTab();
  if (!tab?.id) {
    return { ok: false, error: '未找到已打开的 Temu 页面，请先打开一个 temu.com 标签页。' };
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, msg, (response) => {
      if (chrome.runtime.lastError) {
        const runtimeMessage = chrome.runtime.lastError.message || '';
        resolve({
          ok: false,
          error: mapTabMessageError(runtimeMessage, tab),
        });
        return;
      }

      resolve(response || { ok: false, error: 'Temu 页面未返回响应，请刷新后重试。' });
    });
  });
}

/**
 * 定位要操作的 Temu 标签页。优先找"当前窗口激活的"temu.com 标签，没有就退到任意 temu.com 标签。
 * 返回 null 表示用户压根没打开 Temu，forwardControlAction 会据此给出提示。
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
async function findTemuTab() {
  const activeTabs = await queryTabs({ ...TEMU_TAB_QUERY, active: true, currentWindow: true });
  if (activeTabs[0]) return activeTabs[0];

  const allTabs = await queryTabs(TEMU_TAB_QUERY);
  return allTabs[0] || null;
}

/**
 * Promise 版 chrome.tabs.query 封装。MV3 的 chrome.tabs.query 仍是回调式，
 * 这里统一包一层便于 async/await。
 * @param {chrome.tabs.QueryInfo} queryInfo
 * @returns {Promise<chrome.tabs.Tab[]>}
 */
function queryTabs(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

/**
 * 把 chrome.runtime.lastError.message 翻译成用户能看懂的中文提示。
 * 三种常见错误：
 *   - "Receiving end does not exist" → content script 没注入，提示刷新；
 *   - "cannot access contents of url" → 非 Temu 域或特殊 URL（如 chrome-extension://）；
 *   - "message port closed" → 页面在跳转/刷新中，通信被中断。
 * 其余错误透传原始 message，便于日志诊断。
 * @param {string} runtimeMessage
 * @param {chrome.tabs.Tab} tab
 * @returns {string}
 */
function mapTabMessageError(runtimeMessage, tab) {
  if (/Receiving end does not exist/i.test(runtimeMessage)) {
    return `Temu 页面未注入扩展脚本，请刷新当前页面后重试。当前标签页：${tab.url || 'unknown'}`;
  }
  if (/cannot access contents of url/i.test(runtimeMessage)) {
    return '当前页面暂不支持注入扩展脚本，请切到普通的 temu.com 商品页面后重试。';
  }
  if (/The message port closed before a response was received/i.test(runtimeMessage)) {
    return 'Temu 页面响应中断，可能刚发生跳转或刷新，请稍后再试。';
  }
  return `Temu 页面通信失败：${runtimeMessage || 'unknown error'}`;
}

/**
 * 后端 HTTP 动作分发器。只有三个动作：
 *   - backendStartRun：开启一次 run（领 runUuid 回来，后续所有数据都关联这个 uuid）；
 *   - backendUploadBatch：批量上传 items/edges；
 *   - backendFinishRun：标记 run 结束并写最终统计。
 * 所有 action 都是 POST，payload 来自 content.js。
 * @param {{action: string, payload?: Record<string, unknown>, runUuid?: string}} msg
 * @returns {Promise<{ok: boolean, error?: string, [k: string]: unknown}>}
 */
async function handleBackendAction(msg) {
  if (msg.action === 'backendStartRun') {
    return postJson('/api/runs/start', {});
  }

  if (msg.action === 'backendUploadBatch') {
    return postJson('/api/upload/batch', msg.payload || {});
  }

  if (msg.action === 'backendFinishRun') {
    const runUuid = msg.runUuid;
    if (!runUuid) return { ok: false, error: '缺少 runUuid' };
    return postJson(`/api/runs/${encodeURIComponent(runUuid)}/finish`, msg.payload || {});
  }

  return { ok: false, error: '未知后端动作' };
}

/**
 * 统一的 POST JSON helper。要点：
 *   - 先拿 text 再尝试 JSON.parse，后端返回非 JSON（比如 500 HTML 错误页）时把 raw 字符串带回；
 *   - response.ok=false 时，优先使用 FastAPI 风格的 `detail`/`error` 字段，兜底给状态码；
 *   - 成功时把后端 JSON 展开到返回对象（保留 `ok:true`），content.js 能直接取 `response.run_uuid` 等字段。
 * 注意 SW fetch 不走页面的 CORS —— Temu 本身不允许从页面调 localhost，因此必须放在 SW 这一层。
 * @param {string} path
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{ok: boolean, status?: number, error?: string, data?: unknown, [k: string]: unknown}>}
 */
async function postJson(path, payload) {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: data.detail || data.error || `请求失败: ${response.status}`,
      data,
    };
  }

  return {
    ok: true,
    ...data,
  };
}
