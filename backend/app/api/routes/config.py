from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_admin
from app.core.db import get_db
from app.models.exclusion_keyword import ExclusionKeyword
from app.models.user import User

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class KeywordCreate(BaseModel):
    keyword: str
    category: str | None = None
    note: str | None = None


class KeywordItem(BaseModel):
    id: int
    keyword: str
    category: str | None
    note: str | None

    model_config = {"from_attributes": True}


# ── 扩展调用：只返回词列表 ────────────────────────────────────────────────────

@router.get("/api/config/exclusion-keywords", tags=["config"])
def get_exclusion_keywords(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, list[str]]:
    """返回所有排除词（仅关键词字符串），供扩展启动时拉取。"""
    rows = db.query(ExclusionKeyword.keyword).all()
    return {"keywords": [r.keyword for r in rows]}


# ── 管理接口：带 id/category/note 的完整列表 ──────────────────────────────────

@router.get("/api/config/exclusion-keywords/list", tags=["config"])
def list_exclusion_keywords(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[KeywordItem]:
    """返回完整排除词列表（含 id/category/note），用于管理页。"""
    rows = db.query(ExclusionKeyword).order_by(ExclusionKeyword.category, ExclusionKeyword.id).all()
    return [KeywordItem.model_validate(r) for r in rows]


@router.post("/api/config/exclusion-keywords", tags=["config"], status_code=201)
def add_exclusion_keyword(
    body: KeywordCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
) -> KeywordItem:
    """新增一条排除词。keyword 唯一，重复时返回 409。"""
    existing = db.query(ExclusionKeyword).filter(ExclusionKeyword.keyword == body.keyword).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"关键词 [{body.keyword}] 已存在")
    row = ExclusionKeyword(keyword=body.keyword, category=body.category, note=body.note)
    db.add(row)
    db.commit()
    db.refresh(row)
    return KeywordItem.model_validate(row)


@router.delete("/api/config/exclusion-keywords/{keyword_id}", tags=["config"])
def delete_exclusion_keyword(
    keyword_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
) -> dict[str, str]:
    """删除指定 id 的排除词。"""
    row = db.query(ExclusionKeyword).filter(ExclusionKeyword.id == keyword_id).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"id={keyword_id} 不存在")
    db.delete(row)
    db.commit()
    return {"message": f"已删除：{row.keyword}"}
