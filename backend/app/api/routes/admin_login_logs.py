from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import require_admin
from app.core.db import get_db
from app.models.login_log import LoginLog
from app.models.user import User

router = APIRouter(prefix="/api/admin/login-logs", tags=["admin-login-logs"])


class LoginLogItem(BaseModel):
    id: int
    user_id: int | None
    email: str
    ip_address: str
    user_agent: str
    success: bool
    failure_reason: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


@router.get("", response_model=list[LoginLogItem])
def list_login_logs(
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _current_user: User = Depends(require_admin),
) -> list[LoginLog]:
    return db.query(LoginLog).order_by(LoginLog.id.desc()).limit(limit).all()
