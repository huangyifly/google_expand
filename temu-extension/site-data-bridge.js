/**
 * 后台商品页桥接脚本。
 * 普通网页不能直接调用 chrome.browsingData；这里只在受信任的后台页面中监听
 * window.postMessage，再转发给扩展 background 执行 Temu 站点数据清理。
 */

const TEMU_CLEAR_REQUEST = 'TEMU_EXTENSION_CLEAR_SITE_DATA';
const TEMU_CLEAR_RESPONSE = 'TEMU_EXTENSION_CLEAR_SITE_DATA_RESULT';

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== TEMU_CLEAR_REQUEST) return;

  chrome.runtime.sendMessage({ action: 'clearTemuSiteData' }, (response) => {
    const runtimeError = chrome.runtime.lastError?.message;
    window.postMessage({
      type: TEMU_CLEAR_RESPONSE,
      requestId: event.data.requestId,
      ok: Boolean(response?.ok) && !runtimeError,
      error: runtimeError || response?.error || '',
      details: response?.details || null,
    }, window.location.origin);
  });
});
