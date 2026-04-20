# Temu Scraper Backend

最小可运行后端脚手架，使用：

- FastAPI
- PostgreSQL
- SQLAlchemy 2.0
- Alembic

## 目录

```text
backend/
  app/
    api/
    core/
    models/
    schemas/
    services/
    main.py
  alembic/
  requirements.txt
  .env.example
```

## 快速开始

1. 创建虚拟环境并安装依赖

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. 配置环境变量

```bash
cp .env.example .env
```

3. 启动 PostgreSQL，并确保 `DATABASE_URL` 可用

4. 启动服务

```bash
uvicorn app.main:app --reload
```

默认地址：

- API: `http://127.0.0.1:8000`
- Docs: `http://127.0.0.1:8000/docs`

## MVP 接口

### 健康检查

```http
GET /health
```

### 开始一次采集任务

```http
POST /api/runs/start
```

### 结束一次采集任务

```http
POST /api/runs/{run_uuid}/finish
Content-Type: application/json

{
  "status": "completed",
  "total_collected": 120,
  "notes": "manual stop"
}
```

### 批量上传商品

```http
POST /api/upload/batch
Content-Type: application/json

{
  "run_uuid": "ef9f65cb-a94a-4def-a8c7-e35598ebcb43",
  "page_type": "detail",
  "items": [
    {
      "goods_id": "605667444278389",
      "name": "列表标题",
      "full_title": "完整标题",
      "price": "CA$12.99",
      "sales": "1.2k",
      "star_rating": "4.8",
      "review_count": "340",
      "source": "related",
      "source_page": "https://www.temu.com/...",
      "raw_text": "原始文本块",
      "raw_html": "<div class=\"_foo\">...</div>",
      "scraped_at": "2026-04-15T16:12:54+08:00"
    }
  ],
  "edges": [
    {
      "from_goods_id": "606094793475654",
      "to_goods_id": "606467381927266",
      "relation_type": "related"
    }
  ]
}
```

## 表说明

- `products`: 当前商品最新状态
- `product_snapshots`: 每次上传的商品快照
- `crawl_runs`: 采集任务
- `crawl_edges`: 商品联想链路

## 下一步建议

1. 给扩展增加批量上传逻辑
2. 给 `product_snapshots` 增加“无变化跳过”策略
3. 补第一版 Alembic 迁移
4. 增加查询接口和简单后台
