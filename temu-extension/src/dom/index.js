/**
 * DOM 操作模块
 * 提供 DOM 查找、高亮、交互等功能
 */

import { normalizeText, randomInt, sleep, cubicBezier } from '../utils/index.js';
import { DEBUG_PANEL_ID, DEBUG_PANEL_STYLE_ID, DEBUG_LOG_LIMIT } from '../constants/index.js';

// ─── 页面判断 ─────────────────────────────────────────────────────

/**
 * 从 URL 中提取商品 ID
 * @param {string} url
 * @returns {string} 匹配不到返回空串
 */
export function getGoodsIdFromUrl(url) {
  return String(url || '').match(/-g-(\d+)\.html/)?.[1] || '';
}

/**
 * 判断当前 URL 是否包含商品锚点
 * @returns {boolean}
 */
export function hasCurrentProductAnchor() {
  return Boolean(getGoodsIdFromUrl(location.href));
}

// ─── 商品卡片查找 ─────────────────────────────────────────────────

/**
 * 在给定 DOM 子树里定位所有商品卡片节点
 * 策略: 找所有 `a[href*="-g-"]` 锚点，向上爬到有图片+金额的容器
 * @param {Document | Element} root
 * @returns {Element[]}
 */
export function findProductCards(root = document) {
  const allNodes = Array.from(root.querySelectorAll('a[href*="-g-"]'));
  const cards = [];
  const seen = new Set();

  for (const anchor of allNodes) {
    const href = anchor.href || '';
    if (!getGoodsIdFromUrl(href)) continue;
    if (anchor.closest('#reviewContent')) continue;

    let node = anchor;
    for (let i = 0; i < 8; i += 1) {
      node = node?.parentElement;
      if (!node) break;
      if (node.id === 'reviewContent') break;
      if (node.querySelector('img') && /(\$|CA\$|已售|星)/.test(node.innerText || '')) {
        if (!seen.has(node)) {
          seen.add(node);
          cards.push(node);
        }
        break;
      }
    }
  }

  return cards;
}

/**
 * 从卡片根节点中提取 goodsId
 * @param {Element | null} card
 * @returns {string}
 */
export function getGoodsIdFromCard(card) {
  const anchor = card?.querySelector?.('a[href*="-g-"]');
  return getGoodsIdFromUrl(anchor?.href || '');
}

/**
 * 找联想商品区域的根节点
 * @returns {Element | null}
 */
export function findRelatedArea() {
  return document.getElementById('goodsRecommend');
}

/**
 * 获取联想区根节点 (过滤评价区嵌套)
 * @returns {Element | null}
 */
export function getRelatedItemsRoot() {
  const area = findRelatedArea();
  if (!area || area.closest('#reviewContent')) return null;
  return area;
}

// ─── "查看更多"按钮查找 ───────────────────────────────────────────

/**
 * 找"查看更多商品"按钮
 * 策略: 多语言关键词 + 可见性过滤 + 祖孙折叠 + 页尾优先
 * @returns {HTMLElement | null}
 */
export function findLoadMoreBtn() {
  const keywords = ['查看更多商品', '查看更多', 'View more', 'Load more', 'See more'];
  const raw = Array.from(document.querySelectorAll('button, a, div[role="button"], span'))
    .filter((el) => {
      if (el.offsetParent === null) return false;
      const text = normalizeText(el.innerText);
      return Boolean(text) && keywords.some((keyword) => text.includes(keyword));
    });

  if (raw.length === 0) return null;

  // 祖孙折叠: 丢掉被其他候选包含的内层节点
  const collapsed = raw.filter((el) => !raw.some((other) => other !== el && other.contains(el)));

  // (docY desc, area desc) 排序，页尾 + 大块胜出
  const ranked = collapsed
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        el,
        docY: rect.top + window.scrollY,
        area: rect.width * rect.height,
      };
    })
    .sort((a, b) => (b.docY - a.docY) || (b.area - a.area));

  return resolveLoadMoreClickable(ranked[0]?.el ?? null);
}

/**
 * 从按钮文字节点向上找真正可点击的容器
 * @param {Element | null} element
 * @returns {Element | null}
 */
export function resolveLoadMoreClickable(element) {
  return element?.closest?.('button, a, [role="button"]') || element || null;
}

// ─── 高亮样式 ─────────────────────────────────────────────────────

const HIGHLIGHT_STYLE_ID = 'temu-scraper-highlight-style';

/**
 * 懒注入高亮样式 CSS
 */
export function ensureHighlightStyle() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .temu-scraper-pending-target {
      position: relative !important;
      isolation: isolate !important;
      outline: 4px solid #b98546 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 8px rgba(185, 133, 70, 0.24), 0 16px 32px rgba(47, 72, 88, 0.16) !important;
      border-radius: 12px !important;
      animation: temu-scraper-pulse 1.15s ease-in-out infinite;
      background: rgba(185, 133, 70, 0.12) !important;
      z-index: 999 !important;
    }
    .temu-scraper-pending-target > * {
      position: relative;
      z-index: 1;
    }
    .temu-scraper-pending-target::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(180deg, rgba(185, 133, 70, 0.16), rgba(47, 72, 88, 0.08));
      pointer-events: none;
      z-index: 0;
    }
    .temu-scraper-pending-target::after {
      content: attr(data-temu-pending-label);
      position: absolute;
      left: 10px;
      top: 10px;
      padding: 6px 10px;
      border-radius: 999px;
      background: #2f4858;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
      box-shadow: 0 6px 18px rgba(47, 72, 88, 0.24);
      z-index: 3;
      pointer-events: none;
    }
    .temu-scraper-load-more-target {
      position: relative !important;
      outline: 3px dashed #2f4858 !important;
      box-shadow: 0 0 0 6px rgba(47, 72, 88, 0.18) !important;
      border-radius: 12px !important;
      animation: temu-scraper-pulse-load-more 1.2s ease-in-out infinite;
      z-index: 1;
    }
    .temu-scraper-load-more-target::after {
      content: attr(data-temu-load-more-label);
      position: absolute;
      left: 50%;
      top: -12px;
      transform: translate(-50%, -100%);
      padding: 6px 10px;
      border-radius: 999px;
      background: #2f4858;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
      box-shadow: 0 6px 18px rgba(47, 72, 88, 0.24);
      z-index: 2;
      pointer-events: none;
    }
    .temu-scraper-related-area-target {
      position: relative !important;
      outline: 3px dashed #7a6750 !important;
      box-shadow: 0 0 0 8px rgba(122, 103, 80, 0.16) !important;
      border-radius: 16px !important;
      animation: temu-scraper-pulse-related 1.3s ease-in-out infinite;
      z-index: 1;
    }
    .temu-scraper-related-area-target::after {
      content: attr(data-temu-related-label);
      position: absolute;
      left: 16px;
      top: 16px;
      padding: 6px 10px;
      border-radius: 999px;
      background: #7a6750;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      box-shadow: 0 6px 18px rgba(122, 103, 80, 0.22);
      z-index: 2;
      pointer-events: none;
    }
    .temu-scraper-toast {
      position: fixed;
      left: 50%;
      bottom: 28px;
      transform: translate(-50%, 14px);
      padding: 10px 14px;
      border-radius: 999px;
      background: rgba(47, 72, 88, 0.95);
      color: #fff;
      z-index: 2147483647;
      opacity: 0;
      transition: opacity 0.22s ease, transform 0.22s ease;
      font: 12px/1.4 "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 12px 28px rgba(36, 57, 70, 0.24);
      border: 1px solid rgba(229, 221, 208, 0.32);
    }
    .temu-scraper-toast.show {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    .temu-scraper-toast-error {
      background: rgba(185, 28, 28, 0.94);
    }
    .temu-scraper-toast-success {
      background: rgba(21, 128, 61, 0.94);
    }
    @keyframes temu-scraper-pulse {
      0%, 100% { box-shadow: 0 0 0 8px rgba(185, 133, 70, 0.24), 0 16px 32px rgba(47, 72, 88, 0.16); }
      50% { box-shadow: 0 0 0 12px rgba(185, 133, 70, 0.14), 0 18px 36px rgba(47, 72, 88, 0.10); }
    }
    @keyframes temu-scraper-pulse-load-more {
      0%, 100% { box-shadow: 0 0 0 6px rgba(47, 72, 88, 0.18); }
      50% { box-shadow: 0 0 0 10px rgba(47, 72, 88, 0.10); }
    }
    @keyframes temu-scraper-pulse-related {
      0%, 100% { box-shadow: 0 0 0 8px rgba(122, 103, 80, 0.16); }
      50% { box-shadow: 0 0 0 14px rgba(122, 103, 80, 0.08); }
    }
  `;
  document.documentElement.appendChild(style);
}

/**
 * 清除所有高亮样式
 */
export function clearExistingHighlights() {
  document.querySelectorAll('.temu-scraper-pending-target').forEach((el) => {
    el.classList.remove('temu-scraper-pending-target');
    el.removeAttribute('data-temu-pending-label');
  });
  document.querySelectorAll('.temu-scraper-load-more-target').forEach((el) => {
    el.classList.remove('temu-scraper-load-more-target');
    el.removeAttribute('data-temu-load-more-label');
  });
}

/**
 * 应用待处理高亮样式
 * @param {Element} target
 * @param {string} labelText
 */
export function applyPendingHighlight(target, labelText) {
  target.classList.add('temu-scraper-pending-target');
  target.setAttribute('data-temu-pending-label', labelText);
}

/**
 * 把元素滚到视口指定位置
 * @param {Element | null} element
 * @param {number} desiredTopRatio 视口顶部位置比例 (0-1)
 */
export function scrollElementToViewportAnchor(element, desiredTopRatio = 0.22) {
  if (!element) return;

  element.scrollIntoView({ behavior: 'auto', block: 'start' });

  const rect = element.getBoundingClientRect();
  const viewport = window.innerHeight || 800;
  const desiredTop = viewport * desiredTopRatio;
  const delta = rect.top - desiredTop;

  if (Math.abs(delta) >= 2) {
    window.scrollBy({ top: delta, behavior: 'auto' });
  }
}

// ─── Toast 提示 ───────────────────────────────────────────────────

/**
 * 在页面底部弹一条 Toast 提示
 * @param {string} message
 * @param {'info'|'ok'|'err'|'warn'|'success'|'error'} type
 */
export function showToast(message, type = 'info') {
  const typeMap = {
    info: '',
    ok: 'temu-scraper-toast-success',
    success: 'temu-scraper-toast-success',
    err: 'temu-scraper-toast-error',
    error: 'temu-scraper-toast-error',
    warn: '',
  };

  const toast = document.createElement('div');
  toast.className = `temu-scraper-toast ${typeMap[type] || ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 260);
  }, 3200);
}

// ─── 人类化点击 ───────────────────────────────────────────────────

/**
 * 在元素内部选一个带随机偏移的点击点位
 * @param {Element} element
 * @returns {{clientX: number, clientY: number} | null}
 */
export function getSafeClickPoint(element) {
  const rect = element.getBoundingClientRect();
  if (rect.width < 12 || rect.height < 12) return null;

  const left = rect.left + rect.width * (0.28 + Math.random() * 0.22);
  const top = rect.top + rect.height * (0.3 + Math.random() * 0.22);
  return { clientX: left, clientY: top };
}

/**
 * 判断点位是否可点击
 * @param {Element} element
 * @param {{clientX: number, clientY: number} | null} point
 * @returns {boolean}
 */
export function isPointClickable(element, point) {
  if (!point) return false;

  const inViewport = (
    point.clientX >= 0
    && point.clientY >= 0
    && point.clientX <= window.innerWidth
    && point.clientY <= window.innerHeight
  );
  if (!inViewport) return false;

  const topElement = document.elementFromPoint(point.clientX, point.clientY);
  if (!topElement) return false;

  return (
    element === topElement
    || element.contains(topElement)
    || topElement.contains(element)
  );
}

/**
 * 派发鼠标事件
 * @param {Element} element
 * @param {string} type
 * @param {number} clientX
 * @param {number} clientY
 */
export function dispatchMouseEvent(element, type, clientX, clientY) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    screenX: window.screenX + clientX,
    screenY: window.screenY + clientY,
    button: 0,
    buttons: type === 'mousedown' ? 1 : 0,
  });
  element.dispatchEvent(event);
}

/**
 * 模拟真人点击
 * 使用贝塞尔曲线生成鼠标轨迹
 * @param {Element} element
 * @param {{clientX: number, clientY: number}} point
 */
export async function dispatchHumanLikeClick(element, point) {
  const duration = randomInt(800, 1500);
  const steps = Math.max(24, Math.floor(duration / 16));
  const startX = point.clientX + randomInt(-180, -60);
  const startY = point.clientY + randomInt(-90, 90);
  const cp1x = startX + (point.clientX - startX) * 0.28 + randomInt(-30, 30);
  const cp1y = startY + randomInt(-80, 80);
  const cp2x = startX + (point.clientX - startX) * 0.72 + randomInt(-30, 30);
  const cp2y = point.clientY + randomInt(-60, 60);

  // 鼠标轨迹动画
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const currentX = cubicBezier(startX, cp1x, cp2x, point.clientX, progress);
    const currentY = cubicBezier(startY, cp1y, cp2y, point.clientY, progress);
    dispatchMouseEvent(element, 'mousemove', currentX, currentY);
    await sleep(Math.max(8, Math.floor(duration / steps)));
  }

  // 悬停事件
  dispatchMouseEvent(element, 'mouseover', point.clientX, point.clientY);
  dispatchMouseEvent(element, 'mouseenter', point.clientX, point.clientY);
  dispatchMouseEvent(element, 'mousemove', point.clientX, point.clientY);
  await sleep(randomInt(400, 1200));

  // 点击事件
  dispatchMouseEvent(element, 'mousedown', point.clientX, point.clientY);
  await sleep(randomInt(60, 180));
  dispatchMouseEvent(element, 'mouseup', point.clientX, point.clientY);
  await sleep(randomInt(30, 110));
  dispatchMouseEvent(element, 'click', point.clientX, point.clientY);
}

/**
 * 人类化点击元素
 * @param {Element} element
 * @returns {Promise<boolean>} 是否成功
 */
export async function humanClick(element) {
  const point = getSafeClickPoint(element);
  if (!point) return false;
  await dispatchHumanLikeClick(element, point);
  return true;
}
