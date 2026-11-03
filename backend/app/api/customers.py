import re
import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.deps import Tenant, get_tenant, idempotency_key, manager_only
from app.api.presenters import debt_out, idempotent_create, payment_out
from app.db import get_db
from app.errors import BusinessRuleError, Conflict, Forbidden, NotFound
from app.models import Customer, CustomerStatus, Debt, Payment, Role
from app.repositories.debts import customer_totals, load_views
from app.schemas import CustomerCreate, CustomerOut, CustomerUpdate, DebtOut, Page, PaymentOut
from app.services.common import audit, business_today, next_number, normalize_name, normalize_phone, snapshot

router = APIRouter(prefix="/businesses/{business_id}/customers", tags=["customers"])
FIELDS = ["name", "phone", "email", "address", "notes", "status", "sms_opt_in"]
ZERO = Decimal("0.00")


def _out(c: Customer, totals: dict | None) -> CustomerOut:
    out = CustomerOut.model_validate(c)
    if totals:
        out.outstanding_balance = totals["balance"]
        out.overdue_amount = totals["overdue"]
        out.pending_verification = totals["pending"]
        out.open_debts = totals["open_debts"]
    return out


def _get(db: Session, tenant: Tenant, customer_id: uuid.UUID) -> Customer:
    c = db.scalar(select(Customer).where(Customer.id == customer_id, Customer.business_id == tenant.business_id))
    if c is None:
        raise NotFound("Customer not found")
    return c


def _duplicates(db: Session, tenant: Tenant, name: str, phone: str, exclude: uuid.UUID | None = None) -> list[Customer]:
    stmt = select(Customer).where(
        Customer.business_id == tenant.business_id,
        or_(Customer.phone == phone, Customer.name_normalized == normalize_name(name)),
    )
    if exclude:
        stmt = stmt.where(Customer.id != exclude)
    return list(db.scalars(stmt.limit(5)))


@router.get("", response_model=Page[CustomerOut])
def list_customers(
    q: str | None = Query(default=None, max_length=100),
    status: Literal["active", "archived", "all"] = "active",
    balance: Literal["any", "outstanding", "overdue"] = "any",
    sort: Literal["name", "balance", "recent"] = "name",
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: Tenant = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    stmt = select(Customer).where(Customer.business_id == tenant.business_id)
    if status != "all":
        stmt = stmt.where(Customer.status == CustomerStatus(status))
    if q:
        term = q.strip()
        like = f"%{normalize_name(term)}%"
        conds = [Customer.name_normalized.like(like), Customer.customer_number.ilike(f"%{term}%")]
        if re.fullmatch(r"\+?[\d\s()-]{3,}", term):  # looks like (part of) a phone number
            digits = "".join(ch for ch in term if ch.isdigit())
            digits = digits[3:] if digits.startswith("254") else digits.lstrip("0")
            if len(digits) >= 3:
                conds.append(Customer.phone.like(f"%{digits}%"))
        stmt = stmt.where(or_(*conds))
    customers = list(db.scalars(stmt.order_by(Customer.name_normalized)))
    totals = (
        customer_totals(db, tenant.business_id, business_today(tenant.business), [c.id for c in customers])
        if customers
        else {}
    )
    if balance == "outstanding":
        customers = [c for c in customers if totals.get(c.id, {}).get("balance", ZERO) > 0]
    elif balance == "overdue":
        customers = [c for c in customers if totals.get(c.id, {}).get("overdue", ZERO) > 0]
    if sort == "balance":
        customers.sort(key=lambda c: -totals.get(c.id, {}).get("balance", ZERO))
    elif sort == "recent":
        customers.sort(key=lambda c: c.created_at, reverse=True)
    page = customers[offset : offset + limit]
    return Page(items=[_out(c, totals.get(c.id)) for c in page], total=len(customers), limit=limit, offset=offset)


@router.post("", status_code=201, response_model=CustomerOut)
def create_customer(
    data: CustomerCreate,
    key: str | None = Depends(idempotency_key),
    tenant: Tenant = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    if tenant.role == Role.cashier and not tenant.settings.cashier_can_register_customers:
        raise Forbidden("Cashiers are not allowed to register customers in this business")

    def action():
        phone = normalize_phone(data.phone)
        if data.client_reference:
            existing = db.scalar(
                select(Customer).where(
                    Customer.business_id == tenant.business_id, Customer.client_reference == data.client_reference
                )
            )
            if existing:
                return _out(existing, None)
        if not data.allow_duplicate:
            dups = _duplicates(db, tenant, data.name, phone)
            if dups:
                raise Conflict(
                    "A customer with the same name or phone number already exists",
                    code="possible_duplicate",
                    details=[
                        {"id": str(d.id), "name": d.name, "phone": d.phone, "customer_number": d.customer_number}
                        for d in dups
                    ],
                )
        number = next_number(db, tenant.business_id, "customer")
        c = Customer(
            business_id=tenant.business_id,
            customer_number=f"C-{number:05d}",
            name=data.name.strip(),
            name_normalized=normalize_name(data.name),
            phone=phone,
            email=data.email.lower() if data.email else None,
            address=data.address,
            notes=data.notes,
            sms_opt_in=data.sms_opt_in,
            client_reference=data.client_reference,
            created_by=tenant.user.id,
        )
        db.add(c)
        db.flush()
        audit(
            db,
            business_id=tenant.business_id,
            actor_id=tenant.user.id,
            action="customer.created",
            entity_type="customer",
            entity_id=c.id,
            after=snapshot(c, FIELDS),
            ip=tenant.ip,
        )
        db.refresh(c)
        return _out(c, None)

    return idempotent_create(db, tenant, key, data, action, "customers.create")


@router.get("/{customer_id}", response_model=CustomerOut)
def get_customer(customer_id: uuid.UUID, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    c = _get(db, tenant, customer_id)
    totals = customer_totals(db, tenant.business_id, business_today(tenant.business), [c.id])
    return _out(c, totals.get(c.id))


@router.patch("/{customer_id}", response_model=CustomerOut)
def update_customer(
    customer_id: uuid.UUID,
    data: CustomerUpdate,
    tenant: Tenant = Depends(manager_only),
    db: Session = Depends(get_db),
):
    c = _get(db, tenant, customer_id)
    if c.version != data.version:
        raise Conflict("This customer was changed by someone else. Reload and try again.", code="version_conflict")
    before = snapshot(c, FIELDS)
    changes = data.model_dump(exclude_unset=True, exclude={"version"})
    if "phone" in changes and changes["phone"]:
        changes["phone"] = normalize_phone(changes["phone"])
    for k, v in changes.items():
        if k == "name" and v:
            c.name, c.name_normalized = v.strip(), normalize_name(v)
        elif k == "email":
            c.email = v.lower() if v else None
        else:
            setattr(c, k, v)
    c.version += 1
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="customer.updated",
        entity_type="customer",
        entity_id=c.id,
        before=before,
        after=snapshot(c, FIELDS),
        ip=tenant.ip,
    )
    db.commit()
    return get_customer(customer_id, tenant, db)


@router.post("/{customer_id}/archive", response_model=CustomerOut)
def archive_customer(customer_id: uuid.UUID, tenant: Tenant = Depends(manager_only), db: Session = Depends(get_db)):
    c = _get(db, tenant, customer_id)
    if c.status == CustomerStatus.archived:
        raise BusinessRuleError("Customer is already archived")
    c.status = CustomerStatus.archived
    c.version += 1
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="customer.archived",
        entity_type="customer",
        entity_id=c.id,
        ip=tenant.ip,
    )
    db.commit()
    return get_customer(customer_id, tenant, db)


@router.post("/{customer_id}/restore", response_model=CustomerOut)
def restore_customer(customer_id: uuid.UUID, tenant: Tenant = Depends(manager_only), db: Session = Depends(get_db)):
    c = _get(db, tenant, customer_id)
    c.status = CustomerStatus.active
    c.version += 1
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="customer.restored",
        entity_type="customer",
        entity_id=c.id,
        ip=tenant.ip,
    )
    db.commit()
    return get_customer(customer_id, tenant, db)


@router.get("/{customer_id}/debts", response_model=list[DebtOut])
def customer_debts(customer_id: uuid.UUID, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    _get(db, tenant, customer_id)
    today = business_today(tenant.business)
    views = load_views(db, tenant.business_id, today, Debt.customer_id == customer_id)
    return [debt_out(v, today) for v in sorted(views, key=lambda v: v.debt.created_at, reverse=True)]


@router.get("/{customer_id}/payments", response_model=list[PaymentOut])
def customer_payments(customer_id: uuid.UUID, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    _get(db, tenant, customer_id)
    rows = (
        db.scalars(
            select(Payment)
            .where(Payment.business_id == tenant.business_id, Payment.customer_id == customer_id)
            .order_by(Payment.paid_at.desc())
        )
        .unique()
        .all()
    )
    return [payment_out(p) for p in rows]


@router.get("/check/duplicates", response_model=list[CustomerOut])
def check_duplicates(
    name: str = Query(min_length=2, max_length=160),
    phone: str = Query(min_length=7, max_length=20),
    tenant: Tenant = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return [_out(c, None) for c in _duplicates(db, tenant, name, normalize_phone(phone))]
