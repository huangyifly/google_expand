from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.models import Product
from app.services.dashboard_service import (
    get_dashboard_edges,
    get_dashboard_overview,
    get_dashboard_products,
    get_dashboard_runs,
    get_dashboard_sources,
)

router = APIRouter()


class ProductListingConfigUpdate(BaseModel):
    listing_length_cm: Decimal | None = None
    listing_width_cm: Decimal | None = None
    listing_height_cm: Decimal | None = None
    listing_weight_g: Decimal | None = None
    listing_declared_price: Decimal | None = None
    listing_suggested_price: Decimal | None = None

    @field_validator("*", mode="before")
    @classmethod
    def empty_string_to_none(cls, value):
        if value == "":
            return None
        if value is None:
            return None
        try:
            return Decimal(str(value))
        except (InvalidOperation, ValueError) as exc:
            raise ValueError("必须是有效数字") from exc


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


@router.patch("/products/{goods_id}/listing-config")
def update_product_listing_config(
    goods_id: str,
    payload: ProductListingConfigUpdate,
    db: Session = Depends(get_db),
) -> dict:
    product = db.query(Product).filter(Product.goods_id == goods_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="商品不存在")

    for field, value in payload.model_dump().items():
        setattr(product, field, value)

    db.add(product)
    db.commit()
    db.refresh(product)
    return {"ok": True, "goods_id": product.goods_id}
