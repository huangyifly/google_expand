from sqlalchemy import Boolean, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class LoginLog(Base, TimestampMixin):
    __tablename__ = "login_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    email: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    ip_address: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    user_agent: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    success: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    failure_reason: Mapped[str | None] = mapped_column(String(128), nullable=True)
