"""M-Pesa SMS read on the owner's phone: submit, review and match by hand."""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import Tenant, manager_only
from app.db import get_db
from app.models import Customer, MpesaSmsMessage, MpesaSmsStatus
from app.schemas import (
    MpesaSmsAssignIn,
    MpesaSmsBatchIn,
    MpesaSmsBatchOut,
    MpesaSmsDismissIn,
    MpesaSmsOut,
    MpesaSmsResultOut,
    Page,
)
from app.services import mpesa_sms as svc

router = APIRouter(prefix="/businesses/{business_id}/mpesa-sms", tags=["mpesa-sms"])


def _out(db: Session, rec: MpesaSmsMessage) -> MpesaSmsOut:
    def name(cid):
        c = db.get(Customer, cid) if cid else None
        return c.name if c else None

    return MpesaSmsOut(
        id=rec.id,
        transaction_code=rec.transaction_code,
        amount=rec.amount,
        payer_name=rec.payer_name,
        payer_phone=rec.payer_phone,
        received_at=rec.received_at,
        status=rec.status.value,
        detail=rec.detail,
        customer_id=rec.customer_id,
        customer_name=name(rec.customer_id),
        suggested_customer_id=rec.suggested_customer_id,
        suggested_customer_name=name(rec.suggested_customer_id),
        payment_id=rec.payment_id,
        created_at=rec.created_at,
        resolved_at=rec.resolved_at,
    )


@router.post("", response_model=MpesaSmsBatchOut)
def submit_messages(data: MpesaSmsBatchIn, tenant: Tenant = Depends(manager_only), db: Session = Depends(get_db)):
    """Messages the owner's phone received from M-PESA. Payments that match a customer by
    phone number and name are recorded straight away; the rest wait for review. Sending the
    same message again is harmless."""
    outcomes = svc.process_batch(db, tenant, [(m.sender, m.body, m.received_at) for m in data.messages])
    db.commit()
    return MpesaSmsBatchOut(
        results=[
            MpesaSmsResultOut(
                status=o.status, code=o.code, amount=o.amount, customer_name=o.customer_name, detail=o.detail
            )
            for o in outcomes
        ]
    )


@router.get("", response_model=Page[MpesaSmsOut])
def list_messages(
    status: MpesaSmsStatus | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: Tenant = Depends(manager_only),
    db: Session = Depends(get_db),
):
    stmt = select(MpesaSmsMessage).where(MpesaSmsMessage.business_id == tenant.business_id)
    if status:
        stmt = stmt.where(MpesaSmsMessage.status == status)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(MpesaSmsMessage.received_at.desc()).limit(limit).offset(offset)).all()
    return Page(items=[_out(db, r) for r in rows], total=total, limit=limit, offset=offset)


@router.post("/{message_id}/assign", response_model=MpesaSmsOut)
def assign_message(
    message_id: uuid.UUID, data: MpesaSmsAssignIn, tenant: Tenant = Depends(manager_only), db: Session = Depends(get_db)
):
    """Record an unmatched M-Pesa payment for the customer an owner chose."""
    rec = svc.assign(db, tenant, message_id, data.customer_id)
    db.commit()
    return _out(db, rec)


@router.post("/{message_id}/dismiss", response_model=MpesaSmsOut)
def dismiss_message(
    message_id: uuid.UUID,
    data: MpesaSmsDismissIn,
    tenant: Tenant = Depends(manager_only),
    db: Session = Depends(get_db),
):
    """Mark an M-Pesa payment as not a debt repayment (e.g. a cash sale paid by M-Pesa)."""
    rec = svc.dismiss(db, tenant, message_id, data.reason)
    db.commit()
    return _out(db, rec)
