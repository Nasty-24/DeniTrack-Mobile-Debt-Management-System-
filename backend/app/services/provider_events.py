"""Processing of payment-provider callbacks (M-Pesa STK Push)."""

import logging

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import Tenant
from app.db import bypass_tenant
from app.errors import AppError
from app.integrations.mpesa import get_mpesa, parse_callback
from app.models import (
    BusinessMembership,
    BusinessSettings,
    Notification,
    PaymentMethod,
    PaymentProviderEvent,
    PaymentRequest,
    User,
    VerificationStatus,
)
from app.schemas import AllocationIn, PaymentCreate
from app.services.common import request_hash
from app.services.payments import record_payment

log = logging.getLogger("denitrack.mpesa")


def _record_event(db: Session, key: str, payload: dict, status: str, detail: str, business_id=None) -> None:
    db.add(
        PaymentProviderEvent(
            provider="mpesa",
            event_key=key,
            payload=payload,
            status=status,
            detail=detail[:300],
            business_id=business_id,
        )
    )


def process_stk_callback(db: Session, payload: dict) -> str:
    """Returns the outcome. Safe to call any number of times with the same callback."""
    bypass_tenant(db)
    try:
        cb = parse_callback(payload)
    except ValueError as e:
        key = f"malformed:{request_hash(payload)}"
        if not db.scalar(select(PaymentProviderEvent.id).where(PaymentProviderEvent.event_key == key)):
            _record_event(db, key, payload, "rejected", str(e))
            db.commit()
        return "rejected"

    key = f"stk:{cb.checkout_request_id}"
    if db.scalar(
        select(PaymentProviderEvent.id).where(
            PaymentProviderEvent.provider == "mpesa", PaymentProviderEvent.event_key == key
        )
    ):
        return "duplicate"

    req = db.scalar(
        select(PaymentRequest).where(PaymentRequest.checkout_request_id == cb.checkout_request_id).with_for_update()
    )
    if req is None:
        _record_event(db, key, payload, "rejected", "No matching payment request")
        return _commit(db, "rejected")
    if req.status != "pending":
        _record_event(db, key, payload, "ignored", f"Request already {req.status}", req.business_id)
        return _commit(db, "ignored")

    if cb.result_code != 0:
        req.status, req.failure_reason = "failed", cb.result_desc
        _record_event(db, key, payload, "processed", f"Payment not completed: {cb.result_desc}", req.business_id)
        return _commit(db, "failed")

    problems = []
    if cb.amount != req.amount:
        problems.append(f"amount {cb.amount} does not match requested {req.amount}")
    if cb.phone != req.phone:
        problems.append("phone number does not match the request")
    confirmation = get_mpesa().query(cb.checkout_request_id)
    if confirmation.result_code != 0:
        problems.append(f"provider status query did not confirm success ({confirmation.description})")
    if problems:
        # Do not post. Leave the request pending so it can be reconciled manually.
        detail = "; ".join(problems)
        _record_event(db, key, payload, "rejected", detail, req.business_id)
        _alert(db, req, f"An M-Pesa confirmation could not be verified: {detail}")
        log.warning("STK callback failed verification for request %s", req.id)
        return _commit(db, "rejected")

    tenant = _system_tenant(db, req)
    try:
        payment = record_payment(
            db,
            tenant,
            PaymentCreate(
                customer_id=req.customer_id,
                amount=req.amount,
                method=PaymentMethod.mpesa,
                external_reference=cb.receipt,
                allocations=[AllocationIn(debt_id=req.debt_id, amount=req.amount)],
                notes="M-Pesa STK Push",
            ),
            verification=VerificationStatus.verified,
            actor_id=req.requested_by,
        )
    except AppError as e:
        # Real money arrived but cannot be applied automatically (e.g. debt settled in the
        # meantime, so it would overpay). Never drop it: flag it for the owner.
        db.rollback()
        bypass_tenant(db)
        req = db.get(PaymentRequest, req.id)
        if req is None:  # pragma: no cover - loaded earlier in this call
            return "rejected"
        req.status, req.failure_reason = "needs_review", e.message[:300]
        _record_event(db, key, payload, "needs_review", e.message, req.business_id)
        _alert(db, req, f"M-Pesa payment {cb.receipt} of KSh {cb.amount:,.2f} needs manual review: {e.message}")
        return _commit(db, "needs_review")
    req.status, req.payment_id = "succeeded", payment.id
    _record_event(db, key, payload, "processed", f"Payment {payment.receipt_number}", req.business_id)
    return _commit(db, "succeeded")


def _commit(db: Session, outcome: str) -> str:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # a concurrent delivery of the same callback won the race
        return "duplicate"
    return outcome


def _system_tenant(db: Session, req: PaymentRequest) -> Tenant:
    m = db.scalar(
        select(BusinessMembership).where(
            BusinessMembership.business_id == req.business_id, BusinessMembership.user_id == req.requested_by
        )
    )
    user = db.get(User, req.requested_by)
    settings = db.get(BusinessSettings, req.business_id)
    if m is None or user is None or settings is None:
        raise AppError("The staff member who requested this payment no longer exists", code="requester_missing")
    return Tenant(business=m.business, user=user, role=m.role, settings=settings, ip=None)


def _alert(db: Session, req: PaymentRequest, body: str) -> None:
    db.add(
        Notification(
            business_id=req.business_id,
            kind="payment_review",
            title="M-Pesa payment needs review",
            body=body[:500],
            entity_type="payment_request",
            entity_id=req.id,
        )
    )
