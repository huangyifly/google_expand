from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.models import Base

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    ensure_products_schema()
    ensure_product_snapshots_schema()
    backfill_product_raw_fields()


def ensure_products_schema() -> None:
    inspector = inspect(engine)
    if "products" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("products")}
    with engine.begin() as connection:
        if "current_listing_time" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN current_listing_time VARCHAR(128)"))
        if "current_raw_text" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN current_raw_text VARCHAR(4096)"))
        if "current_raw_html" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN current_raw_html TEXT"))


def ensure_product_snapshots_schema() -> None:
    inspector = inspect(engine)
    if "product_snapshots" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("product_snapshots")}
    with engine.begin() as connection:
        if "listing_time" not in existing_columns:
            connection.execute(text("ALTER TABLE product_snapshots ADD COLUMN listing_time VARCHAR(128)"))
        if "raw_html" not in existing_columns:
            connection.execute(text("ALTER TABLE product_snapshots ADD COLUMN raw_html TEXT"))


def backfill_product_raw_fields() -> None:
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "products" not in table_names or "product_snapshots" not in table_names:
        return

    with engine.begin() as connection:
        connection.execute(
            text(
                """
                WITH latest_snapshot AS (
                    SELECT DISTINCT ON (goods_id)
                        goods_id,
                        listing_time,
                        raw_text,
                        raw_html
                    FROM product_snapshots
                    WHERE
                        (listing_time IS NOT NULL AND listing_time <> '')
                        OR
                        (raw_text IS NOT NULL AND raw_text <> '')
                        OR (raw_html IS NOT NULL AND raw_html <> '')
                    ORDER BY goods_id, scraped_at DESC NULLS LAST, id DESC
                )
                UPDATE products AS p
                SET
                    current_listing_time = COALESCE(NULLIF(p.current_listing_time, ''), latest_snapshot.listing_time),
                    current_raw_text = COALESCE(NULLIF(p.current_raw_text, ''), latest_snapshot.raw_text),
                    current_raw_html = COALESCE(NULLIF(p.current_raw_html, ''), latest_snapshot.raw_html)
                FROM latest_snapshot
                WHERE p.goods_id = latest_snapshot.goods_id
                  AND (
                    p.current_listing_time IS NULL OR p.current_listing_time = ''
                    OR
                    p.current_raw_text IS NULL OR p.current_raw_text = ''
                    OR p.current_raw_html IS NULL OR p.current_raw_html = ''
                  )
                """
            )
        )
