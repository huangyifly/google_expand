import type { ExtensionState, WorkflowSnapshot, WorkflowState } from './types';

/**
 * 轻量级有限状态机定义。
 * 这里不依赖任何外部库，便于在 content/popup/background 之间复用。
 */
// 重构后：详情页也会被视为"商品流入口"，允许 DETAIL_SCRAPE / RELATED_SCAN 直接
// 回到 LIST_DISCOVERY 做联想区扫描；允许 LIST_DISCOVERY 直接切到 DETAIL_SCRAPE
// 以支持"列表页 URL 含商品锚点 → 补齐字段"的新路径。
const TRANSITION_MAP: Record<WorkflowState, WorkflowState[]> = {
  LIST_DISCOVERY: ['TARGET_SELECTED', 'DETAIL_SCRAPE', 'PAUSE', 'WIND_CONTROL'],
  TARGET_SELECTED: ['NAVIGATE_TO_DETAIL', 'LIST_DISCOVERY', 'PAUSE', 'WIND_CONTROL'],
  NAVIGATE_TO_DETAIL: ['DETAIL_SCRAPE', 'LIST_DISCOVERY', 'PAUSE', 'WIND_CONTROL'],
  DETAIL_SCRAPE: ['RELATED_SCAN', 'EDGE_COLLECT', 'LIST_DISCOVERY', 'TARGET_SELECTED', 'PAUSE', 'WIND_CONTROL'],
  RELATED_SCAN: ['EDGE_COLLECT', 'TARGET_SELECTED', 'LIST_DISCOVERY', 'PAUSE', 'WIND_CONTROL'],
  EDGE_COLLECT: ['TARGET_SELECTED', 'LIST_DISCOVERY', 'DETAIL_SCRAPE', 'PAUSE', 'WIND_CONTROL'],
  PAUSE: ['LIST_DISCOVERY', 'TARGET_SELECTED', 'DETAIL_SCRAPE', 'WIND_CONTROL'],
  WIND_CONTROL: ['PAUSE', 'LIST_DISCOVERY', 'DETAIL_SCRAPE']
};

export function getCurrentState(state: Pick<ExtensionState, 'workflow'>): WorkflowState {
  return state.workflow.current;
}

/**
 * 判断两个状态之间是否允许直接迁移。
 * popup/debug panel 在切换状态前都应先调用它。
 */
export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (from === to) return true;
  return TRANSITION_MAP[from]?.includes(to) ?? false;
}

/**
 * 生成新的状态快照。
 * 默认会清掉 manualInterventionRequired，只有显式传 true 才表示仍然需要人工介入。
 */
export function transitionTo(
  snapshot: WorkflowSnapshot,
  next: WorkflowState,
  options: {
    reason?: string;
    force?: boolean;
    manualInterventionRequired?: boolean;
    now?: string;
  } = {}
): WorkflowSnapshot {
  if (!options.force && !canTransition(snapshot.current, next)) {
    throw new Error(`Invalid workflow transition: ${snapshot.current} -> ${next}`);
  }

  return {
    current: next,
    previous: snapshot.current,
    updatedAt: options.now ?? new Date().toISOString(),
    reason: options.reason ?? '',
    manualInterventionRequired: options.manualInterventionRequired ?? false
  };
}
