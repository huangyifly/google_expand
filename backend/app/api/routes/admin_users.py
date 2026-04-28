from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import require_admin
from app.core.db import get_db
from app.core.security import hash_password
from app.models.user import User

router = APIRouter(prefix="/api/admin/users", tags=["admin-users"])

ALLOWED_ROLES = {"admin", "user"}


class UserCreate(BaseModel):
    email: str
    password: str
    role: str = "user"
    is_active: bool = True


class UserUpdate(BaseModel):
    email: str | None = None
    password: str | None = None
    role: str | None = None
    is_active: bool | None = None


class UserItem(BaseModel):
    id: int
    email: str
    role: str
    is_active: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


def normalize_email(email: str) -> str:
    value = email.strip().lower()
    if not value or "@" not in value or "." not in value.rsplit("@", 1)[-1]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="邮箱格式不正确")
    return value


def validate_password(password: str, *, required: bool) -> str | None:
    value = password.strip()
    if not value:
        if required:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="密码不能为空")
        return None
    if len(value) < 6:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="密码至少 6 位")
    return value


def validate_role(role: str) -> str:
    value = role.strip().lower()
    if value not in ALLOWED_ROLES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="角色只支持 admin 或 user")
    return value


@router.get("", response_model=list[UserItem])
def list_users(
    db: Session = Depends(get_db),
    _current_user: User = Depends(require_admin),
) -> list[User]:
    return db.query(User).order_by(User.id.asc()).all()


@router.post("", response_model=UserItem, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(require_admin),
) -> User:
    email = normalize_email(payload.email)
    password = validate_password(payload.password, required=True)
    role = validate_role(payload.role)

    exists = db.query(User).filter(User.email == email).first()
    if exists:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该邮箱已存在")

    user = User(
        email=email,
        hashed_password=hash_password(password),
        role=role,
        is_active=payload.is_active,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserItem)
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="账号不存在")

    if payload.email is not None:
        email = normalize_email(payload.email)
        exists = db.query(User).filter(User.email == email, User.id != user_id).first()
        if exists:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该邮箱已存在")
        user.email = email

    if payload.role is not None:
        role = validate_role(payload.role)
        if user.id == current_user.id and role != "admin":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不能移除自己的管理员权限")
        user.role = role

    if payload.is_active is not None:
        if user.id == current_user.id and not payload.is_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不能停用当前登录账号")
        user.is_active = payload.is_active

    if payload.password is not None:
        password = validate_password(payload.password, required=False)
        if password:
            user.hashed_password = hash_password(password)

    db.commit()
    db.refresh(user)
    return user
