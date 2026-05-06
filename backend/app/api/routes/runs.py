import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.api.deps import get_current_user
from app.core.db import get_db
from app.models.crawl_run import CrawlRun
from app.models.user import User
from app.schemas.run import CrawlRunFinishRequest, CrawlRunResponse, TraceUploadRequest, TraceUploadResponse
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


@router.post("/{run_uuid}/trace", response_model=TraceUploadResponse)
def upload_trace_log(
    payload: TraceUploadRequest,
    run_uuid: str = Path(..., description="采集任务 UUID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TraceUploadResponse:
    """接收前端 content.js 上传的采集流程追踪日志，存入 crawl_runs.trace_log（JSONL 格式）。"""
    logger.info("[trace] 收到上传请求 run_uuid=%s entries数量=%d", run_uuid, len(payload.entries))
    if payload.entries:
        logger.info("[trace] 前3条样本: %s", json.dumps(payload.entries[:3], ensure_ascii=False))

    crawl_run = (
        db.query(CrawlRun)
        .filter(CrawlRun.run_uuid == run_uuid, CrawlRun.user_id == current_user.id)
        .first()
    )
    if crawl_run is None:
        raise HTTPException(status_code=404, detail="采集任务不存在")

    if not payload.entries:
        return TraceUploadResponse(ok=True, count=0)

    jsonl = "\n".join(json.dumps(entry, ensure_ascii=False) for entry in payload.entries)
    crawl_run.trace_log = jsonl
    db.commit()

    return TraceUploadResponse(ok=True, count=len(payload.entries))
