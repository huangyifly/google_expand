/**
 * 调试面板模块
 * 右下角调试面板的渲染和交互
 */

import { escapeHtml, nowText } from '../utils/index.js';
import {
  DEBUG_PANEL_ID,
  DEBUG_PANEL_STYLE_ID,
  DEBUG_LOG_LIMIT,
  COLLECTION_MODES,
  TASK_MODES,
} from '../constants/index.js';
import { getStateSnapshotWorkflow, getStateSnapshotConfig } from '../state/index.js';

// ─── 调试日志存储 ─────────────────────────────────────────────────

/** 调试日志条目 */
let debugEntries = [];
/** 面板是否可见 */
let debugPanelVisible = true;
/** 是否已绑定事件 */
let debugPanelBound = false;
/** 待处理的"加载更多"按钮信息 */
let debugPendingLoadMore = null;

// ─── 模式标签 ─────────────────────────────────────────────────────

/**
 * 获取采集模式标签
 * @param {string} mode
 * @returns {string}
 */
function getCollectionModeLabel(mode) {
  return mode === COLLECTION_MODES.AGGRESSIVE ? '激进自动模式' : '保守辅助模式';
}

/**
 * 获取任务模式标签
 * @param {string} mode
 * @returns {string}
 */
function getTaskModeLabel(mode) {
  return {
    [TASK_MODES.DISCOVERY]: 'Discovery Mode',
    [TASK_MODES.HARVEST]: 'Harvest Mode',
    [TASK_MODES.GRAPH]: 'Graph Mode',
  }[mode] || mode;
}

// ─── 面板可见性 ───────────────────────────────────────────────────

/**
 * 设置调试面板可见性
 * @param {boolean} enabled
 */
export function setDebugPanelVisibility(enabled) {
  debugPanelVisible = enabled !== false;
  if (!debugPanelVisible) {
    document.getElementById(DEBUG_PANEL_ID)?.remove();
    return;
  }
  renderDebugPanel();
}

/**
 * 获取待处理的"加载更多"信息
 * @returns {object | null}
 */
export function getDebugPendingLoadMore() {
  return debugPendingLoadMore;
}

/**
 * 设置待处理的"加载更多"信息
 * @param {object | null} info
 */
export function setDebugPendingLoadMore(info) {
  debugPendingLoadMore = info;
}

// ─── 面板渲染 ─────────────────────────────────────────────────────

/**
 * 确保调试面板存在
 * @returns {HTMLElement | null}
 */
export function ensureDebugPanel() {
  if (!debugPanelVisible) return null;
  if (!document.body) return null;

  // 注入样式
  if (!document.getElementById(DEBUG_PANEL_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = DEBUG_PANEL_STYLE_ID;
    style.textContent = `
      #${DEBUG_PANEL_ID} {
        position: fixed;
        right: 12px;
        bottom: 12px;
        width: 320px;
        max-height: 45vh;
        overflow: auto;
        z-index: 2147483647;
        background: rgba(255, 253, 249, 0.97);
        color: #241f19;
        border: 1px solid #d6cab8;
        border-radius: 10px;
        box-shadow: 0 12px 28px rgba(36, 57, 70, 0.16);
        font: 12px/1.45 "Plus Jakarta Sans", Menlo, Monaco, Consolas, monospace;
        padding: 10px 10px 8px;
        white-space: pre-wrap;
        word-break: break-word;
        pointer-events: auto;
        user-select: text;
        -webkit-user-select: text;
        overscroll-behavior: contain;
        scrollbar-width: thin;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-title {
        color: #2f4858;
        font-weight: 700;
        margin-bottom: 6px;
        position: sticky;
        top: 0;
        background: rgba(255, 253, 249, 0.98);
        padding-bottom: 6px;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-line {
        margin-bottom: 6px;
        opacity: 0.96;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-state {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-pill {
        display: inline-flex;
        align-items: center;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(47, 72, 88, 0.10);
        color: #2f4858;
        font-weight: 700;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-btn {
        border: 1px solid #d6cab8;
        border-radius: 8px;
        background: #f8f4ed;
        color: #241f19;
        padding: 6px 8px;
        cursor: pointer;
        font: inherit;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-btn-primary {
        background: #b98546;
        border-color: transparent;
        color: #fff;
        font-weight: 700;
      }
      #${DEBUG_PANEL_ID}::-webkit-scrollbar {
        width: 8px;
      }
      #${DEBUG_PANEL_ID}::-webkit-scrollbar-thumb {
        background: rgba(47, 72, 88, 0.26);
        border-radius: 999px;
      }
      #${DEBUG_PANEL_ID}::-webkit-scrollbar-track {
        background: rgba(47, 72, 88, 0.08);
        border-radius: 999px;
      }
    `;
    document.documentElement.appendChild(style);
  }

  // 创建面板
  let panel = document.getElementById(DEBUG_PANEL_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = DEBUG_PANEL_ID;
    document.body.appendChild(panel);
  }

  // 绑定事件 (只绑定一次)
  if (!debugPanelBound) {
    panel.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-debug-action');
      if (!action) return;

      // 这些操作会在 content.js 中处理
      if (action === 'load-more-now' || action === 'jump-state') {
        // 通过自定义事件通知主程序
        panel.dispatchEvent(new CustomEvent('debug-action', {
          detail: { action, nextState: target.getAttribute('data-next-state') },
          bubbles: true,
        }));
      }
    });
    debugPanelBound = true;
  }

  return panel;
}

/**
 * 渲染调试面板内容
 * @param {object} options
 * @param {string} options.currentState FSM 当前状态
 * @param {Function} options.getStateLabels 获取状态标签的函数
 */
export function renderDebugPanel(options = {}) {
  if (!debugPanelVisible) return;
  const panel = ensureDebugPanel();
  if (!panel) return;

  const workflow = getStateSnapshotWorkflow();
  const config = getStateSnapshotConfig();

  const loadMoreActions = debugPendingLoadMore ? `
    <button class="temu-scraper-debug-btn temu-scraper-debug-btn-primary" data-debug-action="load-more-now">
      一键加载更多商品
    </button>
  ` : '';

  panel.innerHTML = `
    <div class="temu-scraper-debug-title">Temu Scraper Debug</div>
    <div class="temu-scraper-debug-state">
      <span class="temu-scraper-debug-pill">状态：${escapeHtml(workflow.current)}</span>
      <span class="temu-scraper-debug-pill">模式：${escapeHtml(getCollectionModeLabel(config.collectionMode))}</span>
      <span class="temu-scraper-debug-pill">任务：${escapeHtml(getTaskModeLabel(config.taskMode))}</span>
    </div>
    <div class="temu-scraper-debug-actions">
      ${loadMoreActions}
      <button class="temu-scraper-debug-btn" data-debug-action="jump-state" data-next-state="LIST_DISCOVERY">列表发现</button>
      <button class="temu-scraper-debug-btn" data-debug-action="jump-state" data-next-state="TARGET_SELECTED">目标选中</button>
      <button class="temu-scraper-debug-btn" data-debug-action="jump-state" data-next-state="DETAIL_SCRAPE">详情深采</button>
      <button class="temu-scraper-debug-btn" data-debug-action="jump-state" data-next-state="WIND_CONTROL">风控暂停</button>
    </div>
    ${debugEntries.map((line) => `<div class="temu-scraper-debug-line">${escapeHtml(line)}</div>`).join('')}
  `;
}

/**
 * 添加调试日志
 * @param {string} event 事件名
 * @param {object} extra 附加字段
 */
export function debugLog(event, extra = {}) {
  const payload = { ...extra };
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${event} ${JSON.stringify(payload)}`;
  debugEntries.push(line);
  if (debugEntries.length > DEBUG_LOG_LIMIT) {
    debugEntries = debugEntries.slice(-DEBUG_LOG_LIMIT);
  }
  renderDebugPanel();
}
