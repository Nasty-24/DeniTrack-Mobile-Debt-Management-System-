"""M-Pesa SMS matching and reminders sent from the owner's phone.

- mpesa_sms_messages: each M-Pesa "received" SMS read on the owner's phone and its outcome.
- business_settings.sms_sender: "phone" (default) or "provider".

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

import app.models

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

POLICY = """
    current_setting('app.bypass_rls', true) = 'on'
    OR business_id::text = current_setting('app.business_id', true)
"""


def upgrade() -> None:
    op.add_column(
        "business_settings",
        sa.Column("sms_sender", sa.String(length=16), nullable=False, server_default="phone"),
    )
    op.create_table(
        "mpesa_sms_messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("business_id", sa.Uuid(), nullable=False),
        sa.Column("transaction_code", sa.String(length=10), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("payer_name", sa.String(length=160), nullable=False),
        sa.Column("payer_phone", sa.String(length=20), nullable=True),
        sa.Column("received_at", app.models.UTCDateTime(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("detail", sa.String(length=300), nullable=True),
        sa.Column("customer_id", sa.Uuid(), nullable=True),
        sa.Column("suggested_customer_id", sa.Uuid(), nullable=True),
        sa.Column("payment_id", sa.Uuid(), nullable=True),
        sa.Column("message_text", sa.String(length=1000), nullable=False),
        sa.Column("submitted_by", sa.Uuid(), nullable=False),
        sa.Column("resolved_by", sa.Uuid(), nullable=True),
        sa.Column("resolved_at", app.models.UTCDateTime(), nullable=True),
        sa.Column("created_at", app.models.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(["business_id"], ["businesses.id"]),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["suggested_customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["payment_id"], ["payments.id"]),
        sa.ForeignKeyConstraint(["submitted_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["resolved_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("business_id", "transaction_code"),
    )
    op.create_index("ix_mpesa_sms_messages_business_id", "mpesa_sms_messages", ["business_id"])
    op.create_index("ix_mpesa_sms_business_status", "mpesa_sms_messages", ["business_id", "status"])

    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TABLE mpesa_sms_messages ENABLE ROW LEVEL SECURITY")
        op.execute("ALTER TABLE mpesa_sms_messages FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY tenant_isolation ON mpesa_sms_messages USING ({POLICY}) WITH CHECK ({POLICY})")
        # Grants for the restricted denitrack_app role come from the owner's default privileges
        # (scripts/create_app_role.sh), so nothing extra is needed here.


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("DROP POLICY IF EXISTS tenant_isolation ON mpesa_sms_messages")
    op.drop_index("ix_mpesa_sms_business_status", table_name="mpesa_sms_messages")
    op.drop_index("ix_mpesa_sms_messages_business_id", table_name="mpesa_sms_messages")
    op.drop_table("mpesa_sms_messages")
    with op.batch_alter_table("business_settings") as batch:
        batch.drop_column("sms_sender")
