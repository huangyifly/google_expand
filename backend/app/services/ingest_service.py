from datetime import datetime, timezone
from decimal import Decimal
import re

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import CrawlEdge, Product, ProductSnapshot
from app.models.user import User
from app.schemas.upload import UploadBatchRequest, UploadEdge, UploadItem


def ingest_batch(db: Session, payload: UploadBatchRequest, current_user: User) -> dict[str, int | str | bool | None]:
    upserted_products = 0
    inserted_snapshots = 0
    inserted_edges = 0

    for item in payload.items:
        upsert_product(db, item, current_user.id, payload.run_uuid)
        insert_snapshot(db, payload.run_uuid, payload.page_type, item, current_user.id)
        upserted_products += 1
        inserted_snapshots += 1

    for edge in payload.edges:
        db.add(build_edge(payload.run_uuid, edge, current_user.id))
        inserted_edges += 1

    db.commit()
    return {
        "ok": True,
        "run_uuid": payload.run_uuid,
        "upserted_products": upserted_products,
        "inserted_snapshots": inserted_snapshots,
        "inserted_edges": inserted_edges,
    }


def upsert_product(db: Session, item: UploadItem, user_id: int, run_uuid: str | None) -> None:
    stmt = insert(Product).values(
        user_id=user_id,
        run_uuid=run_uuid,
        goods_id=item.goods_id,
        current_title=item.name,
        current_full_title=item.full_title,
        current_price_text=item.price,
        current_price_value=parse_price_value(item.price),
        current_sales_text=item.sales,
        current_sales_value=parse_sales_value(item.sales),
        current_star_rating=item.star_rating,
        current_review_count=parse_int(item.review_count),
        current_listing_time=item.listing_time,
        current_raw_text=item.raw_text,
        current_raw_html=item.raw_html,
        last_source=item.source,
        last_seen_at=item.scraped_at or datetime.now(timezone.utc),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[Product.user_id, Product.goods_id],
        set_={
            "current_title": stmt.excluded.current_title,
            "run_uuid": stmt.excluded.run_uuid,
            "current_full_title": stmt.excluded.current_full_title,
            "current_price_text": stmt.excluded.current_price_text,
            "current_price_value": stmt.excluded.current_price_value,
            "current_sales_text": stmt.excluded.current_sales_text,
            "current_sales_value": stmt.excluded.current_sales_value,
            "current_star_rating": stmt.excluded.current_star_rating,
            "current_review_count": stmt.excluded.current_review_count,
            "current_listing_time": func.coalesce(
                func.nullif(stmt.excluded.current_listing_time, ""),
                Product.current_listing_time,
            ),
            "current_raw_text": func.coalesce(
                func.nullif(stmt.excluded.current_raw_text, ""),
                Product.current_raw_text,
            ),
            "current_raw_html": func.coalesce(
                func.nullif(stmt.excluded.current_raw_html, ""),
                Product.current_raw_html,
            ),
            "last_source": stmt.excluded.last_source,
            "last_seen_at": stmt.excluded.last_seen_at,
        },
    )
    db.execute(stmt)


def insert_snapshot(db: Session, run_uuid: str | None, page_type: str | None, item: UploadItem, user_id: int) -> None:
    snapshot = ProductSnapshot(
        user_id=user_id,
        goods_id=item.goods_id,
        run_uuid=run_uuid,
        page_type=page_type,
        source=item.source,
        source_page=item.source_page,
        title=item.name,
        full_title=item.full_title,
        price_text=item.price,
        price_value=parse_price_value(item.price),
        sales_text=item.sales,
        sales_value=parse_sales_value(item.sales),
        star_rating=item.star_rating,
        review_count=parse_int(item.review_count),
        listing_time=item.listing_time,
        raw_text=item.raw_text,
        raw_html=item.raw_html,
        scraped_at=item.scraped_at or datetime.now(timezone.utc),
    )
    db.add(snapshot)


def build_edge(run_uuid: str | None, edge: UploadEdge, user_id: int) -> CrawlEdge:
    return CrawlEdge(
        user_id=user_id,
        run_uuid=run_uuid,
        from_goods_id=edge.from_goods_id,
        to_goods_id=edge.to_goods_id,
        relation_type=edge.relation_type,
        captured_at=edge.captured_at or datetime.now(timezone.utc),
    )


def parse_price_value(raw: str | None) -> Decimal | None:
    if not raw:
        return None
    matched = re.search(r"(\d[\d,]*\.?\d{0,2})", raw)
    if not matched:
        return None
    return Decimal(matched.group(1).replace(",", ""))


def parse_sales_value(raw: str | None) -> int | None:
    if not raw:
        return None
    normalized = raw.strip().lower().replace(",", "")
    matched = re.search(r"(\d+(?:\.\d+)?)", normalized)
    if not matched:
        return None

    value = float(matched.group(1))
    if "k" in normalized or "千" in normalized:
        value *= 1_000
    if "万" in normalized:
        value *= 10_000
    return int(value)


def parse_int(raw: str | int | None) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, int):
        return raw
    normalized = re.sub(r"[^\d]", "", raw)
    return int(normalized) if normalized else None
