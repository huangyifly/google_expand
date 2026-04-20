from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.services.dashboard_service import (
    get_dashboard_edges,
    get_dashboard_overview,
    get_dashboard_products,
    get_dashboard_runs,
    get_dashboard_sources,
)

router = APIRouter()


@router.get("/overview")
def dashboard_overview(db: Session = Depends(get_db)) -> dict:
    return get_dashboard_overview(db)


@router.get("/runs")
def dashboard_runs(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    return {"items": get_dashboard_runs(db, limit=limit)}


@router.get("/sources")
def dashboard_sources(db: Session = Depends(get_db)) -> dict:
    return {"items": get_dashboard_sources(db)}


@router.get("/edges")
def dashboard_edges(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    return {"items": get_dashboard_edges(db, limit=limit)}


@router.get("/products")
def dashboard_products(
    q: str = Query(default="", max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=30, ge=1, le=200),
    sort_by: str = Query(default="last_seen_at"),
    sort_order: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_db),
) -> dict:
    return get_dashboard_products(
        db,
        keyword=q,
        page=page,
        page_size=page_size,
        sort_by=sort_by,
        sort_order=sort_order,
    )
