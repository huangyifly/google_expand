from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

ADMIN_HTML = Path(__file__).resolve().parents[2] / "web" / "admin.html"
PRODUCTS_HTML = Path(__file__).resolve().parents[2] / "web" / "products.html"


@router.get("/admin", response_class=HTMLResponse, tags=["admin"])
def admin_page() -> HTMLResponse:
    return HTMLResponse(ADMIN_HTML.read_text(encoding="utf-8"))


@router.get("/admin/products", response_class=HTMLResponse, tags=["admin"])
def admin_products_page() -> HTMLResponse:
    return HTMLResponse(PRODUCTS_HTML.read_text(encoding="utf-8"))
