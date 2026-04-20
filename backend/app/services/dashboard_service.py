from sqlalchemy import desc, distinct, func, or_
from sqlalchemy.orm import Session

from app.models import CrawlEdge, CrawlRun, Product, ProductSnapshot


def get_dashboard_overview(db: Session) -> dict:
    total_products = db.query(func.count(Product.id)).scalar() or 0
    total_snapshots = db.query(func.count(ProductSnapshot.id)).scalar() or 0
    total_runs = db.query(func.count(CrawlRun.id)).scalar() or 0
    completed_runs = (
        db.query(func.count(CrawlRun.id))
        .filter(CrawlRun.status == "completed")
        .scalar()
        or 0
    )
    total_edges = db.query(func.count(CrawlEdge.id)).scalar() or 0
    related_sources = (
        db.query(func.count(ProductSnapshot.id))
        .filter(ProductSnapshot.source == "related")
        .scalar()
        or 0
    )
    distinct_goods = db.query(func.count(distinct(ProductSnapshot.goods_id))).scalar() or 0
    latest_snapshot = db.query(func.max(ProductSnapshot.scraped_at)).scalar()

    return {
        "total_products": total_products,
        "total_snapshots": total_snapshots,
        "total_runs": total_runs,
        "completed_runs": completed_runs,
        "total_edges": total_edges,
        "related_sources": related_sources,
        "distinct_snapshot_goods": distinct_goods,
        "latest_snapshot_at": latest_snapshot.isoformat() if latest_snapshot else None,
    }


def get_dashboard_runs(db: Session, limit: int = 20) -> list[dict]:
    runs = db.query(CrawlRun).order_by(desc(CrawlRun.started_at)).limit(limit).all()
    return [
        {
            "run_uuid": item.run_uuid,
            "status": item.status,
            "started_at": item.started_at.isoformat() if item.started_at else None,
            "ended_at": item.ended_at.isoformat() if item.ended_at else None,
            "total_collected": item.total_collected,
            "notes": item.notes or "",
        }
        for item in runs
    ]


def get_dashboard_sources(db: Session) -> list[dict]:
    rows = (
        db.query(ProductSnapshot.source, func.count(ProductSnapshot.id))
        .group_by(ProductSnapshot.source)
        .order_by(desc(func.count(ProductSnapshot.id)))
        .all()
    )
    return [
        {
            "source": source or "(empty)",
            "count": count,
        }
        for source, count in rows
    ]


def get_dashboard_edges(db: Session, limit: int = 20) -> list[dict]:
    rows = (
        db.query(
            CrawlEdge.from_goods_id,
            CrawlEdge.to_goods_id,
            CrawlEdge.relation_type,
            func.count(CrawlEdge.id).label("count"),
        )
        .group_by(CrawlEdge.from_goods_id, CrawlEdge.to_goods_id, CrawlEdge.relation_type)
        .order_by(desc(func.count(CrawlEdge.id)))
        .limit(limit)
        .all()
    )
    return [
        {
            "from_goods_id": from_goods_id,
            "to_goods_id": to_goods_id,
            "relation_type": relation_type,
            "count": count,
        }
        for from_goods_id, to_goods_id, relation_type, count in rows
    ]


def get_dashboard_products(
    db: Session,
    keyword: str = "",
    page: int = 1,
    page_size: int = 30,
    sort_by: str = "last_seen_at",
    sort_order: str = "desc",
) -> dict:
    query = db.query(Product)
    if keyword.strip():
        pattern = f"%{keyword.strip()}%"
        query = query.filter(
            or_(
                Product.goods_id.ilike(pattern),
                Product.current_title.ilike(pattern),
                Product.current_full_title.ilike(pattern),
            )
        )

    total = query.count()

    sort_mapping = {
        "goods_id": Product.goods_id,
        "title": Product.current_title,
        "price_text": Product.current_price_text,
        "sales_text": Product.current_sales_text,
        "star_rating": Product.current_star_rating,
        "review_count": Product.current_review_count,
        "listing_time": Product.current_listing_time,
        "raw_text": Product.current_raw_text,
        "raw_html": Product.current_raw_html,
        "last_source": Product.last_source,
        "last_seen_at": Product.last_seen_at,
        "updated_at": Product.updated_at,
    }
    sort_column = sort_mapping.get(sort_by, Product.last_seen_at)
    order_fn = desc if sort_order == "desc" else lambda column: column.asc()
    rows = (
        query.order_by(order_fn(sort_column), desc(Product.updated_at))
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    items = [
        {
            "goods_id": item.goods_id,
            "title": item.current_title or "",
            "full_title": item.current_full_title or "",
            "price_text": item.current_price_text or "",
            "sales_text": item.current_sales_text or "",
            "star_rating": item.current_star_rating or "",
            "review_count": item.current_review_count,
            "listing_time": item.current_listing_time or "",
            "raw_text": item.current_raw_text or "",
            "raw_html": item.current_raw_html or "",
            "last_source": item.last_source or "",
            "last_seen_at": item.last_seen_at.isoformat() if item.last_seen_at else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }
        for item in rows
    ]
    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": (total + page_size - 1) // page_size if page_size else 0,
        "sort_by": sort_by,
        "sort_order": sort_order,
        "keyword": keyword,
    }
