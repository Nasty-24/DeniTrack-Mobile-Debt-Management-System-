import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import Tenant
from app.errors import BusinessRuleError, Conflict, Forbidden, NotFound
from app.models import (
    Customer,
    CustomerStatus,
    Debt,
    DebtAdjustment,
    DebtFlag,
    RepaymentSchedule,
)
from app.repositories.debts import DebtView, load_view
from app.schemas import AdjustmentCreate, DebtCreate, DebtFlagIn, DebtUpdate
from app.services.common import audit, business_today, next_number, snapshot
from app.services.ledger import (
    ZERO,
    Installment,
    MoneyError,
    build_schedule,
    validate_schedule,
)

DEBT_AUDIT_FIELDS = ["description", "principal", "due_date", "terms", "reference", "flag", "flag_reason"]


def get_debt(db: Session, tenant: Tenant, debt_id: uuid.UUID, lock: bool = False) -> Debt:
    stmt = select(Debt).where(Debt.id == debt_id, Debt.business_id == tenant.business_id)
    if lock:
        stmt = stmt.with_for_update(of=Debt)
    debt = db.scalar(stmt)
    if debt is None:
        raise NotFound("Debt not found")
    return debt


def view(db: Session, tenant: Tenant, debt_id: uuid.UUID) -> DebtView:
    v = load_view(db, tenant.business_id, debt_id, business_today(tenant.business))
    if v is None:
        raise NotFound("Debt not found")
    return v


def create_debt(db: Session, tenant: Tenant, data: DebtCreate) -> Debt:
    customer = db.scalar(
        select(Customer).where(Customer.id == data.customer_id, Customer.business_id == tenant.business_id)
    )
    if customer is None:
        raise NotFound("Customer not found")
    if customer.status == CustomerStatus.archived:
        raise BusinessRuleError("Archived customers cannot receive new credit", code="customer_archived")
    if data.due_date < data.incurred_on:
        raise BusinessRuleError("Due date cannot be before the date the debt was incurred")
    if data.incurred_on > business_today(tenant.business):
        raise BusinessRuleError("A debt cannot be incurred in the future")
    if data.installment_plan and data.installments:
        raise BusinessRuleError("Provide either an installment plan or explicit installments, not both")

    schedule: list[Installment] = []
    try:
        if data.installment_plan:
            p = data.installment_plan
            schedule = build_schedule(data.principal, p.count, p.first_due_date, p.frequency)
        elif data.installments:
            schedule = [Installment(i + 1, x.due_date, x.amount) for i, x in enumerate(data.installments)]
        validate_schedule(data.principal, schedule)
    except MoneyError as e:
        raise BusinessRuleError(str(e), code="invalid_schedule") from None
    due_date = schedule[-1].due_date if schedule else data.due_date
    if schedule and schedule[0].due_date < data.incurred_on:
        raise BusinessRuleError("Installments cannot fall before the date the debt was incurred")

    number = next_number(db, tenant.business_id, "debt")
    debt = Debt(
        business_id=tenant.business_id,
        customer_id=customer.id,
        debt_number=f"D-{number:06d}",
        description=data.description.strip(),
        principal=data.principal,
        currency=tenant.business.currency,
        incurred_on=data.incurred_on,
        due_date=due_date,
        terms=data.terms,
        reference=data.reference,
        client_reference=data.client_reference,
        created_by=tenant.user.id,
    )
    db.add(debt)
    db.flush()
    for inst in schedule:
        db.add(
            RepaymentSchedule(
                business_id=tenant.business_id,
                debt_id=debt.id,
                installment_number=inst.number,
                due_date=inst.due_date,
                amount=inst.amount,
            )
        )
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="debt.created",
        entity_type="debt",
        entity_id=debt.id,
        after=snapshot(debt, DEBT_AUDIT_FIELDS + ["customer_id", "incurred_on"])
        | {"installments": [[str(i.due_date), str(i.amount)] for i in schedule]},
        ip=tenant.ip,
    )
    db.flush()
    db.refresh(debt)
    return debt


def update_debt(db: Session, tenant: Tenant, debt_id: uuid.UUID, data: DebtUpdate) -> Debt:
    if not tenant.is_manager:
        raise Forbidden("Only owners and administrators can edit debts")
    debt = get_debt(db, tenant, debt_id, lock=True)
    if debt.version != data.version:
        raise Conflict("This debt was changed by someone else. Reload and try again.", code="version_conflict")
    if data.due_date is not None and debt.schedule:
        raise BusinessRuleError("Change installment dates rather than the due date for installment debts")
    if data.due_date is not None and data.due_date < debt.incurred_on:
        raise BusinessRuleError("Due date cannot be before the date the debt was incurred")
    before = snapshot(debt, DEBT_AUDIT_FIELDS)
    for field in ("description", "due_date", "terms", "reference"):
        value = getattr(data, field)
        if value is not None:
            setattr(debt, field, value)
    debt.version += 1
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="debt.updated",
        entity_type="debt",
        entity_id=debt.id,
        before=before,
        after=snapshot(debt, DEBT_AUDIT_FIELDS),
        ip=tenant.ip,
    )
    return debt


def add_adjustment(db: Session, tenant: Tenant, debt_id: uuid.UUID, data: AdjustmentCreate) -> DebtAdjustment:
    if not tenant.is_manager:
        raise Forbidden("Only owners and administrators can adjust debts")
    debt = get_debt(db, tenant, debt_id, lock=True)
    if debt.flag == DebtFlag.cancelled:
        raise BusinessRuleError("Cancelled debts cannot be adjusted")
    v = view(db, tenant, debt_id)
    new_total = v.figures.total_due + data.amount
    if new_total < v.figures.paid + v.figures.pending:
        raise BusinessRuleError(
            "This adjustment would make the debt smaller than what has already been paid. Reverse a payment first.",
            code="adjustment_below_paid",
        )
    adj = DebtAdjustment(
        business_id=tenant.business_id,
        debt_id=debt.id,
        amount=data.amount,
        reason=data.reason,
        created_by=tenant.user.id,
    )
    db.add(adj)
    debt.version += 1
    db.flush()
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="debt.adjusted",
        entity_type="debt",
        entity_id=debt.id,
        before={"total_due": v.figures.total_due},
        after={"total_due": new_total, "adjustment": data.amount},
        reason=data.reason,
        ip=tenant.ip,
    )
    return adj


def set_flag(db: Session, tenant: Tenant, debt_id: uuid.UUID, data: DebtFlagIn) -> Debt:
    if not tenant.is_manager:
        raise Forbidden("Only owners and administrators can cancel or dispute debts")
    debt = get_debt(db, tenant, debt_id, lock=True)
    if debt.flag == DebtFlag.cancelled:
        raise BusinessRuleError("A cancelled debt cannot be changed")
    if data.flag == "cancelled":
        v = view(db, tenant, debt_id)
        if v.figures.paid > 0 or v.figures.pending > 0:
            raise BusinessRuleError(
                "A debt with payments cannot be cancelled. Reverse the payments or use an adjustment.",
                code="debt_has_payments",
            )
    before = snapshot(debt, ["flag", "flag_reason"])
    debt.flag = DebtFlag(data.flag)
    debt.flag_reason = data.reason
    debt.version += 1
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action=f"debt.flag.{data.flag}",
        entity_type="debt",
        entity_id=debt.id,
        before=before,
        after=snapshot(debt, ["flag", "flag_reason"]),
        reason=data.reason,
        ip=tenant.ip,
    )
    return debt


def installment_rows(v: DebtView, today: date) -> list[dict]:
    rows = []
    covered_so_far = v.figures.paid
    for inst in v.schedule:
        covered = min(inst.amount, max(covered_so_far, ZERO))
        covered_so_far -= covered
        if covered >= inst.amount:
            status = "paid"
        elif inst.due_date < today:
            status = "overdue"
        elif covered > 0:
            status = "partially_paid"
        else:
            status = "due"
        rows.append(
            {
                "number": inst.number,
                "due_date": inst.due_date,
                "amount": inst.amount,
                "covered": covered,
                "status": status,
            }
        )
    return rows
