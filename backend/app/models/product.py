from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Index, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class Product(TimestampMixin, Base):
    __tablename__ = "products"
    __table_args__ = (Index("ix_products_goods_id_unique", "goods_id", unique=True),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    goods_id: Mapped[str] = mapped_column(String(64), nullable=False)
    current_title: Mapped[str | None] = mapped_column(String(255))
    current_full_title: Mapped[str | None] = mapped_column(String(1024))
    current_price_text: Mapped[str | None] = mapped_column(String(64))
    current_price_value: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    current_sales_text: Mapped[str | None] = mapped_column(String(64))
    current_sales_value: Mapped[int | None] = mapped_column()
    current_star_rating: Mapped[str | None] = mapped_column(String(32))
    current_review_count: Mapped[int | None] = mapped_column()
    current_listing_time: Mapped[str | None] = mapped_column(String(128))
    current_raw_text: Mapped[str | None] = mapped_column(String(4096))
    current_raw_html: Mapped[str | None] = mapped_column(Text)
    last_source: Mapped[str | None] = mapped_column(String(32))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
