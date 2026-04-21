/**
 * 上传模块
 * 批量上传数据到后端
 */

import { UPLOAD_BATCH_SIZE } from '../constants/index.js';
import { getState, patchState } from '../state/index.js';
import { callRuntime, getNormalizedPageType } from '../messaging/index.js';

/** 上传进行中标志 */
let uploadInFlight = false;

// ─── 数据入队 ─────────────────────────────────────────────────────

/**
 * 将商品推入上传队列
 * @param {Array} items 商品列表
 * @param {string} pageType 页面类型
 */
export async function enqueueUploadItems(items, pageType) {
  const payloadItems = items
    .filter((item) => item?.goodsId)
    .map((item) => ({
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
    }));

  if (!payloadItems.length) return;

  const state = await getState();
  await patchState({
    pendingUploadItems: [...(state.pendingUploadItems || []), ...payloadItems],
  });

  await uploadPendingBatch(false);
}

/**
 * 将边关系推入上传队列
 * @param {Array} edges 边列表
 */
export async function enqueueUploadEdges(edges) {
  if (!edges.length) return;
  const state = await getState();
  await patchState({
    pendingUploadEdges: [...(state.pendingUploadEdges || []), ...edges],
  });
  await uploadPendingBatch(false);
}

// ─── 批量上传 ─────────────────────────────────────────────────────

/**
 * 执行批量上传
 * @param {boolean} force 是否强制上传 (忽略阈值)
 * @returns {Promise<boolean>} 是否成功
 */
export async function uploadPendingBatch(force = false) {
  if (uploadInFlight) return false;

  const state = await getState();
  const pendingItems = state.pendingUploadItems || [];
  const pendingEdges = state.pendingUploadEdges || [];
  const totalPending = pendingItems.length + pendingEdges.length;

  if (!totalPending) return true;
  if (!force && pendingItems.length < UPLOAD_BATCH_SIZE) return false;

  uploadInFlight = true;

  // 切片
  const batchItems = pendingItems.slice(0, force ? pendingItems.length : UPLOAD_BATCH_SIZE);
  const edgeTakeCount = force
    ? pendingEdges.length
    : Math.min(pendingEdges.length, Math.max(batchItems.length * 2, 20));
  const batchEdges = pendingEdges.slice(0, edgeTakeCount);

  // 调用后端
  const response = await callRuntime('backendUploadBatch', {
    payload: {
      run_uuid: state.runUuid || null,
      page_type: getNormalizedPageType(),
      items: batchItems,
      edges: batchEdges,
    },
  });

  // 成功后从队列移除
  if (response?.ok) {
    const latest = await getState();
    await patchState({
      pendingUploadItems: (latest.pendingUploadItems || []).slice(batchItems.length),
      pendingUploadEdges: (latest.pendingUploadEdges || []).slice(batchEdges.length),
    });
  }

  uploadInFlight = false;
  return Boolean(response?.ok);
}

/**
 * 结束后端运行
 * @param {string} status 状态
 * @param {number | null} totalCollected 总数
 */
export async function finishBackendRun(status, totalCollected = null) {
  const state = await getState();
  if (!state.runUuid) return;

  await callRuntime('backendFinishRun', {
    runUuid: state.runUuid,
    payload: {
      status,
      total_collected: totalCollected,
    },
  });
}
