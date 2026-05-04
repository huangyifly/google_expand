/**
 * 采集流程追踪模块
 *
 * 职责：在每个决策节点记录"为什么这么做"，按 runId 分组存储，
 * 支持运行结束后下载为 .jsonl 文件供离线排查。
 *
 * 使用方式：
 *   traceNode('main', 'batch_gate', '本批未满，继续扫描', { batchLoaded: 45, batchSize: 100 }, '→ productStreamTick()');
 *
 * 存储格式：chrome.storage.local  key = temu_trace_{runId}
 *   每条记录：{ ts, runId, seq, layer, node, why, params, outcome }
 *
 * 下载：通过 background.js 的 downloadTraceLog 消息触发
 */

const TRACE_KEY_PREFIX = 'temu_trace_';
const TRACE_FLUSH_INTERVAL_MS = 2000;
const TRACE_MAX_ENTRIES = 3000;

let _runId = '';
let _seq = 0;
let _buffer = [];
let _flushTimer = null;

/**
 * 初始化追踪器，在 run 开始时调用
 * @param {string} runId
 */
export function initTrace(runId) {
  _runId = runId || '';
  _seq = 0;
  _buffer = [];
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
}

/**
 * 记录一个决策节点
 *
 * @param {string} layer  所在层级：'main' | 'stream' | 'filter' | 'detail' | 'upload'
 * @param {string} node   节点名称，唯一标识这个决策点
 * @param {string} why    中文说明：为什么走这条路（依据什么条件）
 * @param {object} params 当时的关键参数快照
 * @param {string} outcome 执行结果：走向哪个分支 / 调用了什么函数
 */
export function traceNode(layer, node, why, params = {}, outcome = '') {
  if (!_runId) return;
  _seq += 1;
  _buffer.push({
    ts: new Date().toISOString(),
    runId: _runId,
    seq: _seq,
    layer,
    node,
    why,
    params,
    outcome,
  });
  _scheduleFlush();
}

/**
 * 立即将缓冲区写入 storage（run 结束时调用）
 */
export async function flushTrace() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  await _writeBuffer();
}

/**
 * 从 storage 删除指定 run 的追踪数据
 * @param {string} runId
 */
export function clearTrace(runId) {
  const key = TRACE_KEY_PREFIX + (runId || _runId);
  chrome.storage.local.remove([key]);
}

// ── 内部实现 ──────────────────────────────────────────────────────────

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    _writeBuffer();
  }, TRACE_FLUSH_INTERVAL_MS);
}

async function _writeBuffer() {
  if (!_runId || _buffer.length === 0) return;
  const key = TRACE_KEY_PREFIX + _runId;
  const toWrite = [..._buffer];
  _buffer = [];

  const existing = await new Promise((resolve) =>
    chrome.storage.local.get([key], (r) => resolve(r[key] || []))
  );
  const combined = [...existing, ...toWrite].slice(-TRACE_MAX_ENTRIES);
  await new Promise((resolve) => chrome.storage.local.set({ [key]: combined }, resolve));
}
