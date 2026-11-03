import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import Tenant, get_tenant, require_idempotency_key
from app.api.presenters import idempotent_create, payment_out
from app.db import get_db
from app.errors import BusinessRuleError, NotFound
from app.integrations.mpesa import ProviderError, get_mpesa
from app.models import (
    Payment,
    PaymentMethod,
    PaymentRequest,
    PaymentStatus,
    Receipt,
    User,
    VerificationStatus,
)
from app.reports import _bounds
from app.schemas import (
    Page,
    PaymentCreate,
    PaymentOut,
    PaymentRequestOut,
    ReceiptOut,
    ReverseIn,
    StkPushIn,
    VerifyIn,
)
from app.services import debts as debt_svc
from app.services import payments as svc
from app.services.common import audit, normalize_phone

router = APIRouter(prefix="/businesses/{business_id}", tags=["payments"])


def _with_recorder(db: Session, p: Payment) -> PaymentOut:
    u = db.get(User, p.recorded_by)
    return payment_out(p, u.full_name if u else None)


@router.get("/payments", response_model=Page[PaymentOut])
def list_payments(
    customer_id: uuid.UUID | None = None,
    method: PaymentMethod | None = None,
    verification: VerificationStatus | None = None,
    status: Literal["posted", "reversed", "all"] = "all",
    recorded_by: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: Tenant = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    stmt = select(Payment).where(Payment.business_id == tenant.business_id)
    if customer_id:
        stmt = stmt.where(Payment.customer_id == customer_id)
    if method:
        stmt = stmt.where(Payment.method == method)
    if verification:
        stmt = stmt.where(Payment.verification_status == verification)
    if status != "all":
        stmt = stmt.where(Payment.status == PaymentStatus(status))
    if recorded_by:
        stmt = stmt.where(Payment.recorded_by == recorded_by)
    if date_from or date_to:
        lo, hi = _bounds(tenant.business, date_from or date(2000, 1, 1), date_to or date(2100, 1, 1))
        stmt = stmt.where(Payment.paid_at >= lo, Payment.paid_at < hi)
    rows = db.scalars(stmt.order_by(Payment.paid_at.desc())).unique().all()
    page = rows[offset : offset + limit]
    return Page(items=[_with_recorder(db, p) for p in page], total=len(rows), limit=limit, offset=offset)


@router.post("/payments", status_code=201, response_model=PaymentOut)
def create_payment(
    data: PaymentCreate,
    key: str = Depends(require_idempotency_key),
    tenant: Tenant = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    """Record a payment. Requires an Idempotency-Key so retries never double-post."""

    def action():
        if data.client_reference:
            existing = db.scalar(
                select(Payment).where(
                    Payment.business_id == tenant.business_id, Payment.client_reference == data.client_reference
                )
            )
            if existing:
                return _with_recorder(db, existing)
        return _with_recorder(db, svc.record_payment(db, tenant, data))

    return idempotent_create(db, tenant, key, data, action, "payments.create")


@router.get("/payments/{payment_id}", response_model=PaymentOut)
def get_payment(payment_id: uuid.UUID, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    return _with_recorder(db, svc.get_payment(db, tenant.business_id, payment_id))


@router.post("/payments/{payment_id}/verify", response_model=PaymentOut)
def verify_payment(
    payment_id: uuid.UUID, data: VerifyIn, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)
):
    p = svc.verify_payment(db, tenant, payment_id, data.approve, data.note)
    db.commit()
    return _with_recorder(db, p)


@router.post("/payments/{payment_id}/reverse", response_model=PaymentOut)
def reverse_payment(
    payment_id: uuid.UUID, data: ReverseIn, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)
):
    p = svc.reverse_payment(db, tenant, payment_id, data.reason)
    db.commit()
    return _with_recorder(db, p)


def _receipt_out(db: Session, r: Receipt) -> ReceiptOut:
    p = svc.get_payment(db, r.business_id, r.payment_id)
    return ReceiptOut(
        receipt_number=r.receipt_number,
        issued_at=r.issued_at,
        payment_id=r.payment_id,
        payment_status=p.status.value,
        snapshot=r.snapshot,
        share_text=svc.receipt_share_text(r, p.status.value),
    )


@router.get("/payments/{payment_id}/receipt", response_model=ReceiptOut)
def payment_receipt(payment_id: uuid.UUID, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    svc.get_payment(db, tenant.business_id, payment_id)
    r = db.scalar(select(Receipt).where(Receipt.payment_id == payment_id, Receipt.business_id == tenant.business_id))
    if r is None:
        raise NotFound("No receipt yet. Receipts are issued once a payment is verified.", code="receipt_not_issued")
    return _receipt_out(db, r)


@router.get("/receipts/{receipt_number}", response_model=ReceiptOut)
def get_receipt(receipt_number: str, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    r = db.scalar(
        select(Receipt).where(
            Receipt.business_id == tenant.business_id, Receipt.receipt_number == receipt_number.upper()
        )
    )
    if r is None:
        raise NotFound("Receipt not found")
    return _receipt_out(db, r)


@router.post("/payment-requests/mpesa", status_code=201, response_model=PaymentRequestOut)
def request_mpesa_payment(data: StkPushIn, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    """Send an STK Push. This creates a *request*; no payment exists until the provider confirms."""
    v = debt_svc.view(db, tenant, data.debt_id)
    if v.debt.flag.value != "none" or v.figures.allocatable <= 0:
        raise BusinessRuleError("This debt has nothing left to collect")
    if data.amount > v.figures.allocatable:
        raise BusinessRuleError(
            f"Amount exceeds the remaining balance of KSh {v.figures.allocatable:,.2f}", code="overpayment"
        )
    phone = normalize_phone(data.phone or v.debt.customer.phone)
    provider = get_mpesa()
    try:
        res = provider.stk_push(phone, data.amount, v.debt.debt_number, "Debt payment")
    except ProviderError as e:
        raise BusinessRuleError(f"M-Pesa request failed: {e}", code="provider_error") from None
    req = PaymentRequest(
        business_id=tenant.business_id,
        customer_id=v.debt.customer_id,
        debt_id=v.debt.id,
        amount=data.amount,
        phone=phone,
        provider=provider.name,
        provider_mode=provider.mode,
        checkout_request_id=res.checkout_request_id,
        requested_by=tenant.user.id,
    )
    db.add(req)
    db.flush()
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="payment_request.created",
        entity_type="payment_request",
        entity_id=req.id,
        after={"amount": data.amount, "debt": v.debt.debt_number, "mode": provider.mode},
        ip=tenant.ip,
    )
    db.commit()
    return PaymentRequestOut.model_validate(req)


@router.get("/payment-requests/{request_id}", response_model=PaymentRequestOut)
def get_payment_request(request_id: uuid.UUID, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    req = db.scalar(
        select(PaymentRequest).where(PaymentRequest.id == request_id, PaymentRequest.business_id == tenant.business_id)
    )
    if req is None:
        raise NotFound("Payment request not found")
    return PaymentRequestOut.model_validate(req)
