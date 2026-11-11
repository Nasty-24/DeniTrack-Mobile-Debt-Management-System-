"""Learned M-Pesa names for customers.

- customer_mpesa_names: names M-Pesa shows for a customer's payments, learned when staff
  matched one of their payments by hand. Used to match later payments.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

import app.models

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

POLICY = """
    current_setting('app.bypass_rls', true) = 'on'
    OR business_id::text = current_setting('app.business_id', true)
"""


def upgrade() -> None:
    op.create_table(
        "customer_mpesa_names",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("business_id", sa.Uuid(), nullable=False),
        sa.Column("customer_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("source_message_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_at", app.models.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(["business_id"], ["businesses.id"]),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["source_message_id"], ["mpesa_sms_messages.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("business_id", "customer_id", "name"),
    )
    op.create_index("ix_customer_mpesa_names_business_id", "customer_mpesa_names", ["business_id"])
    op.create_index("ix_customer_mpesa_names_business_name", "customer_mpesa_names", ["business_id", "name"])

    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TABLE customer_mpesa_names ENABLE ROW LEVEL SECURITY")
        op.execute("ALTER TABLE customer_mpesa_names FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY tenant_isolation ON customer_mpesa_names USING ({POLICY}) WITH CHECK ({POLICY})")
        # Grants for the restricted app role come from the owner's default privileges
        # (scripts/create_app_role.sh), as for the other tables.


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("DROP POLICY IF EXISTS tenant_isolation ON customer_mpesa_names")
    op.drop_index("ix_customer_mpesa_names_business_name", table_name="customer_mpesa_names")
    op.drop_index("ix_customer_mpesa_names_business_id", table_name="customer_mpesa_names")
    op.drop_table("customer_mpesa_names")
