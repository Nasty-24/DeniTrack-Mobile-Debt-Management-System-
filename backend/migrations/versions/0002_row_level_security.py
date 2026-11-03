"""PostgreSQL row-level security on every tenant-owned table.

Defence in depth: the API already filters every query by business_id after checking
membership. RLS makes the database refuse cross-tenant rows even if a query forgets.

The app sets `app.business_id` per transaction (see app/db.py). Trusted system jobs
(scheduler, payment callbacks) set `app.bypass_rls = 'on'`. FORCE ROW LEVEL SECURITY
applies the policies to the table owner too, so this works even if the app connects
as the owning role (a separate non-owner role is still recommended; see docs/security.md).

Revision ID: 0002
Revises: 0001
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

TENANT_TABLES = [
    "customers", "debts", "debt_adjustments", "repayment_schedules", "payments", "payment_allocations",
    "receipts", "payment_requests", "reminder_templates", "reminder_history", "notifications",
    "audit_logs", "business_settings", "idempotency_records", "counters",
]

POLICY = """
    current_setting('app.bypass_rls', true) = 'on'
    OR business_id::text = current_setting('app.business_id', true)
"""


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for t in TENANT_TABLES:
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY tenant_isolation ON {t} USING ({POLICY}) WITH CHECK ({POLICY})")


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for t in TENANT_TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {t}")
        op.execute(f"ALTER TABLE {t} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} DISABLE ROW LEVEL SECURITY")
