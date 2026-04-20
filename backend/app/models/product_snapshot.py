from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ProductSnapshot(Base):
    __tablename__ = "product_snapshots"
    __table_args__ = (
        Index("ix_product_snapshots_goods_id", "goods_id"),
        Index("ix_product_snapshots_run_uuid", "run_uuid"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    goods_id: Mapped[str] = mapped_column(String(64), nullable=False)
    run_uuid: Mapped[str | None] = mapped_column(ForeignKey("crawl_runs.run_uuid"), nullable=True)
    page_type: Mapped[str | None] = mapped_column(String(32))
    source: Mapped[str | None] = mapped_column(String(32))
    source_page: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(String(255))
    full_title: Mapped[str | None] = mapped_column(String(1024))
    price_text: Mapped[str | None] = mapped_column(String(64))
    price_value: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    sales_text: Mapped[str | None] = mapped_column(String(64))
    sales_value: Mapped[int | None] = mapped_column()
    star_rating: Mapped[str | None] = mapped_column(String(32))
    review_count: Mapped[int | None] = mapped_column()
    listing_time: Mapped[str | None] = mapped_column(String(128))
    raw_text: Mapped[str | None] = mapped_column(Text)
    raw_html: Mapped[str | None] = mapped_column(Text)
    scraped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
