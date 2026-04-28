from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.db import get_db
from app.models.user import User
from app.schemas.upload import UploadBatchRequest, UploadBatchResponse
from app.services.ingest_service import ingest_batch

router = APIRouter()


@router.post("/batch", response_model=UploadBatchResponse)
def upload_batch(
    payload: UploadBatchRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> UploadBatchResponse:
    result = ingest_batch(db, payload, current_user)
    return UploadBatchResponse(**result)
