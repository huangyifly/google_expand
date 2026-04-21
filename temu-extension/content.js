/**
 * ============================================================================
 * Temu 数据采集 - content.js v5.2
 * ============================================================================
 *
 * 【模块说明】
 * 本文件是 Chrome 扩展的内容脚本，负责在 temu.com 页面执行采集逻辑。
 * 代码按功能区域组织，详见 src/ 目录下的模块化参考文件：
 *
 *   src/constants/   - 常量定义 (FSM状态、配置等)
 *   src/utils/       - 工具函数 (sleep、随机数、文本处理)
 *   src/state/       - 状态管理 (getState、patchState)
 *   src/messaging/   - 消息通信 (与 background/popup 交互)
 *   src/dom/         - DOM 操作 (查找、高亮、点击)
 *   src/extraction/  - 数据提取 (商品字段解析)
 *   src/workflow/    - 工作流控制 (FSM状态机)
 *   src/debug/       - 调试面板
 *   src/upload/      - 批量上传
 *
 * 【主流程】
 * 1. 页面加载 → main() 入口 → 检查 state.running
 * 2. URL 含商品锚点 → scrapeAndUpsertCurrentProduct() 补齐字段
 * 3. batch 未满 → productStreamTick() 继续采集
 * 4. batch 已满 → runInitialFilter() 筛选目标 → 高亮等待跳转
 * 5. 循环直到达到 totalLimit 或无更多商品
 *
 * 【FSM 状态流转】
 * LIST_DISCOVERY → TARGET_SELECTED → NAVIGATE_TO_DETAIL → DETAIL_SCRAPE
 *       ↑                                                           ↓
 *       └──────────────── RELATED_SCAN ←────────────────────── EDGE_COLLECT
 *
 * 【采集模式】
 * - CONSERVATIVE: 保守辅助模式，需手动确认"查看更多"
 * - AGGRESSIVE: 激进自动模式，全自动点击和滚动
 *
 * ============================================================================
 * 采集流程围绕"商品流（ProductStream）"推进：
 *   - 任何含商品卡片 (`a[href*="-g-"]`) 的子树都被视作商品流；
 *   - 主流（document 层主区）/ 联想流 (#goodsRecommend) / 推荐流等一视同仁；
 *   - 不再以列表/详情做强分界；详情页同样具备 sweep / scrape / batch / load more 能力。
 * ============================================================================
 */

const STORE_KEY = 'temu_v5_state';
const DETAIL_RENDER_DELAY = 2500;
const HUMAN_SCROLL_MAX_STEPS = 12;
const UPLOAD_BATCH_SIZE = 25;
const LOAD_MORE_WATCH_TIMEOUT = 3000;
const FSM_STATES = {
    LIST_DISCOVERY: 'LIST_DISCOVERY',
    TARGET_SELECTED: 'TARGET_SELECTED',
    NAVIGATE_TO_DETAIL: 'NAVIGATE_TO_DETAIL',
    DETAIL_SCRAPE: 'DETAIL_SCRAPE',
    RELATED_SCAN: 'RELATED_SCAN',
    EDGE_COLLECT: 'EDGE_COLLECT',
    PAUSE: 'PAUSE',
    WIND_CONTROL: 'WIND_CONTROL',
};
// FSM 转移表。重构后详情页也会走 productStreamTick，因此允许 DETAIL_SCRAPE / RELATED_SCAN
// 直接回到 LIST_DISCOVERY —— 把详情页的联想区也视为"商品流发现"，和列表页同等地位。
const FSM_TRANSITIONS = {
    [FSM_STATES.LIST_DISCOVERY]: [FSM_STATES.TARGET_SELECTED, FSM_STATES.DETAIL_SCRAPE, FSM_STATES.PAUSE, FSM_STATES.WIND_CONTROL],
    [FSM_STATES.TARGET_SELECTED]: [FSM_STATES.NAVIGATE_TO_DETAIL, FSM_STATES.LIST_DISCOVERY, FSM_STATES.PAUSE, FSM_STATES.WIND_CONTROL],
    [FSM_STATES.NAVIGATE_TO_DETAIL]: [FSM_STATES.DETAIL_SCRAPE, FSM_STATES.LIST_DISCOVERY, FSM_STATES.PAUSE, FSM_STATES.WIND_CONTROL],
    [FSM_STATES.DETAIL_SCRAPE]: [FSM_STATES.RELATED_SCAN, FSM_STATES.EDGE_COLLECT, FSM_STATES.LIST_DISCOVERY, FSM_STATES.TARGET_SELECTED, FSM_STATES.PAUSE, FSM_STATES.WIND_CONTROL],
    [FSM_STATES.RELATED_SCAN]: [FSM_STATES.EDGE_COLLECT, FSM_STATES.TARGET_SELECTED, FSM_STATES.LIST_DISCOVERY, FSM_STATES.PAUSE, FSM_STATES.WIND_CONTROL],
    [FSM_STATES.EDGE_COLLECT]: [FSM_STATES.TARGET_SELECTED, FSM_STATES.LIST_DISCOVERY, FSM_STATES.DETAIL_SCRAPE, FSM_STATES.PAUSE, FSM_STATES.WIND_CONTROL],
    [FSM_STATES.PAUSE]: [FSM_STATES.LIST_DISCOVERY, FSM_STATES.TARGET_SELECTED, FSM_STATES.DETAIL_SCRAPE, FSM_STATES.WIND_CONTROL],
    [FSM_STATES.WIND_CONTROL]: [FSM_STATES.PAUSE, FSM_STATES.LIST_DISCOVERY, FSM_STATES.DETAIL_SCRAPE],
};
const COLLECTION_MODES = {
    CONSERVATIVE: 'CONSERVATIVE',
    AGGRESSIVE: 'AGGRESSIVE',
};
const TASK_MODES = {
    DISCOVERY: 'DISCOVERY',
    HARVEST: 'HARVEST',
    GRAPH: 'GRAPH',
};
const EXCLUDED_TITLE_KEYWORDS = [
    '玩具',
    '电器',
];

/**
 * 生成一份"空白状态"快照，用于初次启动或 clearAll 时重置 chrome.storage.local。
 * 所有状态字段都集中在这里定义，方便排查字段是否齐全或默认值漂移。
 *
 * @returns {{
 *   running: boolean,
 *   phase: string,
 *   config: {intervalSec: number, batchSize: number, totalLimit: number, autoClickV1: boolean, autoClickLoadMore: boolean, showDebugPanel: boolean, collectionMode: string, taskMode: string},
 *   workflow: {current: string, previous: string, updatedAt: string, reason: string, manualInterventionRequired: boolean},
 *   runUuid: string,
 *   listingUrl: string,
 *   lastDiscoveryUrl: string,
 *   collected: Array<object>,
 *   pendingUploadItems: Array<object>,
 *   pendingUploadEdges: Array<object>,
 *   processedIds: Array<string>,
 *   targetQueue: Array<object>,
 *   batchStartCount: number,
 *   batchAnchorUrl: string,
 *   stats: {listingTotal: number, detailDone: number, cycles: number, relatedAdded: number}
 * }}
 */
function defaultState() {
    return {
        running: false,
        phase: 'idle',
        config: {
            intervalSec: 5,
            batchSize: 60,
            totalLimit: 10000,
            autoClickV1: false,
            autoClickLoadMore: false,
            showDebugPanel: false,
            collectionMode: COLLECTION_MODES.CONSERVATIVE,
            taskMode: TASK_MODES.DISCOVERY,
        },
        workflow: {
            current: FSM_STATES.LIST_DISCOVERY,
            previous: '',
            updatedAt: '',
            reason: '',
            manualInterventionRequired: false,
        },
        runUuid: '',
        // listingUrl 是旧字段；lastDiscoveryUrl 是重构后的新字段，命名不再绑定"列表页"概念。
        // 两个值现在同步更新，读取时优先 lastDiscoveryUrl。
        listingUrl: '',
        lastDiscoveryUrl: '',
        collected: [],
        pendingUploadItems: [],
        pendingUploadEdges: [],
        processedIds: [],
        targetQueue: [],
        lastSweptGoodsId: '',
        batchStartCount: 0,
        // 最近一次重置 batchStartCount 时所在的 URL。main() 在每次运行时比较
        // `location.href` 与此字段：不同则视为"刚落地新页面"（listing / detail 都适用），
        // 把 batchStartCount 重置到当前 collected.length，让每个 URL 拥有自己的 batch 计数。
        batchAnchorUrl: '',
        stats: {
            listingTotal: 0,
            detailDone: 0,
            cycles: 0,
            relatedAdded: 0,
        },
    };
}

let lastKnownState = defaultState();

/**
 * 从 chrome.storage.local 读取完整 state 快照，并更新内存缓存 `lastKnownState`。
 * 这是所有读取路径的唯一入口；不要直接操作 chrome.storage.local.get。
 *
 * @returns {Promise<ReturnType<typeof defaultState>>}
 */
async function getState() {
    return new Promise((resolve) => {
        chrome.storage.local.get([STORE_KEY], (result) => {
            lastKnownState = result[STORE_KEY] || defaultState();
            resolve(lastKnownState);
        });
    });
}

/**
 * 增量更新 state：先读当前值 → 浅合并 updates → 对 `config`/`stats`/`workflow` 三个
 * 子对象做二级浅合并 → 写回 storage。所有写入都走这里，不要自己拼 `set()`。
 *
 * 排查点：如果写入失败（比如单条 collected 带了太大的 rawHtml 触发
 * QuotaExceededError），会在 console.error 打印 `[Temu] chrome.storage.local.set 失败`
 * 以及 `collectedCount / approxBytes`。manifest 已加 `unlimitedStorage` 规避 5MB 软限。
 *
 * @param {Partial<ReturnType<typeof defaultState>>} updates
 * @returns {Promise<void>}
 */
async function patchState(updates) {
    const current = await getState();
    const next = {...current, ...updates};
    if (updates.config) next.config = {...current.config, ...updates.config};
    if (updates.stats) next.stats = {...current.stats, ...updates.stats};
    if (updates.workflow) {
        next.workflow = {...current.workflow, ...updates.workflow};
    }
    lastKnownState = next;
    return new Promise((resolve) => {
        chrome.storage.local.set({[STORE_KEY]: next}, () => {
            const err = chrome.runtime.lastError;
            if (err) {
                // 之前这里静默吞掉了 QuotaExceededError 等错误，导致 rawHtml 大字段被丢弃无人察觉。
                // 现在让它在控制台大声报错，并把 collected 的体积信息一起打印出来方便定位。
                try {
                    const collectedCount = Array.isArray(next.collected) ? next.collected.length : 0;
                    const payloadBytes = new Blob([JSON.stringify(next)]).size;
                    console.error('[Temu] chrome.storage.local.set 失败', {
                        message: err.message || String(err),
                        collectedCount,
                        approxBytes: payloadBytes,
                    });
                } catch (_) {
                    console.error('[Temu] chrome.storage.local.set 失败', err);
                }
            }
            resolve();
        });
    });
}

/**
 * 同步读取 workflow 分片（FSM 当前状态/上一个状态/转换原因）。
 * 只读内存缓存，不会触发 chrome.storage 异步读，适合在渲染循环里调用。
 *
 * @returns {ReturnType<typeof defaultState>['workflow']}
 */
function getStateSnapshotWorkflow() {
    return lastKnownState.workflow || defaultState().workflow;
}

/**
 * 同步读取 config 分片（intervalSec/batchSize/totalLimit/采集模式等）。
 * 同样读内存缓存，UI 渲染/防抖判断时用。
 *
 * @returns {ReturnType<typeof defaultState>['config']}
 */
function getStateSnapshotConfig() {
    return lastKnownState.config || defaultState().config;
}

/**
 * 判断当前页是否在 Temu 域内。仅用于"页面是否值得跑商品流采集"的最外层校验，
 * 不再做 listing / detail 的强分界 —— 任何 temu.com 页都按"可能含商品流"对待。
 *
 * 历史上还有 'detail' / 'listing' 两个返回值用于流程分派，现在统一返回 'product' / 'other'，
 * 由 `enumerateProductStreams()` 在 DOM 层面决定到底有几股商品流。
 *
 * @returns {'product' | 'other'}
 */
function getPageType() {
    if (/temu\.com/.test(location.href)) return 'product';
    return 'other';
}

/**
 * @deprecated 保留为对外的兼容名，等同于 `getPageType()`。
 * 老代码（包括上传 payload / popup 通知）里使用的字段仍是 'product' / 'other'。
 *
 * @returns {'product' | 'other'}
 */
function getNormalizedPageType() {
    return getPageType();
}

/**
 * 当前 URL 是否长得像"商品详情"：含 `-g-数字.html` 即视为有"当前主商品"。
 * 仅用于决定 main 流程是否要先抓 h1 / rawBlock 做单商品字段补齐，不影响商品流枚举。
 *
 * @returns {boolean}
 */
function hasCurrentProductAnchor() {
    return Boolean(getGoodsIdFromUrl(location.href));
}

/**
 * 从商品详情页 URL 中提取 goodsId（`-g-数字.html` 里的那串数字）。
 *
 * @param {string} url
 * @returns {string} 匹配不到时返回空串
 */
function getGoodsIdFromUrl(url) {
    return String(url || '').match(/-g-(\d+)\.html/)?.[1] || '';
}

/**
 * 本地化日期字符串（中文，给调试面板展示用）。
 *
 * @returns {string} 形如 "2026/4/19 下午3:24:08"
 */
function nowText() {
    return new Date().toLocaleString('zh-CN');
}

/**
 * ISO 时间戳（给 workflow.updatedAt / 上传后端 payload 用）。
 *
 * @returns {string} 形如 "2026-04-19T07:24:08.123Z"
 */
function nowIsoText() {
    return new Date().toISOString();
}

/**
 * 基于 setTimeout 的 Promise 延时。被滚动/等待加载/人类化点击等逻辑反复使用。
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从 state 里取 FSM 当前状态，缺省 fallback 到 `LIST_DISCOVERY`。
 *
 * @param {ReturnType<typeof defaultState>} state
 * @returns {string}
 */
function getCurrentState(state) {
    return state?.workflow?.current || FSM_STATES.LIST_DISCOVERY;
}

/**
 * 校验 FSM 状态转换是否合法（查 `FSM_TRANSITIONS` 表）。自己跳自己视为合法。
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(from, to) {
    if (from === to) return true;
    return Boolean(FSM_TRANSITIONS[from]?.includes(to));
}

/**
 * 把 FSM 状态映射到 popup/UI 展示的 phase（列表/导航/详情/联想/风控/空闲）。
 * 新加 FSM 状态时记得补一行 case，否则 UI 会退回到 `idle`。
 *
 * @param {string} nextState FSM 目标状态
 * @returns {'listing'|'navigating'|'detail'|'related'|'idle'|'filtering'}
 */
function getPhaseByWorkflow(nextState) {
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
 * 选择 FSM 初始状态。新模型下不再按"页面类型"分派，改成按"页面上有没有可操作的目标"：
 *   - 当前 URL 是详情锚点 + GRAPH 任务 → 跳过主商品字段，直接进联想扫描；
 *   - 当前 URL 是详情锚点 + 其他任务 → 先抓主商品字段；
 *   - HARVEST 任务 → 直接消费队列；
 *   - 其它情况 → 走 LIST_DISCOVERY（统一的商品流发现入口）。
 *
 * 旧签名 `(taskMode, pageType)` 保留第二参数兼容调用点，但只在"page 是 other"时才会阻止进入采集；
 * 其余逻辑全部走 URL 锚点判断。
 *
 * @param {string} taskMode `TASK_MODES.*`
 * @param {'product'|'other'|'detail'|'listing'} [pageType]
 * @returns {string} FSM 状态
 */
function getInitialWorkflowState(taskMode, pageType) {
    void pageType; // 兼容旧调用；不再作为硬分支
    const hasAnchor = hasCurrentProductAnchor();
    if (hasAnchor) {
        if (taskMode === TASK_MODES.GRAPH) return FSM_STATES.RELATED_SCAN;
        return FSM_STATES.DETAIL_SCRAPE;
    }
    if (taskMode === TASK_MODES.HARVEST) return FSM_STATES.TARGET_SELECTED;
    return FSM_STATES.LIST_DISCOVERY;
}

/**
 * FSM 状态切换的唯一入口。会：
 * 1. 查当前状态，非法转换则直接返回 false（除非 `options.force`）
 * 2. 写回新状态 + `updatedAt`/`reason` 到 `workflow` 分片
 * 3. 同步更新 `phase`（UI 用），默认由 `getPhaseByWorkflow` 推导
 * 4. 触发 `notifyState` 广播到 popup + 重绘 debug 面板
 *
 * @param {string} nextState 目标 FSM 状态
 * @param {{phase?: string, reason?: string, force?: boolean, manualInterventionRequired?: boolean}} [options]
 * @returns {Promise<boolean>} true=切换成功，false=非法转换被阻止
 */
async function transitionTo(nextState, options = {}) {
    const current = await getState();
    const currentWorkflow = getCurrentState(current);
    if (!options.force && !canTransition(currentWorkflow, nextState)) {
        return false;
    }

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
    notifyState(await getState());
    renderDebugPanel();
    return true;
}

/**
 * 向 background service worker 发送一条异步消息（后续可能被转发到 popup）。
 * 用 try/catch 吞掉 "Extension context invalidated" 等在扩展重载时的常见错误。
 *
 * @param {{action: string, [key: string]: unknown}} message
 * @returns {void}
 */
function notify(message) {
    try {
        chrome.runtime.sendMessage(message);
    } catch (_) {
    }
}

/**
 * 在页面右上角弹一条 3.2 秒自动消失的 Toast，用于告知用户非阻塞性事件
 * （比如"没找到查看更多按钮"）。依赖 `.temu-scraper-toast*` 样式（在 ensureHighlightStyle 里注入）。
 *
 * @param {string} message
 * @param {'info'|'ok'|'err'|'warn'} [type]
 */
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `temu-scraper-toast temu-scraper-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 260);
    }, 3200);
}

const DEBUG_PANEL_ID = 'temu-scraper-debug-panel';
const DEBUG_PANEL_STYLE_ID = 'temu-scraper-debug-style';
const DEBUG_LOG_LIMIT = 14;
let debugEntries = [];
let debugPanelVisible = true;
let debugPanelBound = false;
let debugPendingLoadMore = null;

/**
 * 采集模式的中文标签（调试面板/toast 用）。
 *
 * @param {string} mode `COLLECTION_MODES.*`
 * @returns {string}
 */
function getCollectionModeLabel(mode) {
    return mode === COLLECTION_MODES.AGGRESSIVE ? '激进自动模式' : '保守辅助模式';
}

/**
 * 任务模式的中文/英文标签（调试面板用）。
 *
 * @param {string} mode `TASK_MODES.*`
 * @returns {string}
 */
function getTaskModeLabel(mode) {
    return {
        [TASK_MODES.DISCOVERY]: 'Discovery Mode',
        [TASK_MODES.HARVEST]: 'Harvest Mode',
        [TASK_MODES.GRAPH]: 'Graph Mode',
    }[mode] || mode;
}

/**
 * 切换右下角调试面板的显隐。`false` 会直接把 DOM 节点移除（不是隐藏）。
 * 由 popup 的 `setConfig({showDebugPanel})` 触发。
 *
 * @param {boolean} enabled
 */
function setDebugPanelVisibility(enabled) {
    debugPanelVisible = enabled !== false;
    if (!debugPanelVisible) {
        document.getElementById(DEBUG_PANEL_ID)?.remove();
        return;
    }
    renderDebugPanel();
}

/**
 * 懒加载调试面板：注入样式 + 创建 `#temu-scraper-debug-panel` 节点，并绑定一次性的
 * 事件代理（状态跳转按钮、"加载更多"按钮）。幂等，重复调用只会复用已有节点。
 *
 * @returns {HTMLElement | null} 面板节点；document.body 还没准备好时返回 null
 */
function ensureDebugPanel() {
    if (!debugPanelVisible) return null;
    if (!document.body) return null;

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
        background: rgba(17, 17, 17, 0.92);
        color: #fff;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 10px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
        font: 12px/1.45 Menlo, Monaco, Consolas, monospace;
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
        color: #ffb36b;
        font-weight: 700;
        margin-bottom: 6px;
        position: sticky;
        top: 0;
        background: rgba(17, 17, 17, 0.98);
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
        background: rgba(255, 179, 107, 0.14);
        color: #ffd7b0;
        font-weight: 700;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-btn {
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 8px;
        background: rgba(255,255,255,0.08);
        color: #fff;
        padding: 6px 8px;
        cursor: pointer;
        font: inherit;
      }
      #${DEBUG_PANEL_ID} .temu-scraper-debug-btn-primary {
        background: linear-gradient(135deg, #f15a24, #ff7a18);
        border-color: transparent;
        color: #fff;
        font-weight: 700;
      }
      #${DEBUG_PANEL_ID}::-webkit-scrollbar {
        width: 8px;
      }
      #${DEBUG_PANEL_ID}::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.24);
        border-radius: 999px;
      }
      #${DEBUG_PANEL_ID}::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.06);
        border-radius: 999px;
      }
    `;
        document.documentElement.appendChild(style);
    }

    let panel = document.getElementById(DEBUG_PANEL_ID);
    if (!panel) {
        panel = document.createElement('div');
        panel.id = DEBUG_PANEL_ID;
        document.body.appendChild(panel);
    }
    if (!debugPanelBound) {
        panel.addEventListener('click', async (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const action = target.getAttribute('data-debug-action');
            if (!action) return;
            if (action === 'load-more-now') {
                await triggerLoadMoreNow();
                return;
            }
            if (action === 'jump-state') {
                const nextState = target.getAttribute('data-next-state');
                if (nextState) {
                    const ok = await transitionTo(nextState, {
                        force: true,
                        reason: 'debug-panel-jump',
                    });
                    if (!ok) {
                        showToast(`无法跳转到状态：${nextState}`, 'error');
                    }
                }
            }
        });
        debugPanelBound = true;
    }
    return panel;
}

/**
 * 重绘调试面板内容：顶部状态药丸 + 操作按钮 + 最近 14 条 debug 日志。
 * 每次 `debugLog()` / `transitionTo()` 之后会自动调用。DOM 渲染是 `innerHTML` 全量覆盖，
 * 对性能友好度一般，但调试面板节点小、刷新不频繁，可以接受。
 */
function renderDebugPanel() {
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
      <button class="temu-scraper-debug-btn" data-debug-action="jump-state" data-next-state="${FSM_STATES.LIST_DISCOVERY}">列表发现</button>
      <button class="temu-scraper-debug-btn" data-debug-action="jump-state" data-next-state="${FSM_STATES.TARGET_SELECTED}">目标选中</button>
      <button class="temu-scraper-debug-btn" data-debug-action="jump-state" data-next-state="${FSM_STATES.DETAIL_SCRAPE}">详情深采</button>
      <button class="temu-scraper-debug-btn" data-debug-action="jump-state" data-next-state="${FSM_STATES.WIND_CONTROL}">风控暂停</button>
    </div>
    ${debugEntries.map((line) => `<div class="temu-scraper-debug-line">${escapeHtml(line)}</div>`).join('')}
  `;
}

/**
 * HTML 转义。调试面板是 `innerHTML` 渲染，所有动态文本必须走这里防 XSS。
 *
 * @param {unknown} text
 * @returns {string}
 */
function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 统一的调试日志入口：
 * 1. 追加到 `debugEntries`（环形，只留最近 14 条）并刷新调试面板
 * 2. 同步 `console.log` 一条结构化日志（`[Temu Scraper Debug]` 前缀），排查 bug 主要靠这条
 *
 * @param {string} event 事件名，如 `sweep-cards-into-view`
 * @param {Record<string, unknown>} [extra] 附加字段，会被 JSON 序列化贴到面板
 */
function debugLog(event, extra = {}) {
    const payload = {
        pageType: getNormalizedPageType(),
        ...extra,
    };
    const line = `${new Date().toLocaleTimeString('zh-CN', {hour12: false})} ${event} ${JSON.stringify(payload)}`;
    debugEntries.push(line);
    if (debugEntries.length > DEBUG_LOG_LIMIT) {
        debugEntries = debugEntries.slice(-DEBUG_LOG_LIMIT);
    }
    renderDebugPanel();

    try {
        // console.log('[Temu Scraper Debug]', event, {
        //     pageType: getNormalizedPageType(),
        //     url: location.href,
        //     ...extra,
        // });
    } catch (_) {
    }
}

/**
 * 按 `config.showDebugPanel` 决定是否渲染调试面板。`main()` 启动时和
 * `setConfig` 消息处理里各会调用一次，保证面板可见性与 popup 勾选同步。
 *
 * @param {ReturnType<typeof defaultState>['config'] | null} [config]
 * @returns {Promise<void>}
 */
async function applyDebugPanelConfig(config = null) {
    const nextConfig = config || (await getState()).config || {};
    setDebugPanelVisibility(nextConfig.showDebugPanel !== false);
}

let mainLock = false;
let pendingLoadMoreResumeTimer = null;
let pendingHighlightRefreshTimer = null;
let pendingHighlightObserver = null;
let pendingAutoClickTimer = null;
let pendingAutoClickGoodsId = '';
let uploadInFlight = false;

/**
 * 把 `chrome.runtime.sendMessage` 的回调风格包成 Promise，并把 `lastError` 和同步异常
 * 统一归一到 `{ok, error}` 形态，避免调用方漏写错误分支。
 *
 * @param {string} action 后端动作名（如 `backendStartRun`/`backendUploadBatch`）
 * @param {Record<string, unknown>} [extra] 额外 payload 字段
 * @returns {Promise<{ok: boolean, error?: string, [key: string]: unknown}>}
 */
function callRuntime(action, extra = {}) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({action, ...extra}, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ok: false, error: chrome.runtime.lastError.message});
                    return;
                }
                resolve(response || {ok: false, error: 'empty response'});
            });
        } catch (error) {
            resolve({ok: false, error: error?.message || String(error)});
        }
    });
}

/**
 * 整个 content script 的总入口。每次页面加载、路由变更、或收到 popup 的控制消息
 * 都会调用一次。内部用 `mainLock` 保证同一时刻只有一条 `main()` 在跑。
 *
 * 新版统一流程（不再按 listing/detail 分派）：
 *   1. 读 state；非 running / 非 Temu 页 → 跳回上次记录的发现页（如果有）；
 *   2. URL 切换判定：`location.href !== state.batchAnchorUrl` → 重置 batchStartCount
 *      为当前 collected.length，并记录 batchAnchorUrl = location.href。这样每个 URL
 *      （listing / detail / detail2 / ...）都拥有自己独立的 batch 计数；
 *   3. URL 含商品锚点（`-g-数字.html`）→ 先抓"当前主商品"字段补齐；
 *   4. batchSize gate：只有当前 batchLoaded >= batchSize 或 collected >= totalLimit，
 *      才允许进入 queue-ready 快速路径高亮目标；否则强制先跑 productStreamTick
 *      继续采满批次（详情页联想区同样受此 gate 约束）；
 *   5. 队列已有目标 + batch 已满 → 高亮第一项等待跳转；
 *   6. 否则跑 `productStreamTick()`：枚举页面所有商品流 → sweep + scrape + upsert + edges
 *      → 满 batch / 超 totalLimit → runInitialFilter；否则尝试 load more / 兜底兜出下一跳。
 *
 * `lastDiscoveryUrl` 取代旧的 `listingUrl` —— 命名上不再绑定"列表页"概念，但行为一致：
 * 记录最近一次成功跑过商品流的页面，便于离开 Temu 后回跳。旧字段同步写入做向下兼容。
 *
 * @returns {Promise<void>}
 */
async function main() {
    if (mainLock) return;
    mainLock = true;

    try {
        const state = await getState();
        await applyDebugPanelConfig(state.config);
        if (!state.running) return;

        notifyState(state);

        // 非 Temu 页：尝试回跳到最近一次跑过商品流的页面（兼容旧字段 listingUrl）
        if (getPageType() === 'other') {
            const fallback = state.lastDiscoveryUrl || state.listingUrl || '';
            if (fallback) {
                await sleep(1000);
                location.href = fallback;
            }
            return;
        }

        // 1) 新 URL 登陆 → 重置本页 batch 计数。每次 URL 变化（listing → detail、
        //    detail → detail2、甚至 listing 内部翻页）都会进到这里。
        //    重置放在 scrapeAndUpsertCurrentProduct 之前，让主商品也计入本页 batch 的第一条。
        if (location.href !== state.batchAnchorUrl) {
            await patchState({
                batchStartCount: state.collected.length,
                batchAnchorUrl: location.href,
            });
        }

        // 2) 当前 URL 是商品锚点 → 补齐主商品字段（独立函数，列表/详情/搜索/任意页都生效）
        if (hasCurrentProductAnchor()) {
            await scrapeAndUpsertCurrentProduct();
        }

        const refreshed = await getState();

        // 3) batchSize gate：无论 listing 还是 detail，先判断本页 batch 是否已采够。
        //    batchStartCount 已在 step 1 针对当前 URL 重置过，所以 batchLoaded 代表的是
        //    "本页之内"已采的条数，detail 和 listing 各自独立计数。
        //    没满就先跑 productStreamTick 继续采（期间会 auto-click 联想区"查看更多"），
        //    本轮 main() 直接 return，等下一轮再判定。
        const batchLoaded = refreshed.collected.length - refreshed.batchStartCount;
        const batchFull = batchLoaded >= refreshed.config.batchSize
            || refreshed.collected.length >= refreshed.config.totalLimit;

        if (!batchFull) {
            await transitionTo(FSM_STATES.LIST_DISCOVERY, {
                phase: 'listing',
                reason: 'stream-discovery',
            });
            await patchState({
                phase: 'listing',
                listingUrl: location.href,
                lastDiscoveryUrl: location.href,
            });
            await sleep(1500);
            await productStreamTick();
            return;
        }

        // 4) batch 已满 + 已有目标队列 → 直接高亮第一项，等用户/auto-click 跳转
        if (refreshed.targetQueue.length > 0) {
            const nextItem = refreshed.targetQueue[0];
            await transitionTo(FSM_STATES.TARGET_SELECTED, {
                phase: 'navigating',
                reason: 'queue-ready',
            });
            await patchState({
                phase: 'navigating',
                listingUrl: location.href,
                lastDiscoveryUrl: location.href,
            });
            await highlightPendingItem(nextItem, '待处理目标，点击后进入下一商品');
            notify({
                action: 'navigate',
                goodsId: nextItem.goodsId,
                queueLen: refreshed.targetQueue.length,
            });
            return;
        }

        // 5) batch 已满但队列空 → 进入"商品流发现"，由 productStreamTick 末尾的
        //    runInitialFilter 挑目标装队列
        await transitionTo(FSM_STATES.LIST_DISCOVERY, {
            phase: 'listing',
            reason: 'stream-discovery',
        });
        await patchState({
            phase: 'listing',
            listingUrl: location.href,
            lastDiscoveryUrl: location.href,
        });
        await sleep(1500);
        await productStreamTick();
    } finally {
        mainLock = false;
    }
}

/**
 * 把当前 state 的关键切片打包成 `stateSync` 消息广播到 popup。popup 收到后会
 * 重绘按钮文字、phase dot、配置表单等。每次状态变更/进入新页面都会调一次。
 *
 * @param {ReturnType<typeof defaultState>} state
 * @param {string} [pageType]
 */
function notifyState(state, pageType = getNormalizedPageType()) {
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
 * 枚举当前页所有"商品流"。
 *
 * 【什么是商品流】
 * 一个商品流 = 含 N 张商品卡片的 DOM 子树。
 * Temu 页面可能有多个商品流区域：
 *   - 主流: document 下的主要商品列表 (列表页/搜索页)
 *   - 联想流: 详情页底部的 #goodsRecommend 区域
 *
 * 【返回结构】
 * 每个流对象包含:
 *   - id: 流标识 ('main' / 'related')
 *   - sourceTag: 来源标签，用于标记采集到的商品来源
 *   - getCards(): 获取该流下的所有商品卡 DOM
 *   - getLoadMoreBtn(): 获取"查看更多"按钮 (主流有，联想流无)
 *   - ensureReady(): 确保流已准备好 (联想流需要先滚动到底部触发渲染)
 *
 * 【扩展说明】
 * 要支持"猜你喜欢/类似商品"等新区域，只需在这里 push 一个新 stream 对象。
 *
 * @returns {Array<object>} 商品流对象数组
 */
function enumerateProductStreams() {
    const streams = [];
    const relatedRoot = getRelatedItemsRoot();

    // 主流：document 全局，但不要把联想区的卡再算进来 —— 后续 scrapeStream 会按 root 过滤
    streams.push({
        id: 'main',
        sourceTag: 'listing',
        getCards: () => {
            const all = findProductCards(document);
            const skip = getRelatedItemsRoot();
            if (!skip) return all;
            return all.filter((card) => !skip.contains(card));
        },
        getLoadMoreBtn: () => findLoadMoreBtn(),
        ensureReady: async () => true,
    });

    // 联想流：仅在 #goodsRecommend 存在时才作为独立 stream
    if (relatedRoot) {
        streams.push({
            id: 'related',
            sourceTag: 'related',
            getCards: () => {
                const root = getRelatedItemsRoot();
                if (!root) return [];
                return findProductCards(root);
            },
            getLoadMoreBtn: () => null, // 联想区暂无独立的 load more 按钮
            ensureReady: async () => {
                const currentId = getGoodsIdFromUrl(location.href);
                return ensureRelatedAreaReady(currentId);
            },
        });
    }

    return streams;
}

/**
 * 对单个商品流执行采集 (sweep + scrape)。
 *
 * 【流程说明】
 * 1. 先调用 sweepCardsIntoView 把卡片滚入视口，触发 Temu 的懒加载
 * 2. 获取所有商品卡片 DOM 节点
 * 3. 遍历每张卡，调用 extractItemFromCard 提取字段
 * 4. 按 goodsId 去重，避免重复采集
 * 5. 给每条记录打上 source 标签 (listing/related)
 *
 * 【参数说明】
 * - stream.id: 流标识 ('main' / 'related')
 * - stream.sourceTag: 来源标签 ('listing' / 'related')
 * - stream.getCards(): 获取该流下的所有商品卡
 * - stream.ensureReady(): 确保流已准备好 (如联想区需要先滚动到底部)
 *
 * @param {object} stream 商品流对象
 * @returns {Promise<Array>} 采集到的商品列表
 */
async function harvestStream(stream) {
    await sweepCardsIntoView({streamId: stream.id});
    const cards = stream.getCards();
    if (!cards.length) return [];
    const items = [];
    const seen = new Set();
    for (let index = 0; index < cards.length; index += 1) {
        const card = cards[index];
        const item = extractItemFromCard(card, stream.sourceTag);
        if (!item?.goodsId || seen.has(item.goodsId)) continue;
        seen.add(item.goodsId);
        items.push({...item, domIndex: index, sourceRootId: stream.id});
    }
    return items;
}

/**
 * 商品流统一推进。本函数取代旧的 `listingTick`：
 *   1. 枚举页面所有商品流（含详情页的联想区）；
 *   2. 对每股流 ensureReady → harvest → upsert；如果当前 URL 是商品锚点，
 *      把 (currentId → 抓到的商品) 当作 edges 记录，便于图谱模式下追溯关系；
 *   3. 满 batch / 超 totalLimit → 进 `runInitialFilter`；
 *   4. 否则尝试找"加载更多"按钮（任一 stream 提供）：
 *      - 激进模式：自动点击；
 *      - 保守模式：高亮等用户点；
 *      - 找不到 + 激进模式：simulateSlowLazyLoad 兜底滚一下再 retry；
 *      - 仍找不到：直接进 `runInitialFilter`，让它从已抓数据里挑下一跳。
 *   5. 极端情况：本页根本没有商品流（如详情页联想区还没渲染）→ 视情况 PAUSE 等人工。
 *
 * 排查 bug：
 *   - `listingProgress` 通知里看 `batchLoaded` / `streams` 字段；
 *   - `product-stream-tick` debug 日志记录每股流的卡数 + 增量。
 *
 * @returns {Promise<void>}
 */
async function productStreamTick() {
    const streams = enumerateProductStreams();
    const currentId = getGoodsIdFromUrl(location.href);

    let totalAdded = 0;
    const perStreamStats = [];
    const allEdges = [];

    for (const stream of streams) {
        const ready = await stream.ensureReady();
        if (!ready) {
            perStreamStats.push({id: stream.id, ready: false, scraped: 0, added: 0});
            continue;
        }
        const scraped = await harvestStream(stream);
        const added = await upsertItems(scraped);
        totalAdded += added;
        perStreamStats.push({id: stream.id, ready: true, scraped: scraped.length, added});

        // 记录 (current → other) 的关系边；联想区或主区都视情况上报
        if (currentId) {
            for (const item of scraped) {
                if (!item.goodsId || item.goodsId === currentId) continue;
                allEdges.push({
                    from_goods_id: currentId,
                    to_goods_id: item.goodsId,
                    relation_type: stream.sourceTag === 'related' ? 'related' : 'co_listing',
                });
            }
        }
    }

    if (allEdges.length) {
        await enqueueUploadEdges(allEdges);
    }

    const refreshed = await getState();
    const batchLoaded = refreshed.collected.length - refreshed.batchStartCount;

    await patchState({
        stats: {
            listingTotal: refreshed.collected.length,
        },
    });

    debugLog('product-stream-tick', {
        currentId,
        streams: perStreamStats,
        totalAdded,
        batchLoaded,
        total: refreshed.collected.length,
    });

    notify({
        action: 'listingProgress',
        total: refreshed.collected.length,
        batchLoaded,
        added: totalAdded,
        streams: perStreamStats,
    });

    if (
        batchLoaded >= refreshed.config.batchSize ||
        refreshed.collected.length >= refreshed.config.totalLimit
    ) {
        await runInitialFilter(await getState());
        return;
    }

    // sweep 只保证卡片水合，没必要把视口还原回去。直接把页面滚到底部，
    // 让 Temu 把"查看更多"按钮渲染出来；sleep 给一点点时间让 DOM 稳定。
    try {
        window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: 'auto',
        });
    } catch (_) {
        // scrollTo 在极端情况会 throw，忽略即可
    }
    await sleep(400);

    // 任一 stream 提供 load more 按钮就用之
    let loadMoreBtn = null;
    for (const stream of streams) {
        const btn = stream.getLoadMoreBtn?.();
        if (btn) {
            loadMoreBtn = btn;
            break;
        }
    }

    if (loadMoreBtn) {
        // loadMoreBtn.scrollIntoView({behavior: 'smooth', block: 'center'});
        const shouldAuto = refreshed.config.collectionMode === COLLECTION_MODES.AGGRESSIVE;
        highlightLoadMoreButton(loadMoreBtn, {
            autoClick: shouldAuto,
            waitSec: refreshed.config.intervalSec,
        });
        notify({
            action: 'clickMore',
            total: refreshed.collected.length,
            autoClick: shouldAuto,
        });
        if (shouldAuto) {
            await handleAutoLoadMoreClick(loadMoreBtn, refreshed.config.intervalSec);
        }
        return;
    }

    // 没有 load more 也没有可消费数据 → 让 runInitialFilter 决定 finish 或换页
    await runInitialFilter(await getState());
}

/**
 * 兼容老调用：保留 `listingTick` 名字，内部直接转发到 `productStreamTick`。
 *
 * @returns {Promise<void>}
 */
async function listingTick() {
    return productStreamTick();
}

/**
 * 初始过滤。"一批抓满之后从 collected 里挑下一跳目标"。
 *
 * 本函数对商品流来源不再敏感：不管候选来自主区还是联想区，只要 `!processedIds` 就是合法候选。
 *
 * 逻辑：
 *   - 从 `collected` 里剔除已处理 ID，余下交给 `selectPriorityItems` 挑 1 条；
 *   - 挑不到：
 *       · collected 已超 totalLimit 或"全页无任何 stream 能继续扩池" → 直接 finish；
 *       · 否则重置 batchStartCount 让下一轮 tick 再去抓；
 *   - 挑得到：入队 + 切 TARGET_SELECTED + 高亮该卡片等用户点。
 *
 * @param {ReturnType<typeof defaultState>} state
 * @returns {Promise<void>}
 */
async function runInitialFilter(state) {
    await transitionTo(FSM_STATES.LIST_DISCOVERY, {
        phase: 'filtering',
        reason: 'run-initial-filter',
    });
    await patchState({phase: 'filtering'});

    const processed = new Set(state.processedIds);
    const queue = selectPriorityItems(
        state.collected.filter((item) => item.goodsId && !processed.has(item.goodsId)),
        1
    );

    notify({
        action: 'filtered',
        validCount: queue.length,
        queued: queue.length,
        total: state.collected.length,
    });

    if (queue.length === 0) {
        // 没可挑的了：检查当前页是否还有"可扩池"的能力。load more 按钮或联想流都算。
        const canExpand = Boolean(findLoadMoreBtn()) || Boolean(getRelatedItemsRoot());
        if (state.collected.length >= state.config.totalLimit || !canExpand) {
            await finish(await getState());
            return;
        }

        await patchState({
            phase: 'listing',
            batchStartCount: state.collected.length,
            stats: {cycles: (state.stats.cycles || 0) + 1},
        });

        setTimeout(() => {
            mainLock = false;
            main();
        }, 1000);
        return;
    }

    await enqueueItems(queue, {
        markProcessed: true,
        phase: 'navigating',
        resetQueue: true,
        incrementCycles: true,
    });
    await transitionTo(FSM_STATES.TARGET_SELECTED, {
        phase: 'navigating',
        reason: 'initial-filter-hit',
    });
    await highlightPendingItem(queue[0], '初筛命中，点击后进入下一商品');
}

/**
 * 抓取并 upsert "当前 URL 锚定的主商品" 字段：h1 标题 / 价格 / 销量 / 星级 / 评价 + rawBlock。
 *
 * 这是一段"对单一商品做字段补齐"的纯逻辑，不再耦合 detail 页的整套流程。`main()` 只在
 * `hasCurrentProductAnchor()` 为真时调用一次；商品流的 sweep / 联想区采集 / 目标挑选 全部
 * 由 `productStreamTick` 接管。
 *
 * 注意点：
 *   - rawHtml/rawText 为空时不会清掉 prev 值（依赖 upsertItems 的过滤）；
 *   - 进入 DETAIL_SCRAPE 状态前等 DETAIL_RENDER_DELAY 让 Temu 把详情区渲染完；
 *   - stats.detailDone++，并广播 `detailDone` 给 popup。
 *
 * @returns {Promise<void>}
 */
async function scrapeAndUpsertCurrentProduct() {
    const currentUrl = location.href;
    const currentId = getGoodsIdFromUrl(currentUrl);
    if (!currentId) return;

    await transitionTo(FSM_STATES.DETAIL_SCRAPE, {
        phase: 'detail',
        reason: 'current-product-scrape',
    });
    await patchState({phase: 'detail'});
    await sleep(DETAIL_RENDER_DELAY);

    const detailData = scrapeDetailFields(currentId);
    const detailRawBlock = scrapeDetailRawBlock();
    debugLog('current-product-scrape', {
        goodsId: currentId,
        rawHtmlLength: detailRawBlock.rawHtml.length,
        rawTextLength: detailRawBlock.rawText.length,
    });

    await upsertItems([
        {
            goodsId: currentId,
            link: currentUrl,
            name: detailData.fullTitle?.slice(0, 80) || '',
            fullTitle: detailData.fullTitle || '',
            price: detailData.price || '',
            detailPrice: detailData.price || '',
            sales: detailData.sales || '',
            detailSales: detailData.sales || '',
            starRating: detailData.stars || '',
            detailStars: detailData.stars || '',
            reviewCount: detailData.reviews || '',
            detailReviews: detailData.reviews || '',
            listingTime: detailData.listingTime || '',
            detailScraped: true,
            scrapedAt: nowText(),
            detailAt: nowText(),
            salesNum: parseSalesNum(detailData.sales || ''),
            // 空字符串会被 upsertItems 的过滤规则丢弃，从而保留 prev.rawHtml
            rawHtml: detailRawBlock.rawHtml,
            rawText: detailRawBlock.rawText,
        },
    ]);

    await patchState({
        targetQueue: [],
        stats: {
            detailDone: ((await getState()).stats.detailDone || 0) + 1,
        },
    });

    const refreshed = await getState();
    notify({
        action: 'detailDone',
        goodsId: currentId,
        remaining: refreshed.targetQueue.length,
        detailDone: refreshed.stats.detailDone || 0,
    });
}

/**
 * @deprecated 兼容旧调用：现在等价于 `scrapeAndUpsertCurrentProduct() + productStreamTick()`。
 * 没有强制要求"在详情页才能跑" —— 只要 URL 含商品锚点就抓主商品字段，剩余靠 streamTick。
 *
 * @returns {Promise<void>}
 */
async function handleDetail() {
    if (hasCurrentProductAnchor()) {
        await scrapeAndUpsertCurrentProduct();
    }
    await productStreamTick();
}

/**
 * @deprecated 兼容旧调用：联想商品的采集已被 `productStreamTick` 中的 'related' stream 接管。
 * 保留函数名作为外部调试入口，仍返回"本次入队的目标数"。
 *
 * @param {string} currentId 当前商品锚点 ID（仅用于上报 edges）
 * @returns {Promise<number>}
 */
async function collectRelatedItems(currentId) {
    void currentId;
    const before = (await getState()).targetQueue.length;
    await productStreamTick();
    const after = (await getState()).targetQueue.length;
    return Math.max(after - before, 0);
}

/**
 * 确认详情页底部的"联想商品"区域已经准备好（DOM 存在 + 有候选卡片）。
 *   1. 把页面滚到底部触发 Temu 的 lazy render
 *   2. 轮询 `findRelatedArea()`
 *   3. 找到后给区域上高亮、滚到视口 0.18 锚点
 *   4. 等候选卡片渲染出来
 *
 * @param {string} currentId 当前详情页 goodsId
 * @returns {Promise<boolean>} true=联想区已就绪；false=需要人工滚动
 */
async function ensureRelatedAreaReady(currentId) {
    await patchState({phase: 'related'});
    notify({action: 'relatedAutoScrolling'});
    debugLog('related-area-start', {currentId});

    await scrollToPageBottomForRelatedRender();

    const relatedArea = await waitForRelatedArea();
    if (!relatedArea) {
        debugLog('related-area-missing', {currentId});
        return false;
    }

    debugLog('related-area-found', {
        currentId,
        rootId: relatedArea.id || '',
        childCount: relatedArea.childElementCount || 0,
        textLength: (relatedArea.innerText || '').length,
    });

    highlightRelatedArea(relatedArea);
    scrollElementToViewportAnchor(relatedArea, 0.18);
    await sleep(700);

    return waitForRelatedCandidates(currentId);
}

/**
 * 把页面一次性跳到底部，触发 Temu 的懒加载把联想商品区域渲染出来。
 * 用 `auto` 而非 `smooth` 避免被用户打断。结束后等 650ms 给浏览器绘制。
 *
 * @returns {Promise<void>}
 */
async function scrollToPageBottomForRelatedRender() {
    const bottomY = Math.max(0, document.documentElement.scrollHeight - (window.innerHeight || 0));
    window.scrollTo({top: bottomY, behavior: 'auto'});
    await sleep(650);
}

/**
 * 轮询等待联想商品区域出现在 DOM 中（`findRelatedArea` 命中）。
 *
 * @param {number} [attempts] 最多轮询次数
 * @param {number} [delayMs] 每次间隔
 * @returns {Promise<Element | null>} 命中就返回 DOM 节点；超时返回 null
 */
async function waitForRelatedArea(attempts = 8, delayMs = 300) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const area = findRelatedArea();
        if (area) {
            debugLog('related-area-poll-hit', {
                attempt: attempt + 1,
                childCount: area.childElementCount || 0,
            });
            return area;
        }
        await sleep(delayMs);
    }
    debugLog('related-area-poll-timeout', {attempts, delayMs});
    return null;
}

/**
 * 把一批商品追加到 `targetQueue`（工作队列），同时做去重和副作用更新。
 *
 * @param {Array<{goodsId: string, [key: string]: unknown}>} items 待入队商品
 * @param {{resetQueue?: boolean, markProcessed?: boolean, phase?: string, incrementCycles?: boolean, incrementRelated?: number}} [options]
 *   - `resetQueue`: true 则先清空再入队（initial filter 用）
 *   - `markProcessed`: 同时把这些 goodsId 写入 processedIds 避免下次重选
 *   - `phase`: 顺带切 UI phase
 *   - `incrementCycles`/`incrementRelated`: 给 stats 的对应计数器加数
 * @returns {Promise<void>}
 */
async function enqueueItems(items, options = {}) {
    if (!items.length) return;
    const state = await getState();
    const queue = options.resetQueue ? [] : [...state.targetQueue];
    const queueIds = new Set(queue.map((item) => item.goodsId));
    const processedIds = new Set(state.processedIds);

    for (const item of items) {
        if (!item.goodsId || queueIds.has(item.goodsId)) continue;
        queue.push(item);
        queueIds.add(item.goodsId);
        if (options.markProcessed) processedIds.add(item.goodsId);
    }

    await patchState({
        targetQueue: queue,
        processedIds: Array.from(processedIds),
        phase: options.phase || state.phase,
        stats: {
            cycles: (state.stats.cycles || 0) + (options.incrementCycles ? 1 : 0),
            relatedAdded: (state.stats.relatedAdded || 0) + (options.incrementRelated || 0),
        },
    });
}

/**
 * 采集结束收尾：
 *   1. `uploadPendingBatch(true)` 强制把本地积压的批上传掉
 *   2. 通知后端 run 结束
 *   3. 把 state.running 置 false、phase 改 done
 *   4. 广播 `done` 消息让 popup 切到已完成态（CSV 可导出）
 *
 * @param {ReturnType<typeof defaultState>} state
 * @returns {Promise<void>}
 */
async function finish(state) {
    await uploadPendingBatch(true);
    await finishBackendRun('completed', state.collected.length);
    await patchState({running: false, phase: 'done'});
    const latest = await getState();
    notify({
        action: 'done',
        total: latest.collected.length,
        queueLen: latest.targetQueue.length,
        stats: latest.stats,
    });
}

/**
 * 向后端上报"本次 run 已结束"（`POST /api/runs/:uuid/finish`）。
 * 没有 runUuid（未启动后端对接）时直接返回。
 *
 * @param {'completed'|'aborted'|'error'} status
 * @param {number | null} [totalCollected]
 * @returns {Promise<void>}
 */
async function finishBackendRun(status, totalCollected = null) {
    const state = await getState();
    if (!state.runUuid) return;

    const response = await callRuntime('backendFinishRun', {
        runUuid: state.runUuid,
        payload: {
            status,
            total_collected: totalCollected,
        },
    });

    if (!response?.ok) {
        debugLog('backend-finish-failed', {
            runUuid: state.runUuid,
            status,
            error: response?.error || 'unknown',
        });
        return;
    }

    debugLog('backend-finish-ok', {
        runUuid: state.runUuid,
        status,
    });
}

/**
 * 抓取列表页可见的商品卡。返回值里 `mode='listing'` 会被 upsert 打标来源。
 *
 * @returns {Array<object>}
 */
function scrapeListingItems() {
    return scrapeCardsFromPage({mode: 'listing'});
}

/**
 * 抓取详情页底部联想商品区域里的候选卡，自动剔除当前页自己。
 *
 * @param {string} currentId 当前详情页 goodsId
 * @returns {Array<object>}
 */
function scrapeRelatedItems(currentId) {
    const relatedRoot = getRelatedItemsRoot();
    if (!relatedRoot) return [];
    return scrapeCardsFromPage({mode: 'related', root: relatedRoot})
        .filter((item) => item.goodsId !== currentId);
}

/**
 * 通用的"从页面某个子树抓商品卡 → 提取字段 → 去重"流水线。
 *
 * @param {{mode: 'listing'|'related', root?: Document | Element}} params
 * @returns {Array<object>} 每条商品对象，带 `domIndex` 和 `sourceRootId` 方便排查定位
 */
function scrapeCardsFromPage({mode, root = document}) {
    const cards = findProductCards(root);
    const seenIds = new Set();
    const items = [];

    for (let index = 0; index < cards.length; index += 1) {
        const card = cards[index];
        const item = extractItemFromCard(card, mode);
        if (!item?.goodsId || seenIds.has(item.goodsId)) continue;
        seenIds.add(item.goodsId);
        items.push({
            ...item,
            domIndex: index,
            sourceRootId: root === document ? '' : (root.id || ''),
        });
    }

    return items;
}

/**
 * 在给定 DOM 子树里定位所有商品卡片节点。
 *
 * 思路：先找所有 `a[href*="-g-"]` 锚点（Temu 商品详情链接含 `-g-数字.html`），然后从
 * 锚点向上爬最多 8 层父元素，找到"既有图片又有 `$ / CA$ / 已售 / 星` 文案"的那一层
 * 当作卡片根节点（因为 DOM 结构每隔一阵会变，这个向上探测比硬编码 class 稳）。
 *
 * 同时排除 `#reviewContent` 内部的评价链接，避免把 reviewer 头像当成商品卡。
 *
 * @param {Document | Element} [root]
 * @returns {Element[]} 唯一的卡片根节点数组
 */
function findProductCards(root = document) {
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
 * 在列表/联想区把"下一个要处理"的卡片高亮出来，并挂一个 label 告诉用户该干嘛。
 *
 * 后续效果：注入样式 → 清掉旧高亮 → 等 DOM 里真有这张卡 → 应用 pending 样式 →
 * 启动 MutationObserver 保证高亮被重绘后能自动恢复 → 可选触发 autoClickV1。
 *
 * @param {{goodsId: string, source?: 'listing'|'related', [key: string]: unknown}} item
 * @param {string} [labelText] 覆盖在卡片上方的提示文字
 * @returns {Promise<void>}
 */
async function highlightPendingItem(item, labelText) {
    if (!item?.goodsId) return;
    debugLog('highlight-start', {
        goodsId: item.goodsId,
        source: item.source,
        domIndex: item.domIndex,
        labelText: labelText || '',
    });

    ensureHighlightStyle();
    clearExistingHighlights();

    const target = await waitForHighlightTarget(item);
    if (!target) {
        debugLog('highlight-target-missing', {
            goodsId: item.goodsId,
            source: item.source,
            relatedRootExists: Boolean(getRelatedItemsRoot()),
            relatedCardCount: item.source === 'related' ? scrapeRelatedItems('').length : 0,
        });
        return;
    }

    const finalLabel = labelText || '待处理目标';
    applyPendingHighlight(target, finalLabel);
    keepPendingHighlightAlive(item, finalLabel);
    scrollElementToViewportAnchor(target, item.source === 'related' ? 0.16 : 0.22);
    debugLog('highlight-applied', {
        goodsId: item.goodsId,
        source: item.source,
        tagName: target.tagName,
        className: target.className || '',
    });
    scheduleAutoClickIfNeeded(item, target);
    await rebindPendingHighlight(item, finalLabel, 5, 180);
}

/**
 * 取消已排期但未触发的 auto click（比如用户切了配置或切换了目标）。
 */
function clearPendingAutoClick() {
    if (pendingAutoClickTimer) {
        clearTimeout(pendingAutoClickTimer);
        pendingAutoClickTimer = null;
    }
    pendingAutoClickGoodsId = '';
}

/**
 * 如果配置里开启了 `autoClickV1`，就给当前 pending 目标排一次延时自动点击。
 *
 * 延时用 4.2~9.8s 的随机抖动，另有 18% 概率再额外 12~25s 的长抖动，模拟真人浏览节奏。
 * 定时器触发时会二次校验 state.running / goodsId 没变才真的点下去。
 *
 * @param {{goodsId: string, source?: string}} item
 * @param {Element} target 实际要点的 DOM 节点
 * @returns {Promise<void>}
 */
async function scheduleAutoClickIfNeeded(item, target) {
    const state = await getState();
    if (!state.running || !state.config?.autoClickV1) return;
    if (!item?.goodsId || !target) return;

    clearPendingAutoClick();
    pendingAutoClickGoodsId = item.goodsId;

    const baseDelay = randomInt(4200, 9800);
    const extraDelay = Math.random() < 0.18 ? randomInt(12000, 25000) : 0;
    const totalDelay = baseDelay + extraDelay;

    debugLog('auto-click-scheduled', {
        goodsId: item.goodsId,
        source: item.source,
        delayMs: totalDelay,
    });

    pendingAutoClickTimer = setTimeout(async () => {
        pendingAutoClickTimer = null;
        try {
            const latest = await getState();
            if (!latest.running || !latest.config?.autoClickV1) return;
            if (pendingAutoClickGoodsId !== item.goodsId) return;
            await performAutoClickV1(item);
        } catch (error) {
            debugLog('auto-click-error', {
                goodsId: item.goodsId,
                message: error?.message || String(error),
            });
        }
    }, totalDelay);
}

/**
 * autoClickV1 的真正执行体：找到目标 → 滚入视口（带随机扰动）→ 选一个带抖动的点位 →
 * 校验点位没被其他层挡住 → 派发人类化鼠标事件。失败分支都走 debugLog，没有 throw。
 *
 * @param {{goodsId: string, source?: string, [key: string]: unknown}} item
 * @returns {Promise<void>}
 */
async function performAutoClickV1(item) {
    const target = findTargetByItem(item);
    if (!target) {
        debugLog('auto-click-target-missing', {goodsId: item.goodsId, source: item.source});
        return;
    }

    scrollElementToViewportAnchor(target, 0.2 + Math.random() * 0.1);
    await sleep(randomInt(800, 1800));

    const nudge = randomInt(-36, 36);
    if (nudge) {
        window.scrollBy({top: nudge, behavior: 'auto'});
        await sleep(randomInt(180, 520));
    }

    const clickable = findClickableTarget(target);
    if (!clickable) {
        debugLog('auto-click-clickable-missing', {goodsId: item.goodsId, source: item.source});
        return;
    }

    const point = getSafeClickPoint(clickable);
    if (!point || !isPointClickable(clickable, point)) {
        debugLog('auto-click-point-blocked', {
            goodsId: item.goodsId,
            source: item.source,
        });
        return;
    }

    debugLog('auto-click-start', {
        goodsId: item.goodsId,
        source: item.source,
        tagName: clickable.tagName,
    });

    await dispatchHumanLikeClick(clickable, point);

    debugLog('auto-click-dispatched', {
        goodsId: item.goodsId,
        source: item.source,
        x: Math.round(point.clientX),
        y: Math.round(point.clientY),
    });
}

/**
 * 从卡片根节点里挑一个真正可点的子节点：优先商品锚点 / 按钮，退回父节点自身。
 *
 * @param {Element | null | undefined} target
 * @returns {Element | null}
 */
function findClickableTarget(target) {
    return target?.querySelector?.('a[href*="-g-"], button, [role="button"]') || target || null;
}

/**
 * 在元素内部选一个带随机偏移的点击点位。避开四周 12px 太小的元素，
 * 偏移范围 left=[28%,50%]、top=[30%,52%]，模拟用户指尖落点。
 *
 * @param {Element} element
 * @returns {{clientX: number, clientY: number} | null}
 */
function getSafeClickPoint(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) return null;

    const left = rect.left + rect.width * (0.28 + Math.random() * 0.22);
    const top = rect.top + rect.height * (0.3 + Math.random() * 0.22);
    return {
        clientX: left,
        clientY: top,
    };
}

/**
 * 点位可点校验：
 * 1. 必须在视口内
 * 2. `document.elementFromPoint` 返回的最顶层节点必须和 `element` 有包含关系
 *    （避免浮层/Toast 挡住真实目标仍被强点）
 *
 * @param {Element} element
 * @param {{clientX: number, clientY: number} | null} point
 * @returns {boolean}
 */
function isPointClickable(element, point) {
    if (!point) return false;

    const inViewport = (
        point.clientX >= 0 &&
        point.clientY >= 0 &&
        point.clientX <= window.innerWidth &&
        point.clientY <= window.innerHeight
    );
    if (!inViewport) return false;

    const topElement = document.elementFromPoint(point.clientX, point.clientY);
    if (!topElement) return false;

    return (
        element === topElement ||
        element.contains(topElement) ||
        topElement.contains(element)
    );
}

/**
 * 模拟真人点击：
 *   1. 从屏幕外某个随机起点出发，用三次贝塞尔曲线生成 24 步 mousemove 轨迹移动到目标
 *   2. 依次派发 mouseover/enter/move
 *   3. 带随机短停顿的 mousedown → mouseup → click
 *
 * 目的是让 Temu 风控判断"像真人"，减少被拦截/挑战。
 *
 * @param {Element} element
 * @param {{clientX: number, clientY: number}} point
 * @returns {Promise<void>}
 */
async function dispatchHumanLikeClick(element, point) {
    const duration = randomInt(800, 1500);
    const steps = Math.max(24, Math.floor(duration / 16));
    const startX = point.clientX + randomInt(-180, -60);
    const startY = point.clientY + randomInt(-90, 90);
    const cp1x = startX + (point.clientX - startX) * 0.28 + randomInt(-30, 30);
    const cp1y = startY + randomInt(-80, 80);
    const cp2x = startX + (point.clientX - startX) * 0.72 + randomInt(-30, 30);
    const cp2y = point.clientY + randomInt(-60, 60);

    for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        const currentX = cubicBezier(startX, cp1x, cp2x, point.clientX, progress);
        const currentY = cubicBezier(startY, cp1y, cp2y, point.clientY, progress);
        dispatchMouseEvent(element, 'mousemove', currentX, currentY);
        await sleep(Math.max(8, Math.floor(duration / steps)));
    }

    dispatchMouseEvent(element, 'mouseover', point.clientX, point.clientY);
    dispatchMouseEvent(element, 'mouseenter', point.clientX, point.clientY);
    dispatchMouseEvent(element, 'mousemove', point.clientX, point.clientY);
    await sleep(randomInt(400, 1200));

    dispatchMouseEvent(element, 'mousedown', point.clientX, point.clientY);
    await sleep(randomInt(60, 180));
    dispatchMouseEvent(element, 'mouseup', point.clientX, point.clientY);
    await sleep(randomInt(30, 110));
    dispatchMouseEvent(element, 'click', point.clientX, point.clientY);
}

/**
 * 三次贝塞尔曲线插值，给 dispatchHumanLikeClick 的鼠标轨迹用。
 *
 * @param {number} p0 起点
 * @param {number} p1 控制点 1
 * @param {number} p2 控制点 2
 * @param {number} p3 终点
 * @param {number} t 进度 [0,1]
 * @returns {number}
 */
function cubicBezier(p0, p1, p2, p3, t) {
    const inverse = 1 - t;
    return inverse ** 3 * p0
        + 3 * inverse ** 2 * t * p1
        + 3 * inverse * t ** 2 * p2
        + t ** 3 * p3;
}

/**
 * 简化版的人类化点击：选点位 + 派发完整事件序列。给"查看更多"等按钮用
 * （不需要 `performAutoClickV1` 里的延时排期 / state 校验）。
 *
 * @param {Element} element
 * @returns {Promise<boolean>} true=成功派发；false=元素太小选不到安全点位
 */
async function humanClick(element) {
    const point = getSafeClickPoint(element);
    if (!point) return false;
    await dispatchHumanLikeClick(element, point);
    return true;
}

/**
 * 把列表卡片按视觉行分组：依据 `getBoundingClientRect().top` 聚类，
 * 容差 30px 内视为同一行（应对子像素 / 边距偏移）。先按 top 升序排序，
 * 行内再按 left 升序，因此返回的行序就是从上到下、从左到右的视觉顺序。
 *
 * @param {Element[]} cards
 * @returns {Element[][]}
 */
function groupCardsIntoRows(cards) {
    if (!cards.length) return [];
    const ROW_TOLERANCE_PX = 30;

    const measured = cards.map((card) => {
        const rect = card.getBoundingClientRect();
        return {
            card,
            top: rect.top + window.scrollY,
            left: rect.left,
        };
    });
    measured.sort((a, b) => a.top - b.top || a.left - b.left);

    const rows = [];
    let currentRow = [];
    let currentTop = null;
    for (const {card, top} of measured) {
        if (currentTop === null || Math.abs(top - currentTop) <= ROW_TOLERANCE_PX) {
            currentRow.push(card);
            if (currentTop === null) currentTop = top;
        } else {
            rows.push(currentRow);
            currentRow = [card];
            currentTop = top;
        }
    }
    if (currentRow.length) rows.push(currentRow);
    return rows;
}

function getLastGoodsIdFromRow(row) {
    if (!Array.isArray(row) || !row.length) return '';
    for (let index = row.length - 1; index >= 0; index -= 1) {
        const goodsId = getGoodsIdFromCard(row[index]);
        if (goodsId) return goodsId;
    }
    return '';
}

/**
 * 视口扫描（行级）：把列表的商品卡按视觉行分组，对未水合的整行做一次
 * `scrollIntoView({ block: 'center' })` 让 5 张卡同时进入视口，停留一会
 * 让 Temu 自身的 lazy hydration 把价格 / 销量 / 星级渲染出来。
 *
 * 整行所有卡都已水合就跳过；总超时兜底；结束时还原原始视口位置。
 *
 * @param {{perRowDelayMs?: number, rowBatchSize?: number, batchSettleMs?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{totalCards: number, totalRows: number, visitedRows: number, hydratedCards: number, timedOut: boolean}>}
 */
async function sweepCardsIntoView(options = {}) {
    const perRowDelayMs = options.perRowDelayMs ?? 2000;
    const rowBatchSize = options.rowBatchSize ?? 4;
    const batchSettleMs = options.batchSettleMs ?? 350;
    const timeoutMs = options.timeoutMs ?? 100000;

    const startedAt = Date.now();
    // 注意：旧版 sweep 结束时会把视口滚回 originalScrollY，现在由调用方
    //（productStreamTick）直接把页面滚到底部去触发"查看更多"，不再在这里还原。
    const state = await getState();
    const cards = findProductCards(document);
    const totalCards = cards.length;

    if (!totalCards) {
        return {totalCards: 0, totalRows: 0, visitedRows: 0, hydratedCards: 0, timedOut: false};
    }

    const rows = groupCardsIntoRows(cards);
    const resumeFromGoodsId = state.lastSweptGoodsId || '';
    const foundRowIndex = resumeFromGoodsId
        ? rows.findIndex((row) => row.some((card) => getGoodsIdFromCard(card) === resumeFromGoodsId))
        : -1;
    const startRowIndex = foundRowIndex >= 0 ? foundRowIndex + 1 : 0;
    // 当前站点这里的"卡片已水合"标准，按你的要求只看是否出现了 `知了数据` 这 4 个字。
    // 只要卡片文本里包含这个完整短语，就认为它已经进入可采集状态；否则继续扫入视口。
    const isHydrated = (card) => String(card?.innerText || '').includes('知了数据');

    let visitedRows = 0;
    let hydratedCards = 0;
    let batchCount = 0;
    let timedOut = false;
    let lastVisitedGoodsId = resumeFromGoodsId;

    for (let rowIndex = startRowIndex; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (Date.now() - startedAt > timeoutMs) {
            timedOut = true;
            break;
        }
        // 整行都已水合 → 跳过整行，避免无谓滚动
        if (row.every(isHydrated)) {
            hydratedCards += row.length;
            continue;
        }
        try {
            row[0].scrollIntoView({behavior: 'auto', block: 'center'});
        } catch (_) {
            // scrollIntoView 在 detached 节点上会 throw，忽略即可
        }
        visitedRows += 1;
        batchCount += 1;
        lastVisitedGoodsId = getLastGoodsIdFromRow(row) || lastVisitedGoodsId;
        await sleep(perRowDelayMs);
        hydratedCards += row.filter(isHydrated).length;
        if (batchCount >= rowBatchSize) {
            await sleep(batchSettleMs);
            batchCount = 0;
        }
    }

    // sweep 完毕后不再还原视口：接下来 productStreamTick 会直接滚到底部
    // 去找"查看更多"按钮，恢复再滚动只是白做功。

    if (lastVisitedGoodsId && lastVisitedGoodsId !== state.lastSweptGoodsId) {
        await patchState({lastSweptGoodsId: lastVisitedGoodsId});
    }

    // 诊断：如果完全没扫（visitedRows=0）却报告全部已水合，抽一张卡的 innerText 片段上来
    // 方便判断是真"所有卡都已水合"还是"探针被骨架文字误判"。
    let hydratedSample = '';
    let skeletonSample = '';
    if (cards.length) {
        const firstHydrated = cards.find((card) => isHydrated(card));
        const firstSkeleton = cards.find((card) => !isHydrated(card));
        hydratedSample = firstHydrated ? String(firstHydrated.innerText || '').slice(0, 120) : '';
        skeletonSample = firstSkeleton ? String(firstSkeleton.innerText || '').slice(0, 120) : '';
    }

    debugLog('sweep-cards-into-view', {
        totalCards,
        totalRows: rows.length,
        startRowIndex,
        resumeFromGoodsId,
        visitedRows,
        hydratedCards,
        timedOut,
        lastVisitedGoodsId,
        elapsedMs: Date.now() - startedAt,
        hydratedSample,
        skeletonSample,
    });

    return {
        totalCards,
        totalRows: rows.length,
        visitedRows,
        hydratedCards,
        timedOut,
    };
}

/**
 * 模拟真人慢速滚动来触发页面懒加载：每步向下 800~1500px + 随机左右抖动 + 长停顿。
 * 当 `findLoadMoreBtn()` 返回 null（按钮被懒渲染遮蔽）时做兜底尝试。
 *
 * @param {number} [steps] 滚动步数
 * @returns {Promise<void>}
 */
async function simulateSlowLazyLoad(steps = 2) {
    for (let index = 0; index < steps; index += 1) {
        window.scrollBy({
            top: randomInt(800, 1500),
            behavior: 'smooth',
        });
        await sleep(randomInt(1500, 3000));

        const jitterX = randomInt(-16, 16);
        window.scrollBy({left: jitterX, top: 0, behavior: 'auto'});
        await sleep(randomInt(80, 180));
        window.scrollBy({left: -jitterX, top: 0, behavior: 'auto'});
        await sleep(randomInt(180, 360));
    }
}

/**
 * 找"整个列表"的容器节点，MutationObserver 观察它来探测列表增量。
 * 优先 `<main>` → `#main` → `document.body`。
 *
 * @returns {Element}
 */
function findListingContainer() {
    return document.querySelector('main') || document.querySelector('#main') || document.body;
}

/**
 * 当前可见列表卡片总数。等价于 `findProductCards(document).length`。
 *
 * @returns {number}
 */
function countListingCards() {
    return findProductCards(document).length;
}

/**
 * 监听列表容器的 MutationObserver，等新卡片数 > 旧计数，或超时兜底。
 * 用来判断"查看更多"按钮点下去之后页面是不是真的追加了商品 —— 没增长就是风控。
 *
 * @param {number} previousCount 点击前的卡片数
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true=检测到增长；false=超时且没增长
 */
function waitForListingGrowth(previousCount, timeoutMs = LOAD_MORE_WATCH_TIMEOUT) {
    return new Promise((resolve) => {
        const root = findListingContainer();
        if (!root) {
            resolve(false);
            return;
        }

        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            clearTimeout(timeoutId);
            resolve(result);
        };

        const observer = new MutationObserver(() => {
            if (countListingCards() > previousCount) {
                finish(true);
            }
        });
        observer.observe(root, {
            childList: true,
            subtree: true,
        });

        const timeoutId = setTimeout(() => {
            finish(countListingCards() > previousCount);
        }, timeoutMs);
    });
}

/**
 * 构造并派发 MouseEvent。带 `composed: true` 以穿透 shadow DOM 边界。
 * `buttons` 位：mousedown 置 1（左键按下中），其他事件为 0。
 *
 * @param {Element} element
 * @param {string} type 事件名（`mousedown`/`mouseup`/`click`/...）
 * @param {number} clientX
 * @param {number} clientY
 */
function dispatchMouseEvent(element, type, clientX, clientY) {
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
 * 给"查看更多商品"按钮加高亮样式 + 文字提示，并记录到 `debugPendingLoadMore`
 * 供调试面板"一键加载"按钮使用。保守模式下同时挂 `click` 监听，走
 * `handleManualLoadMoreClick` 的等待/兜底逻辑。
 *
 * @param {Element | null} button
 * @param {{autoClick?: boolean, waitSec?: number}} [options]
 */
function highlightLoadMoreButton(button, options = {}) {
    if (!button) return;

    ensureHighlightStyle();
    clearLoadMoreHighlights();
    debugPendingLoadMore = {
        element: button,
        waitSec: options.waitSec || 0,
        previousCount: countListingCards(),
    };

    button.classList.add('temu-scraper-load-more-target');
    button.setAttribute(
        'data-temu-load-more-label',
        options.autoClick ? '即将自动点击查看更多商品' : '请手动点击查看更多商品'
    );
    button.scrollIntoView({behavior: 'smooth', block: 'center'});
    renderDebugPanel();
    if (!options.autoClick) {
        button.addEventListener('click', handleManualLoadMoreClick, {once: true});
    }
}

/**
 * 用户手动点"查看更多"时的后续：等页面出新卡 → 排下一次 main() 恢复；
 * 3 秒内没增长 → 进 WIND_CONTROL 状态，通知 popup 弹风控提示。
 *
 * @returns {Promise<void>}
 */
async function handleManualLoadMoreClick() {
    const state = await getState();
    const previousCount = debugPendingLoadMore?.previousCount || countListingCards();
    clearLoadMoreHighlights();
    notify({
        action: 'manualLoadMoreClicked',
        total: state.collected.length,
        waitSec: state.config.intervalSec,
    });
    const hasGrowth = await waitForListingGrowth(previousCount);
    if (!hasGrowth) {
        await enterWindControl('手动点击“查看更多商品”后 3 秒内没有新增商品');
        return;
    }
    showToast('列表已继续加载', 'success');
    scheduleLoadMoreResume(state.config.intervalSec);
}

/**
 * 激进模式下自动点击"查看更多"。实际逻辑全走 `performLoadMoreClick`。
 *
 * @param {Element | null} button
 * @param {number} waitSec 点完后等几秒再继续下一轮 main()
 */
async function handleAutoLoadMoreClick(button, waitSec) {
    if (!button) return;
    await performLoadMoreClick(button, waitSec, 'autoLoadMoreClicked', '自动点击“查看更多商品”后 3 秒内没有新增商品');
}

/**
 * 安排"点击查看更多后等 N 秒 → 重启 main()"的延时恢复。
 * 重复调用会清掉旧定时器。
 *
 * @param {number} waitSec
 */
function scheduleLoadMoreResume(waitSec) {

    if (pendingLoadMoreResumeTimer) {
        clearTimeout(pendingLoadMoreResumeTimer);
    }

    pendingLoadMoreResumeTimer = setTimeout(() => {
        pendingLoadMoreResumeTimer = null;
        mainLock = false;
        main();
    }, waitSec * 1000);
}

/**
 * 调试面板"一键加载更多"按钮的后端逻辑：复用 `debugPendingLoadMore` 里存好的按钮和
 * waitSec，走 `performLoadMoreClick`。没有待点击按钮时提示用户。
 *
 * @returns {Promise<boolean>} true=成功触发
 */
async function triggerLoadMoreNow() {
    if (!debugPendingLoadMore?.element) {
        showToast('当前没有可加载的“查看更多商品”按钮', 'error');
        return false;
    }

    const waitSec = debugPendingLoadMore.waitSec || (await getState()).config.intervalSec;
    await performLoadMoreClick(
        debugPendingLoadMore.element,
        waitSec,
        'manualLoadMoreClicked',
        '一键加载“查看更多商品”后 3 秒内没有新增商品'
    );
    return true;
}

/**
 * 进入风控暂停状态：切 FSM → WIND_CONTROL；UI phase → filtering；标记
 * `manualInterventionRequired=true`；弹 error toast；通知 popup 显示红色告警。
 * 典型触发场景：手动/自动点"查看更多"后页面没增长。
 *
 * @param {string} reason 进入风控的原因（会同步到 workflow.reason 和 toast）
 * @returns {Promise<void>}
 */
async function enterWindControl(reason) {
    await transitionTo(FSM_STATES.WIND_CONTROL, {
        phase: 'filtering',
        reason,
        manualInterventionRequired: true,
    });
    await patchState({phase: 'filtering'});
    notify({action: 'windControlTriggered', reason});
    showToast(reason || '已进入风控暂停，请人工介入', 'error');
}

/**
 * "查看更多"点击的核心执行：
 *   1. 解析真正可点的内嵌元素（a/button/span）
 *   2. 清掉高亮、通知 popup 当前动作
 *   3. 抖动延时 + 滚入视口 + `humanClick`（失败退回普通 `.click()`）
 *   4. `waitForListingGrowth` 观察列表增量，没增长就 `enterWindControl`
 *   5. 成功就 `scheduleLoadMoreResume` 等配置秒后重启 main()
 *
 * @param {Element} button 高亮过的按钮
 * @param {number} waitSec 点完后等几秒
 * @param {'manualLoadMoreClicked' | 'autoLoadMoreClicked'} notifyAction popup 通知的 action
 * @param {string} windReason 风控失败的提示
 * @returns {Promise<boolean>} true=列表增长成功；false=进入风控
 */
async function performLoadMoreClick(button, waitSec, notifyAction, windReason) {
    if (!button) return false;

    const loadMoreTarget = resolveLoadMoreClickable(button);
    if (!loadMoreTarget) return false;

    const previousCount = debugPendingLoadMore?.previousCount || countListingCards();
    clearLoadMoreHighlights();

    const state = await getState();
    notify({
        action: notifyAction,
        total: state.collected.length,
        waitSec,
    });

    await sleep(700 + Math.floor(Math.random() * 700));
    loadMoreTarget.scrollIntoView({behavior: 'smooth', block: 'center'});
    await sleep(250 + Math.floor(Math.random() * 250));

    const clickable = resolveLoadMoreClickable(loadMoreTarget) || findClickableTarget(loadMoreTarget);

    const didHumanClick = clickable ? await humanClick(clickable) : false;
    if (!didHumanClick) {
        loadMoreTarget.click();
    }

    const hasGrowth = await waitForListingGrowth(previousCount);
    if (!hasGrowth) {
        await enterWindControl(windReason);
        return false;
    }

    showToast('列表已继续加载', 'success');
    scheduleLoadMoreResume(waitSec);
    return true;
}

/**
 * 从"查看更多"按钮文字节点向上找真正可点的 button/a/role=button 容器。
 * Temu 有时把文字装在 span 里，直接 click span 不会冒到 React 监听，所以要上溯。
 *
 * @param {Element | null | undefined} element
 * @returns {Element | null}
 */
function resolveLoadMoreClickable(element) {
    return element?.closest?.('button, a, [role="button"]') || element || null;
}

/**
 * 把联想商品区域"框"出来（橙色描边 + 提示文字），用户手动滚动时看得更清楚。
 * areaNode 为空时对 body 上标记做退化，避免找不到区域时无提示。
 *
 * @param {Element | null} areaNode
 */
function highlightRelatedArea(areaNode) {
    ensureHighlightStyle();
    clearRelatedAreaHighlights();

    const area = areaNode || findRelatedArea();
    const target = area || document.body;
    target.classList.add('temu-scraper-related-area-target');
    target.setAttribute('data-temu-related-label', '请手动下拉到联想商品区域');
    target.scrollIntoView({behavior: 'smooth', block: 'center'});
}

/**
 * 清除所有联想区域高亮（class + data 属性）。每次重新走详情页流程前会调一次。
 */
function clearRelatedAreaHighlights() {
    document.querySelectorAll('.temu-scraper-related-area-target').forEach((el) => {
        el.classList.remove('temu-scraper-related-area-target');
        el.removeAttribute('data-temu-related-label');
    });
}

/**
 * 快速判断联想区域有没有候选商品（不等待，当场快照）。
 *
 * @param {string} currentId
 * @returns {boolean}
 */
function hasVisibleRelatedCandidates(currentId) {
    return scrapeRelatedItems(currentId).length > 0;
}

/**
 * 等联想商品候选出现。先用 fixed 间隔轮询 6 次 × 450ms（通常够），
 * 超时后退化到 `waitForRelatedCandidatesByObserver`（MutationObserver + 12s 长兜底）。
 *
 * @param {string} currentId
 * @param {number} [attempts]
 * @param {number} [delayMs]
 * @returns {Promise<boolean>}
 */
async function waitForRelatedCandidates(currentId, attempts = 6, delayMs = 450) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const count = scrapeRelatedItems(currentId).length;
        if (count > 0) {
            debugLog('related-candidates-poll-hit', {
                currentId,
                attempt: attempt + 1,
                count,
            });
            return true;
        }
        await sleep(delayMs);
    }

    debugLog('related-candidates-poll-fallback', {currentId, attempts, delayMs});
    return waitForRelatedCandidatesByObserver(currentId);
}

/**
 * 联想候选的兜底等待：同时用 MutationObserver 和 350ms 轮询两路检测，
 * 任何一路命中就 resolve true。12s 超时仍没命中 → resolve false。
 *
 * @param {string} currentId
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function waitForRelatedCandidatesByObserver(currentId, timeoutMs = 12000) {
    return new Promise((resolve) => {
        const existingArea = getRelatedItemsRoot();
        if (!existingArea) {
            debugLog('related-candidates-observer-no-root', {currentId});
            resolve(false);
            return;
        }

        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            clearInterval(pollId);
            observer.disconnect();
            debugLog('related-candidates-observer-finish', {
                currentId,
                result,
                finalCount: scrapeRelatedItems(currentId).length,
            });
            resolve(result);
        };

        const checkReady = () => {
            const area = getRelatedItemsRoot();
            if (!area) return false;
            if (!document.body.contains(area)) return false;
            return hasVisibleRelatedCandidates(currentId);
        };

        if (checkReady()) {
            debugLog('related-candidates-observer-immediate-hit', {
                currentId,
                count: scrapeRelatedItems(currentId).length,
            });
            resolve(true);
            return;
        }

        const observer = new MutationObserver(() => {
            if (checkReady()) finish(true);
        });
        observer.observe(existingArea, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'href'],
        });

        const pollId = setInterval(() => {
            if (checkReady()) finish(true);
        }, 350);

        const timeoutId = setTimeout(() => {
            finish(checkReady());
        }, timeoutMs);
    });
}

/**
 * 轮询等待目标卡片在 DOM 中就绪（联想区刚渲染完可能有半秒空窗期）。
 * 找不到会 debugLog 一条 `highlight-target-timeout`。
 *
 * @param {{goodsId: string, source?: string, domIndex?: number}} item
 * @param {number} [attempts]
 * @param {number} [delayMs]
 * @returns {Promise<Element | null>}
 */
async function waitForHighlightTarget(item, attempts = 10, delayMs = 320) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const target = findTargetByItem(item);
        if (target) {
            debugLog('highlight-target-found', {
                goodsId: item.goodsId,
                source: item.source,
                attempt: attempt + 1,
                tagName: target.tagName,
            });
            return target;
        }
        await sleep(delayMs);
    }
    debugLog('highlight-target-timeout', {
        goodsId: item.goodsId,
        source: item.source,
        attempts,
        delayMs,
    });
    return null;
}

/**
 * 重新绑定 pending 高亮：Temu 页面偶尔会重绘卡片 DOM，导致高亮 class 脱落。
 * 这个短轮询（默认 3×120ms）会找回新节点并把样式补上。
 * 配合 `keepPendingHighlightAlive` 的 MutationObserver 作为第二道兜底。
 *
 * @param {{goodsId: string, source?: string, domIndex?: number}} item
 * @param {string} labelText
 * @param {number} [attempts]
 * @param {number} [delayMs]
 * @returns {Promise<Element | null>}
 */
async function rebindPendingHighlight(item, labelText, attempts = 3, delayMs = 120) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const target = findTargetByItem(item);
        if (target) {
            removePendingHighlightClasses();
            applyPendingHighlight(target, labelText);
            return target;
        }
        await sleep(delayMs);
    }
    return null;
}

/**
 * 把元素滚到视口指定的"顶部锚点位置"：先 scrollIntoView 到 top，再用 scrollBy 校正到
 * 视口高度 × `desiredTopRatio` 的位置。默认 0.22（顶部 1/5 处），给
 * 用户足够的上下文空间看到卡片又不至于被遮挡。
 *
 * @param {Element | null} element
 * @param {number} [desiredTopRatio]
 */
function scrollElementToViewportAnchor(element, desiredTopRatio = 0.22) {
    if (!element) return;

    element.scrollIntoView({behavior: 'auto', block: 'start'});

    const rect = element.getBoundingClientRect();
    const viewport = window.innerHeight || 800;
    const desiredTop = viewport * desiredTopRatio;
    const delta = rect.top - desiredTop;

    if (Math.abs(delta) >= 2) {
        window.scrollBy({top: delta, behavior: 'auto'});
    }
}

/**
 * 判断当前视口是否已经"贴近页面底部"（距离底部 ≤ 180px）。
 * 给滚动兜底逻辑用：如果已经快到底了就别再强行向下滚。
 *
 * @returns {boolean}
 */
function isNearPageBottom() {
    const scrollBottom = window.scrollY + window.innerHeight;
    return scrollBottom >= document.documentElement.scrollHeight - 180;
}

/**
 * 生成 [min, max] 闭区间的随机整数。所有"人类化延时抖动"都用这个。
 *
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 找联想商品区域的根节点。Temu 详情页把这个区域放在 `#goodsRecommend`，
 * 如果以后 id 改了，**只需要改这里**。
 *
 * @returns {Element | null}
 */
function findRelatedArea() {
    return document.getElementById('goodsRecommend');
}

/**
 * 在 findRelatedArea 基础上过滤掉 `#reviewContent` 嵌套，避免误把评价区当成联想区。
 *
 * @returns {Element | null}
 */
function getRelatedItemsRoot() {
    const area = findRelatedArea();
    if (!area || area.closest('#reviewContent')) return null;
    return area;
}

/**
 * "由 item 反查 DOM 目标"的统一入口。先按"卡片"找（最稳），再按"锚点"兜底。
 *
 * @param {{goodsId: string, source?: 'listing'|'related', domIndex?: number}} item
 * @returns {Element | null}
 */
function findTargetByItem(item) {
    const card = findCardByItem(item);
    if (card) return card;

    const anchor = findAnchorByItem(item);
    return findCardFromAnchor(anchor) || anchor || null;
}

/**
 * 按 item 在卡片列表里找对应的卡片根节点。优先用 `domIndex` 做快速定位，
 * 对不上再遍历 goodsId 匹配。`source='related'` 会把搜索范围限定到联想区。
 *
 * @param {{goodsId: string, source?: 'listing'|'related', domIndex?: number}} item
 * @returns {Element | null}
 */
function findCardByItem(item) {
    const root = item?.source === 'related' ? getRelatedItemsRoot() : document;
    const cards = findProductCards(root || document);
    if (!cards.length) return null;

    if (Number.isInteger(item?.domIndex)) {
        const indexedCard = cards[item.domIndex];
        if (indexedCard && getGoodsIdFromCard(indexedCard) === item.goodsId) {
            return indexedCard;
        }
    }

    return cards.find((card) => getGoodsIdFromCard(card) === item?.goodsId) || null;
}

/**
 * 按 item 找对应的 `<a>` 锚点。联想区先在区域内部查，没查到再退回全局。
 *
 * @param {{goodsId: string, source?: 'listing'|'related', domIndex?: number}} item
 * @returns {HTMLAnchorElement | null}
 */
function findAnchorByItem(item) {
    if (!item?.goodsId) return null;

    if (item.source === 'related') {
        const relatedRoot = getRelatedItemsRoot();
        if (relatedRoot) {
            const relatedAnchors = Array.from(relatedRoot.querySelectorAll('a[href*="-g-"]'))
                .filter((anchor) => getGoodsIdFromUrl(anchor.href) === item.goodsId);
            if (Number.isInteger(item.domIndex) && relatedAnchors[item.domIndex]) {
                return relatedAnchors[item.domIndex];
            }
            if (relatedAnchors.length > 0) return relatedAnchors[0];
        }
    }

    return findAnchorByGoodsId(item.goodsId);
}

/**
 * 全局按 goodsId 找锚点：优先联想区内部（详情页），找不到再退回整个文档。
 * 排除 `#reviewContent` 里的锚点（那是评价卡不是商品卡）。
 *
 * @param {string} goodsId
 * @returns {HTMLAnchorElement | null}
 */
function findAnchorByGoodsId(goodsId) {
    const relatedRoot = getRelatedItemsRoot();
    const relatedAnchor = relatedRoot
        ? Array.from(relatedRoot.querySelectorAll('a[href*="-g-"]'))
            .find((anchor) => getGoodsIdFromUrl(anchor.href) === goodsId)
        : null;
    if (relatedAnchor) return relatedAnchor;

    return Array.from(document.querySelectorAll('a[href*="-g-"]'))
        .find((anchor) => !anchor.closest('#reviewContent') && getGoodsIdFromUrl(anchor.href) === goodsId) || null;
}

/**
 * 从卡片根节点中提取 goodsId（通过内嵌的 `<a href*="-g-">` 锚点）。
 *
 * @param {Element | null | undefined} card
 * @returns {string}
 */
function getGoodsIdFromCard(card) {
    const anchor = card?.querySelector?.('a[href*="-g-"]');
    return getGoodsIdFromUrl(anchor?.href || '');
}

/**
 * 从锚点向上爬最多 8 层，找到带图片+金额/销量/星级的卡片根节点。
 * 逻辑和 `findProductCards` 一致，这里是单锚点版本。
 *
 * @param {HTMLAnchorElement | null | undefined} anchor
 * @returns {Element | null}
 */
function findCardFromAnchor(anchor) {
    let node = anchor;
    for (let i = 0; i < 8; i += 1) {
        node = node?.parentElement;
        if (!node) return anchor || null;
        if (node.querySelector('img') && /(\$|CA\$|已售|星)/.test(node.innerText || '')) {
            return node;
        }
    }
    return anchor || null;
}

/**
 * 懒注入所有高亮 + toast 相关的 CSS。幂等；只会插入一次 `#temu-scraper-highlight-style`。
 * 这里定义了：
 *   - `.temu-scraper-pending-target` 待处理卡片的脉冲橙色高亮
 *   - `.temu-scraper-related-area-target` 联想区域高亮
 *   - `.temu-scraper-load-more-target` 查看更多按钮高亮
 *   - `.temu-scraper-toast` 右上角 toast
 * 调样式时改这里即可。
 */
function ensureHighlightStyle() {
    if (document.getElementById('temu-scraper-highlight-style')) return;

    const style = document.createElement('style');
    style.id = 'temu-scraper-highlight-style';
    style.textContent = `
    .temu-scraper-pending-target {
      position: relative !important;
      isolation: isolate !important;
      outline: 4px solid #ff6a00 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 8px rgba(255, 106, 0, 0.28), 0 18px 38px rgba(255, 106, 0, 0.18) !important;
      border-radius: 12px !important;
      animation: temu-scraper-pulse 1.15s ease-in-out infinite;
      background: rgba(255, 106, 0, 0.10) !important;
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
      background: linear-gradient(180deg, rgba(255, 106, 0, 0.16), rgba(255, 106, 0, 0.06));
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
      background: #ff6a00;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
      box-shadow: 0 6px 18px rgba(255, 106, 0, 0.28);
      z-index: 3;
      pointer-events: none;
    }
    .temu-scraper-pending-target img {
      filter: saturate(1.12) brightness(1.03);
    }
    .temu-scraper-load-more-target {
      position: relative !important;
      outline: 3px dashed #0ea5e9 !important;
      box-shadow: 0 0 0 6px rgba(14, 165, 233, 0.18) !important;
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
      background: #0ea5e9;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
      box-shadow: 0 6px 18px rgba(14, 165, 233, 0.28);
      z-index: 2;
      pointer-events: none;
    }
    .temu-scraper-related-area-target {
      position: relative !important;
      outline: 3px dashed #8b5cf6 !important;
      box-shadow: 0 0 0 8px rgba(139, 92, 246, 0.14) !important;
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
      background: #8b5cf6;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      box-shadow: 0 6px 18px rgba(139, 92, 246, 0.26);
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
      background: rgba(15, 23, 42, 0.94);
      color: #fff;
      z-index: 2147483647;
      opacity: 0;
      transition: opacity 0.22s ease, transform 0.22s ease;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 14px 34px rgba(15, 23, 42, 0.24);
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
      0%, 100% { box-shadow: 0 0 0 8px rgba(255, 106, 0, 0.28), 0 18px 38px rgba(255, 106, 0, 0.18); }
      50% { box-shadow: 0 0 0 12px rgba(255, 106, 0, 0.16), 0 20px 44px rgba(255, 106, 0, 0.12); }
    }
    @keyframes temu-scraper-pulse-load-more {
      0%, 100% { box-shadow: 0 0 0 6px rgba(14, 165, 233, 0.18); }
      50% { box-shadow: 0 0 0 10px rgba(14, 165, 233, 0.1); }
    }
    @keyframes temu-scraper-pulse-related {
      0%, 100% { box-shadow: 0 0 0 8px rgba(139, 92, 246, 0.14); }
      50% { box-shadow: 0 0 0 14px rgba(139, 92, 246, 0.08); }
    }
  `;
    document.documentElement.appendChild(style);
}

/**
 * "换目标前"的总清理：取消 auto-click 排期、断开心跳 interval 和 MutationObserver、
 * 移除所有 pending 高亮 class。切 pending 目标之前一定要先调这个。
 */
function clearExistingHighlights() {
    clearPendingAutoClick();

    if (pendingHighlightRefreshTimer) {
        clearInterval(pendingHighlightRefreshTimer);
        pendingHighlightRefreshTimer = null;
    }

    if (pendingHighlightObserver) {
        pendingHighlightObserver.disconnect();
        pendingHighlightObserver = null;
    }

    removePendingHighlightClasses();
}

/**
 * 只移除 `.temu-scraper-pending-target` class 和 label 属性；不动 interval/observer。
 * rebind 流程里会用到，避免双重高亮并存。
 */
function removePendingHighlightClasses() {
    document.querySelectorAll('.temu-scraper-pending-target').forEach((el) => {
        el.classList.remove('temu-scraper-pending-target');
        el.removeAttribute('data-temu-pending-label');
    });
}

/**
 * 把 pending 高亮样式 + label 应用到目标元素。用 class + data 属性，样式全在
 * `ensureHighlightStyle` 注入的 CSS 里驱动（包括脉冲动画）。
 *
 * @param {Element} target
 * @param {string} labelText
 */
function applyPendingHighlight(target, labelText) {
    target.classList.add('temu-scraper-pending-target');
    target.setAttribute('data-temu-pending-label', labelText);
}

/**
 * 给 pending 高亮挂两道"自我修复"保险：
 *   1. 300ms 的 setInterval 定期调 `restorePendingHighlight`
 *   2. body 的 MutationObserver 在 class/style/子树变化时立刻修复
 * 两者都只在当前高亮脱落时才重绘，避免重复修改造成抖动。
 *
 * @param {{goodsId: string, source?: string}} item
 * @param {string} labelText
 */
function keepPendingHighlightAlive(item, labelText) {
    if (pendingHighlightRefreshTimer) {
        clearInterval(pendingHighlightRefreshTimer);
    }

    if (pendingHighlightObserver) {
        pendingHighlightObserver.disconnect();
    }

    pendingHighlightRefreshTimer = setInterval(() => {
        restorePendingHighlight(item, labelText);
    }, 300);

    pendingHighlightObserver = new MutationObserver(() => {
        restorePendingHighlight(item, labelText);
    });
    pendingHighlightObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
    });
}

/**
 * 发现高亮脱落 → 重新定位目标 → 切换 class 过去。幂等（没变化就啥也不做）。
 *
 * @param {{goodsId: string, source?: string}} item
 * @param {string} labelText
 */
function restorePendingHighlight(item, labelText) {
    const target = findTargetByItem(item);
    if (!target) return;

    const activeTarget = document.querySelector('.temu-scraper-pending-target');
    if (activeTarget === target && target.classList.contains('temu-scraper-pending-target')) return;

    removePendingHighlightClasses();
    applyPendingHighlight(target, labelText);
}

/**
 * 清掉"查看更多"按钮高亮 + 取消延时 resume + 清空调试面板里的 pending 按钮记录。
 * 每次真的点了按钮、或者换目标前都要调一次，避免按钮上脉冲样式残留。
 */
function clearLoadMoreHighlights() {
    if (pendingLoadMoreResumeTimer) {
        clearTimeout(pendingLoadMoreResumeTimer);
        pendingLoadMoreResumeTimer = null;
    }
    debugPendingLoadMore = null;

    document.querySelectorAll('.temu-scraper-load-more-target').forEach((el) => {
        el.classList.remove('temu-scraper-load-more-target');
        el.removeAttribute('data-temu-load-more-label');
    });
    renderDebugPanel();
}

/**
 * 从列表/联想的一张卡片节点里"拆"出一条商品记录。流程：
 *   1. 先拿商品锚点，解析 goodsId（没有就返回 null 丢掉这张卡）
 *   2. 收集所有叶子节点的 text 作为 `textPool`（去重）
 *   3. 分别用 `extractSales/Star/Price/Reviews/Name` 从文本池里挑字段
 *   4. 把 card.outerHTML / innerText 原样保留为 rawHtml / rawText，方便事后复核
 *
 * @param {Element} card
 * @param {'listing'|'related'} mode 标记 source，upsert 时会写入
 * @returns {object | null}
 */
function extractItemFromCard(card, mode) {
    const anchor = card.querySelector('a[href*="-g-"]');
    const link = anchor?.href || '';
    const goodsId = getGoodsIdFromUrl(link);
    if (!goodsId) return null;

    const objectNodes = Array.from(card.querySelectorAll('object'));
    if (objectNodes.length > 0) {
        const objectDiagnostics = objectNodes.slice(0, 3).map((node, index) => {
            let objectText = '';
            let bodyText = '';
            let readable = false;
            let error = '';

            try {
                const objectDoc = node.contentDocument || node.getSVGDocument?.() || null;
                readable = Boolean(objectDoc);
                bodyText = normalizeText(objectDoc?.body?.innerText || objectDoc?.documentElement?.textContent || '');
                objectText = normalizeText(node.innerText || node.textContent || '');
            } catch (err) {
                error = err?.message || String(err);
            }

            return {
                index,
                data: node.getAttribute('data') || '',
                type: node.getAttribute('type') || '',
                readable,
                objectTextLength: objectText.length,
                bodyTextLength: bodyText.length,
                objectTextSample: objectText.slice(0, 120),
                bodyTextSample: bodyText.slice(0, 120),
                hasListingTimeInBody: bodyText.includes('上架时间'),
                error,
            };
        });

        debugLog('card-object-diagnostics', {
            goodsId,
            source: mode,
            objectCount: objectNodes.length,
            cardInnerHasListingTime: String(card.innerText || '').includes('上架时间'),
            cardTextContentHasListingTime: String(card.textContent || '').includes('上架时间'),
            cardOuterHtmlHasListingTime: String(card.outerHTML || '').includes('上架时间'),
            objectDiagnostics,
        });
    }

    const leaves = Array.from(card.querySelectorAll('span, div, p'))
        .filter((el) => el.children.length === 0)
        .map((el) => normalizeText(el.innerText))
        .filter(Boolean);

    const textPool = Array.from(new Set(leaves));
    const salesText = textPool.find((text) => /已售\s*[\d.,万千百k]+\s*件?/i.test(text)) || '';
    const sales = extractSales(salesText);
    const starRating = extractStar(textPool);
    const reviewCount = extractReviews(textPool, starRating, sales);
    const price = extractPrice(textPool);
    const name = extractName(textPool, {anchorText: normalizeText(anchor?.innerText), salesText, price, starRating});
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
        scrapedAt: nowText(),
        source: mode,
    };
}

/**
 * 详情页版本的字段抓取。思路：h1 拿标题；整页所有叶子 text 聚合为 `unique` 池，
 * 再复用同一套 `extractSales/Star/Price/Reviews` 规则。写入 CSV 时和列表字段并排存档。
 *
 * @returns {{fullTitle: string, price: string, sales: string, stars: string, reviews: string}}
 */
function scrapeDetailFields(goodsId = '') {
    const title = normalizeText(document.querySelector('h1')?.innerText) ||
        normalizeText(document.title.replace(/\s*[-|].*Temu.*/i, ''));

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
        reviews: extractReviews(unique, extractStar(unique), extractSales(unique.find((text) => /已售/.test(text)) || '')),
        listingTime: extractInjectedListingTime(document.body, goodsId) ||
            extractListingTime(unique, normalizeText(document.body?.innerText || '')),
    };
}

/**
 * 详情页"商品主信息区块"定位。从 h1 标题节点向上最多回溯 8 层，寻找一个同时含 img 和价格
 * /已售/星级文案的容器；这跟列表页 `findProductCards` 判定卡片的思路一致。
 * 找不到合适祖先时退回 h1 的 parent 作兜底，保证后续 `scrapeDetailRawBlock` 总能拿到节点。
 *
 * @returns {HTMLElement | null}
 */
function findDetailProductRoot() {
    // 从 h1 向上找一个既含图片又含价格/已售/星级文案的容器 —— 对应详情页的"商品主信息区块"。
    // 与 findProductCards 里列表卡片的识别策略保持一致，找不到则退而求其次用 h1 自身。
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

/**
 * 从详情页商品主信息区抓取原始 HTML / 文本快照，存档用。跟列表页的 rawHtml/rawText 并排存储，
 * 便于后续回放或人工对照 Temu DOM 结构变化。
 *
 * @returns {{rawHtml: string, rawText: string}}
 */
function scrapeDetailRawBlock() {
    const root = findDetailProductRoot();
    if (!root) return {rawHtml: '', rawText: ''};
    return {
        rawHtml: root.outerHTML || '',
        rawText: normalizeText(root.innerText || ''),
    };
}

/**
 * 文本规范化：把所有空白（包括换行、制表符、多余空格）压成单个空格并 trim。
 * 贯穿整个抓取链路，所有字段写入 state/CSV 前都需要走一遍以获得稳定格式。
 *
 * @param {unknown} text
 * @returns {string}
 */
function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * 从单段文本里抠出销量数字。匹配"已售 X 件"形式，支持 1.2万 / 1,234 / 500+ / 10k 这些中英混写。
 * 只返回数字部分，不做单位换算 —— 换算在 `parseSalesNum` 里做。
 *
 * @param {string} text
 * @returns {string}
 */
function extractSales(text) {
    const matched = String(text || '').match(/已售\s*([\d.,万千百k]+)\s*件?/i);
    return matched?.[1] || '';
}

/**
 * 在一堆叶子文本里扫"4.7星(满分5星)"这样的评分串，命中第一个就返回。
 * 星级规定 1-5 分，小数可选。这是列表卡片中最稳的评分 anchor。
 *
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
 * 从文本数组中扫首个 CA$ / $ 价格串。命中后剥掉空格返回。
 * 只取第一个命中 —— 后续如果 Temu 把原价/到手价拆成多段文本，需要在此基础上扩展。
 *
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
 * 从知了数据注入层的 shadowRoot 中提取指定字段值。
 * 结构为 `.zl-inject[pro-id] -> shadowRoot -> dl > dt/dd`，因此优先走结构化键值读取，
 * 比全文正则匹配更稳。
 *
 * @param {ParentNode | Element | Document} scope
 * @param {string} goodsId
 * @param {string} [label]
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
 * 提取知了数据注入层里的上架时间。
 *
 * @param {ParentNode | Element | Document} scope
 * @param {string} goodsId
 * @returns {string}
 */
function extractInjectedListingTime(scope, goodsId) {
    return extractInjectedFieldValue(scope, goodsId, '上架时间');
}

/**
 * 提取商品卡里的上架时间原文。
 * 兼容：
 *   1. 同段文本：`上架时间：2026-04-19`
 *   2. 分段文本：`上架时间` + `2026-04-19`
 * 保留页面原始文案，不做日期格式化。
 *
 * @param {string[]} texts
 * @param {string} [fallbackText]
 * @returns {string}
 */
function extractListingTime(texts, fallbackText = '') {
    const normalizedTexts = (texts || []).map((text) => normalizeText(text)).filter(Boolean);
    const combined = normalizeText([fallbackText, ...normalizedTexts].join(' '));
    const inlineMatched = combined.match(/上架时间\s*[:：]?\s*([^\s|/]+(?:\s+[^\s|/]+){0,3})/);
    if (inlineMatched?.[1]) {
        return normalizeText(inlineMatched[1]);
    }

    for (let index = 0; index < normalizedTexts.length; index += 1) {
        const text = normalizedTexts[index];
        const matched = text.match(/上架时间\s*[:：]?\s*(.+)$/);
        if (matched?.[1]) return normalizeText(matched[1]);
        if (/^上架时间\s*[:：]?$/.test(text)) {
            const nextText = normalizedTexts[index + 1] || '';
            if (nextText) return normalizeText(nextText);
        }
    }

    return '';
}

/**
 * 评价数抓取。按下面三个路径依次尝试，越靠前越稳：
 *   1. "613条评价" / "5,000 条评价" 中文界面主通道；
 *   2. "(123)" / "（123）" 括号兜底（注意首字符必须是数字，否则会吃到"（满分5星）"）；
 *   3. 星级文案后紧邻的 aria-hidden 数字 badge，向后多看 4 个 leaf 避开 "613条评价" 兄弟节点。
 * 全部落空则返回 '0' —— 之前的"任取非 sales 纯数字"兜底会把 "CA$13.56" 的 13 当评价，已移除。
 * @param {string[]} texts
 * @param {string} starRating
 * @param {string} sales
 * @returns {string}
 */
function extractReviews(texts, starRating, sales) {
    // 1) Temu 中文界面主要来源："613条评价" / "5,000 条评价"
    //    直接以"条评价"关键字为锚点反向拿到前面的数字，是最稳的一条路径。
    for (const text of texts) {
        const matched = text.match(/([\d,]+)\s*条评价/);
        if (matched) return matched[1].replace(/,/g, '');
    }

    // 2) 部分语言版本用的 "(123)" / "（123）" 括号样式；
    //    注意这里要求括号里"首字符就是数字"，避免误吃 "（满分5星）"。
    for (const text of texts) {
        const matchedParen = text.match(/[（(]([\d,]+)[)）]/);
        if (matchedParen) return matchedParen[1].replace(/,/g, '');
    }

    // 3) 星级文案（"4.7星(满分5星)"）后面紧邻的 aria-hidden 纯数字徽章。
    //    向后多看几个 leaf，避免被 "613条评价" 这类非纯数字的兄弟节点挡住。
    if (starRating) {
        const starPrefix = new RegExp(`^${escapeRegExp(starRating)}\\s*星`);
        for (let index = 0; index < texts.length; index += 1) {
            if (!starPrefix.test(texts[index])) continue;
            for (let offset = 1; offset <= 4; offset += 1) {
                const next = texts[index + offset] || '';
                if (/^\d[\d,]*$/.test(next)) {
                    return next.replace(/,/g, '');
                }
            }
        }
    }

    // 4) 兜底：没抓到就按 0 处理。
    //    旧实现在这里做了"任取一个非 sales 的纯数字"兜底，会把 "CA$13.56" 拆出来的
    //    价格碎片 "13" 当成评价数，这是本次修复要根除的根因。
    void sales;
    return '0';
}

/**
 * 商品名抓取。优先信任调用方传进来的 `context.anchorText`（通常是卡片里 `<a>` 链接的 innerText，
 * 最接近真实商品名）；否则退到"排除价格/销量/星级/数字徽章之后，取最长的 leaf text"这一兜底。
 * 长度 < 6 的文本和 "新品/店铺/颜色/尺寸" 等辅助文案直接忽略。
 *
 * @param {string[]} texts
 * @param {{anchorText?: string, salesText?: string, price?: string, starRating?: string}} [context]
 * @returns {string}
 */
function extractName(texts, context = {}) {
    const anchorText = context.anchorText || '';
    if (anchorText && anchorText.length > 6 && !/^(CA\$|\$)/.test(anchorText)) return anchorText;

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
 * 从一堆卡片里挑出"值得点进去采集详情"的优先级候选。两级排序：
 *   1. 先按标题关键词/徽章关键词过滤（EXCLUDED_TITLE_KEYWORDS / "本地仓"），全被筛掉就回退用原集；
 *   2. 优先挑无评分的新品（销量降序），再挑有评分的（销量降序+评价数升序）。
 * 这样能尽量把"销量靠前但刚上架、数据价值更高"的商品推到前面。
 *
 * @template T
 * @param {T[]} items
 * @param {number} [limit]
 * @returns {T[]}
 */
function selectPriorityItems(items, limit = 1) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const filteredItems = items.filter(
        (item) => !hasExcludedTitleKeyword(item) && !hasExcludedBadgeKeyword(item)
    );
    const candidateItems = filteredItems.length > 0 ? filteredItems : items;

    const priorityOne = candidateItems
        .filter((item) => !normalizeStar(item.starRating))
        .sort(compareBySalesDesc);

    if (priorityOne.length > 0) {
        return priorityOne.slice(0, limit);
    }

    return [...candidateItems]
        .sort(compareBySalesDescThenReviewsAsc)
        .slice(0, limit);
}

/**
 * 判断商品标题里是否含有"排除词"（EXCLUDED_TITLE_KEYWORDS，如平替/二手等）。命中即在
 * `selectPriorityItems` 里被过滤掉，除非所有候选都被筛掉（此时回退不过滤）。
 * @param {{fullTitle?: string, name?: string}} item
 * @returns {boolean}
 */
function hasExcludedTitleKeyword(item) {
    const title = normalizeText(item?.fullTitle || item?.name || '');
    if (!title) return false;
    return EXCLUDED_TITLE_KEYWORDS.some((keyword) => title.includes(keyword));
}

/**
 * 排查卡片文案是否含"本地仓"徽章 —— 本地仓商品通常是已适配的库存，不是我们关注的主力选品，
 * 因此在 `selectPriorityItems` 里把它过滤掉。
 * @param {{name?: string, fullTitle?: string, rawText?: string}} item
 * @returns {boolean}
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
 * 把评分值规范成字符串并去除首尾空白。空值返回空串，是 `selectPriorityItems` 里判断
 * "该商品有没有评分"的工具函数。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeStar(value) {
    return String(value || '').trim();
}

/**
 * 评价数字符串 → 整数。支持 "1,234" 这类千分位格式；失败返回 0。
 * @param {unknown} value
 * @returns {number}
 */
function parseReviewNum(value) {
    const text = String(value || '').replace(/,/g, '').trim();
    if (!text) return 0;
    return parseInt(text, 10) || 0;
}

/**
 * 销量降序比较器。传给 Array.prototype.sort，销量大的排前面。
 * @param {{salesNum?: number, sales?: string, detailSales?: string}} a
 * @param {{salesNum?: number, sales?: string, detailSales?: string}} b
 */
function compareBySalesDesc(a, b) {
    return getSalesNum(b) - getSalesNum(a);
}

/**
 * 复合排序：销量降序 → 评价数升序。销量相同时，评价数少的排前（数据更"稀缺"，便于发现新品）。
 */
function compareBySalesDescThenReviewsAsc(a, b) {
    const salesDiff = getSalesNum(b) - getSalesNum(a);
    if (salesDiff !== 0) return salesDiff;

    const reviewDiff = parseReviewNum(a.reviewCount) - parseReviewNum(b.reviewCount);
    if (reviewDiff !== 0) return reviewDiff;

    return 0;
}

/**
 * 取 item 的销量数字。优先用已解析缓存的 `salesNum`，没有再从原始 `sales/detailSales` 字符串现场算。
 * @param {{salesNum?: number, sales?: string, detailSales?: string}} item
 * @returns {number}
 */
function getSalesNum(item) {
    return item.salesNum || parseSalesNum(item.sales || item.detailSales || '');
}

/**
 * 把字符串里的正则元字符转义，用于拼 RegExp 时避免注入。`extractReviews` 里用这个来
 * 安全拼 `^{星级}\s*星` 的 pattern。
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 销量字符串 → 数字，带单位换算：
 *   "1.2万" → 12000，"3千" → 3000，"2k" → 2000，"1,234" → 1234
 * 解析失败返回 0；写入 state 时和原始字符串并排保存，便于前端展示/排序分离。
 * @param {unknown} value
 * @returns {number}
 */
function parseSalesNum(value) {
    const text = String(value || '').replace(/,/g, '').trim();
    if (!text) return 0;
    if (/万/.test(text)) return parseFloat(text) * 10000;
    if (/千/.test(text)) return parseFloat(text) * 1000;
    if (/k/i.test(text)) return parseFloat(text) * 1000;
    return parseFloat(text) || 0;
}

/**
 * 把一批新抓到的商品合并进 `state.collected` 并落库（chrome.storage.local）：
 *   - 以 `goodsId` 作为主键，旧条目与新条目按字段合并（后者覆盖前者，但空值不会覆盖已有值）；
 *   - 新插入的条目会补上 `scrapedAt` 时间戳；
 *   - 同步补算 `salesNum`，便于后续排序；
 *   - 更新 `stats.listingTotal` 用于 UI 展示；
 *   - 顺带把这批 item 送进上传队列（`enqueueUploadItems`）。
 * 返回这次"新插入"的条数（已存在的不算）。
 * @param {Array<{goodsId?: string, sales?: string, detailSales?: string, scrapedAt?: string}>} items
 * @returns {Promise<number>}
 */
async function upsertItems(items) {
    if (!items.length) return 0;
    const state = await getState();
    const byId = new Map(state.collected.map((item) => [item.goodsId, item]));
    let inserted = 0;

    for (const item of items) {
        if (!item.goodsId) continue;
        const prev = byId.get(item.goodsId);
        const merged = {
            ...prev,
            ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== '' && value !== undefined)),
        };

        if (!prev) {
            inserted += 1;
            if (!merged.scrapedAt) merged.scrapedAt = nowText();
        }

        if (!merged.salesNum) merged.salesNum = parseSalesNum(merged.sales || merged.detailSales || '');
        byId.set(item.goodsId, merged);
    }

    const collected = Array.from(byId.values());
    await patchState({
        collected,
        stats: {
            listingTotal: collected.length,
        },
    });
    await enqueueUploadItems(items, getNormalizedPageType());
    return inserted;
}

/**
 * 把一批商品推进"待上传"队列，并尝试触发一次批量上传：
 *   - 只保留有 goodsId 的条目；
 *   - 字段名 camelCase → snake_case，对齐后端入库 schema；
 *   - 详情页字段 (`detailPrice`/`detailSales` 等) 优先，列表字段兜底；
 *   - 推完队列调用 `uploadPendingBatch(false)` 做"未强制"上传，只有达到 batch 阈值才真发网络请求。
 * @param {Array<Record<string, unknown>>} items
 * @param {string} pageType
 * @returns {Promise<void>}
 */
async function enqueueUploadItems(items, pageType) {
    const payloadItems = items
        .filter((item) => item?.goodsId)
        .map((item) => {
            return {
                goods_id: item.goodsId,
                name: item.name || '',
                full_title: item.fullTitle || item.name || '',
                price: item.detailPrice || item.price || '',
                sales: item.detailSales || item.sales || '',
                star_rating: item.detailStars || item.starRating || '',
                review_count: item.detailReviews || item.reviewCount || '',
                listing_time: item.listingTime || null,
                source: item.source || pageType,
                source_page: item.link || location.href,
                raw_text: item.rawText || null,
                raw_html: item.rawHtml || null,
            };
        });

    if (!payloadItems.length) return;

    const state = await getState();
    await patchState({
        pendingUploadItems: [...(state.pendingUploadItems || []), ...payloadItems],
    });

    await uploadPendingBatch(false);
}

/**
 * 把一批"关联边"推进待上传队列。边用于 Graph 模式记录商品之间的跳转关系
 * （如"看了又看"/"相关推荐"），推完队列同样触发一次批量上传。
 * @param {Array<Record<string, unknown>>} edges
 * @returns {Promise<void>}
 */
async function enqueueUploadEdges(edges) {
    if (!edges.length) return;
    const state = await getState();
    await patchState({
        pendingUploadEdges: [...(state.pendingUploadEdges || []), ...edges],
    });
    await uploadPendingBatch(false);
}

/**
 * 批量上传队列落盘 → 后端。关键点：
 *   - `uploadInFlight` 作为内存互斥，避免多次触发并发上传；
 *   - 非强制模式下只有 items 达到 `UPLOAD_BATCH_SIZE` 才会发，防止每张卡刷一次网络；
 *   - edges 的批量大小会随着 items 规模动态调整（batchItems * 2，最低 20）；
 *   - 调 background.js 的 `backendUploadBatch`，成功后再切片删掉队列里已上传部分。
 * 返回 true 表示"没有剩余或成功"；false 表示"未达阈值跳过/上传失败"。
 * @param {boolean} [force] 是否忽略 batch 阈值强制上传（run 结束时常用）
 * @returns {Promise<boolean>}
 */
async function uploadPendingBatch(force = false) {
    if (uploadInFlight) return false;

    const state = await getState();
    const pendingItems = state.pendingUploadItems || [];
    const pendingEdges = state.pendingUploadEdges || [];
    const totalPending = pendingItems.length + pendingEdges.length;

    if (!totalPending) return true;
    if (!force && pendingItems.length < UPLOAD_BATCH_SIZE) return false;

    uploadInFlight = true;
    const batchItems = pendingItems.slice(0, force ? pendingItems.length : UPLOAD_BATCH_SIZE);
    const edgeTakeCount = force ? pendingEdges.length : Math.min(pendingEdges.length, Math.max(batchItems.length * 2, 20));
    const batchEdges = pendingEdges.slice(0, edgeTakeCount);

    const response = await callRuntime('backendUploadBatch', {
        payload: {
            run_uuid: state.runUuid || null,
            page_type: getNormalizedPageType(),
            items: batchItems,
            edges: batchEdges,
        },
    });

    if (response?.ok) {
        const latest = await getState();
        await patchState({
            pendingUploadItems: (latest.pendingUploadItems || []).slice(batchItems.length),
            pendingUploadEdges: (latest.pendingUploadEdges || []).slice(batchEdges.length),
        });
    } else {
    }

    uploadInFlight = false;
    return Boolean(response?.ok);
}

/**
 * 在当前可见区域里找"查看更多"按钮。
 *
 * 选择策略（对抗"同一颗按钮的 DIV 外壳 + SPAN 文字"以及"页面中段出现的幻影/卡内子控件"两种情况）：
 *   1. 用多语言关键词 + `offsetParent !== null` 过滤出所有可见候选
 *   2. 祖孙折叠：如果候选 A 包含候选 B（同一颗按钮的外壳 + 文字），丢掉 B 保留 A
 *      —— 这样可以拿到 220×52 的 DIV 外壳而不是 79×18 的 SPAN 文字，命中面积大 8 倍
 *   3. 排序：docY 大（越靠页尾越优先）> area 大（同一高度取面积大的）
 *      —— 水合稳定后真·load-more 永远在页尾，这条规则让它压过页面中段任何幻影
 *   4. 交给 `resolveLoadMoreClickable` 再做一次"向上找可点击祖先"的确认
 * @returns {HTMLElement | null}
 */
function findLoadMoreBtn() {
    const keywords = ['查看更多商品', '查看更多', 'View more', 'Load more', 'See more'];
    const raw = Array.from(document.querySelectorAll('button, a, div[role="button"], span'))
        .filter((el) => {
            if (el.offsetParent === null) return false;
            const text = normalizeText(el.innerText);
            return Boolean(text) && keywords.some((keyword) => text.includes(keyword));
        });
    if (raw.length === 0) return resolveLoadMoreClickable(null);

    // 祖孙折叠：丢掉被其他候选包含的内层节点，保留最外层 wrapper
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
 * Chrome runtime 消息分发器。background.js / popup.js 通过 `chrome.tabs.sendMessage`
 * 把用户操作传到这里。每个分支处理一种 action：
 *   - start：校验页面类型 + 启动 run（写 state、拉 runUuid、调 main()）；
 *   - stop：强制把剩余队列上传，标记后端 run 结束，重置 state；
 *   - getState：UI 轮询当前 state（总数/队列长度/当前 phase 等）；
 *   - setConfig：popup 改配置时写回 state 并同步调试面板；
 *   - triggerLoadMoreNow：popup 手动点"立即点击查看更多"按钮的入口；
 *   - setWorkflowState：外部强制迁移 FSM（排障用）；
 *   - getData：popup 拉 collected 数据用于导出 CSV；
 *   - clearAll：清空 state，重置调试面板显隐状态。
 * 所有异步分支都 return true 保持 sendResponse 通道打开。
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'start') {
        (async () => {
            // 重构后：不再区分 listing / detail，只要是 Temu 页面就视为"商品流"入口。
            // 启动凭据只看 URL 是否落在 temu.com 域，之后由 productStreamTick 去发现流。
            const pageType = getPageType();
            const requestedConfig = message.config || {};
            const taskMode = requestedConfig.taskMode || TASK_MODES.DISCOVERY;
            if (pageType === 'other') {
                sendResponse({error: '当前页面不是 Temu 商品页，请切到 temu.com 页面后重试。'});
                return;
            }

            const runResponse = await callRuntime('backendStartRun');
            const state = defaultState();
            state.running = true;
            // phase 只是一个辅助展示字段：有当前商品锚点就叫 'detail'，否则叫 'listing'。
            // 实际流转由 workflow FSM + productStreamTick 决定，不再影响能否工作。
            const hasAnchor = hasCurrentProductAnchor();
            state.phase = hasAnchor ? 'detail' : 'listing';
            state.config = {
                ...state.config,
                ...requestedConfig,
            };
            state.config.autoClickLoadMore = state.config.collectionMode === COLLECTION_MODES.AGGRESSIVE;
            // 启动时始终把当前 URL 记为最近一次发现流来源，兼容老字段 listingUrl。
            state.lastDiscoveryUrl = location.href;
            state.listingUrl = location.href;
            state.runUuid = runResponse?.ok ? (runResponse.run_uuid || '') : '';
            state.workflow = {
                current: getInitialWorkflowState(taskMode, pageType),
                previous: '',
                updatedAt: nowIsoText(),
                reason: 'start-run',
                manualInterventionRequired: false,
            };

            chrome.storage.local.set({[STORE_KEY]: state}, () => {
                mainLock = false;
                notifyState(state, getNormalizedPageType());
                main();
                sendResponse({
                    ok: true,
                    runUuid: state.runUuid,
                    backendOk: Boolean(runResponse?.ok),
                    backendError: runResponse?.ok ? '' : (runResponse?.error || ''),
                });
            });
        })();
        return true;
    }

    if (message.action === 'stop') {
        clearPendingAutoClick();
        (async () => {
            await uploadPendingBatch(true);
            await finishBackendRun('stopped', (await getState()).collected.length);
            await patchState({running: false, phase: 'idle'});
            notifyState(await getState());
            sendResponse({ok: true});
        })();
        return true;
    }

    if (message.action === 'getState') {
        getState().then((state) => {
            sendResponse({
                phase: state.phase,
                running: state.running,
                total: state.collected.length,
                queueLen: state.targetQueue.length,
                config: state.config,
                stats: state.stats,
                workflow: state.workflow,
                workflowState: getCurrentState(state),
            });
        });
        return true;
    }

    if (message.action === 'setConfig') {
        (async () => {
            const current = await getState();
            const nextConfig = {
                ...current.config,
                ...(message.config || {}),
            };
            if (!Object.prototype.hasOwnProperty.call(message.config || {}, 'autoClickLoadMore')) {
                nextConfig.autoClickLoadMore = nextConfig.collectionMode === COLLECTION_MODES.AGGRESSIVE;
            }
            await patchState({config: nextConfig});
            await applyDebugPanelConfig(nextConfig);
            notifyState(await getState());
            sendResponse({ok: true, config: nextConfig});
        })();
        return true;
    }

    if (message.action === 'triggerLoadMoreNow') {
        (async () => {
            const ok = await triggerLoadMoreNow();
            sendResponse({ok});
        })();
        return true;
    }

    if (message.action === 'setWorkflowState') {
        (async () => {
            const ok = await transitionTo(message.nextState, {
                force: Boolean(message.force),
                reason: message.reason || 'external-set-workflow',
            });
            notifyState(await getState());
            sendResponse({
                ok,
                workflow: (await getState()).workflow,
            });
        })();
        return true;
    }

    if (message.action === 'getData') {
        getState().then((state) => sendResponse({data: state.collected}));
        return true;
    }

    if (message.action === 'clearAll') {
        clearPendingAutoClick();
        chrome.storage.local.remove([STORE_KEY], () => {
            setDebugPanelVisibility(defaultState().config.showDebugPanel);
            sendResponse({ok: true});
        });
        return true;
    }

    return false;
});

// 首次加载入口：页面还在 loading 就等 DOMContentLoaded，否则直接 setTimeout 给 Temu 的
// SPA 框架 800ms 初始化时间，然后调 main() 进入 FSM 分发（见 content.js 顶部的 main 函数）。
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(main, 800));
} else {
    setTimeout(main, 800);
}

// bfcache 恢复（前进/后退）入口：页面从内存还原时不会走 DOMContentLoaded，靠 pageshow 兜底。
// 释放 mainLock 是为了允许重入 —— 因为 `main` 里有幂等锁，不释放就会被旧的 lock 挡住。
window.addEventListener('pageshow', () => {
    mainLock = false;
    setTimeout(main, 800);
});
