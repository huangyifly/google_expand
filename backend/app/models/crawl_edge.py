from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class CrawlEdge(Base):
    __tablename__ = "crawl_edges"
    __table_args__ = (
        Index("ix_crawl_edges_run_uuid", "run_uuid"),
        Index("ix_crawl_edges_from_to", "from_goods_id", "to_goods_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    run_uuid: Mapped[str | None] = mapped_column(ForeignKey("crawl_runs.run_uuid"), nullable=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    from_goods_id: Mapped[str] = mapped_column(String(64), nullable=False)
    to_goods_id: Mapped[str] = mapped_column(String(64), nullable=False)
    relation_type: Mapped[str] = mapped_column(String(32), default="related", nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
