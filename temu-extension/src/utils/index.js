/**
 * 工具函数模块
 * 提供通用的辅助函数
 */

// ─── 时间工具 ─────────────────────────────────────────────────────

/**
 * 基于 setTimeout 的 Promise 延时
 * @param {number} ms 延时毫秒数
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 本地化日期字符串 (中文格式)
 * @returns {string} 形如 "2026/4/19 下午3:24:08"
 */
export function nowText() {
  return new Date().toLocaleString('zh-CN');
}

/**
 * ISO 时间戳
 * @returns {string} 形如 "2026-04-19T07:24:08.123Z"
 */
export function nowIsoText() {
  return new Date().toISOString();
}

// ─── 随机工具 ─────────────────────────────────────────────────────

/**
 * 生成 [min, max] 闭区间的随机整数
 * 用于人类化延时抖动
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @returns {number}
 */
export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── 文本处理 ─────────────────────────────────────────────────────

/**
 * 文本规范化
 * 把所有空白压成单个空格并 trim
 * @param {unknown} text 输入文本
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * 把字符串里的正则元字符转义
 * 用于安全拼接 RegExp
 * @param {string} text
 * @returns {string}
 */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * HTML 转义
 * 防止 XSS
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── 数值解析 ─────────────────────────────────────────────────────

/**
 * 销量字符串 → 数字
 * 支持单位换算: "1.2万" → 12000, "3千" → 3000, "2k" → 2000
 * @param {unknown} value
 * @returns {number}
 */
export function parseSalesNum(value) {
  const text = String(value || '').replace(/,/g, '').trim();
  if (!text) return 0;
  if (/万/.test(text)) return parseFloat(text) * 10000;
  if (/千/.test(text)) return parseFloat(text) * 1000;
  if (/k/i.test(text)) return parseFloat(text) * 1000;
  return parseFloat(text) || 0;
}

/**
 * 评价数字符串 → 整数
 * 支持 "1,234" 千分位格式
 * @param {unknown} value
 * @returns {number}
 */
export function parseReviewNum(value) {
  const text = String(value || '').replace(/,/g, '').trim();
  if (!text) return 0;
  return parseInt(text, 10) || 0;
}

/**
 * 把评分值规范成字符串
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeStar(value) {
  return String(value || '').trim();
}

// ─── 三次贝塞尔曲线 ───────────────────────────────────────────────

/**
 * 三次贝塞尔曲线插值
 * 用于生成人类化的鼠标轨迹
 * @param {number} p0 起点
 * @param {number} p1 控制点 1
 * @param {number} p2 控制点 2
 * @param {number} p3 终点
 * @param {number} t 进度 [0,1]
 * @returns {number}
 */
export function cubicBezier(p0, p1, p2, p3, t) {
  const inv = 1 - t;
  return inv ** 3 * p0
    + 3 * inv ** 2 * t * p1
    + 3 * inv * t ** 2 * p2
    + t ** 3 * p3;
}
