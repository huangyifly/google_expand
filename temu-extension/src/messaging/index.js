/**
 * 消息通信模块
 * 负责与 background.js 和 popup.js 的通信
 */

import { getState, getStateSnapshot } from '../state/index.js';

// ─── 消息发送 ─────────────────────────────────────────────────────

/**
 * 向 background service worker 发送消息
 * 用 try/catch 吞掉扩展重载时的常见错误
 * @param {object} message 消息对象
 */
export function notify(message) {
  try {
    chrome.runtime.sendMessage(message);
  } catch (_) {
    // 扩展重载时会抛出 "Extension context invalidated"，忽略即可
  }
}

/**
 * 把 chrome.runtime.sendMessage 包装成 Promise
 * 统一处理 lastError 和异常
 * @param {string} action 动作名
 * @param {object} extra 额外参数
 * @returns {Promise<object>}
 */
export function callRuntime(action, extra = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action, ...extra }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: 'empty response' });
      });
    } catch (error) {
      resolve({ ok: false, error: error?.message || String(error) });
    }
  });
}

// ─── 状态同步 ─────────────────────────────────────────────────────

/**
 * 获取页面类型
 * @returns {'product' | 'other'}
 */
export function getPageType() {
  if (/temu\.com/.test(location.href)) return 'product';
  return 'other';
}

/**
 * 获取规范化页面类型 (兼容旧代码)
 * @returns {'product' | 'other'}
 */
export function getNormalizedPageType() {
  return getPageType();
}

/**
 * 广播当前状态到 popup
 * @param {object} state 状态对象
 * @param {string} pageType 页面类型
 */
export function notifyState(state, pageType = getNormalizedPageType()) {
  notify({
    action: 'stateSync',
    pageType,
    phase: state.phase,
    workflowState: getCurrentState(state),
    workflow: state.workflow,
    running: state.running,
    total: state.collected.length,
    queueLen: state.targetQueue.length,
    stats: state.stats,
    config: state.config,
  });
}

/**
 * 获取 FSM 当前状态
 * @param {object} state
 * @returns {string}
 */
function getCurrentState(state) {
  return state?.workflow?.current || 'LIST_DISCOVERY';
}
