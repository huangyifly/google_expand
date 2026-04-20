/**
 * popup.js - 扩展弹窗 UI 的胶水层。
 *   - 与 background.js 建立 port 连接，接收 content.js 的进度推送并更新 UI；
 *   - 把按钮点击翻译成 runtime 消息（start/stop/getData/clearAll/setConfig）发给 background；
 *   - 导出 CSV / 清空本地数据 / 控制调试面板显隐。
 * 三组顶层数据：PHASES（阶段颜色文案）、WORKFLOW_LABELS（FSM 状态名映射）、
 * COLLECTION_MODE_LABELS / TASK_MODE_LABELS（采集/任务模式中文名）。
 */

// DOM 引用：phase 展示、顶部状态条
const phaseDot = document.getElementById('phaseDot');
const phaseText = document.getElementById('phaseText');
const phaseDesc = document.getElementById('phaseDesc');
const statusMsg = document.getElementById('statusMsg');
const btnMain = document.getElementById('btnMain');
const btnExport = document.getElementById('btnExport');
const btnClear = document.getElementById('btnClear');

const sTotal = document.getElementById('sTotal');
const sDetail = document.getElementById('sDetail');
const sRelated = document.getElementById('sRelated');
const sQueue = document.getElementById('sQueue');
const workflowCurrent = document.getElementById('workflowCurrent');
const workflowModePill = document.getElementById('workflowModePill');
const taskModePill = document.getElementById('taskModePill');

const cfgCollectionMode = document.getElementById('cfgCollectionMode');
const cfgTaskMode = document.getElementById('cfgTaskMode');
const cfgInterval = document.getElementById('cfgInterval');
const cfgBatch = document.getElementById('cfgBatch');
const cfgLimit = document.getElementById('cfgLimit');
const cfgAutoClick = document.getElementById('cfgAutoClick');
const cfgAutoLoadMore = document.getElementById('cfgAutoLoadMore');
const cfgDebugPanel = document.getElementById('cfgDebugPanel');

let isRunning = false;

const PHASES = {
  idle: { dot: 'idle', text: '空闲', desc: '尚未开始' },
  listing: { dot: 'listing', text: '商品发现', desc: '采集当前商品流并继续加载' },
  filtering: { dot: 'filtering', text: '目标筛选', desc: '筛选高优先级商品并生成队列' },
  navigating: { dot: 'navigating', text: '等待操作', desc: '已高亮目标商品，等待继续' },
  detail: { dot: 'detail', text: '商品增强', desc: '补齐当前商品的更多信息' },
  related: { dot: 'related', text: '关联扩展', desc: '扫描并提取关联商品' },
  wind: { dot: 'filtering', text: '风控暂停', desc: '等待人工介入后恢复' },
  done: { dot: 'done', text: '已完成', desc: '采集任务已结束，可导出 CSV' },
};

const WORKFLOW_LABELS = {
  LIST_DISCOVERY: 'LIST_DISCOVERY',
  TARGET_SELECTED: 'TARGET_SELECTED',
  NAVIGATE_TO_DETAIL: 'NAVIGATE_TO_DETAIL',
  DETAIL_SCRAPE: 'DETAIL_SCRAPE',
  RELATED_SCAN: 'RELATED_SCAN',
  EDGE_COLLECT: 'EDGE_COLLECT',
  PAUSE: 'PAUSE',
  WIND_CONTROL: 'WIND_CONTROL',
};

const COLLECTION_MODE_LABELS = {
  CONSERVATIVE: '保守辅助模式',
  AGGRESSIVE: '激进自动模式',
};

const TASK_MODE_LABELS = {
  DISCOVERY: 'Discovery Mode',
  HARVEST: 'Harvest Mode',
  GRAPH: 'Graph Mode',
};

/**
 * 更新当前阶段展示。查 PHASES 表，拿到小圆点颜色类名 + 主文案 + 默认描述，
 * 调用方可以覆写描述（比如 listing 阶段带上实时进度数字）。
 * @param {keyof typeof PHASES} phase
 * @param {string} [desc] 可选的覆写描述
 */
function setPhase(phase, desc) {
  const meta = PHASES[phase] || PHASES.idle;
  phaseDot.className = `phase-dot ${meta.dot}`;
  phaseText.textContent = meta.text;
  phaseDesc.textContent = desc || meta.desc;
}

/**
 * 顶部状态消息区。type 直接当成 CSS class 用（空/'ok'/'err'）控制颜色。
 * @param {string} text
 * @param {'' | 'ok' | 'err'} [type]
 */
function setStatus(text, type = '') {
  statusMsg.textContent = text;
  statusMsg.className = type;
}

/**
 * 按"正在运行"/"已停止"两套 UI 切换：主按钮文字、配置项 disable 状态。
 * 调试面板开关故意始终保持 enable —— 运行中也允许临时打开/关闭右下角面板用于排障。
 * @param {boolean} running
 */
function setRunningUI(running) {
  isRunning = running;
  btnMain.textContent = running ? '停止采集' : '开始采集';
  btnMain.classList.toggle('running', running);
  [cfgCollectionMode, cfgTaskMode, cfgInterval, cfgBatch, cfgLimit, cfgAutoClick, cfgAutoLoadMore]
    .filter(Boolean)
    .forEach((input) => {
    input.disabled = running;
  });
  cfgDebugPanel.disabled = false;
}

/**
 * 把 state 里的计数字段刷到 UI 卡片。每个字段都做存在性判断，避免"只传了部分字段的增量更新"
 * 把其他数字清成 undefined。
 * @param {{total?: number, queueLen?: number, stats?: {detailDone?: number, relatedAdded?: number}}} [payload]
 */
function updateStats(payload = {}) {
  if (payload.total !== undefined) sTotal.textContent = String(payload.total);
  if (payload.queueLen !== undefined) sQueue.textContent = String(payload.queueLen);
  if (payload.stats?.detailDone !== undefined) sDetail.textContent = String(payload.stats.detailDone);
  if (payload.stats?.relatedAdded !== undefined) sRelated.textContent = String(payload.stats.relatedAdded);
}

/**
 * 把 state.config 回填到各个输入控件。用于 popup 首次打开、切换 run 之后的恢复。
 * showDebugPanel 字段缺省当 true 处理（默认开启调试面板）。
 * @param {Record<string, unknown>} [config]
 */
function fillConfig(config = {}) {
  if (cfgCollectionMode && config.collectionMode !== undefined) cfgCollectionMode.value = config.collectionMode;
  if (cfgTaskMode && config.taskMode !== undefined) cfgTaskMode.value = config.taskMode;
  if (config.intervalSec !== undefined) cfgInterval.value = config.intervalSec;
  if (config.batchSize !== undefined) cfgBatch.value = config.batchSize;
  if (config.totalLimit !== undefined) cfgLimit.value = config.totalLimit;
  if (cfgAutoClick) cfgAutoClick.checked = Boolean(config.autoClickV1);
  if (cfgAutoLoadMore) cfgAutoLoadMore.checked = Boolean(config.autoClickLoadMore);
  cfgDebugPanel.checked = config.showDebugPanel !== false;
}

/**
 * 刷新底部 workflow 区：当前 FSM 状态名、采集模式徽标、任务模式徽标。
 * 参数允许是增量 payload（stateSync 推过来的），config 取不到就回退读当前 DOM 值。
 * @param {{workflowState?: string, config?: {collectionMode?: string, taskMode?: string}}} [payload]
 */
function renderWorkflow(payload = {}) {
  const workflowState = payload.workflowState || 'LIST_DISCOVERY';
  const collectionMode = payload.config?.collectionMode || cfgCollectionMode?.value || 'CONSERVATIVE';
  const taskMode = payload.config?.taskMode || cfgTaskMode?.value || 'DISCOVERY';
  workflowCurrent.textContent = WORKFLOW_LABELS[workflowState] || workflowState;
  workflowModePill.textContent = COLLECTION_MODE_LABELS[collectionMode] || collectionMode;
  taskModePill.textContent = TASK_MODE_LABELS[taskMode] || taskMode;
}

/**
 * 统一封装的消息发送：runtime.sendMessage → background.js（controlActions 分支）→ 当前 Temu 标签页。
 *   - 若 chrome.runtime.lastError 存在：把错误直接展示在 UI 的顶部状态条；
 *   - 若调用方没传 callback 且响应里带 error：也把 error 文本渲染到状态条；
 *   - 传了 callback：把响应原样交给 callback，由调用方决定下一步。
 * @param {string} action
 * @param {Record<string, unknown>} [extra]
 * @param {(response: any) => void} [callback]
 */
function sendToContent(action, extra = {}, callback) {
  chrome.runtime.sendMessage({ action, ...extra }, (response) => {
    if (chrome.runtime.lastError) {
      const message = chrome.runtime.lastError.message || '扩展通信失败，请重试。';
      setStatus(message, 'err');
      if (callback) callback({ ok: false, error: message });
      return;
    }
    if (!callback && response?.error) {
      setStatus(response.error, 'err');
    }
    if (callback) callback(response);
  });
}

/**
 * 首次打开 popup / 重新连上 port 时调用，主动拉一次 content.js 当前 state 做初始渲染。
 * "已停止但有历史数据"时还会顺带提示用户可以直接导出。
 */
function syncFromState() {
  sendToContent('getState', {}, (state) => {
    if (!state) return;
    setRunningUI(Boolean(state.running));
    setPhase(state.phase);
    updateStats(state);
    fillConfig(state.config);
    renderWorkflow(state);
    if (!state.running && state.total > 0) {
      setStatus(`当前已保存 ${state.total} 条数据，可继续采集或直接导出。`);
    }
  });
}

// 建立到 background.js 的长连接，用于接收 content.js 主动推过来的进度消息。
// name: 'popup' 让 background.js 能识别这条连接归属并注册进 popupPorts 集合。
const port = chrome.runtime.connect({ name: 'popup' });

/**
 * 进度消息路由。每种 action 都对应 content.js 里一个 `notifyBackground` 调用点：
 *   - stateSync：完整 state 刷新（阶段/数字/配置全部同步）；
 *   - listingProgress / clickMore / manualLoadMoreClicked / autoLoadMoreClicked：列表阶段进度；
 *   - filtered：初筛阶段出结果；
 *   - detailDone：详情页采完一条；
 *   - relatedQueued / relatedAutoScrolling / relatedNeedsManualScroll：联想区进度；
 *   - windControlTriggered：风控触发，展示错误态；
 *   - done：run 自然结束，切回 idle + 展示成功统计。
 */
port.onMessage.addListener((message) => {
  if (message.action === 'stateSync') {
    setRunningUI(Boolean(message.running));
    setPhase(message.phase);
    updateStats(message);
    fillConfig(message.config);
    renderWorkflow(message);
    return;
  }

  if (message.action === 'listingProgress') {
    setPhase('listing', `总计 ${message.total} 条，本批新增 ${message.added} 条`);
    updateStats({ total: message.total });
    setStatus('正在增量收集商品，并持续扩充当前商品流。');
    return;
  }

  if (message.action === 'clickMore') {
    setPhase(
      'listing',
      message.autoClick
        ? `已采集 ${message.total} 条，即将自动点击“查看更多”`
        : `已采集 ${message.total} 条，等待手动点击“查看更多”`
    );
    setStatus(
      message.autoClick
        ? '“查看更多商品”按钮已高亮，扩展会自动点击并等待页面加载。'
        : '“查看更多商品”按钮已高亮，请手动点击一次后等待页面加载。'
    );
    return;
  }

  if (message.action === 'manualLoadMoreClicked') {
    setPhase('listing', `已手动点击，等待 ${message.waitSec} 秒后继续采集`);
    setStatus('已收到手动点击，正在等待页面加载完成后继续筛选。');
    return;
  }

  if (message.action === 'autoLoadMoreClicked') {
    setPhase('listing', `已自动点击，等待 ${message.waitSec} 秒后继续采集`);
    setStatus('已自动点击“查看更多商品”，正在等待页面加载完成后继续筛选。');
    return;
  }

  if (message.action === 'filtered') {
    setPhase('filtering', message.queued ? '初筛后已选中 1 条目标商品' : '当前批次没有命中目标商品');
    setStatus(
      message.queued
        ? '商品优先级筛选完成，已选出 1 条目标商品。'
        : '商品优先级筛选完成，但当前批次没有符合条件的新商品。',
      message.queued ? 'ok' : ''
    );
    return;
  }

  if (message.action === 'detailDone') {
    setPhase('detail', `商品完善 ${message.detailDone} 条，剩余 ${message.remaining} 条`);
    updateStats({ stats: { detailDone: message.detailDone } });
    return;
  }

  if (message.action === 'relatedQueued') {
    setPhase('related', message.added > 0 ? '已追加 1 条新目标' : '当前商品没有新的关联命中');
    updateStats({ queueLen: message.queueLen });
    setStatus(
      message.added > 0
        ? '已从当前商品的关联区域追加 1 条新目标进入队列。'
        : '当前商品未发现符合条件的新关联商品。'
    );
    return;
  }

  if (message.action === 'relatedAutoScrolling') {
    setPhase('related', '正在自动缓慢下拉到关联区域');
    setStatus('当前商品页正在模拟人工滚动到关联区域，请稍等。');
    return;
  }

  if (message.action === 'relatedNeedsManualScroll') {
    setPhase('related', '请先手动下拉到关联区域');
    setStatus('关联区域已高亮，请手动下拉到该区域，出现商品后扩展会继续识别。');
    return;
  }

  if (message.action === 'windControlTriggered') {
    setPhase('wind', '风控暂停，等待人工介入');
    setStatus(message.reason || '商品流扩充未成功，已进入风控暂停。', 'err');
    return;
  }

  if (message.action === 'done') {
    setRunningUI(false);
    setPhase('done');
    updateStats(message);
    setStatus(`采集结束，累计保存 ${message.total} 条数据。`, 'ok');
  }
});

// 主按钮点击：两态切换（开始采集 / 停止采集）。
// 开始路径：从 UI 读配置 → 立即把 UI 切到"运行中"态（乐观更新）→ 调 start；失败回滚到 idle。
// 停止路径：发 stop → UI 切回 idle，忽略 response 内容，强信号优先。
btnMain.addEventListener('click', () => {
  if (!isRunning) {
    const config = {
      collectionMode: cfgCollectionMode?.value || 'CONSERVATIVE',
      taskMode: cfgTaskMode?.value || 'DISCOVERY',
      intervalSec: Math.max(2, parseInt(cfgInterval.value, 10) || 5),
      batchSize: Math.max(20, parseInt(cfgBatch.value, 10) || 60),
      totalLimit: Math.max(100, parseInt(cfgLimit.value, 10) || 10000),
      autoClickV1: false,
      autoClickLoadMore: (cfgCollectionMode?.value || 'CONSERVATIVE') === 'AGGRESSIVE',
      showDebugPanel: Boolean(cfgDebugPanel.checked),
    };

    setRunningUI(true);
    setPhase('listing');
    setStatus('正在启动采集任务...');

    sendToContent('start', { config }, (response) => {
      if (!response?.ok) {
        setRunningUI(false);
        setPhase('idle');
        setStatus(response?.error || '启动失败，请确认当前页是 Temu 商品页面。', 'err');
      }
    });
    return;
  }

  sendToContent('stop', {}, () => {
    setRunningUI(false);
    setPhase('idle');
    setStatus('采集已停止。');
  });
});

// 导出按钮：从 content.js 拉 collected 数据 → 组装 CSV → 通过临时 <a download> 触发浏览器下载。
// CSV 头部写入 BOM (\uFEFF) 让 Excel 直接正确识别 UTF-8 中文；行内的双引号按 CSV 规范做 "" 转义。
// 列顺序固定成一个列表，便于下游脚本按列名读取；index 列在 map 里按行号即时生成。
btnExport.addEventListener('click', () => {
  sendToContent('getData', {}, (response) => {
    const rows = response?.data || [];
    if (!rows.length) {
      setStatus('暂无可导出的数据。', 'err');
      return;
    }

    const columns = [
      ['序号', 'index'],
      ['商品ID', 'goodsId'],
      ['列表商品名', 'name'],
      ['完整商品名', 'fullTitle'],
      ['上架时间', 'listingTime'],
      ['商品元素HTML', 'rawHtml'],
      ['商品元素文本', 'rawText'],
      ['列表价格', 'price'],
      ['详情价格', 'detailPrice'],
      ['已售（列表）', 'sales'],
      ['已售（详情）', 'detailSales'],
      ['星级（列表）', 'starRating'],
      ['星级（详情）', 'detailStars'],
      ['评价数（列表）', 'reviewCount'],
      ['评价数（详情）', 'detailReviews'],
      ['详情已采集', 'detailScraped'],
      ['采集时间', 'scrapedAt'],
      ['详情采集时间', 'detailAt'],
    ];

    const csvRows = rows.map((row, index) => columns.map(([, key]) => {
      const value = key === 'index' ? String(index + 1) : String(row[key] ?? '');
      return `"${value.replace(/"/g, '""')}"`;
    }).join(','));

    const csv = `\uFEFF${columns.map(([title]) => title).join(',')}\r\n${csvRows.join('\r\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `temu_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    setStatus(`已导出 ${rows.length} 条 CSV 数据。`, 'ok');
  });
});

// 清空按钮：二次确认 → 调 clearAll 让 content.js 清空 chrome.storage → 把 UI 复位。
// 注意这里是"清空 state"而不是"停止 run"，只在未运行场景下使用比较安全。
btnClear.addEventListener('click', () => {
  if (!window.confirm('确认清空当前已采集的数据吗？')) return;

  sendToContent('clearAll', {}, () => {
    sTotal.textContent = '0';
    sDetail.textContent = '0';
    sRelated.textContent = '0';
    sQueue.textContent = '0';
    setPhase('idle');
    setStatus('已清空本地采集状态。');
    setRunningUI(false);
  });
});

// 调试面板开关：运行中也允许切换 —— 把 showDebugPanel 推回 content.js 即可（content.js 里
// 有 applyDebugPanelConfig 监听这个字段做面板显隐）。
cfgDebugPanel.addEventListener('change', () => {
  sendToContent('setConfig', {
    config: {
      showDebugPanel: Boolean(cfgDebugPanel.checked),
    },
  }, (response) => {
    if (!response?.ok) {
      setStatus(response?.error || '调试面板开关同步失败。', 'err');
      return;
    }
    setStatus(
      cfgDebugPanel.checked ? '已开启右下角调试面板。' : '已关闭右下角调试面板。',
      'ok'
    );
  });
});

// 采集模式 / 任务模式切换：仅在未运行时允许，运行中变更会被忽略避免破坏 FSM 状态。
// 采集模式改 AGGRESSIVE 时自动勾上 autoClickLoadMore —— 两者在业务语义上是联动的。
[cfgCollectionMode, cfgTaskMode].filter(Boolean).forEach((el) => {
  el.addEventListener('change', () => {
    if (isRunning) return;
    sendToContent('setConfig', {
      config: {
        collectionMode: cfgCollectionMode?.value || 'CONSERVATIVE',
        taskMode: cfgTaskMode?.value || 'DISCOVERY',
        autoClickLoadMore: (cfgCollectionMode?.value || 'CONSERVATIVE') === 'AGGRESSIVE',
      },
    }, (response) => {
      if (response?.ok) {
        fillConfig(response.config || {});
        renderWorkflow({ config: response.config || {} });
      }
    });
  });
});

// 入口：popup 打开时立即拉一次 state 做首屏渲染。
syncFromState();
