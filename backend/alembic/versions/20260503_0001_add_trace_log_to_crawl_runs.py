"""add trace_log to crawl_runs

Revision ID: 20260503_0001
Revises: 20260429_0002_add_is_deleted_to_run_artifacts
Create Date: 2026-05-03
"""

from alembic import op
import sqlalchemy as sa

revision = "20260503_0001"
down_revision = "20260429_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "crawl_runs",
        sa.Column("trace_log", sa.Text(), nullable=True, comment="采集流程追踪日志，JSONL 格式，每行一条决策记录"),
    )


def downgrade() -> None:
    op.drop_column("crawl_runs", "trace_log")
