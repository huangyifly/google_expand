from datetime import datetime, time, timezone
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.db import get_db
from app.models import CrawlEdge, CrawlRun, Product, ProductSnapshot
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
    limit: int | None = Query(default=None, ge=1, le=200),
    sort_by: str = Query(default="last_seen_at"),
    sort_order: str = Query(default="desc", pattern="^(asc|desc)$"),
    user_id: int | None = Query(default=None),
    run_uuid: str | None = Query(default=None, max_length=36),
    created_after: datetime | None = Query(default=None),
    created_before: datetime | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return get_dashboard_products(
        db,
        current_user=current_user,
        keyword=q,
        page=page,
        page_size=limit or page_size,
        sort_by=sort_by,
        sort_order=sort_order,
        user_id=user_id,
        run_uuid=run_uuid,
        created_after=created_after,
        created_before=created_before,
    )


@router.get("/products/export")
def export_products(
    q: str = Query(default=""),
    sort_by: str = Query(default="last_seen_at"),
    sort_order: str = Query(default="desc"),
    user_id: int | None = Query(default=None),
    run_uuid: str | None = Query(default=None, max_length=36),
    created_after: datetime | None = Query(default=None),
    created_before: datetime | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """导出当前筛选条件下的全量商品数据为 Excel 文件。"""
    xlsx_bytes = export_products_excel(
        db,
        current_user=current_user,
        keyword=q,
        sort_by=sort_by,
        sort_order=sort_order,
        user_id=user_id,
        run_uuid=run_uuid,
        created_after=created_after,
        created_before=created_before,
    )
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"temu_products_{timestamp}.xlsx"
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("/runs/{run_uuid}")
def delete_crawl_run(
    run_uuid: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    run_query = db.query(CrawlRun).filter(
        CrawlRun.run_uuid == run_uuid,
        CrawlRun.is_deleted.is_(False),
    )
    if current_user.role != "admin":
        run_query = run_query.filter(CrawlRun.user_id == current_user.id)

    crawl_run = run_query.first()
    if not crawl_run:
        raise HTTPException(status_code=404, detail="采集任务不存在")

    artifact_filters = [ProductSnapshot.run_uuid == run_uuid]
    edge_filters = [CrawlEdge.run_uuid == run_uuid]
    product_filters = [Product.run_uuid == run_uuid]
    if current_user.role != "admin":
        artifact_filters.append(ProductSnapshot.user_id == current_user.id)
        edge_filters.append(CrawlEdge.user_id == current_user.id)
        product_filters.append(Product.user_id == current_user.id)

    snapshot_count = (
        db.query(ProductSnapshot)
        .filter(ProductSnapshot.is_deleted.is_(False), *artifact_filters)
        .update({ProductSnapshot.is_deleted: True}, synchronize_session=False)
    )
    edge_count = (
        db.query(CrawlEdge)
        .filter(CrawlEdge.is_deleted.is_(False), *edge_filters)
        .update({CrawlEdge.is_deleted: True}, synchronize_session=False)
    )
    product_count = (
        db.query(Product)
        .filter(Product.is_deleted.is_(False), *product_filters)
        .update({Product.is_deleted: True}, synchronize_session=False)
    )
    crawl_run.is_deleted = True
    db.add(crawl_run)
    db.commit()
    return {
        "ok": True,
        "run_uuid": run_uuid,
        "deleted_runs": 1,
        "deleted_snapshots": snapshot_count,
        "deleted_edges": edge_count,
        "deleted_products": product_count,
    }


@router.delete("/products/before-today")
def delete_products_before_today(
    user_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    today_start = datetime.combine(datetime.now().date(), time.min)
    query = db.query(Product).filter(
        Product.is_deleted.is_(False),
        Product.created_at < today_start,
    )
    if current_user.role == "admin":
        if user_id is not None:
            query = query.filter(Product.user_id == user_id)
    else:
        query = query.filter(Product.user_id == current_user.id)

    deleted_count = query.update({Product.is_deleted: True}, synchronize_session=False)
    db.commit()
    return {"ok": True, "deleted_count": deleted_count, "before": today_start.isoformat()}


@router.delete("/products/{product_id}")
def delete_product(
    product_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    query = db.query(Product).filter(Product.id == product_id, Product.is_deleted.is_(False))
    if current_user.role != "admin":
        query = query.filter(Product.user_id == current_user.id)
    product = query.first()
    if not product:
        raise HTTPException(status_code=404, detail="商品不存在")

    product.is_deleted = True
    db.add(product)
    db.commit()
    return {"ok": True, "id": product.id}


@router.patch("/products/{goods_id}/listing-config")
def update_product_listing_config(
    goods_id: str,
    payload: ProductListingConfigUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    query = db.query(Product).filter(Product.goods_id == goods_id, Product.is_deleted.is_(False))
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
    query = db.query(Product).filter(Product.goods_id == goods_id, Product.is_deleted.is_(False))
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
