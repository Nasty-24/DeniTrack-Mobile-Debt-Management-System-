"""Pull endpoint for the mobile offline cache. Writes go through the normal endpoints with
Idempotency-Key / client_reference, so a replayed offline queue can never double-post."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.customers import _out as customer_out
from app.api.deps import Tenant, get_tenant
from app.api.presenters import debt_out
from app.db import get_db
from app.models import Customer, Payment, PaymentAllocation
from app.repositories.debts import customer_totals, load_views
from app.services.common import business_today

router = APIRouter(prefix="/businesses/{business_id}/sync", tags=["sync"])


@router.get("/changes")
def changes(since: datetime | None = None, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    server_time = datetime.now(UTC)
    today = business_today(tenant.business)
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=UTC)

    cust_stmt = select(Customer).where(Customer.business_id == tenant.business_id)
    if since:
        cust_stmt = cust_stmt.where(Customer.updated_at >= since)
    customers = list(db.scalars(cust_stmt))

    views = load_views(db, tenant.business_id, today)
    if since:
        touched = set(
            db.scalars(
                select(PaymentAllocation.debt_id)
                .join(Payment, Payment.id == PaymentAllocation.payment_id)
                .where(
                    Payment.business_id == tenant.business_id,
                    or_(Payment.created_at >= since, Payment.reversed_at >= since, Payment.verified_at >= since),
                )
            )
        )
        # Outstanding debts are always resent because their status can change with the date alone.
        views = [v for v in views if v.debt.updated_at >= since or v.debt.id in touched or v.figures.balance > 0]
    totals = customer_totals(db, tenant.business_id, today, [c.id for c in customers]) if customers else {}
    return {
        "server_time": server_time.isoformat(),
        "customers": [customer_out(c, totals.get(c.id)).model_dump(mode="json") for c in customers],
        "debts": [debt_out(v, today).model_dump(mode="json") for v in views],
    }
