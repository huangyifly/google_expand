/**
 * 数据提取模块
 * 从商品卡片和详情页提取字段
 */

import { normalizeText, parseSalesNum, parseReviewNum, escapeRegExp } from '../utils/index.js';
import { getGoodsIdFromUrl, getGoodsIdFromCard, findRelatedArea } from '../dom/index.js';

// ─── 列表卡片提取 ─────────────────────────────────────────────────

/**
 * 从商品卡片提取字段
 * @param {Element} card 卡片节点
 * @param {'listing'|'related'} mode 来源模式
 * @param {string} nowText 当前时间文本
 * @returns {object | null}
 */
export function extractItemFromCard(card, mode, nowText) {
  const anchor = card.querySelector('a[href*="-g-"]');
  const link = anchor?.href || '';
  const goodsId = getGoodsIdFromUrl(link);
  if (!goodsId) return null;

  // 收集所有叶子节点文本
  const leaves = Array.from(card.querySelectorAll('span, div, p'))
    .filter((el) => el.children.length === 0)
    .map((el) => normalizeText(el.innerText))
    .filter(Boolean);

  const textPool = Array.from(new Set(leaves));

  // 提取各字段
  const salesText = textPool.find((text) => /已售\s*[\d.,万千百k]+\s*件?/i.test(text)) || '';
  const sales = extractSales(salesText);
  const starRating = extractStar(textPool);
  const reviewCount = extractReviews(textPool, starRating, sales);
  const price = extractPrice(textPool);
  const name = extractName(textPool, {
    anchorText: normalizeText(anchor?.innerText),
    salesText,
    price,
    starRating,
  });
  const rawText = normalizeText(card.innerText);
  const rawHtml = card.outerHTML || '';
  const listingTime = extractInjectedListingTime(card, goodsId) || extractListingTime(textPool, rawText);

  return {
    goodsId,
    link,
    name: name.slice(0, 80),
    price,
    sales,
    salesNum: parseSalesNum(sales),
    starRating,
    reviewCount,
    listingTime,
    rawText,
    rawHtml,
    scrapedAt: nowText,
    source: mode,
  };
}

// ─── 详情页提取 ───────────────────────────────────────────────────

/**
 * 抓取详情页字段
 * @param {string} goodsId 商品 ID
 * @returns {object}
 */
export function scrapeDetailFields(goodsId = '') {
  const title = normalizeText(document.querySelector('h1')?.innerText)
    || normalizeText(document.title.replace(/\s*[-|].*Temu.*/i, ''));

  const leaves = Array.from(document.querySelectorAll('span, div, p'))
    .filter((el) => el.children.length === 0)
    .map((el) => normalizeText(el.innerText))
    .filter(Boolean);

  const unique = Array.from(new Set(leaves));

  return {
    fullTitle: title,
    price: extractPrice(unique),
    sales: extractSales(unique.find((text) => /已售/.test(text)) || ''),
    stars: extractStar(unique),
    reviews: extractReviews(unique, extractStar(unique), ''),
    listingTime: extractInjectedListingTime(document.body, goodsId)
      || extractListingTime(unique, normalizeText(document.body?.innerText || '')),
  };
}

/**
 * 抓取详情页原始区块
 * @returns {{rawHtml: string, rawText: string}}
 */
export function scrapeDetailRawBlock() {
  const root = findDetailProductRoot();
  if (!root) return { rawHtml: '', rawText: '' };
  return {
    rawHtml: root.outerHTML || '',
    rawText: normalizeText(root.innerText || ''),
  };
}

/**
 * 找详情页商品主信息区块
 * @returns {HTMLElement | null}
 */
function findDetailProductRoot() {
  const h1 = document.querySelector('h1');
  if (!h1) return null;
  let node = h1;
  for (let i = 0; i < 8; i += 1) {
    node = node.parentElement;
    if (!node) break;
    if (node.querySelector('img') && /(\$|CA\$|已售|星)/.test(node.innerText || '')) {
      return node;
    }
  }
  return h1.parentElement || h1;
}

// ─── 字段提取工具 ─────────────────────────────────────────────────

/**
 * 提取销量
 * @param {string} text
 * @returns {string}
 */
function extractSales(text) {
  const matched = String(text || '').match(/已售\s*([\d.,万千百k]+)\s*件?/i);
  return matched?.[1] || '';
}

/**
 * 提取星级评分
 * @param {string[]} texts
 * @returns {string}
 */
function extractStar(texts) {
  for (const text of texts) {
    const matched = text.match(/([1-5](?:\.\d+)?)\s*星(?:（满分5星）)?/);
    if (matched) return matched[1];
  }
  return '';
}

/**
 * 提取价格
 * @param {string[]} texts
 * @returns {string}
 */
function extractPrice(texts) {
  for (const text of texts) {
    const matched = text.match(/(?:CA\$|\$)\s*\d[\d,.]*(?:\.\d{1,2})?/);
    if (matched) return matched[0].replace(/\s+/g, '');
  }
  return '';
}

/**
 * 提取评价数
 * @param {string[]} texts
 * @param {string} starRating
 * @param {string} sales
 * @returns {string}
 */
function extractReviews(texts, starRating, sales) {
  // 1) "613条评价" 中文主通道
  for (const text of texts) {
    const matched = text.match(/([\d,]+)\s*条评价/);
    if (matched) return matched[1].replace(/,/g, '');
  }

  // 2) "(123)" 括号兜底
  for (const text of texts) {
    const matched = text.match(/[（(]([\d,]+)[)）]/);
    if (matched) return matched[1].replace(/,/g, '');
  }

  // 3) 星级后紧邻数字
  if (starRating) {
    const starPrefix = new RegExp(`^${escapeRegExp(starRating)}\\s*星`);
    for (let i = 0; i < texts.length; i += 1) {
      if (!starPrefix.test(texts[i])) continue;
      for (let offset = 1; offset <= 4; offset += 1) {
        const next = texts[i + offset] || '';
        if (/^\d[\d,]*$/.test(next)) {
          return next.replace(/,/g, '');
        }
      }
    }
  }

  void sales;
  return '0';
}

/**
 * 提取商品名
 * @param {string[]} texts
 * @param {object} context
 * @returns {string}
 */
function extractName(texts, context = {}) {
  const anchorText = context.anchorText || '';
  if (anchorText && anchorText.length > 6 && !/^(CA\$|\$)/.test(anchorText)) {
    return anchorText;
  }

  let best = '';
  for (const text of texts) {
    if (text.length < 6) continue;
    if (text === context.salesText || text === context.price) continue;
    if (context.starRating && text.includes(`${context.starRating}星`)) continue;
    if (/^(CA\$|\$)/.test(text)) continue;
    if (/^已售/.test(text)) continue;
    if (/^\d[\d,]*$/.test(text)) continue;
    if (/^(新品|店铺|颜色|尺寸|运费|Free shipping)$/i.test(text)) continue;
    if (text.length > best.length) best = text;
  }
  return best;
}

/**
 * 提取知了数据注入层的上架时间
 * @param {ParentNode} scope
 * @param {string} goodsId
 * @returns {string}
 */
function extractInjectedListingTime(scope, goodsId) {
  return extractInjectedFieldValue(scope, goodsId, '上架时间');
}

/**
 * 提取注入层字段值
 * @param {ParentNode} scope
 * @param {string} goodsId
 * @param {string} label
 * @returns {string}
 */
function extractInjectedFieldValue(scope, goodsId, label = '上架时间') {
  const selector = goodsId ? `.zl-inject[pro-id="${goodsId}"]` : '.zl-inject[pro-id]';
  const hosts = [];
  const scopedHost = scope?.querySelector?.(selector);
  if (scopedHost) hosts.push(scopedHost);

  const globalHost = document.querySelector(selector);
  if (globalHost && !hosts.includes(globalHost)) {
    hosts.push(globalHost);
  }

  for (const host of hosts) {
    const root = host?.shadowRoot;
    if (!root) continue;

    const pairs = Array.from(root.querySelectorAll('dl')).map((dl) => ({
      key: normalizeText(dl.querySelector('dt')?.textContent || ''),
      value: normalizeText(dl.querySelector('dd')?.textContent || ''),
    }));

    const matched = pairs.find((item) => item.key === label && item.value);
    if (matched?.value) {
      return matched.value;
    }
  }

  return '';
}

/**
 * 提取上架时间 (从文本)
 * @param {string[]} texts
 * @param {string} fallbackText
 * @returns {string}
 */
function extractListingTime(texts, fallbackText = '') {
  const normalizedTexts = (texts || []).map((text) => normalizeText(text)).filter(Boolean);
  const combined = normalizeText([fallbackText, ...normalizedTexts].join(' '));

  const inlineMatched = combined.match(/上架时间\s*[:：]?\s*([^\s|/]+(?:\s+[^\s|/]+){0,3})/);
  if (inlineMatched?.[1]) {
    return normalizeText(inlineMatched[1]);
  }

  for (let i = 0; i < normalizedTexts.length; i += 1) {
    const text = normalizedTexts[i];
    const matched = text.match(/上架时间\s*[:：]?\s*(.+)$/);
    if (matched?.[1]) return normalizeText(matched[1]);
    if (/^上架时间\s*[:：]?$/.test(text)) {
      const nextText = normalizedTexts[i + 1] || '';
      if (nextText) return normalizeText(nextText);
    }
  }

  return '';
}
