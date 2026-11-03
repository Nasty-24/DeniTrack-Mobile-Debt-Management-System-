import uuid
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import Tenant, get_tenant, require_idempotency_key
from app.api.presenters import debt_out, idempotent_create, payment_out
from app.db import get_db
from app.models import Debt, DebtAdjustment, Payment, PaymentAllocation
from app.repositories.debts import load_views
from app.schemas import (
    AdjustmentCreate,
    AdjustmentOut,
    DebtCreate,
    DebtDetailOut,
    DebtFlagIn,
    DebtOut,
    DebtUpdate,
    Page,
)
from app.services import debts as svc
from app.services.common import business_today

router = APIRouter(prefix="/businesses/{business_id}/debts", tags=["debts"])

DebtStatus = Literal["open", "partially_paid", "paid", "overdue", "cancelled", "disputed", "outstanding", "all"]


@router.get("", response_model=Page[DebtOut])
def list_debts(
    status: DebtStatus = "outstanding",
    customer_id: uuid.UUID | None = None,
    due_within_days: int | None = Query(default=None, ge=0, le=365),
    created_by: uuid.UUID | None = None,
    incurred_from: date | None = None,
    incurred_to: date | None = None,
    q: str | None = Query(default=None, max_length=100),
    sort: Literal["due_date", "balance", "recent", "days_overdue"] = "due_date",
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: Tenant = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    """Status is derived from the ledger, so filtering on it happens after balances are computed."""
    today = business_today(tenant.business)
    where = []
    if customer_id:
        where.append(Debt.customer_id == customer_id)
    if created_by:
        where.append(Debt.created_by == created_by)
    if incurred_from:
        where.append(Debt.incurred_on >= incurred_from)
    if incurred_to:
        where.append(Debt.incurred_on <= incurred_to)
    views = load_views(db, tenant.business_id, today, *where)
    if status == "outstanding":
        views = [v for v in views if v.status in ("open", "partially_paid", "overdue")]
    elif status != "all":
        views = [v for v in views if v.status == status]
    if due_within_days is not None:
        horizon = today + timedelta(days=due_within_days)
        views = [v for v in views if v.next_due_date and today <= v.next_due_date <= horizon]
    if q:
        term = q.lower()
        views = [
            v
            for v in views
            if term in v.debt.debt_number.lower()
            or term in v.debt.customer.name.lower()
            or term in v.debt.description.lower()
            or (v.debt.reference or "").lower() == term
        ]
    key = {
        "due_date": lambda v: v.next_due_date or v.debt.due_date,
        "balance": lambda v: -v.figures.balance,
        "recent": lambda v: -v.debt.created_at.timestamp(),
        "days_overdue": lambda v: -v.days_overdue,
    }[sort]
    views.sort(key=key)
    page = views[offset : offset + limit]
    return Page(items=[debt_out(v, today) for v in page], total=len(views), limit=limit, offset=offset)


@router.post("", status_code=201, response_model=DebtOut)
def create_debt(
    data: DebtCreate,
    key: str = Depends(require_idempotency_key),
    tenant: Tenant = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    def action():
        if data.client_reference:
            existing = db.scalar(
                select(Debt).where(
                    Debt.business_id == tenant.business_id, Debt.client_reference == data.client_reference
                )
            )
            if existing:
                return debt_out(svc.view(db, tenant, existing.id), business_today(tenant.business))
        debt = svc.create_debt(db, tenant, data)
        return debt_out(svc.view(db, tenant, debt.id), business_today(tenant.business))

    return idempotent_create(db, tenant, key, data, action, "debts.create")


@router.get("/{debt_id}", response_model=DebtDetailOut)
def get_debt(debt_id: uuid.UUID, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    today = business_today(tenant.business)
    v = svc.view(db, tenant, debt_id)
    adjustments = db.scalars(
        select(DebtAdjustment)
        .where(DebtAdjustment.debt_id == debt_id, DebtAdjustment.business_id == tenant.business_id)
        .order_by(DebtAdjustment.created_at)
    ).all()
    payments = (
        db.scalars(
            select(Payment)
            .join(PaymentAllocation, PaymentAllocation.payment_id == Payment.id)
            .where(PaymentAllocation.debt_id == debt_id, Payment.business_id == tenant.business_id)
            .order_by(Payment.paid_at.desc())
        )
        .unique()
        .all()
    )
    return DebtDetailOut(
        **debt_out(v, today).model_dump(),
        adjustments=[AdjustmentOut.model_validate(a) for a in adjustments],
        payments=[payment_out(p) for p in payments],
    )


@router.patch("/{debt_id}", response_model=DebtOut)
def update_debt(
    debt_id: uuid.UUID, data: DebtUpdate, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)
):
    svc.update_debt(db, tenant, debt_id, data)
    db.commit()
    return debt_out(svc.view(db, tenant, debt_id), business_today(tenant.business))


@router.post("/{debt_id}/adjustments", status_code=201, response_model=DebtOut)
def add_adjustment(
    debt_id: uuid.UUID, data: AdjustmentCreate, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)
):
    svc.add_adjustment(db, tenant, debt_id, data)
    db.commit()
    return debt_out(svc.view(db, tenant, debt_id), business_today(tenant.business))


@router.post("/{debt_id}/flag", response_model=DebtOut)
def set_flag(debt_id: uuid.UUID, data: DebtFlagIn, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    svc.set_flag(db, tenant, debt_id, data)
    db.commit()
    return debt_out(svc.view(db, tenant, debt_id), business_today(tenant.business))
