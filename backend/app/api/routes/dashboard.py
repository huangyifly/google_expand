from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.db import get_db
from app.models import Product
from app.models.user import User
from app.services.dashboard_service import (
    export_products_excel,
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
def dashboard_overview(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return get_dashboard_overview(db, current_user)


@router.get("/runs")
def dashboard_runs(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return {"items": get_dashboard_runs(db, current_user, limit=limit)}


@router.get("/sources")
def dashboard_sources(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return {"items": get_dashboard_sources(db, current_user)}


@router.get("/edges")
def dashboard_edges(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return {"items": get_dashboard_edges(db, current_user, limit=limit)}


@router.get("/products")
def dashboard_products(
    q: str = Query(default="", max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=30, ge=1, le=200),
    sort_by: str = Query(default="last_seen_at"),
    sort_order: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return get_dashboard_products(
        db,
        current_user=current_user,
        keyword=q,
        page=page,
        page_size=page_size,
        sort_by=sort_by,
        sort_order=sort_order,
    )


@router.get("/products/export")
def export_products(
    q: str = Query(default=""),
    sort_by: str = Query(default="last_seen_at"),
    sort_order: str = Query(default="desc"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """导出当前筛选条件下的全量商品数据为 Excel 文件。"""
    xlsx_bytes = export_products_excel(db, current_user=current_user, keyword=q, sort_by=sort_by, sort_order=sort_order)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"temu_products_{timestamp}.xlsx"
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.patch("/products/{goods_id}/listing-config")
def update_product_listing_config(
    goods_id: str,
    payload: ProductListingConfigUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    query = db.query(Product).filter(Product.goods_id == goods_id)
    if current_user.role != "admin":
        query = query.filter(Product.user_id == current_user.id)
    product = query.first()
    if not product:
        raise HTTPException(status_code=404, detail="商品不存在")

    for field, value in payload.model_dump().items():
        setattr(product, field, value)

    db.add(product)
    db.commit()
    db.refresh(product)
    return {"ok": True, "goods_id": product.goods_id}


@router.get("/products/{goods_id}/listing-config")
def get_product_listing_config(
    goods_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    query = db.query(Product).filter(Product.goods_id == goods_id)
    if current_user.role != "admin":
        query = query.filter(Product.user_id == current_user.id)
    product = query.first()
    if not product:
        raise HTTPException(status_code=404, detail="商品不存在")

    def decimal_text(value):
        if value is None:
            return ""
        return format(value, "f").rstrip("0").rstrip(".")

    return {
        "ok": True,
        "goods_id": product.goods_id,
        "listing_length_cm": decimal_text(product.listing_length_cm),
        "listing_width_cm": decimal_text(product.listing_width_cm),
        "listing_height_cm": decimal_text(product.listing_height_cm),
        "listing_weight_g": decimal_text(product.listing_weight_g),
        "listing_declared_price": decimal_text(product.listing_declared_price),
        "listing_suggested_price": decimal_text(product.listing_suggested_price),
    }
