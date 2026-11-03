"""Debt queries. Balances are always derived from the ledger tables, never cached."""

import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import Select, case, func, select
from sqlalchemy.orm import Session

from app.models import (
    Debt,
    DebtAdjustment,
    DebtFlag,
    Payment,
    PaymentAllocation,
    PaymentStatus,
    VerificationStatus,
)
from app.services.ledger import (
    ZERO,
    DebtFigures,
    Installment,
    amount_overdue,
    derive_status,
    next_installment_due,
    quantize,
)

COUNTED = (VerificationStatus.verified, VerificationStatus.not_required)


@dataclass
class DebtView:
    debt: Debt
    figures: DebtFigures
    status: str
    overdue_amount: Decimal
    days_overdue: int
    next_due_date: date | None
    schedule: list[Installment]


def _figures_subqueries(business_id: uuid.UUID):
    adj = (
        select(DebtAdjustment.debt_id, func.sum(DebtAdjustment.amount).label("adj"))
        .where(DebtAdjustment.business_id == business_id)
        .group_by(DebtAdjustment.debt_id)
        .subquery()
    )
    pay = (
        select(
            PaymentAllocation.debt_id,
            func.sum(case((Payment.verification_status.in_(COUNTED), PaymentAllocation.amount), else_=0)).label("paid"),
            func.sum(
                case(
                    (Payment.verification_status == VerificationStatus.pending, PaymentAllocation.amount),
                    else_=0,
                )
            ).label("pending"),
        )
        .join(Payment, Payment.id == PaymentAllocation.payment_id)
        .where(PaymentAllocation.business_id == business_id, Payment.status == PaymentStatus.posted)
        .group_by(PaymentAllocation.debt_id)
        .subquery()
    )
    return adj, pay


def debts_with_figures(business_id: uuid.UUID) -> Select:
    adj, pay = _figures_subqueries(business_id)
    return (
        select(Debt, adj.c.adj, pay.c.paid, pay.c.pending)
        .outerjoin(adj, adj.c.debt_id == Debt.id)
        .outerjoin(pay, pay.c.debt_id == Debt.id)
        .where(Debt.business_id == business_id)
    )


def build_view(debt: Debt, adj, paid, pending, today: date) -> DebtView:
    figures = DebtFigures(
        principal=quantize(debt.principal),
        adjustments=quantize(adj),
        paid=quantize(paid),
        pending=quantize(pending),
    )
    schedule = [Installment(s.installment_number, s.due_date, quantize(s.amount)) for s in debt.schedule]
    status = derive_status(debt.flag.value, figures, debt.due_date, today, schedule)
    overdue = amount_overdue(figures, debt.due_date, today, schedule) if debt.flag == DebtFlag.none else ZERO
    next_due = None
    if figures.balance > 0 and debt.flag == DebtFlag.none:
        nxt = next_installment_due(schedule, figures.paid) if schedule else None
        next_due = nxt[0].due_date if nxt else debt.due_date
    days_overdue = 0
    if overdue > 0:
        earliest = debt.due_date
        if schedule and today <= debt.due_date:
            nxt = next_installment_due(schedule, figures.paid)
            earliest = nxt[0].due_date if nxt else debt.due_date
        days_overdue = max(0, (today - earliest).days)
    return DebtView(debt, figures, status, overdue, days_overdue, next_due, schedule)


def load_views(db: Session, business_id: uuid.UUID, today: date, *where) -> list[DebtView]:
    stmt = debts_with_figures(business_id).where(*where).order_by(Debt.due_date, Debt.created_at)
    return [build_view(d, a, p, pe, today) for d, a, p, pe in db.execute(stmt).unique().all()]


def load_view(db: Session, business_id: uuid.UUID, debt_id: uuid.UUID, today: date) -> DebtView | None:
    views = load_views(db, business_id, today, Debt.id == debt_id)
    return views[0] if views else None


def customer_totals(db: Session, business_id: uuid.UUID, today: date, customer_ids=None) -> dict:
    """{customer_id: {"balance", "overdue", "pending", "open_debts"}} for active debts."""
    where = [Debt.flag == DebtFlag.none]
    if customer_ids is not None:
        where.append(Debt.customer_id.in_(customer_ids))
    out: dict[uuid.UUID, dict] = {}
    for v in load_views(db, business_id, today, *where):
        t = out.setdefault(v.debt.customer_id, {"balance": ZERO, "overdue": ZERO, "pending": ZERO, "open_debts": 0})
        t["balance"] += v.figures.balance
        t["overdue"] += v.overdue_amount
        t["pending"] += v.figures.pending
        if v.figures.balance > 0:
            t["open_debts"] += 1
    return out
