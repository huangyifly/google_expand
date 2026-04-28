from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import CrawlRun
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
    if current_user.role != "admin":
        query = query.filter(CrawlRun.user_id == current_user.id)
    crawl_run = query.one_or_none()
    if crawl_run is None:
        return None

    crawl_run.status = status
    crawl_run.ended_at = datetime.now(timezone.utc)
    if total_collected is not None:
        crawl_run.total_collected = total_collected
    if notes is not None:
        crawl_run.notes = notes

    db.add(crawl_run)
    db.commit()
    db.refresh(crawl_run)
    return crawl_run
