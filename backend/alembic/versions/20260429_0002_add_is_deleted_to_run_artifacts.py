"""add_is_deleted_to_run_artifacts

Revision ID: 20260429_0002
Revises: 20260429_0001
Create Date: 2026-04-29 00:00:00.000000
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260429_0002"
down_revision: str | None = "20260429_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for table_name in ("crawl_runs", "product_snapshots", "crawl_edges"):
        op.add_column(
            table_name,
            sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        )
        op.create_index(f"ix_{table_name}_is_deleted", table_name, ["is_deleted"], unique=False)


def downgrade() -> None:
    for table_name in ("crawl_edges", "product_snapshots", "crawl_runs"):
        op.drop_index(f"ix_{table_name}_is_deleted", table_name=table_name)
        op.drop_column(table_name, "is_deleted")
