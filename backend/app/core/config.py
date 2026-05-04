import os

from pydantic_settings import BaseSettings, SettingsConfigDict

# 根据 APP_ENV 环境变量决定加载哪个 .env 文件：
#   APP_ENV=production  → .env.production  （服务器上）
#   APP_ENV 未设置/其他 → .env             （本地开发）
# 优先级：系统环境变量 > .env 文件 > 字段默认值
_app_env = os.getenv("APP_ENV", "development")
_env_file = ".env.production" if _app_env == "production" else ".env"


class Settings(BaseSettings):
    app_name: str = "Temu Scraper Backend"
    app_env: str = "development"
    debug: bool = True
    # 默认值仅作文档示例，实际值始终由 .env 或环境变量覆盖
    database_url: str = "postgresql+psycopg://user:pass@127.0.0.1:5432/temu_scraper"
    jwt_secret: str = "CHANGE_ME_IN_PRODUCTION"
    jwt_expire_minutes: int = 60 * 24 * 7

    model_config = SettingsConfigDict(
        env_file=_env_file,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()
