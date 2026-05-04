/**
 * popup.js - 扩展弹窗 UI 的胶水层。
 *   - 与 background.js 建立 port 连接，接收 content.js 的进度推送并更新 UI；
 *   - 把按钮点击翻译成 runtime 消息（start/stop/clearAll/setConfig）发给 background；
 *   - 清空本地流程状态。
 * 顶层常量：PHASES（阶段颜色文案）、WORKFLOW_LABELS（FSM 状态中文映射）。
 */

// DOM 引用：phase 展示、顶部状态条
const phaseDot = document.getElementById('phaseDot');
const phaseText = document.getElementById('phaseText');
const phaseDesc = document.getElementById('phaseDesc');
const statusMsg = document.getElementById('statusMsg');
const btnMain = document.getElementById('btnMain');
const btnOneClickListing = document.getElementById('btnOneClickListing');
const btnClear = document.getElementById('btnClear');

const sTotal = document.getElementById('sTotal');

const cfgCollectionMode = document.getElementById('cfgCollectionMode');
const cfgInterval = document.getElementById('cfgInterval');
const cfgBatch = document.getElementById('cfgBatch');
const cfgLimit = document.getElementById('cfgLimit');
const cfgRemoveLocalWarehouse = document.getElementById('cfgRemoveLocalWarehouse');
const cfgLogVisible = document.getElementById('cfgLogVisible');
const loginPanel = document.getElementById('loginPanel');
const mainPanel = document.getElementById('mainPanel');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');
const userInfo = document.getElementById('userInfo');
const LOG_VISIBLE_KEY = 'temu_log_visible';

// popup 打开时从 storage 读取日志面板偏好
chrome.storage.local.get([LOG_VISIBLE_KEY], (result) => {
  const visible = result[LOG_VISIBLE_KEY] !== false;
  if (cfgLogVisible) cfgLogVisible.checked = visible;
});

function callRuntime(action, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...extra }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || '扩展通信失败' });
        return;
      }
      resolve(response || { ok: false, error: 'empty response' });
    });
  });
}

function setAuthUI(authed, user = null) {
  if (loginPanel) loginPanel.style.display = authed ? 'none' : '';
  if (mainPanel) mainPanel.style.display = authed ? '' : 'none';
  if (userInfo) {
    userInfo.textContent = authed && user
      ? `已登录：${user.email || '-'}（${user.role || 'user'}）`
      : '';
  }
  if (loginError) {
    loginError.style.display = 'none';
    loginError.textContent = '';
  }
}

async function initAuth() {
  const result = await callRuntime('getAuthUser');
  const authed = Boolean(result?.ok);
  setAuthUI(authed, result?.user || null);
  return authed;
}

let isRunning = false;

const PHASES = {
  idle: { dot: 'idle', text: '空闲', desc: '尚未开始' },
  listing: { dot: 'listing', text: '商品发现', desc: '采集当前商品流并继续加载' },
  filtering: { dot: 'filtering', text: '目标筛选', desc: '筛选高优先级商品并生成队列' },
  navigating: { dot: 'navigating', text: '等待操作', desc: '已高亮目标商品，等待继续' },
  detail: { dot: 'detail', text: '商品增强', desc: '补齐当前商品的更多信息' },
  related: { dot: 'related', text: '关联扩展', desc: '扫描并提取关联商品' },
  wind: { dot: 'filtering', text: '风控暂停', desc: '等待人工介入后恢复' },
  done: { dot: 'done', text: '已完成', desc: '采集任务已结束' },
};

const WORKFLOW_LABELS = {
  LIST_DISCOVERY: '列表发现',
  TARGET_SELECTED: '目标选中',
  NAVIGATE_TO_DETAIL: '等待跳转详情',
  DETAIL_SCRAPE: '详情补齐',
  RELATED_SCAN: '关联扫描',
  EDGE_COLLECT: '关系采集',
  PAUSE: '暂停',
  WIND_CONTROL: '风控暂停',
};

let currentPhase = 'idle';
let currentPhaseDesc = '';
let currentWorkflowLabel = WORKFLOW_LABELS.LIST_DISCOVERY;

function renderPhaseDesc() {
  const meta = PHASES[currentPhase] || PHASES.idle;
  const phasePart = currentPhaseDesc || meta.desc;
  phaseDesc.textContent = `${phasePart} ｜ ${currentWorkflowLabel}`;
}

/**
 * 更新当前阶段展示。查 PHASES 表，拿到小圆点颜色类名 + 主文案 + 默认描述，
 * 调用方可以覆写描述（比如 listing 阶段带上实时进度数字）。
 * @param {keyof typeof PHASES} phase
 * @param {string} [desc] 可选的覆写描述
 */
function setPhase(phase, desc) {
  const meta = PHASES[phase] || PHASES.idle;
  currentPhase = phase;
  currentPhaseDesc = desc || '';
  phaseDot.className = `phase-dot ${meta.dot}`;
  phaseText.textContent = meta.text;
  renderPhaseDesc();
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
 * @param {boolean} running
 */
function setRunningUI(running) {
  isRunning = running;
  btnMain.textContent = running ? '停止采集' : '开始采集';
  btnMain.classList.toggle('running', running);
  [cfgCollectionMode, cfgInterval, cfgBatch, cfgLimit]
    .filter(Boolean)
    .forEach((input) => {
    input.disabled = running;
  });
  if (cfgRemoveLocalWarehouse) cfgRemoveLocalWarehouse.disabled = false;
}

/**
 * 把 state 里的计数字段刷到 UI。当前仅展示总采集量。
 * @param {{total?: number}} [payload]
 */
function updateStats(payload = {}) {
  if (payload.total !== undefined) sTotal.textContent = String(payload.total);
}

/**
 * 把 state.config 回填到各个输入控件。用于 popup 首次打开、切换 run 之后的恢复。
 * @param {Record<string, unknown>} [config]
 */
function fillConfig(config = {}) {
  if (cfgCollectionMode && config.collectionMode !== undefined) cfgCollectionMode.value = config.collectionMode;
  if (config.intervalSec !== undefined) cfgInterval.value = config.intervalSec;
  if (config.batchSize !== undefined) cfgBatch.value = config.batchSize;
  if (config.totalLimit !== undefined) cfgLimit.value = config.totalLimit;
  if (cfgRemoveLocalWarehouse) cfgRemoveLocalWarehouse.checked = config.removeLocalWarehouse !== false;
}

/**
 * 刷新当前工作流状态显示（中文），并并入顶部 phase 描述行。
 * @param {{workflowState?: string}} [payload]
 */
function renderWorkflow(payload = {}) {
  const workflowState = payload.workflowState || 'LIST_DISCOVERY';
  currentWorkflowLabel = WORKFLOW_LABELS[workflowState] || workflowState;
  renderPhaseDesc();
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
 * "已停止但有历史数据"时提示用户可以继续采集。
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
      setStatus(`当前已采集 ${state.total} 条数据，可继续采集。`);
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
    return;
  }

  if (message.action === 'oneClickListingClicked') {
    setPhase('detail', `已点击“一键上架”：${message.goodsId || '-'}`);
    setStatus(
      message.groundingClicked
        ? '上架流程已执行，云启上架页面的一键上架也已点击。'
        : `已点击 Temu 一键上架，云启页面未自动完成：${message.groundingError || '等待超时'}`,
      message.groundingClicked ? 'ok' : 'err'
    );
    return;
  }

  if (message.action === 'relatedQueued') {
    setPhase('related', message.added > 0 ? '已追加 1 条新目标' : '当前商品没有新的关联命中');
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
    setStatus(`采集结束，累计保存 ${message.total} 条数据。追踪日志已上传后端。`, 'ok');
  }
});

// 主按钮点击：两态切换（开始采集 / 停止采集）。
// 开始路径：从 UI 读配置 → 立即把 UI 切到"运行中"态（乐观更新）→ 调 start；失败回滚到 idle。
// 停止路径：发 stop → UI 切回 idle，忽略 response 内容，强信号优先。
btnMain.addEventListener('click', () => {
  if (!isRunning) {
    const isAggressive = (cfgCollectionMode?.value || 'CONSERVATIVE') === 'AGGRESSIVE';
    const config = {
      collectionMode: cfgCollectionMode?.value || 'CONSERVATIVE',
      taskMode: 'DISCOVERY',
      intervalSec: Math.max(2, parseInt(cfgInterval.value, 10) || 5),
      batchSize: Math.max(20, parseInt(cfgBatch.value, 10) || 60),
      totalLimit: Math.max(100, parseInt(cfgLimit.value, 10) || 10000),
      autoClickV1: isAggressive,
      autoClickLoadMore: isAggressive,
      removeLocalWarehouse: Boolean(cfgRemoveLocalWarehouse?.checked),
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

// 独立上架按钮：不依赖采集是否运行，只要求当前有打开的 Temu 商品详情页。
btnOneClickListing.addEventListener('click', () => {
  btnOneClickListing.disabled = true;
  setStatus('已发送上架指令，正在判断当前页面阶段...');
  sendToContent('clickOneClickListing', {}, (response) => {
    btnOneClickListing.disabled = false;
    if (!response?.ok) {
      setStatus(response?.error || '一键上架执行失败，请确认当前页是 Temu 商品详情页。', 'err');
      return;
    }
    setPhase('detail', `已点击“一键上架”：${response.goodsId || '-'}`);
    setStatus(
      response.groundingClicked
        ? '上架流程已执行，云启上架页面的一键上架也已点击。'
        : `已点击 Temu 一键上架，云启页面未自动完成：${response.groundingError || '等待超时'}`,
      response.groundingClicked ? 'ok' : 'err'
    );
  });
});

// 清空按钮：二次确认 → 调 clearAll 让 content.js 清空 chrome.storage → 把 UI 复位。
// 注意这里是"清空 state"而不是"停止 run"，只在未运行场景下使用比较安全。
btnClear.addEventListener('click', () => {
  if (!window.confirm('确认清空当前已采集的数据吗？')) return;

  sendToContent('clearAll', {}, () => {
    sTotal.textContent = '0';
    setPhase('idle');
    setStatus('已清空本地采集状态。');
    setRunningUI(false);
  });
});

cfgLogVisible?.addEventListener('change', () => {
  const visible = Boolean(cfgLogVisible.checked);
  chrome.storage.local.set({ [LOG_VISIBLE_KEY]: visible });
  sendToContent('setLogVisible', { visible });
});

cfgRemoveLocalWarehouse?.addEventListener('change', () => {
  sendToContent('applyLocalWarehouseFilter', {
    enabled: Boolean(cfgRemoveLocalWarehouse.checked),
  }, (response) => {
    if (!response?.ok) {
      setStatus(response?.error || '本地仓过滤开关同步失败。', 'err');
      return;
    }
    setStatus(
      cfgRemoveLocalWarehouse.checked
        ? `已立即隐藏本地仓商品 ${response.removed || 0} 个。`
        : '已关闭本地仓商品移除。',
      'ok'
    );
  });
});

// 采集模式切换：仅在未运行时允许，运行中变更会被忽略避免破坏 FSM 状态。
// 采集模式改 AGGRESSIVE 时自动勾上 autoClickLoadMore —— 两者在业务语义上是联动的。
[cfgCollectionMode].filter(Boolean).forEach((el) => {
  el.addEventListener('change', () => {
    const isAggressive = (cfgCollectionMode?.value || 'CONSERVATIVE') === 'AGGRESSIVE';
    sendToContent('setConfig', {
      config: {
        collectionMode: cfgCollectionMode?.value || 'CONSERVATIVE',
        taskMode: 'DISCOVERY',
        autoClickV1: isAggressive,
        autoClickLoadMore: isAggressive,
      },
    }, (response) => {
      if (response?.ok) {
        fillConfig(response.config || {});
        renderWorkflow({ config: response.config || {} });
      }
    });
  });
});

loginBtn?.addEventListener('click', async () => {
  const email = String(loginEmail?.value || '').trim();
  const password = String(loginPassword?.value || '');
  if (!email || !password) {
    if (loginError) {
      loginError.textContent = '请输入邮箱和密码';
      loginError.style.display = '';
    }
    return;
  }

  loginBtn.disabled = true;
  const previous = loginBtn.textContent;
  loginBtn.textContent = '登录中...';
  const result = await callRuntime('login', { email, password });
  loginBtn.disabled = false;
  loginBtn.textContent = previous;

  if (!result?.ok) {
    if (loginError) {
      loginError.textContent = result?.error || result?.detail || '登录失败';
      loginError.style.display = '';
    }
    return;
  }

  if (loginPassword) loginPassword.value = '';
  const authed = await initAuth();
  if (authed) {
    syncFromState();
  }
});

logoutBtn?.addEventListener('click', async () => {
  await callRuntime('logout');
  setAuthUI(false, null);
});

async function init() {
  const authed = await initAuth();
  if (!authed) return;
  syncFromState();
}

init();
