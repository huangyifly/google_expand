/**
 * 状态管理模块
 * 负责状态的读取、写入、更新
 */

import { STORE_KEY } from '../constants/index.js';
import {
  COLLECTION_MODES,
  TASK_MODES,
  FSM_STATES,
} from '../constants/index.js';
import { nowIsoText } from '../utils/index.js';

// ─── 状态模板 ─────────────────────────────────────────────────────

/**
 * 生成一份空白状态快照
 * 用于初次启动或重置
 * @returns {object}
 */
export function defaultState() {
  return {
    // 运行状态
    running: false,
    phase: 'idle',

    // 配置项
    config: {
      intervalSec: 10,
      batchSize: 300,
      totalLimit: 10000,
      autoClickV1: false,
      autoClickLoadMore: false,
      showDebugPanel: false,
      collectionMode: COLLECTION_MODES.CONSERVATIVE,
      taskMode: TASK_MODES.DISCOVERY,
    },

    // 工作流状态
    workflow: {
      current: FSM_STATES.LIST_DISCOVERY,
      previous: '',
      updatedAt: '',
      reason: '',
      manualInterventionRequired: false,
    },

    // 运行标识
    runUuid: '',
    listingUrl: '',
    lastDiscoveryUrl: '',

    // 采集数据
    collected: [],
    pendingUploadItems: [],
    pendingUploadEdges: [],
    processedIds: [],
    targetQueue: [],

    // 断点续传
    lastSweptGoodsId: '',
    batchStartCount: 0,
    batchAnchorUrl: '',

    // 统计信息
    stats: {
      listingTotal: 0,
      detailDone: 0,
      cycles: 0,
      relatedAdded: 0,
    },
  };
}

// ─── 内存缓存 ─────────────────────────────────────────────────────

/** 内存中的状态缓存，避免频繁读取 storage */
let lastKnownState = defaultState();

// ─── 状态读取 ─────────────────────────────────────────────────────

/**
 * 从 chrome.storage.local 读取完整状态快照
 * 并更新内存缓存
 * @returns {Promise<object>}
 */
export async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORE_KEY], (result) => {
      lastKnownState = result[STORE_KEY] || defaultState();
      resolve(lastKnownState);
    });
  });
}

/**
 * 同步读取内存缓存中的状态
 * 不会触发异步 storage 读取
 * @returns {object}
 */
export function getStateSnapshot() {
  return lastKnownState;
}

/**
 * 同步读取 workflow 分片
 * @returns {object}
 */
export function getStateSnapshotWorkflow() {
  return lastKnownState.workflow || defaultState().workflow;
}

/**
 * 同步读取 config 分片
 * @returns {object}
 */
export function getStateSnapshotConfig() {
  return lastKnownState.config || defaultState().config;
}

// ─── 状态写入 ─────────────────────────────────────────────────────

/**
 * 增量更新状态
 * 会自动合并 config/stats/workflow 子对象
 * @param {Partial<object>} updates 要更新的字段
 * @returns {Promise<void>}
 */
export async function patchState(updates) {
  const current = await getState();
  const next = { ...current, ...updates };

  // 二级合并
  if (updates.config) next.config = { ...current.config, ...updates.config };
  if (updates.stats) next.stats = { ...current.stats, ...updates.stats };
  if (updates.workflow) {
    next.workflow = { ...current.workflow, ...updates.workflow };
  }

  lastKnownState = next;

  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORE_KEY]: next }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // 记录写入失败，便于排查
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
 * 清空所有状态
 * @returns {Promise<void>}
 */
export async function clearState() {
  lastKnownState = defaultState();
  return new Promise((resolve) => {
    chrome.storage.local.remove([STORE_KEY], resolve);
  });
}
