from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.db import get_db
from app.core.security import create_access_token, hash_password, verify_password
from app.models.login_log import LoginLog
from app.models.user import User

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    email: str


class UserMe(BaseModel):
    id: int
    email: str
    role: str


def get_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip() or "unknown"
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def record_login_log(
    db: Session,
    *,
    request: Request,
    email: str,
    user: User | None,
    success: bool,
    failure_reason: str | None = None,
) -> None:
    user_agent = request.headers.get("user-agent", "")[:512]
    db.add(
        LoginLog(
            user_id=user.id if user else None,
            email=email,
            ip_address=get_client_ip(request),
            user_agent=user_agent,
            success=success,
            failure_reason=failure_reason,
        )
    )
    db.commit()


@router.post("/api/auth/login", response_model=TokenResponse, tags=["auth"])
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)) -> TokenResponse:
    email = body.email.strip().lower()
    user = db.query(User).filter_by(email=email).first()
    if not user:
        record_login_log(db, request=request, email=email, user=None, success=False, failure_reason="账号不存在")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码错误")
    if not user.is_active:
        record_login_log(db, request=request, email=email, user=user, success=False, failure_reason="账号已停用")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码错误")
    if not verify_password(body.password, user.hashed_password):
        record_login_log(db, request=request, email=email, user=user, success=False, failure_reason="密码错误")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码错误")

    record_login_log(db, request=request, email=email, user=user, success=True)
    token = create_access_token(user.id, user.role)
    return TokenResponse(access_token=token, role=user.role, email=user.email)


@router.post("/api/auth/register", response_model=TokenResponse, tags=["auth"], status_code=201)
def register(body: RegisterRequest, db: Session = Depends(get_db)) -> TokenResponse:
    email = body.email.strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="邮箱不能为空")
    if len(body.password or "") < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")

    if db.query(User).filter_by(email=email).first():
        raise HTTPException(status_code=400, detail="邮箱已被注册")

    user = User(email=email, hashed_password=hash_password(body.password), role="user")
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token(user.id, user.role)
    return TokenResponse(access_token=token, role=user.role, email=user.email)


@router.get("/api/auth/me", response_model=UserMe, tags=["auth"])
def me(current_user: User = Depends(get_current_user)) -> UserMe:
    return UserMe(id=current_user.id, email=current_user.email, role=current_user.role)
