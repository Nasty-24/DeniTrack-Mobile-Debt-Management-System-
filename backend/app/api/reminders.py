import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import Tenant, get_tenant, manager_only
from app.db import get_db
from app.errors import BusinessRuleError, NotFound
from app.models import ReminderChannel, ReminderHistory, ReminderStatus
from app.schemas import Page, ReminderOut
from app.services.common import audit
from app.services.reminders import dispatch_due, plan_reminders

router = APIRouter(prefix="/businesses/{business_id}/reminders", tags=["reminders"])


@router.get("", response_model=Page[ReminderOut])
def reminder_history(
    status: ReminderStatus | None = None,
    channel: ReminderChannel | None = None,
    customer_id: uuid.UUID | None = None,
    debt_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: Tenant = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    stmt = select(ReminderHistory).where(ReminderHistory.business_id == tenant.business_id)
    if status:
        stmt = stmt.where(ReminderHistory.status == status)
    if channel:
        stmt = stmt.where(ReminderHistory.channel == channel)
    if customer_id:
        stmt = stmt.where(ReminderHistory.customer_id == customer_id)
    if debt_id:
        stmt = stmt.where(ReminderHistory.debt_id == debt_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(ReminderHistory.created_at.desc()).limit(limit).offset(offset)).all()
    return Page(items=[ReminderOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset)


@router.post("/run")
def run_now(tenant: Tenant = Depends(manager_only), db: Session = Depends(get_db)):
    """Plan and send due reminders immediately (the scheduler also does this every 15 minutes)."""
    now = datetime.now(UTC)
    planned = plan_reminders(db, tenant.business, now)
    stats = dispatch_due(db, tenant.business, now)
    db.commit()
    return {"planned": planned, **stats}


@router.post("/{reminder_id}/retry", response_model=ReminderOut)
def retry(reminder_id: uuid.UUID, tenant: Tenant = Depends(manager_only), db: Session = Depends(get_db)):
    """Re-queue a failed reminder. The balance is re-checked before it is sent."""
    r = db.scalar(
        select(ReminderHistory).where(
            ReminderHistory.id == reminder_id, ReminderHistory.business_id == tenant.business_id
        )
    )
    if r is None:
        raise NotFound("Reminder not found")
    if r.status != ReminderStatus.failed:
        raise BusinessRuleError("Only failed reminders can be retried")
    r.status, r.attempts, r.next_attempt_at = ReminderStatus.queued, 0, datetime.now(UTC)
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="reminder.retried",
        entity_type="reminder",
        entity_id=r.id,
        ip=tenant.ip,
    )
    db.commit()
    return ReminderOut.model_validate(r)
