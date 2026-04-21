/**
 * 常量定义模块
 * 集中管理所有配置常量、FSM 状态、采集模式等
 */

// ─── 存储键名 ─────────────────────────────────────────────────────
export const STORE_KEY = 'temu_v5_state';

// ─── 延时常量 ─────────────────────────────────────────────────────
/** 详情页渲染等待时间 (ms) */
export const DETAIL_RENDER_DELAY = 2500;
/** 人类化滚动最大步数 */
export const HUMAN_SCROLL_MAX_STEPS = 12;
/** 批量上传阈值 */
export const UPLOAD_BATCH_SIZE = 25;
/** "查看更多"按钮监听超时 (ms) */
export const LOAD_MORE_WATCH_TIMEOUT = 3000;

// ─── FSM 状态定义 ─────────────────────────────────────────────────
/**
 * 工作流状态枚举
 * 每个状态对应采集流程的一个阶段
 */
export const FSM_STATES = {
  LIST_DISCOVERY: 'LIST_DISCOVERY',      // 商品流发现
  TARGET_SELECTED: 'TARGET_SELECTED',    // 目标已选中
  NAVIGATE_TO_DETAIL: 'NAVIGATE_TO_DETAIL', // 导航到详情
  DETAIL_SCRAPE: 'DETAIL_SCRAPE',        // 详情采集
  RELATED_SCAN: 'RELATED_SCAN',          // 联想扫描
  EDGE_COLLECT: 'EDGE_COLLECT',          // 边关系收集
  PAUSE: 'PAUSE',                        // 暂停
  WIND_CONTROL: 'WIND_CONTROL',          // 风控
};

/**
 * FSM 状态转移表
 * 定义从每个状态可以转移到哪些目标状态
 */
export const FSM_TRANSITIONS = {
  [FSM_STATES.LIST_DISCOVERY]: [
    FSM_STATES.TARGET_SELECTED,
    FSM_STATES.DETAIL_SCRAPE,
    FSM_STATES.PAUSE,
    FSM_STATES.WIND_CONTROL,
  ],
  [FSM_STATES.TARGET_SELECTED]: [
    FSM_STATES.NAVIGATE_TO_DETAIL,
    FSM_STATES.LIST_DISCOVERY,
    FSM_STATES.PAUSE,
    FSM_STATES.WIND_CONTROL,
  ],
  [FSM_STATES.NAVIGATE_TO_DETAIL]: [
    FSM_STATES.DETAIL_SCRAPE,
    FSM_STATES.LIST_DISCOVERY,
    FSM_STATES.PAUSE,
    FSM_STATES.WIND_CONTROL,
  ],
  [FSM_STATES.DETAIL_SCRAPE]: [
    FSM_STATES.RELATED_SCAN,
    FSM_STATES.EDGE_COLLECT,
    FSM_STATES.LIST_DISCOVERY,
    FSM_STATES.TARGET_SELECTED,
    FSM_STATES.PAUSE,
    FSM_STATES.WIND_CONTROL,
  ],
  [FSM_STATES.RELATED_SCAN]: [
    FSM_STATES.EDGE_COLLECT,
    FSM_STATES.TARGET_SELECTED,
    FSM_STATES.LIST_DISCOVERY,
    FSM_STATES.PAUSE,
    FSM_STATES.WIND_CONTROL,
  ],
  [FSM_STATES.EDGE_COLLECT]: [
    FSM_STATES.TARGET_SELECTED,
    FSM_STATES.LIST_DISCOVERY,
    FSM_STATES.DETAIL_SCRAPE,
    FSM_STATES.PAUSE,
    FSM_STATES.WIND_CONTROL,
  ],
  [FSM_STATES.PAUSE]: [
    FSM_STATES.LIST_DISCOVERY,
    FSM_STATES.TARGET_SELECTED,
    FSM_STATES.DETAIL_SCRAPE,
    FSM_STATES.WIND_CONTROL,
  ],
  [FSM_STATES.WIND_CONTROL]: [
    FSM_STATES.PAUSE,
    FSM_STATES.LIST_DISCOVERY,
    FSM_STATES.DETAIL_SCRAPE,
  ],
};

// ─── 采集模式 ─────────────────────────────────────────────────────
export const COLLECTION_MODES = {
  CONSERVATIVE: 'CONSERVATIVE', // 保守辅助模式 (需要手动确认)
  AGGRESSIVE: 'AGGRESSIVE',     // 激进自动模式 (全自动)
};

// ─── 任务模式 ─────────────────────────────────────────────────────
export const TASK_MODES = {
  DISCOVERY: 'DISCOVERY', // 发现模式
  HARVEST: 'HARVEST',     // 收割模式
  GRAPH: 'GRAPH',         // 图谱模式
};

// ─── 过滤关键词 ───────────────────────────────────────────────────
/** 标题中包含这些关键词的商品会被排除 */
export const EXCLUDED_TITLE_KEYWORDS = [
  '玩具',
  '电器',
];

// ─── 调试面板配置 ─────────────────────────────────────────────────
export const DEBUG_PANEL_ID = 'temu-scraper-debug-panel';
export const DEBUG_PANEL_STYLE_ID = 'temu-scraper-debug-style';
export const DEBUG_LOG_LIMIT = 14;

// ─── 自动化行为配置 ───────────────────────────────────────────────

/** 自动点击基础延迟范围 (ms) */
export const AUTO_CLICK_DELAY = {
  BASE_MIN: 4200,
  BASE_MAX: 9800,
  EXTRA_MIN: 12000,
  EXTRA_MAX: 25000,
  EXTRA_PROBABILITY: 0.18, // 18% 概率额外延迟
};

/** 鼠标轨迹配置 */
export const MOUSE_TRAJECTORY = {
  DURATION_MIN: 800,  // 轨迹动画时长最小值
  DURATION_MAX: 1500, // 轨迹动画时长最大值
  STEPS_MIN: 24,      // 最小步数
};

/** 滚动行为配置 */
export const SCROLL_CONFIG = {
  STEP_MIN: 800,   // 单步滚动最小距离
  STEP_MAX: 1500,  // 单步滚动最大距离
  PAUSE_MIN: 1500, // 滚动后暂停最小值
  PAUSE_MAX: 3000, // 滚动后暂停最大值
  JITTER_MIN: 80,  // 横向抖动最小值
  JITTER_MAX: 180, // 横向抖动最大值
};

/** 点击行为配置 */
export const CLICK_CONFIG = {
  HOVER_DELAY_MIN: 400,  // 悬停延迟最小值
  HOVER_DELAY_MAX: 1200, // 悬停延迟最大值
  PRESS_DELAY_MIN: 60,   // 按下延迟最小值
  PRESS_DELAY_MAX: 180,  // 按下延迟最大值
  RELEASE_DELAY_MIN: 30, // 释放延迟最小值
  RELEASE_DELAY_MAX: 110,// 释放延迟最大值
};

/** 视口扫描配置 */
export const SWEEP_CONFIG = {
  PER_ROW_DELAY_MS: 2000, // 每行延迟
  ROW_BATCH_SIZE: 4,      // 批次大小
  BATCH_SETTLE_MS: 350,   // 批次间隔
  TIMEOUT_MS: 100000,     // 总超时
};

/** 视口扫描判定函数 */
export const isHydrated = (card) => {
  return String(card?.innerText || '').includes('知了数据');
};
