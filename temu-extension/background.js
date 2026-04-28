/**
 * Temu 数据采集 - background.js v5.0
 * 职责：Manifest V3 Service Worker 保活 + popup/content 消息中转
 */

// ─── Service Worker 保活 ──────────────────────────────────
// MV3 的 SW 会在 30s 无活动后被浏览器挂起，用 alarm 定期唤醒

// 扩展首次安装/更新时注册保活 alarm。MV3 SW 长时间空闲会被浏览器挂起，
// 挂起后丢失 popupPorts 引用，popup 就收不到进度推送。周期性 alarm 触发 onAlarm 就足以
// 让浏览器把 SW 唤醒（函数体留空即可，不需要干实事）。
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // 每 24 秒触发
});

// keepAlive 闹钟的消费端：触发即满足唤醒条件，不需要做其他事。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // 只是唤醒，不做任何事
  }
});

// ─── 消息中转（content.js → popup）────────────────────────
// MV3 中 content script 无法直接向 popup 发消息
// content.js 调用 chrome.runtime.sendMessage → background 收到 → 转给所有 port

const popupPorts = new Set();
const BACKEND_BASE_URL = 'http://47.107.78.215:8000';
const AUTH_TOKEN_KEY = 'temu_auth_token';
const AUTH_USER_KEY = 'temu_auth_user';
const TEMU_TAB_QUERY = { url: '*://*.temu.com/*' };
const LISTING_WORKFLOW_GOODS_ID_KEY = 'temu_listing_workflow_goods_id';
const TEMU_BROWSING_DATA_ORIGINS = [
  'https://temu.com',
  'https://www.temu.com',
  'http://temu.com',
  'http://www.temu.com',
];
const ONE_CLICK_LISTING_DELAY_MS = 5000;
const YUNQI_GROUNDING_URL_PATTERN = '*://www.yunqishuju.com/temu/grounding*';
const YUNQI_GROUNDING_BUTTON_SELECTOR = '#__layout > div > div.main > div.body > div > div > div.recharge > div:nth-child(1) > div.el-table.custom-table.el-table--fit.el-table--border.el-table--enable-row-hover.el-table--enable-row-transition > div.el-table__body-wrapper.is-scrolling-none > table > tbody > tr:nth-child(1) > td.el-table_1_column_8.is-center.el-table__cell > div > div > button:nth-child(2)';
const YUNQI_GROUNDING_DIALOG_SUBMIT_SELECTOR = '#__layout > div > div.main > div.body > div > div > div.recharge > div:nth-child(1) > section > div > div > div.el-dialog__body > form > div:nth-child(4) > div > div > button';
const YUNQI_GROUNDING_WAIT_MS = 30000;
const TEMU_GOODS_EDIT_URL_PATTERN = '*://agentseller.temu.com/goods/edit*';
const TEMU_GOODS_EDIT_WAIT_MS = 45000;
const TEMU_ORIGIN_PROVINCE_INPUT_SELECTOR = '#productOriginProvinceCode > div > div > div > div > div > div > div > div > div > div > div.IPT_inputBlockCell_5-120-1.ST_inputBlockCell_5-120-1 > input';
const TEMU_MATERIAL_IMAGE_SELECTOR = '#materialImage > div.Grid_col_5-120-1.Grid_colNotFixed_5-120-1.Form_itemWrapper_5-120-1 > div.Grid_row_5-120-1.Grid_rowHorizontal_5-120-1.Grid_rowJustifyStart_5-120-1.Form_itemContent_5-120-1.Form_itemContentCenter_5-120-1 > div > div > img';
const TEMU_UPLOAD_INPUT_SELECTOR = 'input[data-testid="beast-core-upload-input"][type="file"]';
const TEMU_DECLARED_PRICE_INPUT_SELECTOR = '#productSkuMap\\.16091728_287431221\\.supplierPrice > div > div.Grid_row_5-120-1.Grid_rowHorizontal_5-120-1.Grid_rowJustifyStart_5-120-1.Form_itemContent_5-120-1.Form_itemContentCenter_5-120-1 > div > div > div > div.IPT_inputWrapper_5-120-1.IPTN_inputWrapper_5-120-1.IPT_collapseLeft_5-120-1 > div > div > input';
const TEMU_SKU_CLASSIFICATION_INPUT_SELECTOR = '#productSkuMap\\.16091728_287431221\\.productSkuMultiPack\\.skuClassification > div > div > div > div > div > div > div > div > div > div > div.IPT_inputBlockCell_5-120-1.ST_inputBlockCell_5-120-1 > input';
const TEMU_PACK_INCLUDE_INPUT_SELECTOR = '#productSkuMap\\.16091728_287431221\\.productSkuMultiPack\\.packIncludeInfo > div > div > div > div > div > div.IPT_inputWrapper_5-120-1.IPTN_inputWrapper_5-120-1.IPT_collapseBoth_5-120-1 > div > div > input';
const TEMU_SUGGEST_SALES_PRICE_INPUT_SELECTOR = '#productSkuMap\\.16091728_287431221\\.suggestSalesPrice > div > div > div > div > div > div.IPT_inputWrapper_5-120-1.IPT_collapseRight_5-120-1 > div > div > input';
const TEMU_SUGGEST_SALES_PRICE_CURRENCY_INPUT_SELECTOR = '#productSkuMap\\.16091728_287431221\\.suggestSalesPrice > div > div > div > div > div > div.ST_outerWrapper_5-120-1.IPT_selectBorderRadius_5-120-1.ST_medium_5-120-1 > div > div > div > div > div > div > div.IPT_inputBlockCell_5-120-1.ST_inputBlockCell_5-120-1 > input';
const TEMU_AGREEMENT_CHECKBOX_SELECTOR = '#page_container_id > form > div.product-create_container__zWGwR.product-create_withSopAnnouncement__Hi6uH > div > div.product-create_bodyContainer__LhHuy > div.product-create_newButtonContainer__1UHMe > div:nth-child(1) > label > div.CBX_squareInputWrapper_5-120-1 > input';
const TEMU_CREATE_BUTTON_SELECTOR = '#page_container_id > form > div.product-create_container__zWGwR.product-create_withSopAnnouncement__Hi6uH > div > div.product-create_bodyContainer__LhHuy > div.product-create_newButtonContainer__1UHMe > div.product-create_buttons__O6H\\+r > div:nth-child(2) > button.BTN_outerWrapper_5-120-1.BTN_primary_5-120-1.BTN_large_5-120-1.BTN_outerWrapperBtn_5-120-1';
const TEMU_TEST_SKU_CLASSIFICATION = '单品';
const TEMU_TEST_PACK_INCLUDE = '1';
const TEMU_TEST_SUGGEST_SALES_PRICE_CURRENCY = 'USD';

/**
 * popup 打开时会建立一条长连接（port.name === 'popup'），SW 保留引用用于"主动推送"。
 * popup 关闭时连接断开，自动从 set 里移除，防止内存里挂着无效 port 反复抛 "Attempting to use
 * a disconnected port" 错误。
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'popup') {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));
  }
});

async function getToken() {
  const result = await chrome.storage.local.get([AUTH_TOKEN_KEY]);
  return result[AUTH_TOKEN_KEY] || null;
}

async function setAuth(token, user) {
  await chrome.storage.local.set({
    [AUTH_TOKEN_KEY]: token,
    [AUTH_USER_KEY]: user || null,
  });
}

async function clearAuth() {
  await chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
}

async function getAuthUser() {
  const result = await chrome.storage.local.get([AUTH_USER_KEY]);
  return result[AUTH_USER_KEY] || null;
}

async function authHeaders() {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 全局消息路由。背景页同时承担 3 类消息的中转：
 *   1. progressActions：content.js 的进度推送 → 广播给所有已连接的 popup port；
 *   2. backendActions：content.js 要调后端 HTTP 接口 → 走 fetch（放在 SW 避免跨域/CORS 问题）；
 *   3. controlActions：popup 的控制指令 → 定位 Temu 标签页并 sendMessage 过去。
 * 异步分支必须 return true 保持 sendResponse 通道打开，否则 Chrome 会立刻关闭端口。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content.js 发来的进度通知 → 转发给 popup
  const progressActions = [
    'stateSync',
    'navigate',
    'listingProgress',
    'clickMore',
    'manualLoadMoreClicked',
    'autoLoadMoreClicked',
    'filtered',
    'detailDone',
    'oneClickListingClicked',
    'relatedAutoScrolling',
    'relatedNeedsManualScroll',
    'relatedQueued',
    'windControlTriggered',
    'done',
  ];

  if (progressActions.includes(msg.action)) {
    popupPorts.forEach(port => {
      try { port.postMessage(msg); } catch (_) {}
    });
    return false;
  }

  const backendActions = ['backendStartRun', 'backendUploadBatch', 'backendFinishRun', 'fetchExclusionKeywords'];

  if (backendActions.includes(msg.action)) {
    handleBackendAction(msg)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (msg.action === 'openInNewTab') {
    openInNewTab(msg?.url)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (msg.action === 'clearTemuSiteData') {
    clearTemuSiteData()
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (msg.action === 'pruneTemuDetailTabs') {
    pruneTemuDetailTabs(msg.maxCount ?? 1)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (msg.action === 'clickOneClickListing') {
    clickOneClickListingWithDebugger()
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (msg.action === 'login') {
    postJson('/api/auth/login', {
      email: String(msg.email || '').trim(),
      password: String(msg.password || ''),
    }).then(async (response) => {
      if (response?.ok && response.access_token) {
        await setAuth(response.access_token, {
          email: response.email || String(msg.email || '').trim(),
          role: response.role || 'user',
        });
      }
      sendResponse(response);
    }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (msg.action === 'logout') {
    clearAuth()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (msg.action === 'getAuthUser') {
    Promise.all([getToken(), getAuthUser()])
      .then(([token, user]) => sendResponse({ ok: Boolean(token), user }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  // popup 发来的控制指令 → 转发给当前 Temu 标签页
  const controlActions = [
    'start',
    'stop',
    'getState',
    'clearAll',
    'setConfig',
    'setLogVisible',
    'triggerLoadMoreNow',
    'applyLocalWarehouseFilter',
    'setWorkflowState',
  ];

  if (controlActions.includes(msg.action)) {
    forwardControlAction(msg).then(sendResponse);
    return true; // 异步
  }
});

/**
 * 由扩展后台创建新标签页，避免 content script 的 window.open 被页面策略拦截。
 * @param {string | undefined} url
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function openInNewTab(url) {
  const href = String(url || '').trim();
  if (!href) return { ok: false, error: '缺少跳转地址。' };

  await new Promise((resolve, reject) => {
    chrome.tabs.create({ url: href, active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || '无法创建新标签页'));
        return;
      }
      resolve(tab);
    });
  });

  return { ok: true };
}

/**
 * 把 popup 的控制消息（start/stop/getState 等）转发给 Temu 的 content script。
 * 流程：findTemuTab → chrome.tabs.sendMessage → 翻译 lastError 为中文可读错误。
 * 这里把 lastError 识别成几种用户场景（没注入脚本/跨域/页面刷新中），帮助用户自己排障。
 * @param {Record<string, unknown>} msg
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function forwardControlAction(msg) {
  const tab = await findTemuTab();
  if (!tab?.id) {
    return { ok: false, error: '未找到已打开的 Temu 页面，请先打开一个 temu.com 标签页。' };
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, msg, (response) => {
      if (chrome.runtime.lastError) {
        const runtimeMessage = chrome.runtime.lastError.message || '';
        resolve({
          ok: false,
          error: mapTabMessageError(runtimeMessage, tab),
        });
        return;
      }

      resolve(response || { ok: false, error: 'Temu 页面未返回响应，请刷新后重试。' });
    });
  });
}

/**
 * 定位要操作的 Temu 标签页。优先找"当前窗口激活的"temu.com 标签，没有就退到任意 temu.com 标签。
 * 返回 null 表示用户压根没打开 Temu，forwardControlAction 会据此给出提示。
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
async function findTemuTab() {
  const activeTabs = await queryTabs({ ...TEMU_TAB_QUERY, active: true, currentWindow: true });
  if (activeTabs[0]) return activeTabs[0];

  const allTabs = await queryTabs(TEMU_TAB_QUERY);
  return allTabs[0] || null;
}

/**
 * 找当前可继续的上架流程页面。优先当前窗口激活页，再按阶段从后往前找。
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
async function findListingWorkflowTab() {
  const activeTabs = await queryTabs({ active: true, currentWindow: true });
  if (isListingWorkflowUrl(activeTabs[0]?.url)) return activeTabs[0];

  const editTabs = await queryTabs({ url: TEMU_GOODS_EDIT_URL_PATTERN });
  if (editTabs[0]) return editTabs[0];

  const groundingTabs = await queryTabs({ url: YUNQI_GROUNDING_URL_PATTERN });
  if (groundingTabs[0]) return groundingTabs[0];

  return findTemuTab();
}

/**
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isListingWorkflowUrl(url) {
  return isTemuProductDetailUrl(url) || isYunqiGroundingUrl(url) || isTemuGoodsEditUrl(url);
}

/**
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isTemuProductDetailUrl(url) {
  return /-g-\d+\.html/i.test(String(url || ''));
}

/**
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isYunqiGroundingUrl(url) {
  return /^https:\/\/www\.yunqishuju\.com\/temu\/grounding/i.test(String(url || ''));
}

/**
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isTemuGoodsEditUrl(url) {
  return /^https:\/\/agentseller\.temu\.com\/goods\/edit/i.test(String(url || ''));
}

/**
 * 独立上架流程：用 Chrome DevTools Protocol 在目标坐标发送浏览器级鼠标事件。
 * 这条链路不依赖 content script 的 DOM click，适合页面拒绝 synthetic event 的场景。
 * @returns {Promise<{ok: boolean, goodsId?: string, x?: number, y?: number, error?: string}>}
 */
async function clickOneClickListingWithDebugger() {
  const stageTab = await findListingWorkflowTab();
  if (!stageTab?.id) {
    return {
      ok: false,
      error: '未找到可继续的上架页面，请打开 Temu 商品详情页、云启上架页或 Temu 商品编辑页。',
    };
  }

  if (isTemuGoodsEditUrl(stageTab.url)) {
    await focusTab(stageTab);
    await delay(12000);
    const goodsId = await getRememberedListingWorkflowGoodsId();
    if (!goodsId) {
      return {
        ok: false,
        stage: 'temu_goods_edit',
        error: '当前已在商品编辑页，但缺少 goods_id，请从 Temu 商品详情页启动一次上架流程。',
      };
    }
    const originResult = await runTemuGoodsEditAutomation(stageTab.id, goodsId);
    return {
      ok: originResult.ok,
      stage: 'temu_goods_edit',
      ...originResult,
      error: originResult.error || '',
    };
  }

  if (isYunqiGroundingUrl(stageTab.url)) {
    const goodsId = await getRememberedListingWorkflowGoodsId();
    if (!goodsId) {
      return {
        ok: false,
        stage: 'yunqi_grounding',
        error: '当前已在云启上架页，但缺少 goods_id，请从 Temu 商品详情页启动一次上架流程。',
      };
    }
    await focusTab(stageTab);
    const groundingResult = await clickYunqiGroundingButton(stageTab.id);
    if (!groundingResult.ok) {
      return {
        ok: false,
        stage: 'yunqi_grounding',
        groundingClicked: false,
        groundingError: groundingResult.error || '',
        error: groundingResult.error || '',
      };
    }
    const originResult = await waitForAndSelectTemuGoodsOrigin(goodsId);
    return {
      ok: originResult.ok,
      stage: 'yunqi_grounding',
      groundingClicked: true,
      ...originResult,
      groundingError: '',
      error: originResult.error || '',
    };
  }

  const tab = stageTab;
  if (!isTemuProductDetailUrl(tab.url)) {
    return {
      ok: false,
      error: '当前页面不是可识别的上架阶段，请打开 Temu 商品详情页、云启上架页或 Temu 商品编辑页。',
    };
  }

  await focusTab(tab);
  await delay(ONE_CLICK_LISTING_DELAY_MS);

  const target = await locateOneClickListingTarget(tab.id);
  if (!target?.ok) {
    return {
      ok: false,
      error: target?.error || '未找到“一键上架”的可点击区域。',
    };
  }

  await rememberListingWorkflowGoodsId(target.goodsId);
  await dispatchDebuggerClick(tab.id, target.x, target.y);
  const groundingResult = await waitForAndClickYunqiGroundingButton(target.goodsId);

  popupPorts.forEach(port => {
    try {
      port.postMessage({
        action: 'oneClickListingClicked',
        goodsId: target.goodsId,
        groundingClicked: groundingResult.ok,
        groundingError: groundingResult.error || '',
      });
    } catch (_) {}
  });

  return {
    ok: true,
    stage: 'temu_detail',
    goodsId: target.goodsId,
    x: Math.round(target.x),
    y: Math.round(target.y),
    groundingClicked: groundingResult.ok,
    groundingError: groundingResult.error || '',
  };
}

/**
 * @param {string} goodsId
 * @returns {Promise<void>}
 */
function rememberListingWorkflowGoodsId(goodsId) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [LISTING_WORKFLOW_GOODS_ID_KEY]: goodsId || '' }, () => resolve());
  });
}

/**
 * @returns {Promise<string>}
 */
function getRememberedListingWorkflowGoodsId() {
  return new Promise((resolve) => {
    chrome.storage.local.get([LISTING_WORKFLOW_GOODS_ID_KEY], (result) => {
      resolve(result?.[LISTING_WORKFLOW_GOODS_ID_KEY] || '');
    });
  });
}

/**
 * 等待云启上架页面出现，并点击表格第一行的一键上架按钮。
 * @param {string} goodsId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function waitForAndClickYunqiGroundingButton(goodsId) {
  const tab = await waitForYunqiGroundingTab(YUNQI_GROUNDING_WAIT_MS);
  if (!tab?.id) {
    return { ok: false, error: '未检测到云启上架页面打开或跳转。' };
  }

  await focusTab(tab);
  await delay(1500);
  const groundingResult = await clickYunqiGroundingButton(tab.id);
  if (!groundingResult.ok) return groundingResult;

  const originResult = await waitForAndSelectTemuGoodsOrigin(goodsId);
  if (!originResult.ok) return originResult;

  return {
    ok: true,
    dialogSubmitted: true,
    originSelected: true,
  };
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
function waitForYunqiGroundingTab(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (tab) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      resolve(tab || null);
    };

    const handleUpdated = (tabId, changeInfo, tab) => {
      const url = changeInfo.url || tab.url || '';
      if (isYunqiGroundingUrl(url)) {
        if (changeInfo.status === 'complete' || tab.status === 'complete') {
          finish({ ...tab, id: tabId, url });
          return;
        }
      }
    };

    chrome.tabs.onUpdated.addListener(handleUpdated);
    queryTabs({ url: YUNQI_GROUNDING_URL_PATTERN }).then((tabs) => {
      const ready = tabs.find((tab) => tab.status === 'complete') || tabs[0];
      if (ready) finish(ready);
    });

    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function clickYunqiGroundingButton(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: (tableButtonSelector, dialogSubmitSelector) => {
        const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        };
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

        const findTableButton = () => {
          const direct = document.querySelector(tableButtonSelector);
          if (direct && isVisible(direct)) return direct;
          return Array.from(document.querySelectorAll('button, .grounding-yijian-btn'))
            .map((el) => el.closest('button') || el)
            .find((el) => isVisible(el) && normalizeText(el.innerText || el.textContent).includes('一键上架'));
        };

        const findDialogSubmitButton = () => {
          const direct = document.querySelector(dialogSubmitSelector);
          if (direct && isVisible(direct)) return direct;
          return Array.from(document.querySelectorAll('.el-dialog__body button, .el-dialog button, button'))
            .find((el) => isVisible(el) && /上架|确定|提交/.test(normalizeText(el.innerText || el.textContent)));
        };

        const clickButton = async (button) => {
          button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          await sleep(300);
          button.click();
        };

        return (async () => {
          let button = null;
          for (let i = 0; i < 20; i += 1) {
            button = findTableButton();
            if (button) break;
            await sleep(500);
          }

          if (!button) {
            return { ok: false, error: '云启页面未找到表格第一行“一键上架”按钮。' };
          }

          await clickButton(button);
          await sleep(3000);

          let submitButton = null;
          for (let i = 0; i < 20; i += 1) {
            submitButton = findDialogSubmitButton();
            if (submitButton) break;
            await sleep(500);
          }

          if (!submitButton) {
            return { ok: false, error: '云启弹窗未找到最终“上架”按钮。' };
          }

          await clickButton(submitButton);
          return { ok: true, dialogSubmitted: true };
        })();
      },
      args: [YUNQI_GROUNDING_BUTTON_SELECTOR, YUNQI_GROUNDING_DIALOG_SUBMIT_SELECTOR],
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: '云启页面点击脚本未返回结果。' });
    });
  });
}

/**
 * 等待 Temu seller 商品编辑页出现，等待页面渲染后选择商品产地二级下拉为广东省。
 * @param {string} goodsId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function waitForAndSelectTemuGoodsOrigin(goodsId) {
  const tab = await waitForTemuGoodsEditTab(TEMU_GOODS_EDIT_WAIT_MS);
  if (!tab?.id) {
    return { ok: false, error: '未检测到 Temu 商品编辑页打开或跳转。' };
  }

  await focusTab(tab);
  await delay(12000);
  return runTemuGoodsEditAutomation(tab.id, goodsId);
}

/**
 * 执行 Temu seller 编辑页填写。体积/重量/价格来自后台 admin/products。
 * @param {number} tabId
 * @param {string} goodsId
 * @returns {Promise<{ok: boolean, error?: string, [key: string]: unknown}>}
 */
async function runTemuGoodsEditAutomation(tabId, goodsId) {
  const listingConfig = await fetchListingConfig(goodsId);
  if (!listingConfig.ok) return listingConfig;

  const originResult = await selectTemuGoodsOriginProvince(tabId, '广东省');
  if (!originResult.ok) return originResult;

  const uploadResult = await uploadMaterialImageToTemuGoodsEdit(tabId);
  if (!uploadResult.ok) return uploadResult;

  const packageResult = await fillTemuGoodsPackageValues(tabId, listingConfig.packageValues);
  if (!packageResult.ok) return packageResult;

  const priceResult = await fillTemuGoodsDeclaredPrice(tabId, listingConfig.declaredPrice);
  if (!priceResult.ok) return priceResult;

  const skuResult = await fillTemuGoodsSkuMultiPack(tabId, {
    classification: TEMU_TEST_SKU_CLASSIFICATION,
    packInclude: TEMU_TEST_PACK_INCLUDE,
  });
  if (!skuResult.ok) return skuResult;

  const suggestPriceResult = await fillTemuGoodsSuggestSalesPrice(tabId, {
    price: listingConfig.suggestedPrice,
    currency: TEMU_TEST_SUGGEST_SALES_PRICE_CURRENCY,
  });
  if (!suggestPriceResult.ok) return suggestPriceResult;

  const agreementResult = await checkTemuGoodsAgreement(tabId);
  if (!agreementResult.ok) return agreementResult;

  const createResult = await clickTemuGoodsCreateButton(tabId);
  if (!createResult.ok) return createResult;

  return {
    ok: true,
    originSelected: true,
    imageUploaded: true,
    packageFilled: true,
    declaredPriceFilled: true,
    skuMultiPackFilled: true,
    suggestSalesPriceFilled: true,
    agreementChecked: true,
    createClicked: true,
  };
}

/**
 * 从后台读取当前 goods_id 的上架参数。
 * @param {string} goodsId
 * @returns {Promise<{ok: boolean, packageValues?: {length: string, width: string, height: string, weight: string}, declaredPrice?: string, suggestedPrice?: string, error?: string}>}
 */
async function fetchListingConfig(goodsId) {
  if (!goodsId) {
    return { ok: false, error: '缺少 goods_id，无法读取后台上架参数。' };
  }

  const data = await getJson(`/api/dashboard/products/${encodeURIComponent(goodsId)}/listing-config`);
  if (!data?.ok) {
    return {
      ok: false, error: data?.detail || data?.error || '读取后台上架参数失败',
    };
  }

  const required = [
    ['listing_length_cm', '最长边'],
    ['listing_width_cm', '次长边'],
    ['listing_height_cm', '最短边'],
    ['listing_weight_g', '重量'],
    ['listing_declared_price', '申报价'],
    ['listing_suggested_price', '建议零售价'],
  ];
  const missing = required
    .filter(([key]) => data[key] === undefined || data[key] === null || String(data[key]).trim() === '')
    .map(([, label]) => label);
  if (missing.length) {
    return {
      ok: false,
      error: `后台上架参数未填写完整：${missing.join('、')}。请先到 admin/products 保存参数。`,
    };
  }

  return {
    ok: true,
    packageValues: {
      length: String(data.listing_length_cm),
      width: String(data.listing_width_cm),
      height: String(data.listing_height_cm),
      weight: String(data.listing_weight_g),
    },
    declaredPrice: String(data.listing_declared_price),
    suggestedPrice: String(data.listing_suggested_price),
  };
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
function waitForTemuGoodsEditTab(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (tab) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      resolve(tab || null);
    };

    const handleUpdated = (tabId, changeInfo, tab) => {
      const url = changeInfo.url || tab.url || '';
      if (isTemuGoodsEditUrl(url)) {
        if (changeInfo.status === 'complete' || tab.status === 'complete') {
          finish({ ...tab, id: tabId, url });
        }
      }
    };

    chrome.tabs.onUpdated.addListener(handleUpdated);
    queryTabs({ url: TEMU_GOODS_EDIT_URL_PATTERN }).then((tabs) => {
      const ready = tabs.find((tab) => tab.status === 'complete') || tabs[0];
      if (ready) finish(ready);
    });

    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * @param {number} tabId
 * @param {string} province
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function selectTemuGoodsOriginProvince(tabId, province) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (provinceName, provinceInputSelector) => {
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        };
        const click = async (el) => {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          await sleep(300);
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          await sleep(80);
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          el.click();
        };
        const markElement = async (el, label, color = '#b98546', waitMs = 2000) => {
          if (!el) return;
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          const rect = el.getBoundingClientRect();
          const marker = document.createElement('div');
          marker.textContent = label;
          marker.style.cssText = `
            position: fixed;
            left: ${Math.max(0, rect.left - 4)}px;
            top: ${Math.max(0, rect.top - 28)}px;
            z-index: 2147483647;
            padding: 4px 8px;
            border-radius: 4px;
            background: ${color};
            color: #fff;
            font: 12px/1.2 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
            pointer-events: none;
          `;
          const outline = document.createElement('div');
          outline.style.cssText = `
            position: fixed;
            left: ${rect.left}px;
            top: ${rect.top}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            z-index: 2147483646;
            border: 4px solid ${color};
            background: ${color}22;
            pointer-events: none;
            box-sizing: border-box;
          `;
          document.body.appendChild(outline);
          document.body.appendChild(marker);
          await sleep(waitMs);
          outline.remove();
          marker.remove();
        };

        const findOriginSection = () => {
          const nodes = Array.from(document.querySelectorAll('label, span, div, p'))
            .filter((el) => isVisible(el) && normalizeText(el.innerText || el.textContent).includes('商品产地'));
          for (const label of nodes) {
            const row = label.closest('.el-form-item, [class*="form"], [class*="Form"], div') || label.parentElement;
            if (row) return row;
          }
          return null;
        };

        const findSecondDropdown = (section) => {
          const direct = document.querySelector(provinceInputSelector);
          if (direct && isVisible(direct)) return direct;

          const scope = section?.parentElement || document;
          const candidates = Array.from(scope.querySelectorAll(
            '.el-select, .el-cascader, [class*="select"], [class*="Select"], input, [role="combobox"]'
          )).filter(isVisible);
          if (candidates.length >= 2) return candidates[1];
          return candidates[candidates.length - 1] || null;
        };

        const findProvinceOption = () => {
          const candidates = Array.from(document.querySelectorAll(
            '.el-select-dropdown__item, .el-cascader-node, [role="option"], li, span, div'
          )).filter((el) => isVisible(el) && normalizeText(el.innerText || el.textContent) === provinceName);
          return candidates[0] || null;
        };

        let dropdown = null;
        for (let i = 0; i < 30; i += 1) {
          const section = findOriginSection();
          dropdown = findSecondDropdown(section);
          if (dropdown) break;
          await sleep(500);
        }

        if (!dropdown) {
          return { ok: false, error: '未找到“商品产地”的二级下拉框。' };
        }

        await markElement(dropdown, '插件选中的商品产地省份下拉框', '#b98546', 3000);
        dropdown.focus?.();
        await click(dropdown);
        dropdown.dispatchEvent(new Event('input', { bubbles: true }));
        dropdown.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(800);

        let option = null;
        for (let i = 0; i < 20; i += 1) {
          option = findProvinceOption();
          if (option) break;
          await sleep(300);
        }

        if (!option) {
          return { ok: false, error: `未找到“${provinceName}”选项。` };
        }

        await markElement(option, `插件选中的选项：${provinceName}`, '#2f4858', 2000);
        await click(option);
        return { ok: true };
      },
      args: [province, TEMU_ORIGIN_PROVINCE_INPUT_SELECTOR],
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: '商品产地选择脚本未返回结果。' });
    });
  });
}

/**
 * 从商品编辑页素材图片 img.src 获取图片，转成 File 后塞入上传 input。
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function uploadMaterialImageToTemuGoodsEdit(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (imageSelector, uploadInputSelector) => {
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        };

        const waitForElement = async (selector, predicate = () => true, tries = 30, interval = 500) => {
          for (let i = 0; i < tries; i += 1) {
            const element = document.querySelector(selector);
            if (element && predicate(element)) return element;
            await sleep(interval);
          }
          return null;
        };

        const image = await waitForElement(
          imageSelector,
          (el) => isVisible(el) && Boolean(el.src),
          30,
          500
        );
        if (!image?.src) {
          return { ok: false, error: '未找到素材图片 img.src。' };
        }

        const input = await waitForElement(uploadInputSelector, (el) => el.type === 'file', 20, 500);
        if (!input) {
          return { ok: false, error: '未找到图片上传 input。' };
        }

        const response = await fetch(image.src);
        if (!response.ok) {
          return { ok: false, error: `素材图片下载失败：${response.status}` };
        }

        const blob = await response.blob();
        const extension = blob.type.includes('png') ? 'png' : 'jpg';
        const file = new File([blob], `product_material.${extension}`, {
          type: blob.type || 'image/jpeg',
        });

        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        return {
          ok: true,
          imageSrc: image.src.slice(0, 120),
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
        };
      },
      args: [TEMU_MATERIAL_IMAGE_SELECTOR, TEMU_UPLOAD_INPUT_SELECTOR],
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: '图片上传脚本未返回结果。' });
    });
  });
}

/**
 * 填写商品编辑页的体积与重量测试数据。
 * @param {number} tabId
 * @param {{length: string, width: string, height: string, weight: string}} values
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function fillTemuGoodsPackageValues(tabId, values) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (packageValues) => {
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        };

        const setInputValue = async (input, value) => {
          input.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          await sleep(150);
          input.focus();
          input.select?.();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(input, String(value));
          } else {
            input.value = String(value);
          }
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: String(value),
          }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
        };

        const findVolumeInputByLabel = (labelText) => {
          const wrappers = Array.from(document.querySelectorAll('.product-volume_volumeTdContainer__iEDxe [data-testid="beast-core-inputNumber"]'))
            .filter(isVisible);
          return wrappers
            .find((wrapper) => normalizeText(wrapper.innerText || wrapper.textContent).includes(labelText))
            ?.querySelector('input[data-testid="beast-core-inputNumber-htmlInput"], input');
        };

        const findWeightInput = () => {
          const wrappers = Array.from(document.querySelectorAll('[data-testid="beast-core-inputNumber"]'))
            .filter(isVisible);
          return wrappers
            .find((wrapper) => normalizeText(wrapper.innerText || wrapper.textContent).endsWith('g'))
            ?.querySelector('input[data-testid="beast-core-inputNumber-htmlInput"], input');
        };

        const fields = [
          ['最长边', packageValues.length, findVolumeInputByLabel('最长边')],
          ['次长边', packageValues.width, findVolumeInputByLabel('次长边')],
          ['最短边', packageValues.height, findVolumeInputByLabel('最短边')],
          ['重量', packageValues.weight, findWeightInput()],
        ];

        const missing = fields.filter(([, , input]) => !input).map(([label]) => label);
        if (missing.length) {
          return { ok: false, error: `未找到体积/重量输入框：${missing.join('、')}` };
        }

        for (const [, value, input] of fields) {
          await setInputValue(input, value);
          await sleep(120);
        }

        return {
          ok: true,
          values: packageValues,
        };
      },
      args: [values],
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: '体积重量填写脚本未返回结果。' });
    });
  });
}

/**
 * 填写申报价测试数据。
 * @param {number} tabId
 * @param {string} price
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function fillTemuGoodsDeclaredPrice(tabId, price) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (selector, value) => {
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        const setInputValue = async (input, nextValue) => {
          input.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          await sleep(150);
          input.focus();
          input.select?.();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(input, String(nextValue));
          } else {
            input.value = String(nextValue);
          }
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: String(nextValue),
          }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
        };

        let input = null;
        for (let i = 0; i < 20; i += 1) {
          input = document.querySelector(selector);
          if (input) break;
          await sleep(500);
        }

        if (!input) {
          return { ok: false, error: '未找到申报价输入框。' };
        }

        await setInputValue(input, value);
        return { ok: true, value };
      },
      args: [TEMU_DECLARED_PRICE_INPUT_SELECTOR, price],
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: '申报价填写脚本未返回结果。' });
    });
  });
}

/**
 * 填写 SKU 分类和共计内含测试数据。
 * @param {number} tabId
 * @param {{classification: string, packInclude: string}} values
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function fillTemuGoodsSkuMultiPack(tabId, values) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (classificationSelector, packIncludeSelector, nextValues) => {
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        };
        const waitForElement = async (selector, tries = 20, interval = 500) => {
          for (let i = 0; i < tries; i += 1) {
            const element = document.querySelector(selector);
            if (element) return element;
            await sleep(interval);
          }
          return null;
        };
        const click = async (el) => {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          await sleep(200);
          el.focus?.();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          await sleep(80);
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          el.click();
        };
        const setInputValue = async (input, value) => {
          input.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          await sleep(150);
          input.focus();
          input.select?.();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(input, String(value));
          } else {
            input.value = String(value);
          }
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: String(value),
          }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
        };
        const findFirstOption = () => {
          const dropdowns = Array.from(document.querySelectorAll(
            'ul[role="listbox"].ST_dropdownPanel_5-120-1, ul[role="listbox"], [role="listbox"]'
          )).filter(isVisible);

          for (let i = dropdowns.length - 1; i >= 0; i -= 1) {
            const option = Array.from(dropdowns[i].querySelectorAll('li[role="option"], [role="option"]'))
              .find((el) => {
                if (!isVisible(el)) return false;
                if (el.getAttribute('data-disabled') === 'true') return false;
                const text = normalizeText(el.innerText || el.textContent);
                return Boolean(text) && !/请选择|搜索|请输入/.test(text);
              });
            if (option) return option;
          }

          return null;
        };

        const classificationInput = await waitForElement(classificationSelector);
        if (!classificationInput) {
          return { ok: false, error: '未找到 SKU 分类下拉框。' };
        }

        await click(classificationInput);
        await sleep(500);

        let option = null;
        for (let i = 0; i < 20; i += 1) {
          option = findFirstOption();
          if (option) break;
          await sleep(300);
        }

        if (!option) {
          return { ok: false, error: '未找到 SKU 分类第一个可选项。' };
        }

        await click(option);
        await sleep(300);

        const packIncludeInput = await waitForElement(packIncludeSelector);
        if (!packIncludeInput) {
          return { ok: false, error: '未找到“共计内含”输入框。' };
        }

        await setInputValue(packIncludeInput, nextValues.packInclude);

        return {
          ok: true,
          values: nextValues,
        };
      },
      args: [
        TEMU_SKU_CLASSIFICATION_INPUT_SELECTOR,
        TEMU_PACK_INCLUDE_INPUT_SELECTOR,
        values,
      ],
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: 'SKU 分类/共计内含填写脚本未返回结果。' });
    });
  });
}

/**
 * 填写建议零售价和币种测试数据。
 * @param {number} tabId
 * @param {{price: string, currency: string}} values
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function fillTemuGoodsSuggestSalesPrice(tabId, values) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (priceSelector, currencySelector, nextValues) => {
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        };
        const waitForElement = async (selector, tries = 20, interval = 500) => {
          for (let i = 0; i < tries; i += 1) {
            const element = document.querySelector(selector);
            if (element) return element;
            await sleep(interval);
          }
          return null;
        };
        const click = async (el) => {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          await sleep(200);
          el.focus?.();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          await sleep(80);
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          el.click();
        };
        const setInputValue = async (input, value) => {
          input.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          await sleep(150);
          input.focus();
          input.select?.();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(input, String(value));
          } else {
            input.value = String(value);
          }
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: String(value),
          }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
        };
        const findCurrencyOption = (currency) => {
          const dropdowns = Array.from(document.querySelectorAll(
            'ul[role="listbox"].ST_dropdownPanel_5-120-1, ul[role="listbox"], [role="listbox"]'
          )).filter(isVisible);

          for (let i = dropdowns.length - 1; i >= 0; i -= 1) {
            const option = Array.from(dropdowns[i].querySelectorAll('li[role="option"], [role="option"]'))
              .find((el) => {
                if (!isVisible(el)) return false;
                if (el.getAttribute('data-disabled') === 'true') return false;
                const text = normalizeText(el.innerText || el.textContent);
                return text === currency || text.startsWith(`${currency}（`) || text.startsWith(`${currency}(`);
              });
            if (option) return option;
          }

          return null;
        };

        const priceInput = await waitForElement(priceSelector);
        if (!priceInput) {
          return { ok: false, error: '未找到建议零售价输入框。' };
        }
        await setInputValue(priceInput, nextValues.price);
        await sleep(300);

        const currencyInput = await waitForElement(currencySelector);
        if (!currencyInput) {
          return { ok: false, error: '未找到建议零售价币种下拉框。' };
        }
        await click(currencyInput);
        await sleep(500);

        let option = null;
        for (let i = 0; i < 20; i += 1) {
          option = findCurrencyOption(nextValues.currency);
          if (option) break;
          await sleep(300);
        }

        if (!option) {
          return { ok: false, error: `未找到建议零售价币种选项：${nextValues.currency}` };
        }

        await click(option);
        return {
          ok: true,
          values: nextValues,
        };
      },
      args: [
        TEMU_SUGGEST_SALES_PRICE_INPUT_SELECTOR,
        TEMU_SUGGEST_SALES_PRICE_CURRENCY_INPUT_SELECTOR,
        values,
      ],
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: '建议零售价填写脚本未返回结果。' });
    });
  });
}

/**
 * 勾选“我已阅读并同意”。
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function checkTemuGoodsAgreement(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (selector) => {
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        let checkbox = null;
        for (let i = 0; i < 20; i += 1) {
          checkbox = document.querySelector(selector);
          if (checkbox) break;
          await sleep(500);
        }

        if (!checkbox) {
          return { ok: false, error: '未找到“我已阅读并同意”复选框。' };
        }

        checkbox.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        await sleep(200);

        if (!checkbox.checked) {
          checkbox.click();
          checkbox.dispatchEvent(new Event('input', { bubbles: true }));
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return { ok: true, checked: checkbox.checked };
      },
      args: [TEMU_AGREEMENT_CHECKBOX_SELECTOR],
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: '协议勾选脚本未返回结果。' });
    });
  });
}

/**
 * 点击商品创建按钮。
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function clickTemuGoodsCreateButton(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (selector) => {
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        const isEnabled = (button) => button
          && !button.disabled
          && button.getAttribute('aria-disabled') !== 'true'
          && !button.className.includes('disabled')
          && !button.className.includes('BTN_disabled');

        let button = null;
        for (let i = 0; i < 30; i += 1) {
          button = document.querySelector(selector);
          if (isEnabled(button)) break;
          await sleep(500);
        }

        if (!button) {
          return { ok: false, error: '未找到创建按钮。' };
        }

        if (!isEnabled(button)) {
          return { ok: false, error: '创建按钮仍处于不可点击状态。' };
        }

        button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        await sleep(300);
        button.click();

        return { ok: true };
      },
      args: [TEMU_CREATE_BUTTON_SELECTOR],
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: '创建按钮点击脚本未返回结果。' });
    });
  });
}

/**
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<void>}
 */
async function focusTab(tab) {
  if (tab.windowId) {
    await new Promise((resolve) => chrome.windows.update(tab.windowId, { focused: true }, () => resolve()));
  }
  if (tab.id) {
    await new Promise((resolve) => chrome.tabs.update(tab.id, { active: true }, () => resolve()));
  }
}

/**
 * 在页面中只做坐标测量，不做 DOM click。
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, goodsId?: string, x?: number, y?: number, error?: string}>}
 */
function locateOneClickListingTarget(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selectors = [
          '.gdyqmod',
          'div > div > div.title-bar > div > div.item.yjsj',
        ];
        const goodsId = String(location.href || '').match(/-g-(\d+)\.html/)?.[1] || '';
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();

        for (const selector of selectors) {
          const element = Array.from(document.querySelectorAll(selector)).find((el) => {
            if (!isVisible(el)) return false;
            if (selector === '.gdyqmod') return true;
            const text = normalizeText(el.innerText || el.textContent);
            return !text || text === '一键上架' || text.includes('一键上架');
          });
          if (!element) continue;

          element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          const rect = element.getBoundingClientRect();
          const point = selector === '.gdyqmod'
            ? {
                // .gdyqmod 是 closed shadow host，真实的 .item.yjsj 在右上角 title-bar 内。
                // 不能 query closed shadowRoot，所以按 host 右上角的按钮位置点击。
                x: rect.right - Math.min(62, Math.max(38, rect.width * 0.055)),
                y: rect.top + Math.min(28, Math.max(18, rect.height * 0.08)),
              }
            : {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
              };
          return {
            ok: true,
            goodsId,
            selector,
            x: point.x,
            y: point.y,
            width: rect.width,
            height: rect.height,
          };
        }

        return {
          ok: false,
          goodsId,
          error: '页面中没有找到 .gdyqmod 或 一键上架 按钮。',
        };
      },
    }, (results) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(results?.[0]?.result || { ok: false, error: '坐标测量失败。' });
    });
  });
}

/**
 * @param {number} tabId
 * @param {number} x
 * @param {number} y
 * @returns {Promise<void>}
 */
async function dispatchDebuggerClick(tabId, x, y) {
  const debuggee = { tabId };
  await attachDebugger(debuggee);
  try {
    await sendDebuggerCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
    });
    await delay(120);
    await sendDebuggerCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await delay(90);
    await sendDebuggerCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await detachDebugger(debuggee);
  }
}

/**
 * @param {chrome.debugger.Debuggee} debuggee
 * @returns {Promise<void>}
 */
function attachDebugger(debuggee) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(debuggee, '1.3', () => {
      const message = chrome.runtime.lastError?.message;
      if (message) {
        reject(new Error(`无法启用浏览器级点击：${message}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * @param {chrome.debugger.Debuggee} debuggee
 * @returns {Promise<void>}
 */
function detachDebugger(debuggee) {
  return new Promise((resolve) => {
    chrome.debugger.detach(debuggee, () => resolve());
  });
}

/**
 * @param {chrome.debugger.Debuggee} debuggee
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<unknown>}
 */
function sendDebuggerCommand(debuggee, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params, (result) => {
      const message = chrome.runtime.lastError?.message;
      if (message) {
        reject(new Error(message));
        return;
      }
      resolve(result);
    });
  });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 清理 Temu 相关浏览器站点数据，用于手动跳转商品详情前降低旧会话/风控状态影响。
 * 覆盖范围：
 *   - 已打开 Temu 标签页内的 sessionStorage/localStorage/Cache/IndexedDB/Service Worker；
 *   - Chrome 持久化的 temu.com Cookie；
 *   - temu.com / www.temu.com origin 下的缓存、LocalStorage、IndexedDB、CacheStorage、Service Worker。
 * @returns {Promise<{ok: boolean, details: Record<string, number>}>}
 */
async function clearTemuSiteData() {
  const tabs = await queryTabs(TEMU_TAB_QUERY);
  const tabResults = await Promise.allSettled(
    tabs
      .filter((tab) => tab.id)
      .map((tab) => clearTemuTabStorage(tab.id))
  );
  const tabStorageCleared = tabResults
    .filter((result) => result.status === 'fulfilled')
    .reduce((total, result) => total + (result.value?.framesCleared || 0), 0);

  const cookieCount = await clearTemuCookies();
  await removeTemuBrowsingData();

  return {
    ok: true,
    details: {
      tabs: tabs.length,
      framesCleared: tabStorageCleared,
      localStorage: true,
      sessionStorage: true,
      cookies: cookieCount,
    },
  };
}

/**
 * 在已打开的 Temu 标签页里清理会话级数据。sessionStorage 只能在页面上下文中清。
 * @param {number} tabId
 * @returns {Promise<{framesCleared: number}>}
 */
function clearTemuTabStorage(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async () => {
        try { window.sessionStorage.clear(); } catch (_) {}
        try { window.localStorage.clear(); } catch (_) {}
        try {
          if (window.caches?.keys) {
            const keys = await window.caches.keys();
            await Promise.all(keys.map((key) => window.caches.delete(key)));
          }
        } catch (_) {}
        try {
          if (navigator.serviceWorker?.getRegistrations) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((registration) => registration.unregister()));
          }
        } catch (_) {}
        try {
          if (indexedDB.databases) {
            const databases = await indexedDB.databases();
            databases.forEach((database) => {
              if (database.name) indexedDB.deleteDatabase(database.name);
            });
          }
        } catch (_) {}
        return {
          localStorage: true,
          sessionStorage: true,
        };
      },
    }, (results) => {
      resolve({
        framesCleared: Array.isArray(results) ? results.length : 0,
      });
    });
  });
}

/**
 * 删除所有 domain 命中 temu.com 的 Cookie，包含 .temu.com 与子域 Cookie。
 * @returns {Promise<number>}
 */
function clearTemuCookies() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain: 'temu.com' }, async (cookies) => {
      const removals = cookies.map((cookie) => removeCookie(cookie));
      await Promise.allSettled(removals);
      resolve(cookies.length);
    });
  });
}

/**
 * @param {chrome.cookies.Cookie} cookie
 * @returns {Promise<void>}
 */
function removeCookie(cookie) {
  return new Promise((resolve) => {
    const domain = cookie.domain.replace(/^\./, '');
    const path = cookie.path || '/';
    const scheme = cookie.secure ? 'https' : 'http';
    chrome.cookies.remove({
      url: `${scheme}://${domain}${path}`,
      name: cookie.name,
      storeId: cookie.storeId,
    }, () => resolve());
  });
}

/**
 * 清除 Chrome 持久化的 origin 级站点数据。
 * @returns {Promise<void>}
 */
function removeTemuBrowsingData() {
  return new Promise((resolve, reject) => {
    chrome.browsingData.remove({
      origins: TEMU_BROWSING_DATA_ORIGINS,
    }, {
      cacheStorage: true,
      cookies: true,
      fileSystems: true,
      indexedDB: true,
      localStorage: true,
      serviceWorkers: true,
      webSQL: true,
    }, () => {
      const message = chrome.runtime.lastError?.message;
      if (message) {
        reject(new Error(message));
        return;
      }
      resolve();
    });
  });
}

/**
 * 当 Temu 详情页 tab 数量超过 maxCount 时，关闭最旧的若干个，只保留最近的 maxCount 个。
 * 判断依据：URL 匹配 temu.com 且是商品详情页（含 -g-数字.html 模式）。
 * 按 lastAccessed 升序排列，优先关闭最久未访问的。
 * @param {number} maxCount 最多保留的 detail tab 数量
 * @returns {Promise<{ok: boolean, closed: number, remaining: number}>}
 */
async function pruneTemuDetailTabs(maxCount) {
  const limit = typeof maxCount === 'number' && maxCount > 0 ? maxCount : 1;
  const allTemuTabs = await queryTabs(TEMU_TAB_QUERY);

  // 只处理详情页
  const detailTabs = allTemuTabs.filter((tab) => isTemuProductDetailUrl(tab.url));

  if (detailTabs.length <= limit) {
    return { ok: true, closed: 0, remaining: detailTabs.length };
  }

  // 按 lastAccessed 升序（最旧在前），关闭超出部分
  const sorted = [...detailTabs].sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));
  const toClose = sorted.slice(0, sorted.length - limit);
  const tabIds = toClose.map((tab) => tab.id).filter(Boolean);

  await new Promise((resolve) => {
    chrome.tabs.remove(tabIds, () => resolve());
  });

  return { ok: true, closed: tabIds.length, remaining: detailTabs.length - tabIds.length };
}

/**
 * Promise 版 chrome.tabs.query 封装。MV3 的 chrome.tabs.query 仍是回调式，
 * 这里统一包一层便于 async/await。
 * @param {chrome.tabs.QueryInfo} queryInfo
 * @returns {Promise<chrome.tabs.Tab[]>}
 */
function queryTabs(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

/**
 * 把 chrome.runtime.lastError.message 翻译成用户能看懂的中文提示。
 * 三种常见错误：
 *   - "Receiving end does not exist" → content script 没注入，提示刷新；
 *   - "cannot access contents of url" → 非 Temu 域或特殊 URL（如 chrome-extension://）；
 *   - "message port closed" → 页面在跳转/刷新中，通信被中断。
 * 其余错误透传原始 message，便于日志诊断。
 * @param {string} runtimeMessage
 * @param {chrome.tabs.Tab} tab
 * @returns {string}
 */
function mapTabMessageError(runtimeMessage, tab) {
  if (/Receiving end does not exist/i.test(runtimeMessage)) {
    return `Temu 页面未注入扩展脚本，请刷新当前页面后重试。当前标签页：${tab.url || 'unknown'}`;
  }
  if (/cannot access contents of url/i.test(runtimeMessage)) {
    return '当前页面暂不支持注入扩展脚本，请切到普通的 temu.com 商品页面后重试。';
  }
  if (/The message port closed before a response was received/i.test(runtimeMessage)) {
    return 'Temu 页面响应中断，可能刚发生跳转或刷新，请稍后再试。';
  }
  return `Temu 页面通信失败：${runtimeMessage || 'unknown error'}`;
}

/**
 * 后端 HTTP 动作分发器。只有三个动作：
 *   - backendStartRun：开启一次 run（领 runUuid 回来，后续所有数据都关联这个 uuid）；
 *   - backendUploadBatch：批量上传 items/edges；
 *   - backendFinishRun：标记 run 结束并写最终统计。
 * 所有 action 都是 POST，payload 来自 content.js。
 * @param {{action: string, payload?: Record<string, unknown>, runUuid?: string}} msg
 * @returns {Promise<{ok: boolean, error?: string, [k: string]: unknown}>}
 */
async function handleBackendAction(msg) {
  if (msg.action === 'backendStartRun') {
    return postJson('/api/runs/start', {});
  }

  if (msg.action === 'backendUploadBatch') {
    return postJson('/api/upload/batch', msg.payload || {});
  }

  if (msg.action === 'backendFinishRun') {
    const runUuid = msg.runUuid;
    if (!runUuid) return { ok: false, error: '缺少 runUuid' };
    return postJson(`/api/runs/${encodeURIComponent(runUuid)}/finish`, msg.payload || {});
  }

  if (msg.action === 'fetchExclusionKeywords') {
    return getJson('/api/config/exclusion-keywords');
  }

  return { ok: false, error: '未知后端动作' };
}

/**
 * 统一的 POST JSON helper。要点：
 *   - 先拿 text 再尝试 JSON.parse，后端返回非 JSON（比如 500 HTML 错误页）时把 raw 字符串带回；
 *   - response.ok=false 时，优先使用 FastAPI 风格的 `detail`/`error` 字段，兜底给状态码；
 *   - 成功时把后端 JSON 展开到返回对象（保留 `ok:true`），content.js 能直接取 `response.run_uuid` 等字段。
 * 注意 SW fetch 不走页面的 CORS —— Temu 本身不允许从页面调 localhost，因此必须放在 SW 这一层。
 * @param {string} path
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{ok: boolean, status?: number, error?: string, data?: unknown, [k: string]: unknown}>}
 */
async function postJson(path, payload) {
  const headers = {
    'Content-Type': 'application/json',
    ...(await authHeaders()),
  };
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload || {}),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    if (response.status === 401) {
      await clearAuth();
    }
    return {
      ok: false,
      status: response.status,
      error: data.detail || data.error || `请求失败: ${response.status}`,
      data,
    };
  }

  return {
    ok: true,
    ...data,
  };
}

/**
 * 统一的 GET JSON helper。与 postJson 逻辑相同，不带 body。
 * @param {string} path
 * @returns {Promise<{ok: boolean, status?: number, error?: string, [k: string]: unknown}>}
 */
async function getJson(path) {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    headers: {
      ...(await authHeaders()),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    if (response.status === 401) {
      await clearAuth();
    }
    return {
      ok: false,
      status: response.status,
      error: data.detail || data.error || `请求失败: ${response.status}`,
      data,
    };
  }

  return {
    ok: true,
    ...data,
  };
}
