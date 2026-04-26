from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ExclusionKeyword(Base, TimestampMixin):
    __tablename__ = "exclusion_keywords"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    keyword: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    category: Mapped[str | None] = mapped_column(String(64))  # 可选分类标签，如"服装"/"电器"
    note: Mapped[str | None] = mapped_column(Text)  # 备注
