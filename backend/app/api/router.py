from fastapi import APIRouter

from app.api.routes import admin, admin_login_logs, admin_users, auth, config, dashboard, health, runs, upload

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(admin.router)
api_router.include_router(admin_login_logs.router)
api_router.include_router(admin_users.router)
api_router.include_router(config.router)
api_router.include_router(runs.router, prefix="/api/runs", tags=["runs"])
api_router.include_router(upload.router, prefix="/api/upload", tags=["upload"])
api_router.include_router(dashboard.router, prefix="/api/dashboard", tags=["dashboard"])
