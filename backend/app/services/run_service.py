from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import CrawlRun, Product, ProductSnapshot
from app.models.user import User


def start_run(db: Session, current_user: User) -> CrawlRun:
    crawl_run = CrawlRun(user_id=current_user.id)
    db.add(crawl_run)
    db.commit()
    db.refresh(crawl_run)
    return crawl_run


def finish_run(
    db: Session,
    current_user: User,
    run_uuid: str,
    status: str,
    total_collected: int | None,
    notes: str | None,
) -> CrawlRun | None:
    query = db.query(CrawlRun).filter(CrawlRun.run_uuid == run_uuid)
    query = query.filter(CrawlRun.is_deleted.is_(False))
    if current_user.role != "admin":
        query = query.filter(CrawlRun.user_id == current_user.id)
    crawl_run = query.one_or_none()
    if crawl_run is None:
        return None

    actual_collected = count_run_collected(db, current_user, run_uuid)
    crawl_run.status = status
    crawl_run.ended_at = datetime.now(timezone.utc)
    crawl_run.total_collected = actual_collected
    if notes is not None:
        crawl_run.notes = notes

    db.add(crawl_run)
    db.commit()
    db.refresh(crawl_run)
    return crawl_run


def count_run_collected(db: Session, current_user: User, run_uuid: str) -> int:
    query = (
        db.query(func.count(func.distinct(ProductSnapshot.goods_id)))
        .filter(ProductSnapshot.is_deleted.is_(False))
        .join(
            Product,
            (Product.user_id.is_not_distinct_from(ProductSnapshot.user_id))
            & (Product.goods_id == ProductSnapshot.goods_id)
            & (Product.is_deleted.is_(False)),
        )
        .filter(ProductSnapshot.run_uuid == run_uuid)
    )
    if current_user.role != "admin":
        query = query.filter(ProductSnapshot.user_id == current_user.id)
    return int(query.scalar() or 0)
