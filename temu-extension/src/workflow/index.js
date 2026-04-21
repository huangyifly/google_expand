/**
 * 工作流模块
 * FSM 状态机和主流程控制
 */

import { FSM_STATES, FSM_TRANSITIONS, TASK_MODES } from '../constants/index.js';
import { getState, patchState } from '../state/index.js';
import { notifyState, getNormalizedPageType } from '../messaging/index.js';
import { hasCurrentProductAnchor } from '../dom/index.js';
import { nowIsoText } from '../utils/index.js';
import { renderDebugPanel } from '../debug/index.js';

// ─── FSM 状态判断 ─────────────────────────────────────────────────

/**
 * 获取 FSM 当前状态
 * @param {object} state
 * @returns {string}
 */
export function getCurrentState(state) {
  return state?.workflow?.current || FSM_STATES.LIST_DISCOVERY;
}

/**
 * 判断状态转换是否合法
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (from === to) return true;
  return Boolean(FSM_TRANSITIONS[from]?.includes(to));
}

/**
 * 获取 FSM 状态对应的 UI phase
 * @param {string} nextState
 * @returns {string}
 */
export function getPhaseByWorkflow(nextState) {
  switch (nextState) {
    case FSM_STATES.LIST_DISCOVERY:
      return 'listing';
    case FSM_STATES.TARGET_SELECTED:
    case FSM_STATES.NAVIGATE_TO_DETAIL:
      return 'navigating';
    case FSM_STATES.DETAIL_SCRAPE:
      return 'detail';
    case FSM_STATES.RELATED_SCAN:
    case FSM_STATES.EDGE_COLLECT:
      return 'related';
    case FSM_STATES.PAUSE:
      return 'idle';
    case FSM_STATES.WIND_CONTROL:
      return 'filtering';
    default:
      return 'idle';
  }
}

/**
 * 选择 FSM 初始状态
 * @param {string} taskMode 任务模式
 * @returns {string}
 */
export function getInitialWorkflowState(taskMode) {
  const hasAnchor = hasCurrentProductAnchor();
  if (hasAnchor) {
    if (taskMode === TASK_MODES.GRAPH) return FSM_STATES.RELATED_SCAN;
    return FSM_STATES.DETAIL_SCRAPE;
  }
  if (taskMode === TASK_MODES.HARVEST) return FSM_STATES.TARGET_SELECTED;
  return FSM_STATES.LIST_DISCOVERY;
}

// ─── 状态转换 ─────────────────────────────────────────────────────

/**
 * FSM 状态切换
 * @param {string} nextState 目标状态
 * @param {object} options 选项
 * @returns {Promise<boolean>} 是否成功
 */
export async function transitionTo(nextState, options = {}) {
  const current = await getState();
  const currentWorkflow = getCurrentState(current);

  // 非法转换检查
  if (!options.force && !canTransition(currentWorkflow, nextState)) {
    return false;
  }

  // 更新状态
  await patchState({
    phase: options.phase || getPhaseByWorkflow(nextState),
    workflow: {
      current: nextState,
      previous: currentWorkflow,
      updatedAt: nowIsoText(),
      reason: options.reason || '',
      manualInterventionRequired: options.manualInterventionRequired ?? false,
    },
  });

  // 通知并渲染
  notifyState(await getState());
  renderDebugPanel();
  return true;
}

// ─── 目标筛选 ─────────────────────────────────────────────────────

/**
 * 从候选商品中挑选优先级目标
 * @param {Array} items 候选商品
 * @param {number} limit 数量限制
 * @returns {Array}
 */
export function selectPriorityItems(items, limit = 1) {
  if (!Array.isArray(items) || items.length === 0) return [];

  // 过滤排除词
  const filteredItems = items.filter(
    (item) => !hasExcludedTitleKeyword(item) && !hasExcludedBadgeKeyword(item)
  );
  const candidateItems = filteredItems.length > 0 ? filteredItems : items;

  // 优先挑无评分新品 (销量降序)
  const priorityOne = candidateItems
    .filter((item) => !normalizeStar(item.starRating))
    .sort(compareBySalesDesc);

  if (priorityOne.length > 0) {
    return priorityOne.slice(0, limit);
  }

  // 退回销量降序 + 评价升序
  return [...candidateItems]
    .sort(compareBySalesDescThenReviewsAsc)
    .slice(0, limit);
}

// ─── 辅助函数 ─────────────────────────────────────────────────────

/**
 * 判断标题是否含排除关键词
 */
function hasExcludedTitleKeyword(item) {
  const title = normalizeText(item?.fullTitle || item?.name || '');
  if (!title) return false;
  const EXCLUDED_TITLE_KEYWORDS = ['玩具', '电器'];
  return EXCLUDED_TITLE_KEYWORDS.some((keyword) => title.includes(keyword));
}

/**
 * 判断是否含排除徽章
 */
function hasExcludedBadgeKeyword(item) {
  const haystack = normalizeText([
    item?.name,
    item?.fullTitle,
    item?.rawText,
  ].filter(Boolean).join(' '));
  if (!haystack) return false;
  return haystack.includes('本地仓');
}

/**
 * 规范化星级
 */
function normalizeStar(value) {
  return String(value || '').trim();
}

/**
 * 销量降序比较器
 */
function compareBySalesDesc(a, b) {
  return getSalesNum(b) - getSalesNum(a);
}

/**
 * 销量降序 + 评价升序比较器
 */
function compareBySalesDescThenReviewsAsc(a, b) {
  const salesDiff = getSalesNum(b) - getSalesNum(a);
  if (salesDiff !== 0) return salesDiff;

  const reviewDiff = parseReviewNum(a.reviewCount) - parseReviewNum(b.reviewCount);
  if (reviewDiff !== 0) return reviewDiff;

  return 0;
}

/**
 * 获取销量数字
 */
function getSalesNum(item) {
  if (item.salesNum) return item.salesNum;
  const text = String(item.sales || item.detailSales || '').replace(/,/g, '').trim();
  if (!text) return 0;
  if (/万/.test(text)) return parseFloat(text) * 10000;
  if (/千/.test(text)) return parseFloat(text) * 1000;
  if (/k/i.test(text)) return parseFloat(text) * 1000;
  return parseFloat(text) || 0;
}

/**
 * 解析评价数
 */
function parseReviewNum(value) {
  const text = String(value || '').replace(/,/g, '').trim();
  if (!text) return 0;
  return parseInt(text, 10) || 0;
}

/**
 * 文本规范化
 */
function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
