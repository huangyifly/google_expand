from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.db import get_db
from app.core.security import create_access_token, hash_password, verify_password
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


@router.post("/api/auth/login", response_model=TokenResponse, tags=["auth"])
def login(body: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    email = body.email.strip().lower()
    user = db.query(User).filter_by(email=email, is_active=True).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码错误")

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
