/**
 * 工作流状态。
 * 这里刻意保持字符串字面量，便于直接持久化到 chrome.storage.local。
 */
export type WorkflowState =
  | 'LIST_DISCOVERY'
  | 'TARGET_SELECTED'
  | 'NAVIGATE_TO_DETAIL'
  | 'DETAIL_SCRAPE'
  | 'RELATED_SCAN'
  | 'EDGE_COLLECT'
  | 'PAUSE'
  | 'WIND_CONTROL';

export type CollectionMode = 'CONSERVATIVE' | 'AGGRESSIVE';
export type TaskMode = 'DISCOVERY' | 'HARVEST' | 'GRAPH';

/**
 * 用于 popup / debug panel / background 同步展示的轻量状态快照。
 */
export interface WorkflowSnapshot {
  current: WorkflowState;
  previous: WorkflowState | '';
  updatedAt: string;
  reason: string;
  manualInterventionRequired: boolean;
}

/**
 * 插件可配置项。
 * 新增的 collectionMode 与 taskMode 用于决定自动化强度和任务阶段。
 */
export interface ExtensionConfig {
  intervalSec: number;
  batchSize: number;
  totalLimit: number;
  autoClickV1: boolean;
  autoClickLoadMore: boolean;
  showDebugPanel: boolean;
  collectionMode: CollectionMode;
  taskMode: TaskMode;
}

/**
 * 统计信息仅保留面板展示所需的最小集合，避免 storage 中的对象过重。
 */
export interface ExtensionStats {
  listingTotal: number;
  detailDone: number;
  cycles: number;
  relatedAdded: number;
}

/**
 * 这里是 popup/background/content 三端共享的最小运行时状态。
 */
export interface ExtensionState {
  running: boolean;
  phase: string;
  config: ExtensionConfig;
  workflow: WorkflowSnapshot;
  runUuid: string;
}
