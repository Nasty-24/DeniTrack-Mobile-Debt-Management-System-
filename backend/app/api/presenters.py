from collections.abc import Callable
from datetime import date

from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import Tenant
from app.errors import Conflict
from app.models import Payment
from app.repositories.debts import DebtView
from app.schemas import AllocationOut, DebtOut, InstallmentOut, PaymentOut
from app.services.common import find_idempotent_response, request_hash, store_idempotent_response
from app.services.debts import installment_rows


def debt_out(v: DebtView, today: date) -> DebtOut:
    d = v.debt
    return DebtOut(
        id=d.id,
        debt_number=d.debt_number,
        customer_id=d.customer_id,
        customer_name=d.customer.name,
        customer_phone=d.customer.phone,
        description=d.description,
        currency=d.currency,
        principal=v.figures.principal,
        adjustments_total=v.figures.adjustments,
        total_due=v.figures.total_due,
        paid=v.figures.paid,
        pending_verification=v.figures.pending,
        balance=v.figures.balance,
        overdue_amount=v.overdue_amount,
        status=v.status,
        days_overdue=v.days_overdue,
        incurred_on=d.incurred_on,
        due_date=d.due_date,
        next_due_date=v.next_due_date,
        terms=d.terms,
        reference=d.reference,
        flag_reason=d.flag_reason,
        created_by=d.created_by,
        created_at=d.created_at,
        updated_at=d.updated_at,
        version=d.version,
        schedule=[InstallmentOut(**r) for r in installment_rows(v, today)],
    )


def payment_out(p: Payment, recorder_name: str | None = None) -> PaymentOut:
    return PaymentOut(
        id=p.id,
        customer_id=p.customer_id,
        customer_name=p.customer.name,
        amount=p.amount,
        currency=p.currency,
        method=p.method.value,
        paid_at=p.paid_at,
        external_reference=p.external_reference,
        verification_status=p.verification_status.value,
        status=p.status.value,
        receipt_number=p.receipt_number,
        notes=p.notes,
        recorded_by=p.recorded_by,
        recorded_by_name=recorder_name,
        reversal_reason=p.reversal_reason,
        reversed_at=p.reversed_at,
        created_at=p.created_at,
        allocations=[AllocationOut.model_validate(a) for a in p.allocations],
    )


def idempotent_create(
    db: Session,
    tenant: Tenant,
    key: str | None,
    payload: BaseModel,
    action: Callable[[], BaseModel],
    route: str,
) -> JSONResponse:
    """Run `action` once per Idempotency-Key. A retried request gets the original response."""
    req_hash = request_hash({"route": route, "body": payload.model_dump(mode="json")})
    if key:
        rec = find_idempotent_response(db, tenant.business_id, tenant.user.id, key, req_hash)
        if rec:
            return JSONResponse(rec.response_body, rec.response_status, headers={"Idempotent-Replayed": "true"})
    result = action()
    body = result.model_dump(mode="json")
    if key:
        store_idempotent_response(db, tenant.business_id, tenant.user.id, key, req_hash, 201, body)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if key:
            rec = find_idempotent_response(db, tenant.business_id, tenant.user.id, key, req_hash)
            if rec:
                return JSONResponse(rec.response_body, rec.response_status, headers={"Idempotent-Replayed": "true"})
        raise Conflict("This record was already created by another request", code="duplicate_request") from None
    return JSONResponse(body, 201)
