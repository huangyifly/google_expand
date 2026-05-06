from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class CrawlRunFinishRequest(BaseModel):
    status: str = Field(default="completed")
    total_collected: int | None = None
    notes: str | None = None


class TraceUploadRequest(BaseModel):
    """前端 content.js 上传的采集流程追踪日志"""
    entries: list[dict[str, Any]] = Field(default_factory=list, description="trace 记录数组，每条含 ts/layer/node/why/params/outcome 等字段")


class TraceUploadResponse(BaseModel):
    ok: bool
    count: int


class CrawlRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    run_uuid: str
    status: str
    started_at: datetime
    ended_at: datetime | None = None
    total_collected: int
    notes: str | None = None
