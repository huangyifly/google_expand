from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class CrawlRun(Base):
    __tablename__ = "crawl_runs"
    __table_args__ = (Index("ix_crawl_runs_run_uuid_unique", "run_uuid", unique=True),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    run_uuid: Mapped[str] = mapped_column(String(36), default=lambda: str(uuid4()), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="running", nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    total_collected: Mapped[int] = mapped_column(default=0, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
