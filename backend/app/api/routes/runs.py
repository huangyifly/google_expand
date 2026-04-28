from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.db import get_db
from app.models.user import User
from app.schemas.run import CrawlRunFinishRequest, CrawlRunResponse
from app.services.run_service import finish_run, start_run

router = APIRouter()


@router.post("/start", response_model=CrawlRunResponse)
def start_crawl_run(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CrawlRunResponse:
    crawl_run = start_run(db, current_user)
    return CrawlRunResponse.model_validate(crawl_run)


@router.post("/{run_uuid}/finish", response_model=CrawlRunResponse)
def finish_crawl_run(
    payload: CrawlRunFinishRequest,
    run_uuid: str = Path(..., description="采集任务 UUID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CrawlRunResponse:
    crawl_run = finish_run(
        db,
        current_user=current_user,
        run_uuid=run_uuid,
        status=payload.status,
        total_collected=payload.total_collected,
        notes=payload.notes,
    )
    if crawl_run is None:
        raise HTTPException(status_code=404, detail="采集任务不存在")
    return CrawlRunResponse.model_validate(crawl_run)
