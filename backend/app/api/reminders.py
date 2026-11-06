import uuid
from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import Tenant, get_tenant, manager_only
from app.db import get_db
from app.errors import BusinessRuleError, Forbidden, NotFound
from app.models import ReminderChannel, ReminderHistory, ReminderStatus
from app.schemas import ManualReminderIn, Page, PhoneResultIn, PhoneSmsOut, ReminderOut
from app.services.common import audit
from app.services.reminders import (
    MANUAL_PREFIX,
    claim_for_phone,
    dispatch_due,
    manual_reminder,
    plan_reminders,
    record_phone_result,
    waiting_for_phone,
)

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
    return {"planned": planned, **stats, "waiting_for_phone": waiting_for_phone(db, tenant.business, now)}


@router.get("/phone-queue", response_model=list[PhoneSmsOut])
def phone_queue(tenant: Tenant = Depends(manager_only), db: Session = Depends(get_db)):
    """SMS reminders for the owner's phone to send now from its own SIM.

    Plans any newly due reminders first, so the phone does not depend on the scheduler.
    Each one is reserved for this phone for 15 minutes; report the outcome to /phone-result.
    """
    now = datetime.now(UTC)
    plan_reminders(db, tenant.business, now)
    claimed = claim_for_phone(db, tenant.business, now)
    db.commit()
    return [
        PhoneSmsOut(reminder_id=rec.id, customer_name=c.name, phone=c.phone, message=rec.message or "")
        for rec, c in claimed
    ]


@router.post("/manual", status_code=201, response_model=PhoneSmsOut)
def send_manual(data: ManualReminderIn, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    """Prepare a reminder that this staff member sends now from their phone (SMS or WhatsApp)."""
    channel = ReminderChannel(data.channel)
    rec, customer = manual_reminder(db, tenant.business, data.customer_id, channel, datetime.now(UTC))
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="reminder.manual",
        entity_type="customer",
        entity_id=customer.id,
        after={"channel": channel.value, "reminder": str(rec.id)},
        ip=tenant.ip,
    )
    db.commit()
    message = rec.message or ""
    wa = (
        f"https://wa.me/{customer.phone.lstrip('+')}?text={quote(message)}"
        if channel == ReminderChannel.whatsapp
        else None
    )
    return PhoneSmsOut(
        reminder_id=rec.id, customer_name=customer.name, phone=customer.phone, message=message, whatsapp_url=wa
    )


@router.post("/{reminder_id}/phone-result", response_model=ReminderOut)
def phone_result(
    reminder_id: uuid.UUID, data: PhoneResultIn, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)
):
    """The phone reports whether it sent an SMS reminder. Safe to repeat."""
    r = db.scalar(
        select(ReminderHistory)
        .where(ReminderHistory.id == reminder_id, ReminderHistory.business_id == tenant.business_id)
        .with_for_update()
    )
    if r is None:
        raise NotFound("Reminder not found")
    if r.channel != ReminderChannel.sms:
        raise BusinessRuleError("Only SMS reminders are sent by the phone")
    if not r.idempotency_key.startswith(MANUAL_PREFIX) and not tenant.is_manager:
        raise Forbidden("Only owners and administrators send scheduled reminders")
    record_phone_result(db, tenant.business, r, data.sent, data.error, datetime.now(UTC))
    db.commit()
    return ReminderOut.model_validate(r)


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
    if r.idempotency_key.startswith(MANUAL_PREFIX):
        raise BusinessRuleError("Send a new reminder from the customer's profile instead")
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
