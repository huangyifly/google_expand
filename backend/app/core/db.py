from collections.abc import Generator
import os
import re

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.core.security import hash_password
from app.models import Base
from app.models.exclusion_keyword import ExclusionKeyword
from app.models.product import Product
from app.models.user import User

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
    ensure_user_isolation_schema()
    ensure_products_schema()
    ensure_product_snapshots_schema()
    backfill_product_raw_fields()
    backfill_product_run_uuid()
    seed_exclusion_keywords()
    backfill_product_sales_values()
    seed_admin()


def ensure_user_isolation_schema() -> None:
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    with engine.begin() as connection:
        if "products" in table_names:
            product_columns = {column["name"] for column in inspector.get_columns("products")}
            if "user_id" not in product_columns:
                connection.execute(text("ALTER TABLE products ADD COLUMN user_id INTEGER"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_products_user_id ON products (user_id)"))
            connection.execute(text("DROP INDEX IF EXISTS ix_products_goods_id_unique"))
            connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_products_user_goods_unique ON products (user_id, goods_id)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_products_goods_id ON products (goods_id)"))

        if "crawl_runs" in table_names:
            run_columns = {column["name"] for column in inspector.get_columns("crawl_runs")}
            if "user_id" not in run_columns:
                connection.execute(text("ALTER TABLE crawl_runs ADD COLUMN user_id INTEGER"))
            if "is_deleted" not in run_columns:
                connection.execute(text("ALTER TABLE crawl_runs ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT FALSE"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_crawl_runs_user_id ON crawl_runs (user_id)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_crawl_runs_is_deleted ON crawl_runs (is_deleted)"))

        if "crawl_edges" in table_names:
            edge_columns = {column["name"] for column in inspector.get_columns("crawl_edges")}
            if "user_id" not in edge_columns:
                connection.execute(text("ALTER TABLE crawl_edges ADD COLUMN user_id INTEGER"))
            if "is_deleted" not in edge_columns:
                connection.execute(text("ALTER TABLE crawl_edges ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT FALSE"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_crawl_edges_user_id ON crawl_edges (user_id)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_crawl_edges_is_deleted ON crawl_edges (is_deleted)"))

        if "product_snapshots" in table_names:
            snapshot_columns = {column["name"] for column in inspector.get_columns("product_snapshots")}
            if "user_id" not in snapshot_columns:
                connection.execute(text("ALTER TABLE product_snapshots ADD COLUMN user_id INTEGER"))
            if "is_deleted" not in snapshot_columns:
                connection.execute(text("ALTER TABLE product_snapshots ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT FALSE"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_product_snapshots_user_id ON product_snapshots (user_id)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_product_snapshots_is_deleted ON product_snapshots (is_deleted)"))


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
        if "current_sales_value" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN current_sales_value INTEGER"))
        if "run_uuid" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN run_uuid VARCHAR(36)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_products_run_uuid ON products (run_uuid)"))
        else:
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_products_run_uuid ON products (run_uuid)"))
        if "is_deleted" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT FALSE"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_products_is_deleted ON products (is_deleted)"))
        if "listing_length_cm" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN listing_length_cm NUMERIC(10, 2)"))
        if "listing_width_cm" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN listing_width_cm NUMERIC(10, 2)"))
        if "listing_height_cm" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN listing_height_cm NUMERIC(10, 2)"))
        if "listing_weight_g" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN listing_weight_g NUMERIC(10, 2)"))
        if "listing_declared_price" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN listing_declared_price NUMERIC(12, 2)"))
        if "listing_suggested_price" not in existing_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN listing_suggested_price NUMERIC(12, 2)"))


def ensure_product_snapshots_schema() -> None:
    inspector = inspect(engine)
    if "product_snapshots" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("product_snapshots")}
    with engine.begin() as connection:
        if "listing_time" not in existing_columns:
            connection.execute(text("ALTER TABLE product_snapshots ADD COLUMN listing_time VARCHAR(128)"))
        if "sales_value" not in existing_columns:
            connection.execute(text("ALTER TABLE product_snapshots ADD COLUMN sales_value INTEGER"))
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


def backfill_product_run_uuid() -> None:
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "products" not in table_names or "product_snapshots" not in table_names:
        return

    product_columns = {column["name"] for column in inspector.get_columns("products")}
    snapshot_columns = {column["name"] for column in inspector.get_columns("product_snapshots")}
    if "run_uuid" not in product_columns or "run_uuid" not in snapshot_columns:
        return

    with engine.begin() as connection:
        connection.execute(
            text(
                """
                WITH latest_snapshot AS (
                    SELECT DISTINCT ON (user_id, goods_id)
                        user_id,
                        goods_id,
                        run_uuid
                    FROM product_snapshots
                    WHERE run_uuid IS NOT NULL AND run_uuid <> ''
                    ORDER BY user_id, goods_id, scraped_at DESC NULLS LAST, id DESC
                )
                UPDATE products AS p
                SET run_uuid = latest_snapshot.run_uuid
                FROM latest_snapshot
                WHERE p.goods_id = latest_snapshot.goods_id
                  AND p.user_id IS NOT DISTINCT FROM latest_snapshot.user_id
                  AND p.run_uuid IS NULL
                """
            )
        )


def parse_sales_value(raw: str | None) -> int | None:
    if not raw:
        return None
    normalized = raw.strip().lower().replace(",", "")
    matched = re.search(r"(\d+(?:\.\d+)?)", normalized)
    if not matched:
        return None

    value = float(matched.group(1))
    if "k" in normalized or "千" in normalized:
        value *= 1_000
    if "万" in normalized:
        value *= 10_000
    return int(value)


def backfill_product_sales_values() -> None:
    inspector = inspect(engine)
    if "products" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("products")}
    if "current_sales_value" not in existing_columns or "current_sales_text" not in existing_columns:
        return

    with SessionLocal() as db:
        rows = (
            db.query(Product)
            .filter(Product.current_sales_value.is_(None))
            .filter(Product.current_sales_text.isnot(None))
            .all()
        )
        changed = False
        for row in rows:
            parsed = parse_sales_value(row.current_sales_text)
            if parsed is not None:
                row.current_sales_value = parsed
                changed = True
        if changed:
            db.commit()


# (keyword, category) 初始种子数据，仅在表为空时插入一次
_SEED_KEYWORDS: list[tuple[str, str]] = [
    ("玩具", "其他"),
    # 大家电
    ("洗衣机", "电器"), ("冰箱", "电器"), ("冰柜", "电器"), ("空调", "电器"),
    ("电视机", "电器"), ("投影仪", "电器"), ("微波炉", "电器"), ("烤箱", "电器"),
    ("热水器", "电器"), ("电热水器", "电器"), ("洗碗机", "电器"), ("干衣机", "电器"),
    # 厨房小电
    ("电饭锅", "电器"), ("电压力锅", "电器"), ("电磁炉", "电器"), ("电陶炉", "电器"),
    ("料理机", "电器"), ("榨汁机", "电器"), ("破壁机", "电器"), ("豆浆机", "电器"),
    ("咖啡机", "电器"), ("胶囊咖啡机", "电器"), ("电热水壶", "电器"), ("养生壶", "电器"),
    ("烤面包机", "电器"), ("多士炉", "电器"), ("空气炸锅", "电器"), ("电炒锅", "电器"),
    ("电烤盘", "电器"), ("蒸汽锅", "电器"), ("三明治机", "电器"), ("华夫饼机", "电器"),
    ("绞肉机", "电器"), ("和面机", "电器"),
    # 清洁家电
    ("吸尘器", "电器"), ("扫地机器人", "电器"), ("扫地机", "电器"), ("拖地机", "电器"),
    ("洗地机", "电器"), ("蒸汽拖把", "电器"), ("除螨仪", "电器"),
    # 空气/温控
    ("空气净化器", "电器"), ("加湿器", "电器"), ("除湿机", "电器"),
    ("电风扇", "电器"), ("风扇", "电器"), ("暖风机", "电器"), ("取暖器", "电器"),
    ("电暖器", "电器"), ("油汀", "电器"), ("电热毯", "电器"), ("电热丝毯", "电器"),
    # 照明
    ("台灯", "电器"), ("落地灯", "电器"), ("床头灯", "电器"), ("夜灯", "电器"),
    ("感应灯", "电器"), ("LED灯带", "电器"), ("射灯", "电器"), ("筒灯", "电器"), ("吸顶灯", "电器"),
    # 手机/平板/电脑
    ("手机", "电器"), ("平板电脑", "电器"), ("笔记本电脑", "电器"), ("台式机", "电器"),
    ("一体机", "电器"), ("电脑主机", "电器"), ("显示器", "电器"), ("键盘", "电器"), ("鼠标", "电器"),
    # 耳机/音响
    ("耳机", "电器"), ("蓝牙耳机", "电器"), ("有线耳机", "电器"), ("降噪耳机", "电器"),
    ("音箱", "电器"), ("蓝牙音箱", "电器"), ("音响", "电器"), ("回音壁", "电器"),
    # 充电/配件
    ("充电器", "电器"), ("充电宝", "电器"), ("数据线", "电器"), ("无线充", "电器"),
    ("移动电源", "电器"), ("快充头", "电器"), ("充电头", "电器"),
    # 智能穿戴
    ("智能手表", "电器"), ("智能手环", "电器"), ("运动手表", "电器"),
    # 美容仪器
    ("电动牙刷", "电器"), ("冲牙器", "电器"), ("洁面仪", "电器"), ("美容仪", "电器"),
    ("脱毛仪", "电器"), ("卷发棒", "电器"), ("直发器", "电器"), ("直发夹", "电器"),
    ("吹风机", "电器"), ("电吹风", "电器"), ("梳子", "电器"),
    # 摄影/安防
    ("摄像头", "电器"), ("行车记录仪", "电器"), ("运动相机", "电器"), ("运动摄像机", "电器"),
    ("监控", "电器"), ("门铃摄像头", "电器"),
    # 游戏/娱乐
    ("游戏机", "电器"), ("游戏手柄", "电器"), ("手柄", "电器"),
    # 办公设备
    ("打印机", "电器"), ("扫描仪", "电器"), ("碎纸机", "电器"), ("投影屏", "电器"),
    # 食品接触材料
    ("碗", "食品接触"), ("饭碗", "食品接触"), ("汤碗", "食品接触"), ("沙拉碗", "食品接触"),
    ("盘子", "食品接触"), ("碟子", "食品接触"), ("餐盘", "食品接触"), ("碟", "食品接触"),
    ("筷子", "食品接触"), ("勺子", "食品接触"), ("汤匙", "食品接触"), ("餐叉", "食品接触"),
    ("叉子", "食品接触"), ("餐勺", "食品接触"), ("餐刀", "食品接触"), ("刀叉", "食品接触"),
    ("餐具", "食品接触"), ("杯子", "食品接触"), ("水杯", "食品接触"), ("茶杯", "食品接触"),
    ("马克杯", "食品接触"), ("咖啡杯", "食品接触"), ("玻璃杯", "食品接触"),
    ("保温杯", "食品接触"), ("焖烧杯", "食品接触"), ("随行杯", "食品接触"),
    ("保温壶", "食品接触"), ("水壶", "食品接触"), ("茶壶", "食品接触"), ("茶具", "食品接触"),
    ("公道杯", "食品接触"), ("茶盘", "食品接触"),
    ("吸管", "食品接触"), ("金属吸管", "食品接触"), ("硅胶吸管", "食品接触"),
    ("饭盒", "食品接触"), ("便当盒", "食品接触"), ("餐盒", "食品接触"),
    ("保鲜盒", "食品接触"), ("食品盒", "食品接触"), ("密封罐", "食品接触"),
    ("储物罐", "食品接触"), ("密封袋", "食品接触"), ("保鲜袋", "食品接触"),
    ("食品袋", "食品接触"), ("真空袋", "食品接触"), ("保鲜膜", "食品接触"),
    ("炒锅", "食品接触"), ("汤锅", "食品接触"), ("平底锅", "食品接触"),
    ("不粘锅", "食品接触"), ("铸铁锅", "食品接触"), ("砂锅", "食品接触"),
    ("蒸锅", "食品接触"), ("奶锅", "食品接触"), ("煎锅", "食品接触"),
    ("烤盘", "食品接触"), ("烤架", "食品接触"),
    ("菜刀", "食品接触"), ("水果刀", "食品接触"), ("砧板", "食品接触"),
    ("切菜板", "食品接触"), ("案板", "食品接触"),
    ("削皮器", "食品接触"), ("刨丝器", "食品接触"), ("擦丝器", "食品接触"),
    ("漏勺", "食品接触"), ("滤网", "食品接触"), ("沥水篮", "食品接触"),
    ("量杯", "食品接触"), ("量勺", "食品接触"), ("开瓶器", "食品接触"), ("开罐器", "食品接触"),
    ("调味瓶", "食品接触"), ("调料盒", "食品接触"), ("油壶", "食品接触"), ("醋壶", "食品接触"),
    ("冰格", "食品接触"), ("制冰盒", "食品接触"), ("烘焙模具", "食品接触"),
    ("蛋糕模", "食品接触"), ("烘焙纸", "食品接触"), ("锡纸", "食品接触"),
    # 服装上衣
    ("T恤", "服装"), ("衬衫", "服装"), ("衬衣", "服装"), ("卫衣", "服装"),
    ("毛衣", "服装"), ("针织衫", "服装"), ("毛衫", "服装"), ("吊带衫", "服装"),
    ("吊带背心", "服装"), ("背心", "服装"), ("马甲", "服装"),
    ("外套", "服装"), ("夹克", "服装"), ("风衣", "服装"), ("大衣", "服装"),
    ("棉衣", "服装"), ("棉服", "服装"), ("羽绒服", "服装"),
    ("皮衣", "服装"), ("皮草", "服装"), ("西装", "服装"), ("西服", "服装"),
    ("礼服", "服装"), ("正装", "服装"), ("内衣", "服装"), ("睡衣", "服装"),
    ("打底衫", "服装"), ("秋衣", "服装"),
    # 裤子
    ("牛仔裤", "服装"), ("休闲裤", "服装"), ("运动裤", "服装"), ("西裤", "服装"),
    ("短裤", "服装"), ("长裤", "服装"), ("九分裤", "服装"), ("七分裤", "服装"),
    ("阔腿裤", "服装"), ("小脚裤", "服装"), ("打底裤", "服装"),
    ("瑜伽裤", "服装"), ("睡裤", "服装"), ("内裤", "服装"), ("秋裤", "服装"), ("裤子", "服装"),
    # 裙子
    ("连衣裙", "服装"), ("半身裙", "服装"), ("短裙", "服装"), ("长裙", "服装"),
    ("百褶裙", "服装"), ("蓬蓬裙", "服装"), ("A字裙", "服装"), ("包臀裙", "服装"), ("裙子", "服装"),
    # 鞋履
    ("运动鞋", "服装"), ("板鞋", "服装"), ("凉鞋", "服装"), ("高跟鞋", "服装"),
    ("平底鞋", "服装"), ("拖鞋", "服装"), ("马丁靴", "服装"), ("雪地靴", "服装"),
    ("帆布鞋", "服装"), ("皮鞋", "服装"), ("短靴", "服装"), ("长靴", "服装"),
    ("老爹鞋", "服装"), ("洞洞鞋", "服装"),
    # 配件
    ("遮阳帽", "服装"), ("棒球帽", "服装"), ("针织帽", "服装"), ("渔夫帽", "服装"),
    ("毛线帽", "服装"), ("围巾", "服装"), ("口罩", "服装"), ("手套", "服装"),
    ("袜子", "服装"), ("丝袜", "服装"), ("连裤袜", "服装"),
    # 内衣/泳衣/运动服
    ("胸罩", "服装"), ("文胸", "服装"), ("塑身衣", "服装"),
    ("泳衣", "服装"), ("泳裤", "服装"), ("泳装", "服装"),
    ("瑜伽服", "服装"), ("健身服", "服装"), ("运动服", "服装"),
    # 特定品类
    ("汉服", "服装"), ("旗袍", "服装"), ("唐装", "服装"),
    ("孕妇装", "服装"), ("哺乳服", "服装"),
    ("童装", "服装"), ("婴儿服", "服装"), ("儿童服", "服装"),
    ("男装", "服装"), ("女装", "服装"),
    # 包包
    ("手提包", "服装"), ("单肩包", "服装"), ("斜挎包", "服装"),
    ("背包", "服装"), ("双肩包", "服装"), ("钱包", "服装"), ("卡包", "服装"),
    ("零钱包", "服装"), ("行李箱", "服装"), ("旅行包", "服装"),
]


def seed_exclusion_keywords() -> None:
    """首次启动时将初始排除词写入数据库（表为空时才插入，幂等）。"""
    with SessionLocal() as db:
        if db.query(ExclusionKeyword).count() > 0:
            return
        db.bulk_insert_mappings(
            ExclusionKeyword,  # type: ignore[arg-type]
            [{"keyword": kw, "category": cat} for kw, cat in _SEED_KEYWORDS],
        )
        db.commit()


def seed_admin() -> None:
    with SessionLocal() as db:
        if db.query(User).count() > 0:
            return
        admin = User(
            email=os.environ.get("ADMIN_EMAIL", "admin@example.com").strip().lower(),
            hashed_password=hash_password(os.environ.get("ADMIN_PASSWORD", "changeme123")),
            role="admin",
            is_active=True,
        )
        db.add(admin)
        db.commit()
