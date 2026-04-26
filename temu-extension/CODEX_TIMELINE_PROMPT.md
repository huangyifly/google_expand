# Task: Add a Real-Time Action Timeline Overlay to content.js

## Background

This is a Chrome extension content script (`content.js`) for scraping Temu product data.
It is a single self-contained file with no ES module imports — everything is in one global scope.

The script drives a finite-state machine (FSM) that loops through these phases:
```
main() → productStreamTick() → runInitialFilter() → highlightPendingItem() → performAutoClickV1() → [URL changes] → main() again
```

Currently debugging is very difficult. We need a visible, real-time action timeline panel
injected into the page so we can trace every step without opening DevTools.

---

## What to Build

### 1. Data Layer — `logAction(level, label, detail)`

Add a circular buffer and a `logAction` function **near the top of the file**, after the existing
constants and before `mainLock`:

```js
const TIMELINE_LOG_LIMIT = 50;
let timelineEntries = []; // [{id, time, level, label, detail, expanded}]

/**
 * Record one action entry and re-render the timeline panel.
 * @param {'info'|'warn'|'error'} level
 * @param {string} label  — one Chinese sentence summarising what happened
 * @param {object} [detail] — raw data shown on expand (optional)
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
    timelineEntries.unshift(entry); // newest first
    if (timelineEntries.length > TIMELINE_LOG_LIMIT) {
        timelineEntries.pop();
    }
    renderTimelinePanel();
}
```

---

### 2. UI Layer — Shadow DOM floating panel

Add two functions: `ensureTimelinePanel()` and `renderTimelinePanel()`.

#### `ensureTimelinePanel()`

Injects a host `<div id="temu-timeline-host">` into `document.body` with a Shadow DOM.
The Shadow DOM contains:
- A `<style>` block (scoped, Temu CSS cannot bleed in)
- A wrapper `#tl-wrap` containing:
  - A header bar with title "📋 操作时间线" and a minimize button "—"
  - A scrollable `#tl-list` for entries

Panel position: `fixed`, `bottom: 16px`, `right: 16px`, `width: 320px`, `z-index: 2147483647`.

When minimized, hide `#tl-list` and show only the header (acts as a compact badge).
Clicking the minimize button toggles this state.

Style guidelines:
- Background: `#1a1a1a`, text: `#e0e0e0`, border-radius: `8px`, `font-size: 12px`, `font-family: monospace`
- `info` entries: left border `#4a9eff` (blue)
- `warn` entries: left border `#f5a623` (yellow), label color `#f5a623`
- `error` entries: left border `#e74c3c` (red), label color `#e74c3c`
- Each entry has `3px solid` left border, `padding: 6px 8px`, `cursor: pointer`
- Clicking an entry toggles expanded state showing `detail` as formatted JSON in a `<pre>` block

#### `renderTimelinePanel()`

Called after every `logAction`. Calls `ensureTimelinePanel()` first, then replaces the
`#tl-list` innerHTML with the current `timelineEntries` rendered as list items.
Each item: `[HH:MM:SS] label` on one line, expandable JSON below.

---

### 3. Instrumentation — where to call `logAction`

Add `logAction(...)` calls at **every** decision point listed below.
Do NOT remove or change any existing logic — only add `logAction` calls alongside existing code.

#### `main()`

| Location in function | level | label template |
|---|---|---|
| Top, after `getState()`, if `!state.running` | `'warn'` | `'main() 跳过：采集未启动'` |
| After page type check, if `getPageType() === 'other'` | `'warn'` | `'非 Temu 页面，准备跳回：${fallback || "无记录"}'` |
| After URL change detection, if URL changed | `'info'` | `'新页面进入，重置 batch 计数（原 collected=${state.collected.length}）'` detail: `{newUrl: location.href, batchStartCount: state.collected.length}` |
| After `scrapeAndUpsertCurrentProduct()` call site (if `hasCurrentProductAnchor()`) | `'info'` | `'当前页是商品详情，触发主商品字段补全'` |
| batchFull check, if `!batchFull` | `'info'` | `'本批未满（${batchLoaded}/${refreshed.config.batchSize}），进入商品流扫描'` detail: `{batchLoaded, batchSize: refreshed.config.batchSize, total: refreshed.collected.length}` |
| batchFull check, if `batchFull && targetQueue.length > 0` | `'info'` | `'本批已满，队列已有目标（${refreshed.targetQueue.length} 条），直接高亮等跳转'` detail: `{goodsId: nextItem.goodsId, queueLen: refreshed.targetQueue.length}` |
| batchFull check, if `batchFull && targetQueue.length === 0` | `'info'` | `'本批已满，队列为空，进入商品流发现挑选目标'` detail: `{batchLoaded, total: refreshed.collected.length}` |

#### `productStreamTick()`

| Location | level | label template |
|---|---|---|
| Top, after `enumerateProductStreams()` | `'info'` | `'商品流扫描开始，发现 ${streams.length} 条流'` detail: `{streamIds: streams.map(s=>s.id)}` |
| Per stream, if `!ready` | `'warn'` | `'流 [${stream.id}] 未就绪，跳过'` |
| Per stream, after `processStream`, after `upsertItems` | `'info'` | `'流 [${stream.id}] 扫描完成：发现 ${items.length} 条，新增 ${added} 条，删本地仓 ${removed} 条'` detail: `{scraped: items.length, added, removed, streamId: stream.id}` |
| After all streams, batchFull branch | `'info'` | `'本批已满（${batchLoaded}/${refreshed.config.batchSize}），进入初筛'` detail: `{batchLoaded, total: refreshed.collected.length}` |
| After scroll to bottom, if `loadMoreBtn` found, auto mode | `'info'` | `'找到"查看更多"按钮，${shouldAuto ? "即将自动点击" : "等待手动点击"}'` |
| If no `loadMoreBtn` found | `'warn'` | `'未找到"查看更多"按钮，进入初筛'` |

#### `processStream(stream, context)`

| Location | level | label template |
|---|---|---|
| After `sweepCardsIntoView()` | `'info'` | `'流 [${stream.id}] sweep 完成，找到 ${cards.length} 张卡片'` detail: `{streamId: stream.id, cardCount: cards.length}` |
| After dedup loop | `'info'` | `'流 [${stream.id}] 去重后有效商品 ${items.length} 条'` |

#### `runInitialFilter(state)`

| Location | level | label template |
|---|---|---|
| After building `currentPageIds` | `'info'` | `'初筛：当前页可见商品 ${currentPageIds.size} 条，历史候选 ${visibleCandidates.length} 条（全量兜底：${pool === visibleCandidates ? "否" : "是"}）'` detail: `{visibleCount: currentPageIds.size, candidateCount: visibleCandidates.length, fallback: pool !== visibleCandidates}` |
| After `selectPriorityItems`, if `queue.length > 0` | `'info'` | `'初筛命中：goodsId=${queue[0].goodsId} 名称="${(queue[0].name||queue[0].fullTitle||'').slice(0,20)}"'` detail: `{goodsId: queue[0].goodsId, starRating: queue[0].starRating, sales: queue[0].sales}` |
| After `selectPriorityItems`, if `queue.length === 0` | `'warn'` | `'初筛无结果：候选池已全部处理或为空'` detail: `{poolSize: pool.length, processedCount: processed.size}` |
| In `queue.length === 0` branch, if `canExpand` | `'info'` | `'当前页仍可扩池（有查看更多或联想区），重置 batch 继续采'` |
| In `queue.length === 0` branch, if `!canExpand` or over totalLimit | `'warn'` | `'无法继续扩池，准备结束采集'` |

#### `scrapeAndUpsertCurrentProduct()`

| Location | level | label template |
|---|---|---|
| After getting `currentId` | `'info'` | `'详情页主商品抓取开始：goodsId=${currentId}'` |
| After upsert | `'info'` | `'详情页主商品字段补全完成：标题="${title.slice(0,20)}" 价格=${price} 销量=${sales} 星级=${stars}'` detail: `{goodsId: currentId, title, price, sales, stars, reviews}` |

#### `highlightPendingItem(item, labelText)`

| Location | level | label template |
|---|---|---|
| Top | `'info'` | `'准备高亮目标：goodsId=${item.goodsId} 来源=${item.source||"?"}'` |
| After `waitForHighlightTarget`, if `!target` | `'error'` | `'高亮失败：页面上找不到 goodsId=${item.goodsId} 的卡片节点'` detail: `{goodsId: item.goodsId, source: item.source}` |
| After `applyPendingHighlight` | `'info'` | `'高亮已应用：goodsId=${item.goodsId}'` |
| After `scheduleAutoClickIfNeeded` | `'info'` | `'已排期自动点击'` |

#### `scheduleAutoClickIfNeeded(item, target)`

| Location | level | label template |
|---|---|---|
| After computing `totalDelay`, if `autoClickV1` enabled | `'info'` | `'自动点击已排期：goodsId=${item.goodsId} 延迟 ${(totalDelay/1000).toFixed(1)}s'` detail: `{delayMs: totalDelay, isAggressive}` |
| If `!state.config.autoClickV1` | `'warn'` | `'autoClickV1 未开启，等待手动点击'` |

#### `performAutoClickV1(item)`

| Location | level | label template |
|---|---|---|
| Top | `'info'` | `'执行自动点击：goodsId=${item.goodsId}'` |
| If `!target` | `'error'` | `'自动点击失败：找不到目标节点 goodsId=${item.goodsId}'` |
| After dispatching click events | `'info'` | `'鼠标事件已派发，等待页面跳转'` detail: `{goodsId: item.goodsId, point}` |

#### `handleAutoLoadMoreClick(button, waitSec)` / `performLoadMoreClick(...)`

| Location | level | label template |
|---|---|---|
| Top of `handleAutoLoadMoreClick` | `'info'` | `'自动点击"查看更多"，等待 ${waitSec}s 后恢复'` |
| After click in `performLoadMoreClick`, if cards increased | `'info'` | `'点击"查看更多"成功，页面新增商品'` |
| After click in `performLoadMoreClick`, if cards did NOT increase | `'error'` | `'点击"查看更多"后无新增，疑似风控'` |

#### `enterWindControl(reason)`

| Location | level | label template |
|---|---|---|
| Top | `'error'` | `'进入风控暂停：${reason}'` detail: `{reason}` |

#### `finish(state)`

| Location | level | label template |
|---|---|---|
| Top | `'info'` | `'采集结束，共采 ${state.collected.length} 条，已处理 ${state.processedIds?.length||0} 条'` detail: `{total: state.collected.length, processed: state.processedIds?.length}` |

---

### 4. Implementation Constraints

- **Do NOT** use `import`/`export` — this is a single-file content script
- **Do NOT** modify any existing logic, only add `logAction(...)` calls alongside
- `ensureTimelinePanel()` must use `attachShadow({mode: 'open'})` to isolate styles
- `renderTimelinePanel()` must be safe to call frequently (it replaces innerHTML, not appends)
- The panel must survive Temu's DOM mutations — use `document.body.appendChild`, not injecting into Temu's app root
- Keep the panel draggable is a nice-to-have but not required
- All label strings must be in Chinese
- The `detail` object in each entry should be shown as `JSON.stringify(detail, null, 2)` inside a `<pre>` on click/expand
- Clicking the same entry again collapses it

---

### 5. File to modify

`content.js` — the single self-contained content script. All additions go into this one file.
