from datetime import datetime

from pydantic import BaseModel, Field


class UploadItem(BaseModel):
    goods_id: str = Field(..., min_length=1, max_length=64)
    name: str | None = None
    full_title: str | None = None
    price: str | None = None
    sales: str | None = None
    star_rating: str | None = None
    review_count: str | int | None = None
    listing_time: str | None = None
    source: str | None = None
    source_page: str | None = None
    raw_text: str | None = None
    raw_html: str | None = None
    scraped_at: datetime | None = None


class UploadEdge(BaseModel):
    from_goods_id: str
    to_goods_id: str
    relation_type: str = "related"
    captured_at: datetime | None = None


class UploadBatchRequest(BaseModel):
    run_uuid: str | None = None
    page_type: str | None = None
    items: list[UploadItem]
    edges: list[UploadEdge] = Field(default_factory=list)


class UploadBatchResponse(BaseModel):
    ok: bool = True
    run_uuid: str | None = None
    upserted_products: int
    inserted_snapshots: int
    inserted_edges: int
