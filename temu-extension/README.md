# Temu 数据采集插件 v5.0

Chrome Manifest V3 扩展，用于采集 Temu 商品数据。

## 项目结构

```
temu-extension/
├── manifest.json       # MV3 配置
├── background.js       # Service Worker (消息中转 + 后端代理)
├── content.js          # 内容脚本 (核心采集逻辑)
├── popup.html          # 弹窗 UI
├── popup.js            # 弹窗逻辑
├── icon.png            # 插件图标
└── src/                # 模块化参考 (未打包)
    ├── constants/      # 常量定义
    ├── utils/          # 工具函数
    ├── state/          # 状态管理
    ├── messaging/      # 消息通信
    ├── dom/            # DOM 操作
    ├── extraction/     # 数据提取
    ├── workflow/       # 工作流控制
    ├── debug/          # 调试面板
    └── upload/         # 批量上传
```

## 主流程说明

### 1. 启动流程

```
页面加载 → content.js 注入 → 延时 800ms 调用 main()
    ↓
main() 检查 state.running
    ↓
popup 点击"开始采集" → 创建初始 state → 调用 main()
```

### 2. 采集循环

```
┌─────────────────────────────────────────────────┐
│  1. 判断 URL 类型 (商品详情 / 普通)              │
│  2. URL 含锚点 → 补齐主商品字段                  │
│  3. batch 未满 → productStreamTick() 继续采集   │
│  4. batch 已满 + 队列有目标 → 高亮等待跳转       │
│  5. batch 已满 + 队列空 → 筛选目标              │
└─────────────────────────────────────────────────┘
```

### 3. 商品流处理

```
enumerateProductStreams()   → 枚举页面商品流
    ├── 主流 (document - 联想区)
    └── 联想流 (#goodsRecommend)
    ↓
harvestStream()             → 扫描 + 采集
    ↓
upsertItems()               → 合并入库
    ↓
uploadPendingBatch()        → 批量上传
```

## FSM 状态机

```
LIST_DISCOVERY    ──→  TARGET_SELECTED  ──→  NAVIGATE_TO_DETAIL
    ↑                    ↓                        ↓
    │              LIST_DISCOVERY          DETAIL_SCRAPE
    │                    ↑                        ↓
    └────────────── RELATED_SCAN ←─────── EDGE_COLLECT
                           ↓
                      TARGET_SELECTED

特殊状态: PAUSE / WIND_CONTROL
```

## 采集模式

| 模式 | 说明 |
|------|------|
| CONSERVATIVE | 保守辅助模式，需手动确认"查看更多" |
| AGGRESSIVE | 激进自动模式，全自动点击和滚动 |

## 任务模式

| 模式 | 说明 |
|------|------|
| DISCOVERY | 发现模式，从列表页发现新商品 |
| HARVEST | 收割模式，消费已有队列 |
| GRAPH | 图谱模式，采集商品关联关系 |

## 配置说明

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| intervalSec | 5 | 操作间隔 (秒) |
| batchSize | 60 | 初始批次大小 |
| totalLimit | 10000 | 总采集上限 |
| autoClickLoadMore | false | 自动点击"查看更多" |
| showDebugPanel | false | 显示调试面板 |

## 后端接口

需要配置 `http://47.107.78.215:8000` 作为后端：

- `POST /api/runs/start` - 开始运行
- `POST /api/upload/batch` - 批量上传
- `POST /api/runs/:uuid/finish` - 结束运行

## 开发说明

### 模块化参考

`src/` 目录下的模块文件展示了理想的代码组织结构。由于 Chrome 扩展 content script 不支持 ES modules，实际代码整合在 `content.js` 单文件中。

未来可以使用打包工具 (webpack/rollup) 将模块打包。

### 关键文件

- `content.js` - 核心逻辑，包含所有采集流程
- `background.js` - Service Worker，负责消息中转和后端代理
- `popup.js` - UI 交互和配置管理

## 安装使用

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `temu-extension` 目录
5. 打开 temu.com 页面，点击插件图标开始采集
