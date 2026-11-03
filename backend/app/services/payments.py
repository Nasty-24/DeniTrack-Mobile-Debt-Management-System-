"""Payment ledger. Posted payments are never edited or deleted: corrections are reversals."""

import re
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import Tenant
from app.errors import BusinessRuleError, Conflict, Forbidden, NotFound
from app.models import (
    Business,
    Customer,
    Debt,
    DebtFlag,
    Notification,
    Payment,
    PaymentAllocation,
    PaymentMethod,
    PaymentStatus,
    Receipt,
    User,
    VerificationStatus,
)
from app.repositories.debts import load_views
from app.schemas import PaymentCreate
from app.services.common import audit, next_number, snapshot, utcnow
from app.services.ledger import (
    MoneyError,
    OpenDebt,
    OverpaymentError,
    allocate_oldest_first,
    check_explicit_allocations,
)

MPESA_CODE = re.compile(r"^[A-Z0-9]{10}$")
PAYMENT_AUDIT_FIELDS = [
    "amount",
    "method",
    "external_reference",
    "verification_status",
    "status",
    "paid_at",
    "receipt_number",
]


def _initial_verification(method: PaymentMethod) -> VerificationStatus:
    # Cash is received in hand by the person recording it. Anything that moved through
    # a bank or M-Pesa must be reconciled before it reduces the balance.
    return VerificationStatus.not_required if method == PaymentMethod.cash else VerificationStatus.pending


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def record_payment(
    db: Session,
    tenant: Tenant,
    data: PaymentCreate,
    *,
    verification: VerificationStatus | None = None,
    actor_id: uuid.UUID | None = None,
) -> Payment:
    business_id = tenant.business_id
    if data.method.value not in tenant.settings.payment_methods and verification is None:
        raise BusinessRuleError("This payment method is not enabled for the business")
    customer = db.scalar(select(Customer).where(Customer.id == data.customer_id, Customer.business_id == business_id))
    if customer is None:
        raise NotFound("Customer not found")

    ext_ref = data.external_reference.strip().upper() if data.external_reference else None
    if data.method == PaymentMethod.mpesa and (not ext_ref or not MPESA_CODE.match(ext_ref)):
        raise BusinessRuleError(
            "Enter the 10-character M-Pesa transaction code (e.g. SLK4H7R2QX)", code="invalid_mpesa_code"
        )
    if ext_ref:
        dup = db.scalar(
            select(Payment.id).where(
                Payment.business_id == business_id,
                Payment.method == data.method,
                Payment.external_reference == ext_ref,
                Payment.status == PaymentStatus.posted,
            )
        )
        if dup:
            raise Conflict(
                "A payment with this transaction reference has already been recorded", code="duplicate_reference"
            )

    paid_at = _aware(data.paid_at) if data.paid_at else utcnow()
    if paid_at > utcnow() + timedelta(minutes=5):
        raise BusinessRuleError("Payment date cannot be in the future")

    # Lock this customer's debts so concurrent payments cannot both pass the balance check.
    debt_rows = db.scalars(
        select(Debt.id)
        .where(Debt.business_id == business_id, Debt.customer_id == customer.id, Debt.flag == DebtFlag.none)
        .with_for_update()
    ).all()
    from app.services.common import business_today

    today = business_today(tenant.business)
    views = load_views(db, business_id, today, Debt.id.in_(debt_rows)) if debt_rows else []
    allocatable = {v.debt.id: v.figures.allocatable for v in views if v.figures.allocatable > 0}

    try:
        if data.allocations:
            requested = [(a.debt_id, a.amount) for a in data.allocations]
            check_explicit_allocations(data.amount, requested, allocatable)
            allocations = requested
        else:
            allocations = allocate_oldest_first(
                data.amount,
                [
                    OpenDebt(v.debt.id, v.next_due_date or v.debt.due_date, v.debt.incurred_on, v.figures.allocatable)
                    for v in views
                ],
            )
    except OverpaymentError as e:
        raise BusinessRuleError(str(e), code="overpayment") from None
    except MoneyError as e:
        raise BusinessRuleError(str(e), code="invalid_allocation") from None

    payment = Payment(
        business_id=business_id,
        customer_id=customer.id,
        amount=data.amount,
        currency=tenant.business.currency,
        paid_at=paid_at,
        method=data.method,
        external_reference=ext_ref,
        verification_status=verification or _initial_verification(data.method),
        notes=data.notes,
        client_reference=data.client_reference,
        recorded_by=actor_id or tenant.user.id,
    )
    if payment.verification_status == VerificationStatus.verified:
        payment.verified_at = utcnow()
    db.add(payment)
    try:
        db.flush()
    except IntegrityError:
        raise Conflict("This payment has already been recorded", code="duplicate_payment") from None
    for debt_id, amount in allocations:
        db.add(PaymentAllocation(business_id=business_id, payment_id=payment.id, debt_id=debt_id, amount=amount))
    db.flush()
    if payment.verification_status in (VerificationStatus.not_required, VerificationStatus.verified):
        issue_receipt(db, tenant.business, payment)
    audit(
        db,
        business_id=business_id,
        actor_id=actor_id or tenant.user.id,
        action="payment.recorded",
        entity_type="payment",
        entity_id=payment.id,
        after=snapshot(payment, PAYMENT_AUDIT_FIELDS) | {"allocations": [[str(d), str(a)] for d, a in allocations]},
        ip=tenant.ip,
    )
    db.flush()
    db.refresh(payment)
    return payment


def get_payment(db: Session, business_id: uuid.UUID, payment_id: uuid.UUID, lock=False) -> Payment:
    stmt = select(Payment).where(Payment.id == payment_id, Payment.business_id == business_id)
    if lock:
        stmt = stmt.with_for_update(of=Payment)
    p = db.scalar(stmt)
    if p is None:
        raise NotFound("Payment not found")
    return p


def verify_payment(db: Session, tenant: Tenant, payment_id: uuid.UUID, approve: bool, note: str | None) -> Payment:
    if not tenant.is_manager:
        raise Forbidden("Only owners and administrators can verify payments")
    p = get_payment(db, tenant.business_id, payment_id, lock=True)
    if p.status != PaymentStatus.posted or p.verification_status != VerificationStatus.pending:
        raise BusinessRuleError("Only posted payments awaiting verification can be verified")
    before = snapshot(p, PAYMENT_AUDIT_FIELDS)
    p.verification_status = VerificationStatus.verified if approve else VerificationStatus.rejected
    p.verified_by = tenant.user.id
    p.verified_at = utcnow()
    db.flush()
    if approve:
        issue_receipt(db, tenant.business, p)
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="payment.verified" if approve else "payment.rejected",
        entity_type="payment",
        entity_id=p.id,
        before=before,
        after=snapshot(p, PAYMENT_AUDIT_FIELDS),
        reason=note,
        ip=tenant.ip,
    )
    return p


def reverse_payment(db: Session, tenant: Tenant, payment_id: uuid.UUID, reason: str) -> Payment:
    if not tenant.is_manager:
        raise Forbidden("Only owners and administrators can reverse payments")
    p = get_payment(db, tenant.business_id, payment_id, lock=True)
    if p.status == PaymentStatus.reversed:
        raise BusinessRuleError("This payment has already been reversed", code="already_reversed")
    before = snapshot(p, PAYMENT_AUDIT_FIELDS)
    p.status = PaymentStatus.reversed
    p.reversal_reason = reason
    p.reversed_by = tenant.user.id
    p.reversed_at = utcnow()
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="payment.reversed",
        entity_type="payment",
        entity_id=p.id,
        before=before,
        after=snapshot(p, PAYMENT_AUDIT_FIELDS),
        reason=reason,
        ip=tenant.ip,
    )
    db.add(
        Notification(
            business_id=tenant.business_id,
            kind="payment_reversed",
            title="Payment reversed",
            body=f"KSh {p.amount:,.2f} from {p.customer.name} was reversed: {reason}",
            entity_type="payment",
            entity_id=p.id,
        )
    )
    return p


def issue_receipt(db: Session, business: Business, payment: Payment) -> Receipt:
    existing = db.scalar(select(Receipt).where(Receipt.payment_id == payment.id))
    if existing:
        return existing
    year = payment.paid_at.year
    seq = next_number(db, business.id, f"receipt:{year}")
    number = f"RCT-{year}-{seq:06d}"
    today = datetime.now(UTC).date()
    debts = {
        v.debt.id: v for v in load_views(db, business.id, today, Debt.id.in_([a.debt_id for a in payment.allocations]))
    }
    recorder = db.get(User, payment.recorded_by)
    snap = {
        "business": {"name": business.name, "phone": business.phone, "address": business.address},
        "customer": {
            "name": payment.customer.name,
            "number": payment.customer.customer_number,
            "phone": payment.customer.phone,
        },
        "amount": f"{payment.amount:.2f}",
        "currency": payment.currency,
        "method": payment.method.value,
        "external_reference": payment.external_reference,
        "paid_at": _aware(payment.paid_at).isoformat(),
        "recorded_by": recorder.full_name if recorder else None,
        "allocations": [
            {
                "debt_number": debts[a.debt_id].debt.debt_number,
                "description": debts[a.debt_id].debt.description,
                "amount": f"{a.amount:.2f}",
                "balance_after": f"{debts[a.debt_id].figures.balance:.2f}",
            }
            for a in payment.allocations
            if a.debt_id in debts
        ],
    }
    receipt = Receipt(business_id=business.id, payment_id=payment.id, receipt_number=number, snapshot=snap)
    payment.receipt_number = number
    db.add(receipt)
    db.flush()
    return receipt


def receipt_share_text(r: Receipt, payment_status: str) -> str:
    s = r.snapshot
    lines = [
        f"{s['business']['name']} - Payment Receipt",
        f"Receipt: {r.receipt_number}",
        f"Date: {s['paid_at'][:16].replace('T', ' ')}",
        f"Customer: {s['customer']['name']}",
        f"Amount: KSh {Decimal(s['amount']):,.2f} ({s['method'].replace('_', ' ')})",
    ]
    if s.get("external_reference"):
        lines.append(f"Ref: {s['external_reference']}")
    for a in s["allocations"]:
        lines.append(
            f"{a['debt_number']}: paid KSh {Decimal(a['amount']):,.2f}, balance KSh {Decimal(a['balance_after']):,.2f}"
        )
    if payment_status == "reversed":
        lines.append("THIS PAYMENT HAS BEEN REVERSED")
    lines.append("Thank you.")
    return "\n".join(lines)
