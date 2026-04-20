from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class CrawlRunFinishRequest(BaseModel):
    status: str = Field(default="completed")
    total_collected: int | None = None
    notes: str | None = None


class CrawlRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    run_uuid: str
    status: str
    started_at: datetime
    ended_at: datetime | None = None
    total_collected: int
    notes: str | None = None
