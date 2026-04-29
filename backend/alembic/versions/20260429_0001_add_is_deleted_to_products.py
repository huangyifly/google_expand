"""add_is_deleted_to_products

Revision ID: 20260429_0001
Revises:
Create Date: 2026-04-29 00:00:00.000000
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260429_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("products", sa.Column("run_uuid", sa.String(length=36), nullable=True))
    op.add_column(
        "products",
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.create_index("ix_products_run_uuid", "products", ["run_uuid"], unique=False)
    op.create_index("ix_products_is_deleted", "products", ["is_deleted"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_products_is_deleted", table_name="products")
    op.drop_index("ix_products_run_uuid", table_name="products")
    op.drop_column("products", "is_deleted")
    op.drop_column("products", "run_uuid")
