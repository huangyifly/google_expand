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
 *   src/debug/       - 控制台调试日志
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
const ONE_CLICK_LISTING_TEXT = '一键上架';
const ONE_CLICK_LISTING_SELECTORS = [
    '.gdyqmod',
    'div > div > div.title-bar > div > div.item.yjsj',
];
const ONE_CLICK_LISTING_DELAY_MS = 5000;
const HUMAN_SCROLL_MAX_STEPS = 12;
const UPLOAD_BATCH_SIZE = 25;
// 多样性降权：滑动窗口大小（记录最近 N 条已处理商品名）
const RECENT_NAMES_WINDOW = 8;
// 多样性降权：候选名称与窗口的 2-gram 重叠数 >= 此值时视为"高重叠"，降级排序
const DIVERSITY_OVERLAP_THRESHOLD = 0.3; // 比例阈值：候选名称 ≥30% 的汉字 bigram 与近期窗口重叠则降权
const LOAD_MORE_WATCH_TIMEOUT = 10000;
const DOM_PRUNE_CARD_THRESHOLD = 50;
const DOM_PRUNE_KEEP_COUNT = 20;
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

// ─── 流程追踪器（Trace） ──────────────────────────────────────────────
// 在每个决策节点调用 traceNode()，记录"为什么这么做 / 依据什么参数 / 走向哪里"。
// 所有记录按 runId 存入 chrome.storage.local（key = temu_trace_{runId}）。
// 运行结束后可调用 downloadTrace(runId) 导出为 .jsonl 文件。

const TRACE_KEY_PREFIX = 'temu_trace_';
const TRACE_FLUSH_MS = 2000;
const TRACE_MAX_ENTRIES = 3000;

let _traceRunId = '';
let _traceSeq = 0;
let _traceBuf = [];
let _traceFlushTimer = null;

/** 初始化追踪器，每次 run 开始时调用 */
function initTrace(runId) {
    _traceRunId = runId || '';
    _traceSeq = 0;
    _traceBuf = [];
    if (_traceFlushTimer) { clearTimeout(_traceFlushTimer); _traceFlushTimer = null; }
}

/**
 * 记录一个决策节点
 * @param {string} layer   所在层：'main' | 'stream' | 'filter' | 'detail' | 'upload'
 * @param {string} node    节点标识（英文 snake_case，唯一）
 * @param {string} why     中文说明：依据什么条件 / 为什么走这条路
 * @param {object} params  当时的关键参数快照
 * @param {string} outcome 执行结果：调用了什么 / 走向哪个分支
 */
function traceNode(layer, node, why, params = {}, outcome = '') {
    if (!_traceRunId) return;
    _traceSeq += 1;
    _traceBuf.push({
        ts: new Date().toISOString(),
        runId: _traceRunId,
        seq: _traceSeq,
        layer,
        node,
        why,
        params,
        outcome,
    });
    if (!_traceFlushTimer) {
        _traceFlushTimer = setTimeout(() => {
            _traceFlushTimer = null;
            _flushTrace();
        }, TRACE_FLUSH_MS);
    }
}

async function _flushTrace() {
    if (!_traceRunId || _traceBuf.length === 0) return;
    const key = TRACE_KEY_PREFIX + _traceRunId;
    const toWrite = [..._traceBuf];
    _traceBuf = [];
    const existing = await new Promise((r) => chrome.storage.local.get([key], (res) => r(res[key] || [])));
    const combined = [...existing, ...toWrite].slice(-TRACE_MAX_ENTRIES);
    await new Promise((r) => chrome.storage.local.set({ [key]: combined }, r));
}

/**
 * run 结束时立即落盘，然后把所有 trace 记录上传到后端。
 * 上传成功后清除本地 storage，避免无限积累。
 * @param {string} runId
 */
async function flushAndUploadTrace(runId) {
    const id = runId || _traceRunId;
    if (!id) return;

    // 先把内存缓冲区落盘
    if (_traceFlushTimer) { clearTimeout(_traceFlushTimer); _traceFlushTimer = null; }
    await _flushTrace();

    // 从 storage 读出全部记录
    const key = TRACE_KEY_PREFIX + id;
    const entries = await new Promise((r) =>
        chrome.storage.local.get([key], (res) => r(res[key] || []))
    );

    if (entries.length === 0) {
        logAction('info', '[trace] 无记录，跳过上传');
        return;
    }

    // 上传到后端
    const resp = await callRuntime('backendUploadTrace', { runUuid: id, entries });
    if (resp?.ok) {
        logAction('info', `[trace] 已上传 ${resp.count} 条追踪记录到后端`);
        // 上传成功，清理本地 storage
        chrome.storage.local.remove([key]);
        chrome.storage.local.remove(['temu_last_trace_run_id']);
    } else {
        logAction('warn', `[trace] 上传失败（${resp?.error}），本地记录保留`);
    }
}

// ─────────────────────────────────────────────────────────────────────
/**
 * 兜底排除词列表（后端不可达时使用）。
 * 运行时真正使用的是 `excludedTitleKeywords`，它会在启动时被后端数据覆盖。
 * 后端接口：GET /api/config/exclusion-keywords → { keywords: string[] }
 */
const EXCLUDED_TITLE_KEYWORDS_FALLBACK = [
    '玩具',

    // ── 大家电 ────────────────────────────────────────────
    '洗衣机', '冰箱', '冰柜', '空调', '电视机', '投影仪',
    '微波炉', '烤箱', '热水器', '电热水器', '洗碗机', '干衣机',

    // ── 厨房小电 ──────────────────────────────────────────
    '电饭锅', '电压力锅', '电磁炉', '电陶炉', '料理机',
    '榨汁机', '破壁机', '豆浆机', '咖啡机', '胶囊咖啡机',
    '电热水壶', '养生壶', '烤面包机', '多士炉', '空气炸锅',
    '电炒锅', '电烤盘', '蒸汽锅', '三明治机', '华夫饼机',
    '绞肉机', '和面机',

    // ── 清洁家电 ──────────────────────────────────────────
    '吸尘器', '扫地机器人', '扫地机', '拖地机', '洗地机',
    '蒸汽拖把', '除螨仪',

    // ── 空气/温控 ──────────────────────────────────────────
    '空气净化器', '加湿器', '除湿机', '电风扇', '风扇',
    '暖风机', '取暖器', '电暖器', '油汀', '电热毯', '电热丝毯',

    // ── 照明 ──────────────────────────────────────────────
    '台灯', '落地灯', '床头灯', '夜灯', '感应灯', 'LED灯带',
    '射灯', '筒灯', '吸顶灯',

    // ── 手机/平板/电脑 ────────────────────────────────────
    '手机', '平板电脑', '笔记本电脑', '台式机', '一体机',
    '电脑主机', '显示器', '键盘', '鼠标',

    // ── 耳机/音响 ─────────────────────────────────────────
    '耳机', '蓝牙耳机', '有线耳机', '降噪耳机',
    '音箱', '蓝牙音箱', '音响', '回音壁',

    // ── 充电/配件 ─────────────────────────────────────────
    '充电器', '充电宝', '数据线', '无线充',
    '移动电源', '快充头', '充电头',

    // ── 智能穿戴 ──────────────────────────────────────────
    '智能手表', '智能手环', '运动手表',

    // ── 美容仪器 ──────────────────────────────────────────
    '电动牙刷', '冲牙器', '洁面仪', '美容仪', '脱毛仪',
    '卷发棒', '直发器', '直发夹', '吹风机', '电吹风', '梳子',

    // ── 摄影/安防 ─────────────────────────────────────────
    '摄像头', '行车记录仪', '运动相机', '运动摄像机',
    '监控', '门铃摄像头',

    // ── 游戏/娱乐 ─────────────────────────────────────────
    '游戏机', '游戏手柄', '手柄',

    // ── 办公设备 ──────────────────────────────────────────
    '打印机', '扫描仪', '碎纸机', '投影屏',

    // ── 食品接触材料（餐具/厨具/容器）───────────────────────
    // 碗碟盘
    '碗', '饭碗', '汤碗', '沙拉碗', '盘子', '碟子', '餐盘', '碟',
    // 筷勺叉刀
    '筷子', '勺子', '汤匙', '餐叉', '叉子', '餐勺', '餐刀', '刀叉', '餐具',
    // 杯壶
    '杯子', '水杯', '茶杯', '马克杯', '咖啡杯', '玻璃杯',
    '保温杯', '焖烧杯', '随行杯', '保温壶', '水壶',
    '茶壶', '茶具', '公道杯', '茶盘',
    // 吸管
    '吸管', '金属吸管', '硅胶吸管',
    // 饭盒/保鲜盒
    '饭盒', '便当盒', '餐盒', '保鲜盒', '食品盒',
    '密封罐', '储物罐', '密封袋', '保鲜袋', '食品袋', '真空袋',
    '保鲜膜',
    // 锅
    '炒锅', '汤锅', '平底锅', '不粘锅', '铸铁锅', '砂锅', '蒸锅',
    '奶锅', '煎锅', '烤盘', '烤架',
    // 刀板
    '菜刀', '水果刀', '砧板', '切菜板', '案板',
    // 备餐小工具
    '削皮器', '刨丝器', '擦丝器', '漏勺', '滤网', '沥水篮',
    '量杯', '量勺', '开瓶器', '开罐器',
    '调味瓶', '调料盒', '油壶', '醋壶',
    // 冰格/烘焙
    '冰格', '制冰盒', '烘焙模具', '蛋糕模', '烘焙纸', '锡纸',


    // ── 服装（上衣）────────────────────────────────────────
    'T恤', '衬衫', '衬衣', '卫衣', '毛衣', '针织衫', '毛衫',
    '吊带衫', '吊带背心', '背心', '马甲',
    '外套', '夹克', '风衣', '大衣', '棉衣', '棉服', '羽绒服',
    '皮衣', '皮草', '西装', '西服', '礼服', '正装',
    '内衣', '睡衣', '打底衫', '秋衣',

    // ── 裤子 ─────────────────────────────────────────────
    '牛仔裤', '休闲裤', '运动裤', '西裤', '短裤', '长裤',
    '九分裤', '七分裤', '阔腿裤', '小脚裤', '打底裤',
    '瑜伽裤', '睡裤', '内裤', '秋裤', '裤子',

    // ── 裙子 ─────────────────────────────────────────────
    '连衣裙', '半身裙', '短裙', '长裙', '百褶裙',
    '蓬蓬裙', 'A字裙', '包臀裙', '裙子',

    // ── 鞋履 ─────────────────────────────────────────────
    '运动鞋', '板鞋', '凉鞋', '高跟鞋', '平底鞋', '拖鞋',
    '马丁靴', '雪地靴', '帆布鞋', '皮鞋', '短靴', '长靴',
    '老爹鞋', '洞洞鞋',

    // ── 配件（帽/袜/手套/围巾）──────────────────────────────
    '遮阳帽', '棒球帽', '针织帽', '渔夫帽', '毛线帽',
    '围巾', '口罩', '手套', '袜子', '丝袜', '连裤袜',

    // ── 内衣/泳衣/运动服 ──────────────────────────────────
    '胸罩', '文胸', '塑身衣',
    '泳衣', '泳裤', '泳装',
    '瑜伽服', '健身服', '运动服',

    // ── 特定品类 ──────────────────────────────────────────
    '汉服', '旗袍', '唐装',
    '孕妇装', '哺乳服',
    '童装', '婴儿服', '儿童服',
    '男装', '女装',
];

/**
 * 运行时排除词列表，初始值为本地兜底，启动时由 `loadExclusionKeywords()` 从后端覆盖。
 * 使用 let 而非 const，方便热更新（后续可支持运行中刷新）。
 */
let excludedTitleKeywords = EXCLUDED_TITLE_KEYWORDS_FALLBACK;

/**
 * 从后端拉取最新排除词列表，成功则覆盖 `excludedTitleKeywords`，失败则保留本地兜底。
 * 在 content script 启动时调用一次；后续如需热刷新可再次调用。
 */
async function loadExclusionKeywords() {
    const resp = await callRuntime('fetchExclusionKeywords');
    if (resp?.ok && Array.isArray(resp.keywords) && resp.keywords.length > 0) {
        excludedTitleKeywords = resp.keywords;
        logAction('info', `[exclusionKeywords] 从后端加载 ${resp.keywords.length} 条排除词`, {
            count: resp.keywords.length,
        });
    } else {
        logAction('warn', `[exclusionKeywords] 后端加载失败，使用本地兜底 ${EXCLUDED_TITLE_KEYWORDS_FALLBACK.length} 条`, {
            error: resp?.error,
        });
    }
}

/**
 * 生成一份"空白状态"快照，用于初次启动或 clearAll 时重置 chrome.storage.local。
 * 所有状态字段都集中在这里定义，方便排查字段是否齐全或默认值漂移。
 *
 * @returns {{
 *   running: boolean,
 *   phase: string,
 *   config: {intervalSec: number, batchSize: number, totalLimit: number, autoClickV1: boolean, autoClickLoadMore: boolean, removeLocalWarehouse: boolean, collectionMode: string, taskMode: string},
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
 *   totalCollected: number,
 *   seenGoodsIds: Array<string>,
 *   stats: {listingTotal: number, detailDone: number, cycles: number, relatedAdded: number}
 * }}
 */
function defaultState() {
    return {
        running: false,
        phase: 'idle',
        config: {
            intervalSec: 10,
            batchSize: 100,
            totalLimit: 10000,
            autoClickV1: false,
            autoClickLoadMore: false,
            removeLocalWarehouse: true,
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
        targetQueueIndex: 0,   // 辅助模式下当前高亮的是 targetQueue 第几条（0-based）
        lastSweptGoodsId: '',
        batchStartCount: 0,
        // 最近一次重置 batchStartCount 时所在的 URL。main() 在每次运行时比较
        // `location.href` 与此字段：不同则视为"刚落地新页面"（listing / detail 都适用），
        // 把 batchStartCount 重置到当前 collected.length，让每个 URL 拥有自己的 batch 计数。
        batchAnchorUrl: '',
        // 上传成功后 collected 会被清空；totalCollected 累计"历史上传总数"，
        // seenGoodsIds 保留所有已见 goodsId 用于去重。
        totalCollected: 0,
        seenGoodsIds: [],
        // 最近处理过的商品名称，用于多样性降权（滑动窗口，最多保留 RECENT_NAMES_WINDOW 条）
        recentProcessedNames: [],
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
 * 返回"总采集量"：历史已上传清空的计数 + 当前 collected 里还未上传的条目。
 * 替代所有直接使用 state.collected.length 作计数的地方。
 * @param {ReturnType<typeof defaultState>} state
 * @returns {number}
 */
function getTotalCollected(state) {
    return (state.totalCollected || 0) + (state.collected?.length || 0);
}

/**
 * 从 chrome.storage.local 读取完整 state 快照，并更新内存缓存 `lastKnownState`。
 * 这是所有读取路径的唯一入口；不要直接操作 chrome.storage.local.get。
 *
 * @returns {Promise<ReturnType<typeof defaultState>>}
 */
async function getState() {
    return new Promise((resolve) => {
        chrome.storage.local.get([STORE_KEY], (result) => {
            lastKnownState = compactStateForStorage(result[STORE_KEY] || defaultState());
            resolve(lastKnownState);
        });
    });
}

/**
 * 写入 chrome.storage.local 前压缩流程状态。后端已经接收完整商品数据，
 * 插件本地只保留下一跳筛选和页面点击所需字段。
 *
 * @param {ReturnType<typeof defaultState>} state
 * @returns {ReturnType<typeof defaultState>}
 */
function compactStateForStorage(state) {
    if (!Array.isArray(state?.collected)) return state;
    const config = {...(state.config || {})};
    delete config[['show', 'Debug', 'Panel'].join('')];
    config.taskMode = TASK_MODES.DISCOVERY;
    return {
        ...state,
        config,
        collected: state.collected
            .filter((item) => item?.goodsId)
            .map((item) => compactCollectedItemForWorkflow(item)),
    };
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
    const storageState = compactStateForStorage(next);
    lastKnownState = storageState;
    return new Promise((resolve) => {
        chrome.storage.local.set({[STORE_KEY]: storageState}, () => {
            const err = chrome.runtime.lastError;
            if (err) {
                // 之前这里静默吞掉了 QuotaExceededError 等错误，导致 rawHtml 大字段被丢弃无人察觉。
                // 现在让它在控制台大声报错，并把 collected 的体积信息一起打印出来方便定位。
                try {
                    const collectedCount = Array.isArray(storageState.collected) ? storageState.collected.length : 0;
                    const payloadBytes = new Blob([JSON.stringify(storageState)]).size;
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
 * 本地化日期字符串（中文，给状态日志展示用）。
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
 * 将基准秒数加上随机浮动后转为毫秒，防止 Temu 通过固定间隔识别爬虫特征。
 * 浮动范围：baseSec ± (baseSec × jitterRatio)，默认 ±30%。
 * 例：baseSec=10 → 随机返回 [7000, 13000] ms。
 *
 * @param {number} baseSec 基准秒数
 * @param {number} [jitterRatio=0.3] 浮动比例（0~1）
 * @returns {number} 含随机浮动的毫秒数
 */
function jitteredMs(baseSec, jitterRatio = 0.3) {
    const base = baseSec * 1000;
    const delta = base * jitterRatio;
    return Math.round(base + (Math.random() * 2 - 1) * delta);
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

const DEBUG_LOG_LIMIT = 14;
let debugEntries = [];
let debugPendingLoadMore = null;
const TIMELINE_LOG_LIMIT = 50;
let timelineEntries = [];
let timelineMinimized = false;

/**
 * 统一的调试日志入口：
 * 追加到 `debugEntries`（环形，只留最近 14 条），并同步 `console.log` 一条结构化日志。
 *
 * @param {string} event 事件名，如 `sweep-cards-into-view`
 * @param {Record<string, unknown>} [extra] 附加字段
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

    try {
        console.log('[Temu Scraper Debug]', event, {
            pageType: getNormalizedPageType(),
            url: location.href,
            ...extra,
        });
    } catch (_) {
    }
}

/**
 * Record one action entry and re-render the timeline panel.
 * @param {'info'|'warn'|'error'} level
 * @param {string} label one Chinese sentence summarising what happened
 * @param {object} [detail] raw data shown on expand
 */
function logAction(level, label, detail = {}) {
    const entry = {
        id: Date.now() + Math.random(),
        time: new Date().toLocaleTimeString('zh-CN', {hour12: false}),
        level,
        label,
        detail,
        expanded: false,
    };
    timelineEntries.unshift(entry);
    if (timelineEntries.length > TIMELINE_LOG_LIMIT) {
        timelineEntries.pop();
    }
    renderTimelinePanel();
}

function ensureTimelinePanel() {
    if (!document.body) return null;

    let host = document.getElementById('temu-timeline-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'temu-timeline-host';
        document.body.appendChild(host);
    }

    if (!host.shadowRoot) {
        const shadow = host.attachShadow({mode: 'open'});
        shadow.innerHTML = `
            <style>
                :host {
                    position: fixed;
                    right: 16px;
                    bottom: 16px;
                    z-index: 2147483647;
                    font-family: monospace;
                    font-size: 12px;
                    color: #e0e0e0;
                }
                #tl-wrap {
                    width: 320px;
                    max-height: 420px;
                    overflow: hidden;
                    background: #1a1a1a;
                    border: 1px solid rgba(255, 255, 255, 0.16);
                    border-radius: 8px;
                    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.36);
                }
                #tl-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    height: 32px;
                    padding: 0 8px 0 10px;
                    box-sizing: border-box;
                    background: #242424;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                    user-select: none;
                }
                #tl-title {
                    font-weight: 700;
                }
                #tl-min {
                    width: 24px;
                    height: 24px;
                    padding: 0;
                    border: 0;
                    border-radius: 4px;
                    background: transparent;
                    color: #e0e0e0;
                    cursor: pointer;
                    font: inherit;
                    line-height: 24px;
                }
                #tl-min:hover {
                    background: rgba(255, 255, 255, 0.12);
                }
                #tl-list {
                    max-height: 388px;
                    overflow-y: auto;
                    padding: 6px;
                    box-sizing: border-box;
                }
                #tl-list.is-minimized {
                    display: none;
                }
                .tl-entry {
                    margin-bottom: 6px;
                    padding: 6px 8px;
                    border-left: 3px solid #4a9eff;
                    border-radius: 4px;
                    background: rgba(255, 255, 255, 0.06);
                    cursor: pointer;
                    word-break: break-word;
                }
                .tl-entry:last-child {
                    margin-bottom: 0;
                }
                .tl-entry.warn {
                    border-left-color: #f5a623;
                }
                .tl-entry.error {
                    border-left-color: #e74c3c;
                }
                .tl-label {
                    color: #e0e0e0;
                    line-height: 1.45;
                }
                .tl-entry.warn .tl-label {
                    color: #f5a623;
                }
                .tl-entry.error .tl-label {
                    color: #e74c3c;
                }
                pre {
                    margin: 6px 0 0;
                    padding: 6px;
                    max-height: 180px;
                    overflow: auto;
                    border-radius: 4px;
                    background: rgba(0, 0, 0, 0.35);
                    color: #d8d8d8;
                    font: 11px/1.45 monospace;
                    white-space: pre-wrap;
                }
            </style>
            <div id="tl-wrap">
                <div id="tl-header">
                    <span id="tl-title">📋 操作时间线</span>
                    <button id="tl-min" type="button" title="最小化">—</button>
                </div>
                <div id="tl-list"></div>
            </div>
        `;
        shadow.getElementById('tl-min')?.addEventListener('click', (event) => {
            event.stopPropagation();
            timelineMinimized = !timelineMinimized;
            renderTimelinePanel();
        });
    }

    return host.shadowRoot;
}

function escapeTimelineHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stringifyTimelineDetail(detail) {
    try {
        return JSON.stringify(detail || {}, null, 2);
    } catch (error) {
        return JSON.stringify({error: error?.message || String(error)}, null, 2);
    }
}

function renderTimelinePanel() {
    const shadow = ensureTimelinePanel();
    if (!shadow) return;

    // 同步整体面板显隐（由 popup 开关控制）
    const host = document.getElementById('temu-timeline-host');
    if (host) host.style.display = timelineVisible ? '' : 'none';

    const list = shadow.getElementById('tl-list');
    if (!list) return;

    list.classList.toggle('is-minimized', timelineMinimized);
    list.innerHTML = timelineEntries.map((entry) => `
        <div class="tl-entry ${escapeTimelineHtml(entry.level)}" data-id="${entry.id}">
            <div class="tl-label">[${escapeTimelineHtml(entry.time)}] ${escapeTimelineHtml(entry.label)}</div>
            ${entry.expanded ? `<pre>${escapeTimelineHtml(stringifyTimelineDetail(entry.detail))}</pre>` : ''}
        </div>
    `).join('');

    for (const node of Array.from(list.querySelectorAll('.tl-entry'))) {
        node.addEventListener('click', () => {
            const id = Number(node.getAttribute('data-id'));
            const entry = timelineEntries.find((item) => item.id === id);
            if (!entry) return;
            entry.expanded = !entry.expanded;
            renderTimelinePanel();
        });
    }
}

let mainLock = false;
let pendingLoadMoreResumeTimer = null;

/**
 * 记录每条 stream 上一次 fiber 扫描后的节点数（含被过滤的本地仓商品）。
 * key = stream.id，value = number。
 * 用 Map 持久化跨 tick，因为 enumerateProductStreams() 每次都重建 stream 对象。
 * 页面导航后 content script 会重新注入，此 Map 自动清空，无需手动重置。
 */
const _streamFiberCountMap = new Map();

// content script 注入后立即拉取一次排除词；失败时保留本地兜底，不阻塞主流程
loadExclusionKeywords();

// 读取日志面板显示偏好，恢复上次用户的选择（默认显示）
const LOG_VISIBLE_KEY = 'temu_log_visible';
let timelineVisible = true;
chrome.storage.local.get([LOG_VISIBLE_KEY], (result) => {
    timelineVisible = result[LOG_VISIBLE_KEY] !== false;
    const host = document.getElementById('temu-timeline-host');
    if (host) host.style.display = timelineVisible ? '' : 'none';
});
let pendingHighlightRefreshTimer = null;
let pendingHighlightObserver = null;
let pendingAutoClickTimer = null;
let pendingAutoClickGoodsId = '';
let lastAutoClickPoint = null;
let uploadInFlight = false;
const AUTO_CLICK_MARKER_PREVIEW_MS = 3000;

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

        // ── [节点] main:not_running ────────────────────────────────────
        // 判断：state.running = false，说明用户尚未点"开始"或已停止
        // 决策：直接跳过本轮，不做任何采集操作
        if (!state.running) {
            logAction('warn', 'main() 跳过：采集未启动');
            traceNode('main', 'not_running', '采集未启动（state.running=false），跳过本轮', {
                running: state.running,
                url: location.href,
            }, '→ return，等待下次 tick 或用户点开始');
            return;
        }

        notifyState(state);

        // ── [节点] main:non_temu_page ──────────────────────────────────
        // 判断：当前 URL 不匹配 temu.com 域名
        // 决策：退出本轮，不采集非 Temu 页面
        if (getPageType() === 'other') {
            logAction('warn', `非 Temu 页面`);
            traceNode('main', 'non_temu_page', '当前页面不是 temu.com，无法采集', {
                url: location.href,
                pageType: getPageType(),
            }, '→ return，等待用户切回 Temu 页面');
            return;
        }

        // ── [节点] main:url_reset ──────────────────────────────────────
        // 判断：location.pathname 与上次记录的 batchAnchorUrl 不同 → 说明跳转到了新页面
        // 决策：重置 batchStartCount，让 batchLoaded 从 0 开始重新计算本页采集量
        //       （每个页面独立计数，防止 query string 变化引起的误判）
        const currentPageKey = location.origin + location.pathname;
        const anchorPageKey = (() => {
            try {
                const u = new URL(state.batchAnchorUrl || '');
                return u.origin + u.pathname;
            } catch (_) {
                return '';
            }
        })();
        if (currentPageKey !== anchorPageKey) {
            logAction('info', `新页面进入，重置 batch 计数（原累计=${getTotalCollected(state)}，其中 collected=${state.collected.length} + 历史=${state.totalCollected || 0}）`, {
                newUrl: location.href,
                batchStartCount: getTotalCollected(state),
                collectedNow: state.collected.length,
                totalCollectedHistory: state.totalCollected || 0,
                seenGoodsIdsSize: (state.seenGoodsIds || []).length,
            });
            traceNode('main', 'url_reset', '跳转到了新页面，本页 batch 计数从 0 开始', {
                prevAnchorUrl: state.batchAnchorUrl || '(空)',
                totalCollectedBeforeReset: getTotalCollected(state),
                collectedInPrev: state.collected.length,
            }, `→ batchStartCount 重置为 ${getTotalCollected(state)}`);
            // 新页面进入时清空 fiber 节点数缓存，避免跨页残留导致 waitForFiberNodeCount 误判
            _streamFiberCountMap.clear();
            await patchState({
                batchStartCount: getTotalCollected(state),
                batchAnchorUrl: location.href,
            });
        }

        // ── [节点] main:detail_scrape_triggered ───────────────────────
        // 判断：URL 含 -g-数字.html，说明当前是商品详情页
        // 决策：先抓主商品完整字段（价格/销量/评分等），补全 collected 里的同 goodsId 记录
        if (hasCurrentProductAnchor()) {
            logAction('info', '当前页是商品详情，触发主商品字段补全');
            traceNode('main', 'detail_scrape_triggered', 'URL 含商品锚点（-g-数字.html），需要提取详情页完整字段', {
                goodsId: getGoodsIdFromUrl(location.href),
            }, '→ scrapeAndUpsertCurrentProduct()');
            await scrapeAndUpsertCurrentProduct();
        }

        const refreshed = await getState();
        const batchLoaded = getTotalCollected(refreshed) - refreshed.batchStartCount;
        const batchFull = batchLoaded >= refreshed.config.batchSize
            || getTotalCollected(refreshed) >= refreshed.config.totalLimit;
        const isConservativeMode = refreshed.config?.collectionMode === COLLECTION_MODES.CONSERVATIVE;

        // ── [节点] main:batch_gate ─────────────────────────────────────
        // 判断：本页已采数量（batchLoaded）是否达到 batchSize（默认 100）
        //       或全局总量是否超过 totalLimit
        // 决策（未满）：继续扫描采集，不进入选目标流程
        // 决策（已满）：停止采集，进入选目标 / 初筛流程
        if (!batchFull) {
            logAction('info', `本批未满（${batchLoaded}/${refreshed.config.batchSize}），进入商品流扫描`, {
                batchLoaded,
                batchSize: refreshed.config.batchSize,
                total: getTotalCollected(refreshed),
            });
            traceNode('main', 'batch_gate_open', `本页已采 ${batchLoaded} 条，未达 batchSize(${refreshed.config.batchSize})，继续扫描`, {
                batchLoaded,
                batchSize: refreshed.config.batchSize,
                totalCollected: getTotalCollected(refreshed),
                totalLimit: refreshed.config.totalLimit,
                batchStartCount: refreshed.batchStartCount,
            }, '→ productStreamTick()');
            await transitionTo(FSM_STATES.LIST_DISCOVERY, {
                phase: 'listing',
                reason: 'stream-discovery',
            });
            await patchState({
                phase: 'listing',
                listingUrl: location.href,
                lastDiscoveryUrl: location.href,
            });
            // 辅助模式用户在场，无需抖动延迟；激进模式加随机间隔降低特征
            if (!isConservativeMode) await sleep(jitteredMs(1.5));
            await productStreamTick();
            return;
        }

        // ── [节点] main:queue_ready ────────────────────────────────────
        // 判断：batch 已满 + targetQueue 里已有上次 runInitialFilter 选好的目标
        // 决策：直接高亮队列第一个目标等待跳转，跳过重新筛选（省一次 filter 计算）
        if (refreshed.targetQueue.length > 0) {
            const nextItem = refreshed.targetQueue[0];
            logAction('info', `本批已满，队列已有目标（${refreshed.targetQueue.length} 条），直接高亮等跳转`, {
                goodsId: nextItem.goodsId,
                queueLen: refreshed.targetQueue.length,
            });
            traceNode('main', 'queue_ready', `batch 已满且队列非空，跳过初筛直接高亮目标`, {
                batchLoaded,
                batchSize: refreshed.config.batchSize,
                queueLen: refreshed.targetQueue.length,
                nextGoodsId: nextItem.goodsId,
                nextName: (nextItem.name || nextItem.fullTitle || '').slice(0, 30),
            }, `→ highlightPendingItem(goodsId=${nextItem.goodsId})`);
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

        // ── [节点] main:filter_needed ──────────────────────────────────
        // 判断：batch 已满 + 队列为空（上一轮 filter 结果已消费完）
        // 决策：进入商品流扫描，productStreamTick 扫完后会调 runInitialFilter 补充队列
        logAction('info', '本批已满，队列为空，进入商品流发现挑选目标', {
            batchLoaded,
            total: getTotalCollected(refreshed),
        });
        traceNode('main', 'filter_needed', 'batch 已满但目标队列为空，需要重新扫描并筛选下一目标', {
            batchLoaded,
            batchSize: refreshed.config.batchSize,
            totalCollected: getTotalCollected(refreshed),
            totalLimit: refreshed.config.totalLimit,
            processedCount: (refreshed.processedIds || []).length,
        }, '→ productStreamTick() → runInitialFilter()');
        await transitionTo(FSM_STATES.LIST_DISCOVERY, {
            phase: 'listing',
            reason: 'stream-discovery',
        });
        await patchState({
            phase: 'listing',
            listingUrl: location.href,
            lastDiscoveryUrl: location.href,
        });
        if (!isConservativeMode) await sleep(jitteredMs(1.5));
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
        total: getTotalCollected(state),
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

    // 主流：列表页/搜索页主区，排除联想区
    // streams.push({
    //     id: 'main',
    //     sourceTag: 'listing',
    //     getCards: () => {
    //         const all = findProductCards(document);
    //         const skip = getRelatedItemsRoot();
    //         if (!skip) return all;
    //         return all.filter((card) => !skip.contains(card));
    //     },
    //     // 本流的本地仓删除策略：优先精确网格选择器，fallback 遍历卡片直接删
    //     removeLocalWarehouse: () => {
    //         const cards = findProductCards(document).filter((c) => !getRelatedItemsRoot()?.contains(c));
    //         return removeLocalWarehouseFromCards(cards, /* removeParent */ false);
    //     },
    //     getLoadMoreBtn: () => findLoadMoreBtn(),
    //     ensureReady: async () => true,
    // });

    // 联想流：详情页 #goodsRecommend 区域
    if (relatedRoot) {
        streams.push({
            id: 'related',
            sourceTag: 'related',
            getCards: () => {
                const root = getRelatedItemsRoot();
                if (!root) return [];
                return findProductCards(root);
            },
            // 联想区卡片外面多一层网格包装容器，需要删 parentElement 才能整体移除
            removeLocalWarehouse: () => {
                const root = getRelatedItemsRoot();
                if (!root) return 0;
                return removeLocalWarehouseFromCards(findProductCards(root), /* removeParent */ true);
            },
            getLoadMoreBtn: () => findLoadMoreBtn(),
            ensureReady: async () => {
                const currentId = getGoodsIdFromUrl(location.href);
                return ensureRelatedAreaReady(currentId);
            },
        });
    }

    return streams;
}

/**
 * 对单个商品流执行完整处理管道：
 *   1. 按流策略删除本地仓元素（removeParent 差异已封装在 stream.removeLocalWarehouse 里）
 *   2. sweepCardsIntoView 触发懒加载
 *   3. 提取卡片字段并去重
 *   4. 构建关系边（currentId → 当前流中的其他商品）
 *
 * 调用方只需传入流描述符和上下文，不感知"当前是列表页还是详情页"。
 *
 * @param {object} stream 商品流描述符（由 enumerateProductStreams 创建）
 * @param {{shouldRemoveLocalWarehouse: boolean, currentId: string}} context
 * @returns {Promise<{removed: number, items: Array, edges: Array}>}
 */
/**
 * 通过 background 的 chrome.scripting.executeScript(world=MAIN) 读取 React Fiber 数据。
 * 绕过 content script 隔离世界限制，同时不受页面 CSP inline-script 限制。
 *
 * @returns {Promise<Array>} 页面上所有命中 goodsInfo 的原始数据数组
 */
async function readRawItemsFromPageWorld() {
    const resp = await callRuntime('readFiberData');
    return resp?.items || [];
}

/**
 * 轮询等待页面上 data-tooltip^="goodName-" 节点数量超过 minCount。
 * 用于"查看更多"点击后等待新卡片渲染到 DOM。
 *
 * @param {number} minCount 期望超过的数量
 * @param {{intervalMs?: number, timeoutMs?: number}} opts
 * @returns {Promise<number>} 实际节点数量
 */
async function waitForFiberNodeCount(minCount, {intervalMs = 300, timeoutMs = 8000} = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const count = document.querySelectorAll('[data-tooltip^="goodName-"]').length;
        if (count > minCount) {
            logAction('info', `[fiber] 节点数从 ${minCount} 增长到 ${count}，开始读取`);
            return count;
        }
        await sleep(intervalMs);
    }
    const fallback = document.querySelectorAll('[data-tooltip^="goodName-"]').length;
    logAction('warn', `[fiber] 等待超时（${timeoutMs}ms），当前节点数=${fallback}，直接读取`);
    return fallback;
}

/**
 * 从 React Fiber 内存读取联想区所有商品数据（通过注入页面主世界脚本）。
 * 无需等待水合（知了数据注入），瞬间读取。
 * minCount > 0 时会先轮询等待节点数增长（用于"查看更多"后的二次扫描）。
 *
 * @param {{streamId: string, sourceTag: string, currentId: string, shouldRemoveLocalWarehouse: boolean, minCount?: number}} opts
 * @returns {Promise<Array>} items 数组，附带 _removedCount 属性记录过滤掉的本地仓数量
 */
async function readItemsFromReactFiber({streamId, sourceTag, currentId, shouldRemoveLocalWarehouse, minCount = 0}) {
    if (minCount > 0) {
        await waitForFiberNodeCount(minCount);
    }

    const rawList = await readRawItemsFromPageWorld();
    logAction('info', `[fiber] 页面主世界返回 ${rawList.length} 条原始数据`, {streamId});

    const map = new Map();
    let removedCount = 0;

    for (const o of rawList) {
        const goodsId = o.goodsId?.toString();
        if (!goodsId) continue;

        // 跳过当前详情页自身
        if (goodsId === currentId) continue;

        // 过滤本地仓（wareHouseType !== 0）
        if (shouldRemoveLocalWarehouse && o.wareHouseType !== 0) {
            removedCount++;
            continue;
        }

        if (!map.has(goodsId)) {
            const comment = o.comment || {};
            const starRating = comment.goodsScore != null ? String(comment.goodsScore) : '';
            const reviewCount = comment.commentNumTips || '';
            const salesTipList = Array.from(o.salesTipTextList || []);
            const salesRaw = salesTipList[1] || '';
            const sales = salesTipList.join(' ').trim();
            const salesNum = parseInt(salesRaw.replace(/[,，件]/g, ''), 10) || 0;
            const link = o.seoLinkUrl
                ? (location.origin + o.seoLinkUrl)
                : '';

            map.set(goodsId, {
                goodsId,
                link,
                name: (o.title || o.pageAlt || '').slice(0, 80),
                price: o.priceInfo?.priceStr || '',
                sales,
                salesNum,
                starRating,
                reviewCount,
                listingTime: '',
                mallId: o.mallId?.toString() || '',
                source: sourceTag,
                sourceRootId: streamId,
                scrapedAt: nowText(),
            });
        }
    }

    const items = Array.from(map.values());
    logAction('info', `[fiber] 去重后 ${items.length} 条，过滤本地仓 ${removedCount} 条`, {
        streamId,
        total: items.length,
        removed: removedCount,
        sample: items.slice(0, 3).map((x) => `${x.goodsId}|${x.name.slice(0, 12)}|${x.price}`),
    });

    items._removedCount = removedCount;
    return items;
}

async function processStream(stream, context) {
    // 1. 从 React Fiber 内存读取商品数据（替代 DOM 抠字段 + sweepCardsIntoView）
    const items = await readItemsFromReactFiber({
        streamId: stream.id,
        sourceTag: stream.sourceTag,
        currentId: context.currentId,
        shouldRemoveLocalWarehouse: context.shouldRemoveLocalWarehouse,
        minCount: _streamFiberCountMap.get(stream.id) || 0,
    });
    const removed = items._removedCount || 0;
    // 更新本轮实际扫到的节点数（含被过滤的），供下次"查看更多"后的轮询使用
    // 用模块级 Map 持久化，因为 enumerateProductStreams() 每次重建 stream 对象
    _streamFiberCountMap.set(stream.id, items.length + removed);
    delete items._removedCount;

    // 4. 构建关系边
    const edges = [];
    if (context.currentId) {
        for (const item of items) {
            if (!item.goodsId || item.goodsId === context.currentId) continue;
            edges.push({
                from_goods_id: context.currentId,
                to_goods_id: item.goodsId,
                relation_type: stream.sourceTag === 'related' ? 'related' : 'co_listing',
            });
        }
    }

    return {removed, items, edges};
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
    const state = await getState();
    const streams = enumerateProductStreams();

    // ── [节点] stream:scan_start ───────────────────────────────────────
    // 判断：enumerateProductStreams() 返回了几条商品流
    // 说明：目前主流（列表页主区）被注释掉，只有详情页的联想流（#goodsRecommend）生效
    //       如果 streams.length=0，说明当前页没有联想区，后续会走 no_streams 分支
    logAction('info', `商品流扫描开始，发现 ${streams.length} 条流`, {
        streamIds: streams.map((stream) => stream.id),
    });
    traceNode('stream', 'scan_start', '开始枚举页面商品流（主流已注释，当前仅扫联想流）', {
        streamCount: streams.length,
        streamIds: streams.map((s) => s.id),
        currentId: getGoodsIdFromUrl(location.href),
        removeLocalWarehouse: state.config?.removeLocalWarehouse,
    }, streams.length > 0 ? `→ 逐流处理 ${streams.length} 条流` : '→ 无流可扫，后续进 runInitialFilter');

    const currentId = getGoodsIdFromUrl(location.href);
    const shouldRemoveLocalWarehouse = Boolean(state.config?.removeLocalWarehouse);

    let totalAdded = 0;
    let totalRemovedLocalWarehouse = 0;
    const perStreamStats = [];
    const allEdges = [];

    for (const stream of streams) {
        const ready = await stream.ensureReady();

        // ── [节点] stream:not_ready ────────────────────────────────────
        // 判断：stream.ensureReady() 返回 false
        // 原因：联想流需要先滚到底部触发 Temu 懒加载，如果滚动后仍未渲染则返回 false
        // 决策：跳过该流，不采集，继续处理其他流
        if (!ready) {
            logAction('warn', `流 [${stream.id}] 未就绪，跳过`);
            traceNode('stream', 'not_ready', `流 [${stream.id}] 未就绪（联想区未渲染或无商品），跳过`, {
                streamId: stream.id,
            }, '→ continue，跳过该流');
            perStreamStats.push({id: stream.id, ready: false, scraped: 0, added: 0, removed: 0});
            continue;
        }

        const {removed, items, edges} = await processStream(stream, {
            shouldRemoveLocalWarehouse,
            currentId,
        });
        const added = await upsertItems(items);

        // ── [节点] stream:processed ────────────────────────────────────
        // 记录本流处理结果：找到多少商品、去重后新增多少、删除多少本地仓商品
        logAction('info', `流 [${stream.id}] 扫描完成：发现 ${items.length} 条，新增 ${added} 条，删本地仓 ${removed} 条`, {
            scraped: items.length,
            added,
            removed,
            streamId: stream.id,
        });
        traceNode('stream', 'processed', `流 [${stream.id}] 本轮扫描完成`, {
            streamId: stream.id,
            scraped: items.length,
            newAdded: added,
            alreadySeen: items.length - added,
            localWarehouseRemoved: removed,
            edgesFound: edges.length,
        }, added > 0 ? `新增 ${added} 条商品到 collected` : '0 新增（全部已在 seenGoodsIds）');

        totalAdded += added;
        totalRemovedLocalWarehouse += removed;
        allEdges.push(...edges);
        perStreamStats.push({id: stream.id, ready: true, scraped: items.length, added, removed});
    }

    if (allEdges.length) {
        await enqueueUploadEdges(allEdges);
    }

    const refreshed = await getState();
    const batchLoaded = getTotalCollected(refreshed) - refreshed.batchStartCount;

    await patchState({stats: {listingTotal: getTotalCollected(refreshed)}});

    // ── [节点] stream:batch_full ───────────────────────────────────────
    // 判断：本页累计采集量（batchLoaded）已达 batchSize，或全局总量超 totalLimit
    // 决策：停止继续采集，进入初筛挑选下一个要跳转的目标
    if (
        batchLoaded >= refreshed.config.batchSize ||
        getTotalCollected(refreshed) >= refreshed.config.totalLimit
    ) {
        logAction('info', `本批已满（${batchLoaded}/${refreshed.config.batchSize}），进入初筛`, {
            batchLoaded,
            total: getTotalCollected(refreshed),
        });
        traceNode('stream', 'batch_full', `本页已采 ${batchLoaded} 条达到 batchSize(${refreshed.config.batchSize})，停止采集进入初筛`, {
            batchLoaded,
            batchSize: refreshed.config.batchSize,
            totalCollected: getTotalCollected(refreshed),
            totalLimit: refreshed.config.totalLimit,
            perStreamStats,
        }, '→ runInitialFilter()');
        await runInitialFilter(await getState());
        return;
    }

    // ── [节点] stream:zero_new_items ──────────────────────────────────
    // 判断：本轮所有流加起来 0 新增
    // 原因：页面上所有商品已在 seenGoodsIds 里，继续滚动加载的也会是同类商品
    // 决策：直接进初筛，避免陷入"点查看更多 → 加载旧商品 → 0 新增 → 再点"的死循环
    if (totalAdded === 0) {
        logAction('info', '本轮扫描 0 新增（全部已见），跳过"查看更多"，进入初筛', {
            batchLoaded,
            total: getTotalCollected(refreshed),
            perStreamStats,
        });
        traceNode('stream', 'zero_new_items', '本轮所有流均无新商品，继续滚动无意义，直接初筛', {
            totalAdded: 0,
            batchLoaded,
            seenGoodsIdsCount: (refreshed.seenGoodsIds || []).length,
            perStreamStats,
        }, '→ runInitialFilter()（跳过"查看更多"）');
        await runInitialFilter(await getState());
        return;
    }

    // 辅助模式：用户自己控制滚动，不强制跳到页面底部
    if (refreshed.config?.collectionMode !== COLLECTION_MODES.CONSERVATIVE) {
        try {
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        } catch (_) {}
        await sleep(400);
    }

    let loadMoreBtn = null;
    for (const stream of streams) {
        const btn = stream.getLoadMoreBtn?.();
        if (btn) { loadMoreBtn = btn; break; }
    }

    if (loadMoreBtn) {
        const shouldAuto = refreshed.config.collectionMode === COLLECTION_MODES.AGGRESSIVE;

        // ── [节点] stream:load_more_found ─────────────────────────────
        // 判断：找到"查看更多"按钮 + 本批未满
        // 决策：按采集模式决定自动还是手动点击
        //   - AGGRESSIVE：自动点击，继续采集不打断
        //   - CONSERVATIVE：高亮按钮，等用户手动点，防误操作
        logAction('info', `找到"查看更多"按钮，${shouldAuto ? '即将自动点击' : '等待手动点击'}`);
        traceNode('stream', 'load_more_found', `找到"查看更多"按钮，根据采集模式决定是否自动点击`, {
            collectionMode: refreshed.config.collectionMode,
            shouldAutoClick: shouldAuto,
            batchLoaded,
            totalAdded,
        }, shouldAuto ? '→ handleAutoLoadMoreClick()（自动点击）' : '→ highlightLoadMoreButton()（等待手动点击）');

        highlightLoadMoreButton(loadMoreBtn, {
            autoClick: shouldAuto,
            waitSec: refreshed.config.intervalSec,
            noScroll: refreshed.config.collectionMode === COLLECTION_MODES.CONSERVATIVE,
        });
        notify({ action: 'clickMore', total: getTotalCollected(refreshed), autoClick: shouldAuto });
        if (shouldAuto) {
            await handleAutoLoadMoreClick(loadMoreBtn, refreshed.config.intervalSec);
        }
        return;
    }

    // ── [节点] stream:no_load_more ────────────────────────────────────
    // 判断：没找到"查看更多"按钮
    // 原因：页面已经加载到底，或按钮还未渲染
    // 决策：进初筛，由 runInitialFilter 决定是换页还是结束
    logAction('warn', '未找到"查看更多"按钮，进入初筛');
    traceNode('stream', 'no_load_more', '未找到"查看更多"按钮，页面可能已到底', {
        batchLoaded,
        totalAdded,
    }, '→ runInitialFilter()（由它决定换页/结束）');
    await runInitialFilter(await getState());
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

    // 只从当前页面 DOM 可见的商品里挑，保证 highlightPendingItem 一定能找到节点。
    // 用 state.collected 里的富数据排序（含详情页补全的字段），但限制在当前页可见范围。
    const currentPageIds = new Set();
    for (const stream of enumerateProductStreams()) {
        for (const card of stream.getCards()) {
            const item = extractItemFromCard(card, stream.sourceTag);
            if (item?.goodsId) currentPageIds.add(item.goodsId);
        }
    }

    const processed = new Set(state.processedIds);
    const visibleCandidates = state.collected.filter(
        (item) => item.goodsId && !processed.has(item.goodsId) && currentPageIds.has(item.goodsId)
    );
    // 当前页全都处理过时回退到全量，防止死锁
    const pool = visibleCandidates.length > 0
        ? visibleCandidates
        : state.collected.filter((item) => item.goodsId && !processed.has(item.goodsId));

    logAction('info', `初筛：当前页可见商品 ${currentPageIds.size} 条，历史候选 ${visibleCandidates.length} 条（全量兜底：${pool === visibleCandidates ? '否' : '是'}）`, {
        visibleCount: currentPageIds.size,
        candidateCount: visibleCandidates.length,
        fallback: pool !== visibleCandidates,
    });

    // ── [节点] filter:pool_stats ───────────────────────────────────────
    // 判断：从 collected 里筛出候选池
    //   - 优先用当前页面 DOM 可见的商品（保证高亮时能找到节点）
    //   - 全部处理过时退到全量 collected，防止死锁
    traceNode('filter', 'pool_stats', '计算候选池：优先当前页可见商品，全处理过则退到全量', {
        collectedTotal: state.collected.length,
        processedCount: processed.size,
        currentPageVisible: currentPageIds.size,
        visibleCandidates: visibleCandidates.length,
        usingFallback: pool !== visibleCandidates,
        poolSize: pool.length,
    }, pool.length > 0 ? `→ selectPriorityItems(pool=${pool.length})` : '→ 候选池为空，准备结束或扩池');

    // 辅助模式多取几条候选供用户翻页浏览；激进模式只需要 1 条直接跳转
    const isConservative = state.config?.collectionMode === COLLECTION_MODES.CONSERVATIVE;
    const candidateLimit = isConservative ? 10 : 1;
    const queue = selectPriorityItems(pool, candidateLimit, state.recentProcessedNames || []);

    if (queue.length > 0) {
        logAction('info', `初筛命中：goodsId=${queue[0].goodsId} 名称="${(queue[0].name || queue[0].fullTitle || '').slice(0, 20)}"${isConservative ? `（共 ${queue.length} 条候选可翻页）` : ''}`, {
            goodsId: queue[0].goodsId,
            starRating: queue[0].starRating,
            sales: queue[0].sales,
            candidateCount: queue.length,
        });

        // ── [节点] filter:selected ─────────────────────────────────────
        // 判断：selectPriorityItems 从候选池中命中目标
        // 优先规则：① 无评分新品（销量降序）② 有评分商品（销量降序+评价升序）
        // 决策：把目标放入 targetQueue，高亮等待跳转（辅助模式可翻页）
        traceNode('filter', 'selected', 'selectPriorityItems 命中目标，优先无评分高销量商品', {
            goodsId: queue[0].goodsId,
            name: (queue[0].name || queue[0].fullTitle || '').slice(0, 40),
            starRating: queue[0].starRating || '(无)',
            sales: queue[0].sales || '(无)',
            salesNum: queue[0].salesNum || 0,
            reviewCount: queue[0].reviewCount || '(无)',
            sourceRootId: queue[0].sourceRootId,
            candidateCount: queue.length,
        }, `→ highlightPendingItem(goodsId=${queue[0].goodsId})`);
    } else {
        logAction('warn', '初筛无结果：候选池已全部处理或为空', {
            poolSize: pool.length,
            processedCount: processed.size,
        });
    }

    notify({
        action: 'filtered',
        validCount: queue.length,
        queued: queue.length,
        total: getTotalCollected(state),
    });

    if (queue.length === 0) {
        const canExpand = Boolean(findLoadMoreBtn()) || Boolean(getRelatedItemsRoot());
        const collectedExhausted = (state.collected?.length || 0) === 0;

        if (getTotalCollected(state) >= state.config.totalLimit || !canExpand || collectedExhausted) {

            // ── [节点] filter:finish ───────────────────────────────────
            // 判断：满足以下任一条件就结束：
            //   ① totalCollected >= totalLimit（采集量达上限）
            //   ② canExpand=false（没有"查看更多"也没有联想区，无法获取新商品）
            //   ③ collectedExhausted=true（collected 已全部上传清空，再采也是重复的 seenId）
            if (collectedExhausted && canExpand) {
                logAction('warn', '当前页 collected 已全部上传清空，继续扫描无法得到新目标，结束采集', {
                    totalCollected: getTotalCollected(state),
                    seenGoodsIdsSize: (state.seenGoodsIds || []).length,
                });
                traceNode('filter', 'finish', 'collected 全部上传清空，继续扫描只会得到已见 ID，结束采集', {
                    totalCollected: getTotalCollected(state),
                    seenCount: (state.seenGoodsIds || []).length,
                    canExpand,
                    collectedExhausted,
                }, '→ finish()');
            } else {
                logAction('warn', '无法继续扩池，准备结束采集');
                traceNode('filter', 'finish', '无候选且无法扩池，采集自然结束', {
                    totalCollected: getTotalCollected(state),
                    totalLimit: state.config.totalLimit,
                    canExpand,
                    poolSize: pool.length,
                    processedCount: processed.size,
                }, '→ finish()');
            }
            await finish(await getState());
            return;
        }

        // ── [节点] filter:expand_pool ──────────────────────────────────
        // 判断：候选池空 + 但页面还能扩池（有"查看更多"或联想区）
        // 决策：重置 batchStartCount，重新触发 main() 让 productStreamTick 采更多商品
        logAction('info', '当前页仍可扩池（有查看更多或联想区），重置 batch 继续采');
        traceNode('filter', 'expand_pool', '候选池为空但页面仍可继续加载商品，重置 batch 计数扩充候选', {
            canExpand,
            hasLoadMore: Boolean(findLoadMoreBtn()),
            hasRelated: Boolean(getRelatedItemsRoot()),
            currentCycles: state.stats.cycles || 0,
            batchStartCountBefore: state.batchStartCount,
        }, '→ 重置 batchStartCount，延迟 1s 重新触发 main()');
        await patchState({
            phase: 'listing',
            batchStartCount: getTotalCollected(state),
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
    // 辅助模式记录候选总数和当前索引，供 popup 上一个/下一个按钮使用
    await patchState({targetQueueIndex: 0});
    await transitionTo(FSM_STATES.TARGET_SELECTED, {
        phase: 'navigating',
        reason: 'initial-filter-hit',
    });
    await highlightPendingItem(queue[0], '初筛命中，点击后进入下一商品');
    // 通知 popup 候选数量，用于渲染翻页导航条
    notify({action: 'candidatesReady', index: 0, total: queue.length, isConservative});
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

    // ── [节点] detail:start ────────────────────────────────────────────
    // 判断：URL 中提取到合法 goodsId，可以开始抓取
    // 决策：等 DETAIL_RENDER_DELAY(2500ms) 让 Temu React 渲染完毕再提取 DOM
    logAction('info', `详情页主商品抓取开始：goodsId=${currentId}`);
    traceNode('detail', 'start', 'URL 含商品锚点，开始提取详情页完整字段', {
        goodsId: currentId,
        renderDelay: DETAIL_RENDER_DELAY,
    }, `→ sleep(${DETAIL_RENDER_DELAY}ms) 等页面渲染，然后 scrapeDetailFields()`);

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
    logAction('info', `详情页主商品字段补全完成：标题="${(detailData.fullTitle || '').slice(0, 20)}" 价格=${detailData.price || ''} 销量=${detailData.sales || ''} 星级=${detailData.stars || ''}`, {
        goodsId: currentId,
        title: detailData.fullTitle || '',
        price: detailData.price || '',
        sales: detailData.sales || '',
        stars: detailData.stars || '',
        reviews: detailData.reviews || '',
    });

    // ── [节点] detail:fields_extracted ────────────────────────────────
    // 记录提取结果：哪些字段拿到值、哪些为空（空字段不会覆盖 collected 里的旧值）
    traceNode('detail', 'fields_extracted', '详情页 DOM 解析完成，字段已 upsert 到 collected', {
        goodsId: currentId,
        title: (detailData.fullTitle || '').slice(0, 50),
        price: detailData.price || '(空)',
        sales: detailData.sales || '(空)',
        stars: detailData.stars || '(空)',
        reviews: detailData.reviews || '(空)',
        listingTime: detailData.listingTime || '(空)',
        rawHtmlLen: detailRawBlock.rawHtml.length,
        rawTextLen: detailRawBlock.rawText.length,
    }, detailRawBlock.rawHtml.length > 0 ? '字段完整，已写入 collected' : '⚠️ rawHtml 为空，可能页面未完全渲染');

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
 * 独立上架流程入口：由 popup 可视按钮主动触发，和采集流程解耦。
 * 当前页面必须是 Temu 商品详情页，然后查找文本为"一键上架"的可点击元素并点击。
 *
 * @returns {Promise<{ok: boolean, goodsId?: string, error?: string}>}
 */
async function clickOneClickListingButton() {
    const goodsId = getGoodsIdFromUrl(location.href);
    if (!goodsId || !hasCurrentProductAnchor()) {
        return {ok: false, error: '当前页面不是 Temu 商品详情页，请先打开商品详情页。'};
    }

    showToast('将在 5 秒后点击“一键上架”', 'info');
    await sleep(ONE_CLICK_LISTING_DELAY_MS + randomInt(-350, 350));

    const button = findOneClickListingButton();
    if (!button) {
        debugLog('one-click-listing-button-missing', {goodsId});
        return {ok: false, goodsId, error: '当前详情页未找到“一键上架”按钮。'};
    }

    scrollElementToViewportAnchor(button, 0.45);
    await sleep(randomInt(350, 900));

    const clickable = resolveOneClickListingClickable(button);
    const didHumanClick = clickable ? await humanClick(clickable) : false;
    if (clickable) {
        await sleep(randomInt(80, 180));
        clickable.click();
    }

    debugLog('one-click-listing-clicked', {
        goodsId,
        tagName: clickable?.tagName || '',
        text: normalizeText(clickable?.innerText || button.innerText || ''),
    });
    showToast('已点击“一键上架”', 'ok');
    notify({
        action: 'oneClickListingClicked',
        goodsId,
    });
    return {ok: true, goodsId};
}

/**
 * 查找页面上文本内容为"一键上架"的候选元素。
 * 先匹配 button/a/[role=button]，再允许 span/div 文字节点向上找可点击容器。
 *
 * @returns {Element | null}
 */
function findOneClickListingButton() {
    for (const preferredSelector of ONE_CLICK_LISTING_SELECTORS) {
        const selectorMatch = Array.from(document.querySelectorAll(preferredSelector))
            .find((el) => {
                if (!isVisibleElement(el)) return false;
                const text = normalizeText(el.innerText || el.textContent);
                return preferredSelector === '.gdyqmod'
                    || !text
                    || text === ONE_CLICK_LISTING_TEXT
                    || text.includes(ONE_CLICK_LISTING_TEXT);
            });
        if (selectorMatch) {
            debugLog('one-click-listing-selector-hit', {
                selector: preferredSelector,
                text: normalizeText(selectorMatch.innerText || selectorMatch.textContent || ''),
            });
            return selectorMatch;
        }
    }

    const selector = 'button, a, [role="button"], span, div';
    const candidates = Array.from(document.querySelectorAll(selector))
        .filter((el) => {
            if (!isVisibleElement(el)) return false;
            return normalizeText(el.innerText || el.textContent) === ONE_CLICK_LISTING_TEXT;
        });

    if (!candidates.length) return null;

    const seen = new Set();
    const ranked = candidates
        .map((el, index) => {
            const clickable = resolveOneClickListingClickable(el);
            const rect = clickable?.getBoundingClientRect();
            const isNativeClickable = clickable?.matches?.('button, a, [role="button"]') || false;
            return {
                el,
                clickable,
                index,
                isNativeClickable,
                area: rect ? rect.width * rect.height : 0,
            };
        })
        .filter((item) => {
            if (!item.clickable || item.area <= 0) return false;
            if (seen.has(item.clickable)) return false;
            seen.add(item.clickable);
            return true;
        })
        .sort((a, b) => {
            if (a.isNativeClickable !== b.isNativeClickable) return a.isNativeClickable ? -1 : 1;
            return a.index - b.index;
        });

    return ranked[0]?.clickable || null;
}

/**
 * 从文字节点或包装层向上找真正的点击目标。
 *
 * @param {Element | null | undefined} element
 * @returns {Element | null}
 */
function resolveOneClickListingClickable(element) {
    return element?.closest?.('button, a, [role="button"]') || element || null;
}

/**
 * 可见性判断，避免点到隐藏模板节点。
 *
 * @param {Element | null | undefined} element
 * @returns {boolean}
 */
function isVisibleElement(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
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

    // 辅助模式：用户在场，跳过强制滚底（避免干扰用户视角）
    const state = await getState();
    if (state.config?.collectionMode !== COLLECTION_MODES.CONSERVATIVE) {
        await scrollToPageBottomForRelatedRender();
    }

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
    // 辅助模式：用户自己浏览，不自动将联想区滚入视口
    if (state.config?.collectionMode !== COLLECTION_MODES.CONSERVATIVE) {
        scrollElementToViewportAnchor(relatedArea, 0.18);
    }
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
    let recentProcessedNames = [...(state.recentProcessedNames || [])];

    for (const item of items) {
        if (!item.goodsId || queueIds.has(item.goodsId)) continue;
        queue.push(item);
        queueIds.add(item.goodsId);
        if (options.markProcessed) {
            processedIds.add(item.goodsId);
            // 把商品名加入滑动窗口，超出上限时丢弃最老的
            const name = item.name || item.fullTitle || '';
            if (name) {
                recentProcessedNames = [...recentProcessedNames, name].slice(-RECENT_NAMES_WINDOW);
            }
        }
    }

    await patchState({
        targetQueue: queue,
        processedIds: Array.from(processedIds),
        recentProcessedNames,
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
 *   4. 广播 `done` 消息让 popup 切到已完成态
 *
 * @param {ReturnType<typeof defaultState>} state
 * @returns {Promise<void>}
 */
async function finish(state) {
    logAction('info', `采集结束，共采 ${getTotalCollected(state)} 条，已处理 ${state.processedIds?.length || 0} 条`, {
        total: getTotalCollected(state),
        processed: state.processedIds?.length,
    });
    await uploadPendingBatch(true);
    // uploadPendingBatch 成功后 collected 已被清空、totalCollected 已累加，
    // 读最新 state 来获取正确的最终计数。
    const afterUpload = await getState();
    logAction('info', `[finish] 最终计数：totalCollected=${afterUpload.totalCollected || 0}，collected 剩余=${afterUpload.collected.length}，合计=${getTotalCollected(afterUpload)}，seenGoodsIds=${(afterUpload.seenGoodsIds || []).length}`, {
        totalCollectedHistory: afterUpload.totalCollected || 0,
        collectedRemaining: afterUpload.collected.length,
        grandTotal: getTotalCollected(afterUpload),
        seenGoodsIdsSize: (afterUpload.seenGoodsIds || []).length,
        processedIds: afterUpload.processedIds?.length || 0,
    });
    await finishBackendRun('completed', getTotalCollected(afterUpload));
    await patchState({running: false, phase: 'done'});
    const latest = await getState();

    // trace 上传后端（内部会先 flush 再 POST，上传成功后自动清本地 storage）
    await flushAndUploadTrace(latest.runUuid || _traceRunId);

    notify({
        action: 'done',
        total: getTotalCollected(latest),
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
    logAction('info', `准备高亮目标：goodsId=${item.goodsId} 来源=${item.source || '?'}`);
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
        logAction('error', `高亮失败：页面上找不到 goodsId=${item.goodsId} 的卡片节点`, {
            goodsId: item.goodsId,
            source: item.source,
        });
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
    logAction('info', `高亮已应用：goodsId=${item.goodsId}`);
    keepPendingHighlightAlive(item, finalLabel);

    // 辅助模式：用户自己看页面，不自动滚动（避免干扰用户视角）
    const hlState = await getState();
    if (hlState.config?.collectionMode !== COLLECTION_MODES.CONSERVATIVE) {
        const scrollAnchor = item.source === 'related' ? 0.16 : 0.22;
        logAction('info', `开始滚动至高亮商品：goodsId=${item.goodsId}`, {
            goodsId: item.goodsId,
            source: item.source,
            anchorRatio: scrollAnchor
        });
        const scrolled = await scrollToRenderedAnchor(target, scrollAnchor, 50, 800000, item);
        if (scrolled) {
            const rectFinal = target.getBoundingClientRect();
            const desiredTop = Math.round(window.innerHeight * scrollAnchor);
            logAction('info', `滚动完成：goodsId=${item.goodsId} 偏差=${Math.round(rectFinal.top - desiredTop)}px`, {
                goodsId: item.goodsId,
                anchorRatio: scrollAnchor,
                desiredTop,
                rectFinal_top: Math.round(rectFinal.top),
                delta: Math.round(rectFinal.top - desiredTop),
            });
        } else {
            logAction('warn', `滚动超时：goodsId=${item.goodsId} 元素 3s 内未渲染`, {
                goodsId: item.goodsId,
                source: item.source
            });
        }
    }

    debugLog('highlight-applied', {
        goodsId: item.goodsId,
        source: item.source,
        tagName: target.tagName,
        className: target.className || '',
    });
    scheduleAutoClickIfNeeded(item, target);
    logAction('info', '已排期自动点击');
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
 * 激进模式用短延时（1.2~2.6s）快速推进；其他模式保留更长的人类化抖动。
 * 定时器触发时会二次校验 state.running / goodsId 没变才真的点下去。
 *
 * @param {{goodsId: string, source?: string}} item
 * @param {Element} target 实际要点的 DOM 节点
 * @returns {Promise<void>}
 */
async function scheduleAutoClickIfNeeded(item, target) {
    const state = await getState();
    if (!state.running || !state.config?.autoClickV1) {
        if (state.running && !state.config?.autoClickV1) {
            logAction('warn', 'autoClickV1 未开启，等待手动点击');
        }
        return;
    }
    if (!item?.goodsId || !target) return;

    clearPendingAutoClick();
    pendingAutoClickGoodsId = item.goodsId;

    const isAggressive = state.config.collectionMode === COLLECTION_MODES.AGGRESSIVE;
    const baseDelay = isAggressive ? randomInt(1200, 2600) : randomInt(4200, 9800);
    const extraDelay = isAggressive ? 0 : (Math.random() < 0.18 ? randomInt(12000, 25000) : 0);
    const totalDelay = baseDelay + extraDelay;

    debugLog('auto-click-scheduled', {
        goodsId: item.goodsId,
        source: item.source,
        delayMs: totalDelay,
    });
    logAction('info', `自动点击已排期：goodsId=${item.goodsId} 延迟 ${(totalDelay / 1000).toFixed(1)}s`, {
        delayMs: totalDelay,
        isAggressive,
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
    logAction('info', `执行自动点击：goodsId=${item.goodsId}`);
    const target = findTargetByItem(item);
    if (!target) {
        logAction('error', `自动点击失败：找不到目标节点 goodsId=${item.goodsId}`);
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
        return;
    }

    // 命中商品 a 标签后，让 Temu 自己在点击链路里补齐 href 参数并跳转。
    const anchorCandidates = [];
    if (clickable.tagName === 'A') anchorCandidates.push(clickable);
    anchorCandidates.push(...Array.from(clickable.querySelectorAll?.('a[href*="-g-"]') || []));
    anchorCandidates.push(...Array.from(target.querySelectorAll?.('a[href*="-g-"]') || []));
    const goodsAnchor = anchorCandidates.find((a) => getGoodsIdFromUrl(a?.href || '') === item.goodsId)
        || anchorCandidates[0]
        || null;
    const clickTarget = goodsAnchor || clickable;

    const point = goodsAnchor ? getProbeStyleAnchorClickPoint(goodsAnchor) : getSafeClickPoint(clickTarget);
    if (!point || !isPointClickable(clickTarget, point)) {
        return;
    }

    // await previewAutoClickPoint(point, AUTO_CLICK_MARKER_PREVIEW_MS);
    await dispatchProbeStyleAnchorClick();
    logAction('info', '鼠标事件已派发，等待页面跳转', {
        goodsId: item.goodsId,
        point,
    });
}


/**
 * 从卡片根节点里挑一个点击目标：
 * - 优先返回外层卡片自身（这样点位可稳定落在卡片中心，避开边缘按钮）
 * - 仅当根节点太小/不可用时，退回内部可点击子节点。
 *
 * @param {Element | null | undefined} target
 * @returns {Element | null}
 */
function findClickableTarget(target) {
    if (!target) return null;
    // 最高优先级：命中商品详情 a 标签（你的要求）
    const goodsAnchor = target.querySelector?.('a[href*="-g-"]');
    if (goodsAnchor) return goodsAnchor;

    // Temu 卡片里如果混入了知了注入块（zlcrx-inject-object），优先点上层原生商品区：
    // goodContainer / goodsImage / goodName，避免落到下层插件面板。
    const upperProductArea = target.querySelector?.(
        '[data-tooltip^="goodContainer-"], [data-tooltip^="goodsImage-"], [data-tooltip^="goodName-"]'
    );
    if (upperProductArea) {
        const linkLike = upperProductArea.querySelector?.('a[href*="-g-"]');
        return linkLike || upperProductArea;
    }

    const rect = target.getBoundingClientRect?.();
    if (rect && rect.width >= 120 && rect.height >= 60) {
        return target;
    }
    return target.querySelector?.('button, [role="button"]') || target;
}

/**
 * 在元素上半区取随机点位，并尽量避免连续两次落到几乎同一点。
 * 规则：
 * - X: 36%~64%（中间偏宽区域）
 * - Y: 16%~40%（上半区，避开下层注入信息）
 * - 与上次点位距离不足 22px 时重抽，最多尝试 8 次
 *
 * @param {Element} element
 * @returns {{clientX: number, clientY: number} | null}
 */
function getSafeClickPoint(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) return null;
    let chosen = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const point = {
            clientX: rect.left + rect.width * (0.36 + Math.random() * 0.28),
            clientY: rect.top + rect.height * (0.16 + Math.random() * 0.24),
        };

        if (!lastAutoClickPoint) {
            chosen = point;
            break;
        }

        const dx = point.clientX - lastAutoClickPoint.clientX;
        const dy = point.clientY - lastAutoClickPoint.clientY;
        const distance = Math.hypot(dx, dy);
        if (distance >= 22) {
            chosen = point;
            break;
        }

        // 最后一次兜底，避免没有返回值
        if (attempt === 7) chosen = point;
    }

    lastAutoClickPoint = chosen;
    return chosen;
}

/**
 * 按你验证过的控制台探针点位：a 标签宽度 48%，高度 28%。
 *
 * @param {Element} element
 * @returns {{clientX: number, clientY: number} | null}
 */
function getProbeStyleAnchorClickPoint(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) return null;
    return {
        clientX: rect.left + rect.width * 0.48,
        clientY: rect.top + rect.height * 0.28,
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

    dispatchPointerEvent(element, 'pointerover', point.clientX, point.clientY, 0);
    dispatchPointerEvent(element, 'pointerenter', point.clientX, point.clientY, 0);
    dispatchPointerEvent(element, 'pointermove', point.clientX, point.clientY, 0);
    dispatchMouseEvent(element, 'mouseover', point.clientX, point.clientY);
    dispatchMouseEvent(element, 'mouseenter', point.clientX, point.clientY);
    dispatchMouseEvent(element, 'mousemove', point.clientX, point.clientY);
    await sleep(randomInt(400, 1200));

    dispatchPointerEvent(element, 'pointerdown', point.clientX, point.clientY, 1);
    dispatchMouseEvent(element, 'mousedown', point.clientX, point.clientY);
    await sleep(randomInt(60, 180));
    dispatchPointerEvent(element, 'pointerup', point.clientX, point.clientY, 0);
    dispatchMouseEvent(element, 'mouseup', point.clientX, point.clientY);
    await sleep(randomInt(30, 110));
    dispatchPointerEvent(element, 'pointermove', point.clientX, point.clientY, 0);
    dispatchPointerEvent(element, 'click', point.clientX, point.clientY, 0);
    dispatchMouseEvent(element, 'click', point.clientX, point.clientY);
}


function dispatchProbeStyleAnchorClick(element, point) {
    const target = document.querySelector('.temu-scraper-pending-target');
    const a = target?.querySelector('a[href*="-g-"]');

    if (!a) {
        console.log('[probe] 没找到商品 a');
        return;
    }
    const prevent = (e) => {
        log('capture-before-prevent', e);
        e.preventDefault();
        setTimeout(() => log('after-event-loop', e), 0);
    };
    a.addEventListener('click', prevent, true);

    const rect = a.getBoundingClientRect();
    const x = rect.left + rect.width * 0.48;
    const y = rect.top + rect.height * 0.28;

    const ev = (type, opts = {}) => {
        const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: window.screenX + x,
            screenY: window.screenY + y,
            button: 0,
            buttons: type === 'mousedown' ? 1 : 0,
            which: 1,
            detail: type === 'click' ? 1 : 0,
            ...opts,
        });
        a.dispatchEvent(event);
    };

    ev('mouseover');
    ev('mouseenter');
    ev('mousemove');
    ev('mousedown');
    ev('mouseup');
    ev('click');

    setTimeout(() => {
        a.removeEventListener('click', prevent, true);
    }, 500);
    setTimeout(async () => {
        // 导航前先清理 collected，新页面的内容脚本拿到的是空的 collected + 更新后的计数
        await clearCollectedBeforeNavigation();
        window.open(a.href, '_blank');
        // 打开新详情页后，清理多余的旧详情页（保留最近 1 个）
        callRuntime('pruneTemuDetailTabs', {maxCount: 1});
    }, 600);
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
        which: 1,
        detail: type === 'click' ? 1 : 0,
    });
    element.dispatchEvent(event);
}

/**
 * 构造并派发 PointerEvent（左键语义）。部分站点只监听 pointer 事件链。
 *
 * @param {Element} element
 * @param {string} type
 * @param {number} clientX
 * @param {number} clientY
 * @param {number} buttons
 */
function dispatchPointerEvent(element, type, clientX, clientY, buttons = 0) {
    if (typeof PointerEvent !== 'function') return;
    const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        pointerType: 'mouse',
        isPrimary: true,
        clientX,
        clientY,
        screenX: window.screenX + clientX,
        screenY: window.screenY + clientY,
        button: 0,
        buttons,
    });
    element.dispatchEvent(event);
}

/**
 * 给"查看更多商品"按钮加高亮样式 + 文字提示，并记录到 `debugPendingLoadMore`
 * 供控制台或外部消息触发加载时复用。保守模式下同时挂 `click` 监听，走
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
    // 辅助模式：用户自己看页面，不自动滚到"查看更多"按钮
    if (!options.noScroll) {
        button.scrollIntoView({behavior: 'smooth', block: 'center'});
    }
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
        total: getTotalCollected(state),
        waitSec: state.config.intervalSec,
    });
    const hasGrowth = await waitForListingGrowth(previousCount);
    if (!hasGrowth) {
        logAction('warn', '手动点击”查看更多”后无新增，直接进入初筛继续流程');
        const latestState = await getState();
        await runInitialFilter(latestState);
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
    logAction('info', `自动点击"查看更多"，等待 ${waitSec}s 后恢复`);
    await performLoadMoreClick(button, waitSec, 'autoLoadMoreClicked', '自动点击“查看更多商品”后 10 秒内没有新增商品');
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

    const actualMs = jitteredMs(waitSec);

    // 辅助模式：用户在场，无需模拟真人滚动；激进模式才启用反风控滚动
    getState().then(state => {
        const isAggressive = state.config?.collectionMode === COLLECTION_MODES.AGGRESSIVE;
        logAction('info', `下次扫描将在 ${(actualMs / 1000).toFixed(1)}s 后恢复（基准 ${waitSec}s ±30%）${isAggressive ? '，期间模拟真人滚动' : ''}`);

        const scrollInterval = isAggressive ? simulateHumanScrollDuring(actualMs) : null;

        pendingLoadMoreResumeTimer = setTimeout(() => {
            if (scrollInterval) clearInterval(scrollInterval);
            pendingLoadMoreResumeTimer = null;
            mainLock = false;
            main();
        }, actualMs);
    });
}

/**
 * 在指定时间窗口内模拟真人随机上下滚动。
 * 每隔 1.5~3.5s 随机选一次方向和幅度，滚动距离 80~400px。
 * 偶尔（30% 概率）短暂回滚，模拟用户看了一眼又往下的习惯。
 *
 * @param {number} windowMs 总持续时间，到期后调用方负责 clearInterval
 * @returns {number} intervalId，供调用方在 windowMs 到期时清除
 */
function simulateHumanScrollDuring(windowMs) {
    // 首次滚动延迟随机化，不要一点完就立刻动
    const firstDelay = 800 + Math.random() * 1200;
    let totalElapsed = firstDelay;

    const tick = () => {
        if (totalElapsed >= windowMs) return;

        const scrollHeight = document.documentElement.scrollHeight;
        const viewHeight = window.innerHeight;
        const currentY = window.scrollY;
        const maxScroll = scrollHeight - viewHeight;

        // 主方向：偏向向下（70% 向下，30% 向上）
        const goDown = Math.random() < 0.7;
        const distance = Math.round(80 + Math.random() * 320); // 80~400px

        let targetY = goDown
            ? Math.min(currentY + distance, maxScroll)
            : Math.max(currentY - distance, 0);

        // 30% 概率：先小幅反向再继续，模拟"扫了一眼往回看"
        const doGlance = Math.random() < 0.3;
        if (doGlance) {
            const glanceBack = Math.round(40 + Math.random() * 80);
            const glanceY = goDown
                ? Math.max(targetY - glanceBack, 0)
                : Math.min(targetY + glanceBack, maxScroll);
            window.scrollTo({ top: glanceY, behavior: 'smooth' });
            setTimeout(() => {
                window.scrollTo({ top: targetY, behavior: 'smooth' });
            }, 300 + Math.random() * 400);
        } else {
            window.scrollTo({ top: targetY, behavior: 'smooth' });
        }
    };

    // 用 setInterval 定期触发，间隔 1500~3500ms 随机
    const intervalMs = 1500 + Math.random() * 2000;
    setTimeout(tick, firstDelay); // 第一次延迟触发
    const id = setInterval(() => {
        totalElapsed += intervalMs;
        tick();
    }, intervalMs);

    return id;
}

/**
 * 外部触发"一键加载更多"的后端逻辑：复用 `debugPendingLoadMore` 里存好的按钮和
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
    logAction('error', `进入风控暂停：${reason}`, {reason});
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
 * 列表页点击"查看更多"后无新增时的兜底策略：
 *   1) 不直接停在风控态，先从已采集数据里跑 `runInitialFilter` 挑下一条；
 *   2) 如果筛出目标，沿用高亮并自动点击进入详情，继续后续流程；
 *   3) 仅当筛不到目标或不在列表页时，返回 false 让调用方走原风控分支。
 *
 * @param {string} reason
 * @returns {Promise<boolean>} true=已触发列表页兜底继续流程；false=应进入原风控逻辑
 */
async function fallbackToTargetSelectionWhenLoadMoreStalls(reason) {
    // 只在列表页生效；详情页联想区无增长仍按原风控处理。
    if (hasCurrentProductAnchor()) return false;

    const state = await getState();
    if (!state.running) return false;

    debugLog('load-more-stall-fallback-start', {
        reason,
        total: getTotalCollected(state),
        queueLen: state.targetQueue.length,
    });
    showToast('未检测到新增，尝试从已采集中筛选目标继续', 'warn');

    await runInitialFilter(state);

    const refreshed = await getState();
    const nextItem = refreshed.targetQueue?.[0];
    if (!refreshed.running || !nextItem?.goodsId) {
        debugLog('load-more-stall-fallback-no-target', {
            reason,
            running: refreshed.running,
            queueLen: refreshed.targetQueue?.length || 0,
        });
        return false;
    }

    await transitionTo(FSM_STATES.NAVIGATE_TO_DETAIL, {
        phase: 'navigating',
        reason: 'load-more-stall-fallback-click',
    });

    await performAutoClickV1(nextItem);

    notify({
        action: 'navigate',
        goodsId: nextItem.goodsId,
        queueLen: refreshed.targetQueue.length,
    });

    debugLog('load-more-stall-fallback-clicked', {
        reason,
        goodsId: nextItem.goodsId,
    });
    return true;
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
        total: getTotalCollected(state),
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
        logAction('warn', '点击"查看更多"后无新增，直接进入初筛继续流程');
        const state = await getState();
        await runInitialFilter(state);
        return false;
    }

    logAction('info', '点击"查看更多"成功，页面新增商品');
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
 * 利用联想区"每行固定 itemsPerRow 个卡片"的布局，通过已渲染的前两行量出行高，
 * 再推算目标行在文档中的 Y 坐标，返回可直接传给 scrollTo 的 scrollY 值。
 *
 * 原理：
 *   rowHeight  = 第二行第一张卡的 rectTop − 第一行第一张卡的 rectTop
 *   targetDocY = 第一行第一张卡的 docTop + targetRowIndex × rowHeight
 *   scrollY    = targetDocY − viewport × desiredTopRatio
 *
 * @param {number} domIndex       目标卡片在联想区卡片列表中的索引
 * @param {number} desiredTopRatio
 * @param {number} [itemsPerRow=5]
 * @returns {number | null} 目标 scrollY；行高无法计算时返回 null
 */
function estimateRelatedRowScrollY(domIndex, desiredTopRatio, itemsPerRow = 5) {
    const relatedRoot = getRelatedItemsRoot();
    if (!relatedRoot) return null;

    const allCards = findProductCards(relatedRoot);
    if (allCards.length < itemsPerRow + 1) return null;

    // 前两行首张卡必须都已渲染才能量出行高
    const rowACard = allCards[0];
    const rowBCard = allCards[itemsPerRow];
    if (!rowACard || !rowBCard) return null;

    const rectA = rowACard.getBoundingClientRect();
    const rectB = rowBCard.getBoundingClientRect();

    if (rectA.height === 0 || rectB.height === 0) return null;

    const rowHeight = rectB.top - rectA.top;
    if (rowHeight <= 10) return null; // 行高不合理

    const targetRowIndex = Math.floor(domIndex / itemsPerRow);
    const rowADocTop = rectA.top + window.scrollY;
    const targetRowDocTop = rowADocTop + targetRowIndex * rowHeight;
    const scrollY = Math.max(0, targetRowDocTop - Math.round(window.innerHeight * desiredTopRatio));

    logAction('info', '行高计算完成', {
        rowHeight: Math.round(rowHeight),
        targetRowIndex,
        rowADocTop: Math.round(rowADocTop),
        targetRowDocTop: Math.round(targetRowDocTop),
        scrollY: Math.round(scrollY),
    });

    return scrollY;
}

/**
 * 将元素滚动到视口指定锚点位置，处理懒加载场景。执行顺序：
 *
 *   阶段一（仅 related 且有 domIndex）：
 *     通过行高计算精确跳转，等 150ms 检查渲染状态。
 *
 *   阶段二：
 *     高速向下扫描（600px / stepMs），直到元素渲染或到达页面底部。
 *
 * @param {Element} element
 * @param {number} [desiredTopRatio=0.22]
 * @param {number} [stepMs=50]      阶段二每步等待时间（ms）
 * @param {number} [timeoutMs=8000] 阶段二总超时（ms）
 * @param {{source?: string, domIndex?: number} | null} [item=null]
 * @returns {Promise<boolean>}
 */
async function scrollToRenderedAnchor(element, desiredTopRatio = 0.22, stepMs = 50, timeoutMs = 8000, item = null) {
    if (!element) return false;

    // 元素已渲染，直接定位
    const rectNow = element.getBoundingClientRect();
    if (rectNow.width > 0 && rectNow.height > 0) {
        logAction('info', '元素已渲染，直接定位', {
            scrollY: window.scrollY,
            rectTop: Math.round(rectNow.top),
            width: Math.round(rectNow.width),
            height: Math.round(rectNow.height),
        });
        scrollElementToViewportAnchor(element, desiredTopRatio);
        return true;
    }

    // ── 阶段一：行高计算直接跳转（仅 related 且有 domIndex）─────────
    if (item?.source === 'related' && Number.isInteger(item?.domIndex)) {
        const targetScrollY = estimateRelatedRowScrollY(item.domIndex, desiredTopRatio);
        if (targetScrollY !== null) {
            logAction('info', `阶段一：行高定位，跳转至 scrollY=${Math.round(targetScrollY)}`, {
                domIndex: item.domIndex,
                targetScrollY: Math.round(targetScrollY),
            });
            window.scrollTo({top: targetScrollY, behavior: 'auto'});
            await sleep(150);
            const rectAfterJump = element.getBoundingClientRect();
            if (rectAfterJump.width > 0 && rectAfterJump.height > 0) {
                logAction('info', '阶段一：跳转后元素已渲染，执行锚点定位', {
                    scrollY: Math.round(window.scrollY),
                    rectTop: Math.round(rectAfterJump.top),
                });
                scrollElementToViewportAnchor(element, desiredTopRatio);
                return true;
            }
            logAction('info', '阶段一：跳转后仍未渲染，进入阶段二扫描', {
                scrollY: Math.round(window.scrollY),
            });
        } else {
            logAction('info', '阶段一：行高无法计算（前两行未渲染），直接进入阶段二', {
                domIndex: item.domIndex,
                scrollY: Math.round(window.scrollY),
            });
        }
    }

    // ── 阶段二：高速向下扫描 600px / stepMs ──────────────────────────
    logAction('info', '阶段二：开始高速扫描', {
        scrollY: Math.round(window.scrollY),
        pageHeight: document.documentElement.scrollHeight,
    });

    const startedAt = Date.now();
    let step = 0;

    while (Date.now() - startedAt < timeoutMs) {
        const before = window.scrollY;
        window.scrollBy({top: 600, left: 0, behavior: 'auto'});
        await sleep(stepMs);
        step += 1;

        const rect = element.getBoundingClientRect();

        if (step % 20 === 0) {
            logAction('info', `阶段二：第 ${step} 步 scrollY=${Math.round(window.scrollY)} 元素宽=${Math.round(rect.width)} 高=${Math.round(rect.height)}`, {
                step,
                scrollY: Math.round(window.scrollY),
                elapsed: Date.now() - startedAt,
            });
        }

        if (rect.width > 0 && rect.height > 0) {
            logAction('info', `阶段二：第 ${step} 步元素已渲染，执行锚点定位`, {
                step, scrollY: Math.round(window.scrollY), elapsed: Date.now() - startedAt,
            });
            scrollElementToViewportAnchor(element, desiredTopRatio);
            return true;
        }

        if (window.scrollY === before) {
            logAction('warn', `阶段二：已到页面底部仍未渲染，跳回顶部进入阶段三（水合扫描）`, {
                step, scrollY: Math.round(window.scrollY), elapsed: Date.now() - startedAt,
            });
            break;
        }
    }

    // ── 阶段三：跳顶 + 逐行水合扫描（慢速，给 Temu 每行渲染时间）───
    window.scrollTo({top: 0, behavior: 'auto'});
    await sleep(300);

    logAction('info', '阶段三：从顶部开始水合扫描', {
        scrollY: Math.round(window.scrollY),
        pageHeight: document.documentElement.scrollHeight,
    });

    const phase3StartedAt = Date.now();
    const PHASE3_TIMEOUT_MS = 800000;
    const PHASE3_STEP_PX = 400;
    const PHASE3_STEP_MS = 300;
    let step3 = 0;

    while (Date.now() - phase3StartedAt < PHASE3_TIMEOUT_MS) {
        const before3 = window.scrollY;
        window.scrollBy({top: PHASE3_STEP_PX, left: 0, behavior: 'auto'});
        await sleep(PHASE3_STEP_MS);
        step3 += 1;

        const rect = element.getBoundingClientRect();

        if (step3 % 10 === 0) {
            logAction('info', `阶段三：第 ${step3} 步 scrollY=${Math.round(window.scrollY)} 元素高=${Math.round(rect.height)}`, {
                step: step3, scrollY: Math.round(window.scrollY), elapsed: Date.now() - phase3StartedAt,
            });
        }

        if (rect.width > 0 && rect.height > 0) {
            logAction('info', `阶段三：第 ${step3} 步元素已渲染，执行锚点定位`, {
                step: step3, scrollY: Math.round(window.scrollY), elapsed: Date.now() - phase3StartedAt,
            });
            scrollElementToViewportAnchor(element, desiredTopRatio);
            return true;
        }

        if (window.scrollY === before3) {
            logAction('warn', '阶段三：已到页面底部仍未渲染，放弃', {
                step: step3, elapsed: Date.now() - phase3StartedAt,
            });
            break;
        }
    }

    logAction('error', `scrollToRenderedAnchor 全部阶段结束，元素未渲染`, {
        phase2Steps: step, phase3Steps: step3,
        totalElapsed: Date.now() - startedAt,
    });
    return false;
}

function scrollElementToViewportAnchor(element, desiredTopRatio = 0.22) {
    if (!element) return;

    element.scrollIntoView({behavior: 'auto', block: 'start'});

    const rect = element.getBoundingClientRect();

    // 宽高为 0 说明元素尚未渲染（懒加载未完成），跳过校正避免错误滚动
    if (rect.width === 0 && rect.height === 0) return;

    const viewport = window.innerHeight || 800;
    const desiredTop = viewport * desiredTopRatio;
    const delta = rect.top - desiredTop;

    if (Math.abs(delta) >= 2) {
        // 防止 scrollY + delta < 0（页面顶部附近时无法再往上滚）
        const newScrollY = window.scrollY + delta;
        if (newScrollY < 0) {
            window.scrollTo({top: 0, behavior: 'auto'});
        } else {
            window.scrollBy({top: delta, behavior: 'auto'});
        }
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
    .temu-scraper-pending-target img {
      filter: saturate(1.12) brightness(1.03);
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
 * 清掉"查看更多"按钮高亮 + 取消延时 resume + 清空 pending 按钮记录。
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
 * 再复用同一套 `extractSales/Star/Price/Reviews` 规则。完整字段会通过上传队列同步到后端。
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

    const salesText = unique.find((text) => /已售/.test(text)) || '';
    const stars = extractStar(unique);
    return {
        fullTitle: title,
        price: extractPrice(unique),
        sales: extractSales(salesText),
        stars,
        reviews: extractReviews(unique, stars, extractSales(salesText)),
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
 * 贯穿整个抓取链路，字段入库或参与筛选前都需要走一遍以获得稳定格式。
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
/**
 * 从名称中提取 2-gram 字符集合，用于多样性重叠计算。
 * 例："人造吊花" → Set{"人造", "造吊", "吊花"}
 * @param {string} name
 * @returns {Set<string>}
 */
function extractNameBigrams(name) {
    // 只保留 CJK 汉字，过滤数字/字母/符号，避免噪声 bigram 拉低辨别力
    const s = (name || '').replace(/[^一-鿿]/g, '');
    const grams = new Set();
    for (let i = 0; i < s.length - 1; i++) {
        grams.add(s.slice(i, i + 2));
    }
    return grams;
}

/**
 * 计算候选名称与最近处理窗口的 2-gram 重叠数。
 * @param {string} name
 * @param {Set<string>} recentBigrams
 * @returns {number}
 */
function calcOverlap(name, recentBigrams) {
    if (!recentBigrams.size) return 0;
    const nameBigrams = extractNameBigrams(name);
    if (!nameBigrams.size) return 0;
    let count = 0;
    for (const gram of nameBigrams) {
        if (recentBigrams.has(gram)) count++;
    }
    // 返回比例（0.0 ~ 1.0），而非绝对数，避免长名称因字多而被误杀
    return count / nameBigrams.size;
}

function selectPriorityItems(items, limit = 1, recentNames = []) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const filteredItems = items.filter(
        (item) => !hasExcludedTitleKeyword(item) && !hasExcludedBadgeKeyword(item)
    );
    const candidateItems = filteredItems.length > 0 ? filteredItems : items;

    // 构建最近处理名称的 2-gram 合并集合
    const recentBigrams = new Set();
    for (const n of recentNames) {
        for (const gram of extractNameBigrams(n)) recentBigrams.add(gram);
    }

    // 按多样性分组：低重叠（优先）vs 高重叠（降权）
    const diverse = [];
    const penalized = [];
    for (const item of candidateItems) {
        const name = item.name || item.fullTitle || '';
        const overlap = calcOverlap(name, recentBigrams);
        if (overlap >= DIVERSITY_OVERLAP_THRESHOLD) {
            penalized.push({item, overlap});
        } else {
            diverse.push({item, overlap});
        }
    }

    const hasDiversity = recentNames.length > 0;
    logAction('info', `[selectPriorityItems] 候选 ${candidateItems.length} 条，低重叠(优先)=${diverse.length}，高重叠(降权)=${penalized.length}，recentWindow=${recentNames.length}`, {
        total: candidateItems.length,
        diverseCount: diverse.length,
        penalizedCount: penalized.length,
        recentWindowSize: recentNames.length,
        recentNames: recentNames.slice(-3), // 只打最近 3 条避免日志过长
        threshold: DIVERSITY_OVERLAP_THRESHOLD,
    });

    // 排序函数：无评分优先（销量降序），其次全量（销量降序+评价升序）
    const sortedPool = (pool) => {
        const poolItems = pool.map((e) => e.item);
        const noStar = poolItems.filter((item) => !normalizeStar(item.starRating)).sort(compareBySalesDesc);
        const hasStar = poolItems.filter((item) => normalizeStar(item.starRating)).sort(compareBySalesDescThenReviewsAsc);
        return [...noStar, ...hasStar];
    };

    // limit=1（激进模式）：保持原逻辑，低重叠组优先，为空才降级
    // limit>1（辅助模式）：低重叠排前，高重叠排后，合并返回 limit 条
    if (limit === 1) {
        if (diverse.length > 0) {
            const result = sortedPool(diverse).slice(0, 1);
            if (result.length > 0) {
                const chosen = result[0];
                const overlap = calcOverlap(chosen.name || chosen.fullTitle || '', recentBigrams);
                logAction('info', `[selectPriorityItems] 命中低重叠组：goodsId=${chosen.goodsId} 名称="${(chosen.name || chosen.fullTitle || '').slice(0, 20)}" overlap=${overlap}`, {goodsId: chosen.goodsId, overlap, group: 'diverse'});
                return result;
            }
        }
        if (penalized.length > 0) {
            const result = sortedPool(penalized).slice(0, 1);
            if (result.length > 0) {
                const chosen = result[0];
                const overlap = calcOverlap(chosen.name || chosen.fullTitle || '', recentBigrams);
                logAction('warn', `[selectPriorityItems] 低重叠组为空，降级使用高重叠组：goodsId=${chosen.goodsId} 名称="${(chosen.name || chosen.fullTitle || '').slice(0, 20)}" overlap=${overlap}`, {goodsId: chosen.goodsId, overlap, group: 'penalized'});
                return result;
            }
        }
        return [];
    }

    // limit > 1：低重叠在前，高重叠在后，合并取 limit 条
    const combined = [...sortedPool(diverse), ...sortedPool(penalized)].slice(0, limit);
    if (combined.length > 0) {
        logAction('info', `[selectPriorityItems] 多候选模式：低重叠 ${diverse.length} 条 + 高重叠 ${penalized.length} 条 → 返回 ${combined.length} 条`, {
            total: combined.length, diverseCount: diverse.length, penalizedCount: penalized.length,
        });
    }
    return combined;
}

/**
 * 判断商品标题里是否含有"排除词"。词列表由 `excludedTitleKeywords` 提供，
 * 启动时从后端 GET /api/config/exclusion-keywords 拉取，拉取失败则回退到本地兜底。
 * 命中即在 `selectPriorityItems` 里被过滤掉，除非所有候选都被筛掉（此时回退不过滤）。
 * @param {{fullTitle?: string, name?: string}} item
 * @returns {boolean}
 */
function hasExcludedTitleKeyword(item) {
    const title = normalizeText(item?.fullTitle || item?.name || '');
    if (!title) return false;
    return excludedTitleKeywords.some((keyword) => title.includes(keyword));
}

/**
 * 排查卡片文案是否含"本地仓"徽章 —— 本地仓商品通常是已适配的库存，不是我们关注的主力选品，
 * 因此在 `selectPriorityItems` 里把它过滤掉。
 * @param {{name?: string, fullTitle?: string, rawText?: string}} item
 * @returns {boolean}
 */
function hasExcludedBadgeKeyword(item) {
    if (item?.hasLocalWarehouse) return true;
    const haystack = normalizeText([
        item?.name,
        item?.fullTitle,
        item?.rawText,
    ].filter(Boolean).join(' '));

    if (!haystack) return false;
    return haystack.includes('本地仓');
}

/**
 * 从给定卡片列表中移除含"本地仓"文案的节点。两种流的删除节点层级不同：
 *   - 列表主区（removeParent=false）：findProductCards 找到的即是网格子项，直接删；
 *   - 详情联想区（removeParent=true）：卡片外还有一层包装容器，需删 parentElement。
 *
 * @param {Element[]} cards
 * @param {boolean} removeParent 是否删除卡片的父节点
 * @returns {number} 移除数量
 */
function removeLocalWarehouseFromCards(cards, removeParent) {
    console.log('removeLocalWarehouseFromCards is {},removeParent is {}', cards, removeParent);
    let removed = 0;
    for (const card of cards) {
        const text = normalizeText(card?.innerText || card?.textContent || '');
        if (!text.includes('本地仓')) continue;
        const nodeToRemove = card.parentElement.parentElement.parentElement;
        console.log('removeParent true card is {}', nodeToRemove);
        nodeToRemove.remove();
        removed += 1;
    }
    if (removed > 0) {
        debugLog('remove-local-warehouse-cards', {removed});
        triggerRelayout();
    }
    return removed;
}

/**
 * 遍历所有商品流，调用各流自己的 removeLocalWarehouse 策略。
 * 供消息处理器（applyLocalWarehouseFilter）主动触发时使用。
 *
 * @returns {number} 总移除数量
 */
function removeLocalWarehouseProductCards() {
    return enumerateProductStreams().reduce((total, stream) => {
        return total + stream.removeLocalWarehouse();
    }, 0);
}

/**
 * 按商品列表容器的直接子元素删除本地仓商品。
 *
 * @returns {number}
 */
function removeLocalWarehouseGridItems() {
    const grid = document.querySelector('#main_scale > div.baseContent > div > div:nth-child(2) > div._3b5Mfoua.js-goods-list > div._29dBm1gx.autoFitGoodsList');
    if (!grid) return 0;

    let removed = 0;
    Array.from(grid.children).forEach((item) => {
        const text = normalizeText(item?.innerText || item?.textContent || '');
        if (!text.includes('本地仓')) return;
        item.remove();
        removed += 1;
    });

    return removed;
}

/**
 * 删除商品 DOM 节点后，触发 Temu 商品列表重新计算布局。
 * resize + scroll + 微量滚动三连发，强制 Temu 重绘网格。
 *
 * @returns {void}
 */
function triggerRelayout() {
    requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
        document.dispatchEvent(new Event('scroll'));
        try {
            window.scrollBy({top: 1, behavior: 'auto'});
            window.scrollBy({top: -1, behavior: 'auto'});
        } catch (_) {
        }
    });
}

/**
 * 当前页面商品流 DOM 过多时，按选品优先级保留更可能后续点击的商品，删除低优先级元素。
 * 会同时覆盖列表主流与详情页联想流；列表页优先删除主网格的外层 item，详情页则删除对应商品卡节点。
 * 删除掉的 goodsId 会写入 processedIds，避免后续从 collected 中重新选到一个已被删 DOM 的商品。
 *
 * @param {ReturnType<typeof defaultState>} state
 * @returns {Promise<{removed: number, removedGoodsIds: string[]}>}
 */
async function pruneProductDomIfNeeded(state) {
    const entriesByGoodsId = new Map();

    // 1) 主列表优先用网格直接子元素，保证删除的是用户指定的"更外层"节点。
    const mainGrid = document.querySelector('#main_scale > div.baseContent > div > div:nth-child(2) > div._3b5Mfoua.js-goods-list > div._29dBm1gx.autoFitGoodsList');
    if (mainGrid) {
        Array.from(mainGrid.children).forEach((node, domIndex) => {
            const card = findProductCards(node)[0] || node;
            const item = extractItemFromCard(card, 'listing');
            if (!item?.goodsId) return;
            entriesByGoodsId.set(item.goodsId, {
                node,
                item: {...item, domIndex, sourceTag: 'listing'},
            });
        });
    }

    // 2) 补齐所有商品流（含详情页 related）；仅在主网格没有该 goodsId 时使用卡片节点。
    // related 流：findProductCards 找到的是内层内容节点，#goodsRecommend 外层还有一个包装 div，
    // 删除时需移除包装层，否则留下空壳占位。
    const streams = enumerateProductStreams();
    streams.forEach((stream) => {
        const cards = stream.getCards();
        cards.forEach((card, domIndex) => {
            const item = extractItemFromCard(card, stream.sourceTag);
            if (!item?.goodsId || entriesByGoodsId.has(item.goodsId)) return;
            const nodeToRemove = stream.id === 'related' ? (card.parentElement.parentElement.parentElement || card) : card;
            entriesByGoodsId.set(item.goodsId, {
                node: nodeToRemove,
                item: {...item, domIndex, sourceTag: stream.sourceTag},
            });
        });
    });

    const entries = Array.from(entriesByGoodsId.values())
        .filter((entry) => entry?.node?.isConnected && entry?.item?.goodsId);

    if (entries.length <= DOM_PRUNE_CARD_THRESHOLD) {
        return {removed: 0, removedGoodsIds: []};
    }

    const protectedIds = new Set((state.targetQueue || []).map((item) => item.goodsId).filter(Boolean));
    const keepIds = new Set(
        rankItemsForDomPrune(entries.map((entry) => entry.item))
            .slice(0, DOM_PRUNE_KEEP_COUNT)
            .map((item) => item.goodsId)
    );
    protectedIds.forEach((goodsId) => keepIds.add(goodsId));

    const removedGoodsIds = [];
    for (const entry of entries) {
        if (keepIds.has(entry.item.goodsId)) continue;
        entry.node.remove();
        removedGoodsIds.push(entry.item.goodsId);
    }

    if (!removedGoodsIds.length) {
        return {removed: 0, removedGoodsIds: []};
    }

    const processedIds = new Set([...(state.processedIds || []), ...removedGoodsIds]);
    await patchState({processedIds: Array.from(processedIds)});

    triggerRelayout();

    return {
        removed: removedGoodsIds.length,
        removedGoodsIds,
    };
}

/**
 * DOM 裁剪排序：非排除词 > 排除词；无评分新品优先；销量高优先；有评分时评价少优先。
 *
 * @param {Array<{goodsId?: string, starRating?: string, sales?: string, detailSales?: string, reviewCount?: number}>} items
 * @returns {Array}
 */
function rankItemsForDomPrune(items) {
    return [...items].sort((a, b) => {
        const excludedA = hasExcludedTitleKeyword(a) || hasExcludedBadgeKeyword(a);
        const excludedB = hasExcludedTitleKeyword(b) || hasExcludedBadgeKeyword(b);
        if (excludedA !== excludedB) return excludedA ? 1 : -1;

        const hasStarA = Boolean(normalizeStar(a.starRating));
        const hasStarB = Boolean(normalizeStar(b.starRating));
        if (hasStarA !== hasStarB) return hasStarA ? 1 : -1;

        const salesDelta = getSalesNum(b) - getSalesNum(a);
        if (salesDelta !== 0) return salesDelta;

        return parseReviewNum(a.reviewCount) - parseReviewNum(b.reviewCount);
    });
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
 * 只保留采集流程后续筛选/点击需要的轻量字段。完整商品数据已经走上传队列发给后端，
 * 不再把 rawHtml/rawText 这类大字段长期保存到插件本地状态。
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function compactCollectedItemForWorkflow(item) {
    const textForBadge = normalizeText([
        item?.name,
        item?.fullTitle,
        item?.rawText,
    ].filter(Boolean).join(' '));
    return {
        goodsId: item.goodsId,
        name: item.name || '',
        fullTitle: item.fullTitle || '',
        link: item.link || '',
        price: item.price || '',
        detailPrice: item.detailPrice || '',
        sales: item.sales || '',
        detailSales: item.detailSales || '',
        salesNum: item.salesNum || parseSalesNum(item.sales || item.detailSales || ''),
        starRating: item.starRating || '',
        detailStars: item.detailStars || '',
        reviewCount: item.reviewCount || '',
        detailReviews: item.detailReviews || '',
        listingTime: item.listingTime || '',
        source: item.source || '',
        sourceRootId: item.sourceRootId || '',
        domIndex: item.domIndex,
        detailScraped: Boolean(item.detailScraped),
        scrapedAt: item.scrapedAt || '',
        detailAt: item.detailAt || '',
        hasLocalWarehouse: item.hasLocalWarehouse || textForBadge.includes('本地仓'),
    };
}

/**
 * 把一批新抓到的商品合并进流程用的 `state.collected`：
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
    // seenIds 包含"已上传清空"的历史 goodsId，用于跳过已见商品的全局去重
    const seenIds = new Set(state.seenGoodsIds || []);
    let inserted = 0;
    let skippedBySeen = 0;
    let mergedCount = 0;
    const newItems = [];    // 第三类：真正新增，进上传队列
    const mergedNames = []; // 第一类：byId 合并（已在 collected 里）
    const skippedNames = [];// 第二类：seenIds 跳过（历史已上传）

    for (const item of items) {
        if (!item.goodsId) continue;
        const alreadySeen = seenIds.has(item.goodsId);
        const prev = byId.get(item.goodsId);

        // 第二类：seenIds 命中且不在当前 collected → 历史已上传，直接跳过
        if (alreadySeen && !prev) {
            skippedBySeen += 1;
            skippedNames.push({goodsId: item.goodsId, name: item.name || item.fullTitle || ''});
            continue;
        }

        const merged = {
            ...prev,
            ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== '' && value !== undefined)),
        };

        if (!prev && !alreadySeen) {
            // 第三类：全新商品
            inserted += 1;
            if (!merged.scrapedAt) merged.scrapedAt = nowText();
            newItems.push(item);
        } else {
            // 第一类：已在 collected 里，只做字段合并
            mergedCount += 1;
            mergedNames.push({goodsId: item.goodsId, name: item.name || item.fullTitle || ''});
        }

        if (!merged.salesNum) merged.salesNum = parseSalesNum(merged.sales || merged.detailSales || '');
        byId.set(item.goodsId, compactCollectedItemForWorkflow(merged));
    }

    const collected = Array.from(byId.values());
    const newTotal = getTotalCollected({...state, collected});
    logAction('info', `[upsertItems] 新增=${inserted} 合并=${mergedCount} 历史跳过=${skippedBySeen} | collected=${collected.length} 累计=${newTotal}`, {
        inserted,
        mergedCount,
        skippedBySeen,
        collectedNow: collected.length,
        totalCollected: newTotal,
        seenGoodsIdsSize: seenIds.size,
    });
    if (mergedCount > 0) {
        logAction('info', `[upsertItems] 第一类（byId合并）完整列表 ${mergedCount} 条`, {
            items: mergedNames.map(({goodsId, name}) => `${goodsId} | ${name}`),
        });
    }
    if (skippedBySeen > 0) {
        logAction('info', `[upsertItems] 第二类（历史跳过）完整列表 ${skippedBySeen} 条`, {
            items: skippedNames.map(({goodsId, name}) => `${goodsId} | ${name}`),
        });
    }
    await patchState({
        collected,
        stats: {
            listingTotal: newTotal,
        },
    });
    // 只上传本次真正新增的条目，跳过已入库的历史商品
    if (newItems.length > 0) {
        await enqueueUploadItems(newItems, getNormalizedPageType());
    }
    return inserted;
}

/**
 * 把一批商品推进"待上传"队列，并立刻强制同步到后端：
 *   - 只保留有 goodsId 的条目；
 *   - 字段名 camelCase → snake_case，对齐后端入库 schema；
 *   - 详情页字段 (`detailPrice`/`detailSales` 等) 优先，列表字段兜底；
 *   - 成功后 `uploadPendingBatch(true)` 会清掉本地待上传队列，避免插件本地长期保存完整商品数据。
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

    await uploadPendingBatch(true);
}

/**
 * 把一批"关联边"推进待上传队列。边用于 Graph 模式记录商品之间的跳转关系
 * （如"看了又看"/"相关推荐"），推完队列同样立刻同步到后端。
 * @param {Array<Record<string, unknown>>} edges
 * @returns {Promise<void>}
 */
async function enqueueUploadEdges(edges) {
    if (!edges.length) return;
    const state = await getState();
    await patchState({
        pendingUploadEdges: [...(state.pendingUploadEdges || []), ...edges],
    });
    await uploadPendingBatch(true);
}

/**
 * 批量上传队列落盘 → 后端。关键点：
 *   - `uploadInFlight` 作为内存互斥，避免多次触发并发上传；
 *   - 非强制模式下只有 items 达到 `UPLOAD_BATCH_SIZE` 才会发；采集入口现在默认用强制模式直接同步；
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
        // 上传成功后只更新 seenGoodsIds（后续去重用），collected 保持不动。
        // collected 会在导航跳转前由 clearCollectedBeforeNavigation() 统一清理，
        // 这样 runInitialFilter 在导航前仍能从 collected 里挑选目标。
        const uploadedIds = new Set(batchItems.map((i) => i.goods_id).filter(Boolean));
        const existingSeenSet = new Set(latest.seenGoodsIds || []);
        const newSeenGoodsIds = [
            ...(latest.seenGoodsIds || []),
            ...Array.from(uploadedIds).filter((id) => !existingSeenSet.has(id)),
        ];
        logAction('info', `[uploadPendingBatch] 上传成功：本批 ${batchItems.length} 条，seenGoodsIds=${newSeenGoodsIds.length}（collected 保留至导航前清理）`, {
            batchSize: batchItems.length,
            collectedNow: (latest.collected || []).length,
            seenGoodsIdsSize: newSeenGoodsIds.length,
        });
        await patchState({
            pendingUploadItems: (latest.pendingUploadItems || []).slice(batchItems.length),
            pendingUploadEdges: (latest.pendingUploadEdges || []).slice(batchEdges.length),
            seenGoodsIds: newSeenGoodsIds,
        });
    } else {
        logAction('warn', `[uploadPendingBatch] 上传失败，本批 ${batchItems.length} 条保留待重传`, {
            batchSize: batchItems.length,
            response,
        });
    }

    uploadInFlight = false;
    return Boolean(response?.ok);
}

/**
 * 导航跳转前清理 collected：
 *   - 把 collected.length 累加到 totalCollected，保持计数连续；
 *   - 把所有 goodsId 补入 seenGoodsIds（防止未上传完的条目漏掉去重）；
 *   - 清空 collected。
 * 应在 window.open 之前 await，确保新页面的内容脚本读到的是干净状态。
 */
async function clearCollectedBeforeNavigation() {
    const state = await getState();
    const count = state.collected?.length || 0;
    if (count === 0) return;

    const existingSeenSet = new Set(state.seenGoodsIds || []);
    const newSeenGoodsIds = [
        ...(state.seenGoodsIds || []),
        ...(state.collected || []).map((c) => c.goodsId).filter((id) => id && !existingSeenSet.has(id)),
    ];
    const newTotalCollected = (state.totalCollected || 0) + count;

    logAction('info', `[nav] 导航前清理 collected ${count} 条，totalCollected: ${state.totalCollected || 0} → ${newTotalCollected}，seenGoodsIds=${newSeenGoodsIds.length}`, {
        cleared: count,
        totalCollectedBefore: state.totalCollected || 0,
        totalCollectedAfter: newTotalCollected,
        seenGoodsIdsSize: newSeenGoodsIds.length,
    });

    await patchState({
        collected: [],
        totalCollected: newTotalCollected,
        seenGoodsIds: newSeenGoodsIds,
    });
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
 *   - setConfig：popup 改配置时写回 state；
 *   - triggerLoadMoreNow：popup 手动点"立即点击查看更多"按钮的入口；
 *   - setWorkflowState：外部强制迁移 FSM（排障用）；
 *   - applyLocalWarehouseFilter：立即应用本地仓商品过滤；
 *   - clickOneClickListing：独立上架流程，主动点击当前详情页的"一键上架"；
 *   - clearAll：清空 state。
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
            const isAggressive = state.config.collectionMode === COLLECTION_MODES.AGGRESSIVE;
            state.config.autoClickLoadMore = isAggressive;
            state.config.autoClickV1 = isAggressive;
            // 启动时始终把当前 URL 记为最近一次发现流来源，兼容老字段 listingUrl。
            state.lastDiscoveryUrl = location.href;
            state.listingUrl = location.href;
            state.runUuid = runResponse?.ok ? (runResponse.run_uuid || '') : '';
            initTrace(state.runUuid || `local_${Date.now()}`);
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
            const latest = await getState();
            await finishBackendRun('stopped', getTotalCollected(latest));
            await flushAndUploadTrace(latest.runUuid || _traceRunId);
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
                total: getTotalCollected(state),
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
            const isAggressive = nextConfig.collectionMode === COLLECTION_MODES.AGGRESSIVE;
            nextConfig.autoClickLoadMore = isAggressive;
            nextConfig.autoClickV1 = isAggressive;
            await patchState({config: nextConfig});
            const nextState = await getState();
            if (
                nextState.running
                && nextState.phase === 'navigating'
                && nextConfig.autoClickV1
                && Array.isArray(nextState.targetQueue)
                && nextState.targetQueue.length > 0
            ) {
                await highlightPendingItem(nextState.targetQueue[0], '待处理目标，点击后进入下一商品');
            }
            notifyState(await getState());
            sendResponse({ok: true, config: nextConfig});
        })();
        return true;
    }

    if (message.action === 'setLogVisible') {
        timelineVisible = Boolean(message.visible);
        const host = document.getElementById('temu-timeline-host');
        if (host) host.style.display = timelineVisible ? '' : 'none';
        sendResponse({ok: true});
        return true;
    }

    // 辅助模式：上一个/下一个候选商品
    if (message.action === 'prevTarget' || message.action === 'nextTarget') {
        (async () => {
            const state = await getState();
            const queue = state.targetQueue || [];
            if (queue.length === 0) { sendResponse({ok: false}); return; }
            const delta = message.action === 'nextTarget' ? 1 : -1;
            const newIndex = Math.max(0, Math.min(queue.length - 1, (state.targetQueueIndex || 0) + delta));
            await patchState({targetQueueIndex: newIndex});
            clearPendingAutoClick();
            await highlightPendingItem(queue[newIndex], '初筛命中，点击后进入下一商品');
            notify({action: 'candidatesReady', index: newIndex, total: queue.length, isConservative: true});
            sendResponse({ok: true, index: newIndex, total: queue.length});
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

    if (message.action === 'applyLocalWarehouseFilter') {
        (async () => {
            await patchState({
                config: {
                    removeLocalWarehouse: Boolean(message.enabled),
                },
            });
            const removed = message.enabled ? removeLocalWarehouseProductCards() : 0;
            notifyState(await getState());
            sendResponse({ok: true, removed});
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

    if (message.action === 'clickOneClickListing') {
        clickOneClickListingButton().then(sendResponse);
        return true;
    }

    if (message.action === 'clearAll') {
        clearPendingAutoClick();
        chrome.storage.local.remove([STORE_KEY], () => {
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
