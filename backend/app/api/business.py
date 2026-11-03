import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import Tenant, get_tenant, manager_only, owner_only
from app.db import get_db
from app.errors import BusinessRuleError, Conflict, NotFound
from app.models import (
    AuditLog,
    BusinessMembership,
    Notification,
    ReminderTemplate,
    Role,
    User,
)
from app.schemas import (
    AuditOut,
    BusinessOut,
    BusinessUpdate,
    NotificationOut,
    Page,
    SettingsOut,
    SettingsUpdate,
    StaffCreate,
    StaffOut,
    StaffUpdate,
    TemplateOut,
    TemplateUpdate,
)
from app.security import hash_password
from app.services.common import audit, normalize_phone, snapshot
from app.services.reminders import DEFAULT_TEMPLATES, validate_template

router = APIRouter(prefix="/businesses/{business_id}", tags=["business"])
SETTINGS_FIELDS = list(SettingsUpdate.model_fields)


@router.get("", response_model=BusinessOut)
def get_business(tenant: Tenant = Depends(get_tenant)):
    return tenant.business


@router.patch("", response_model=BusinessOut)
def update_business(data: BusinessUpdate, tenant: Tenant = Depends(owner_only), db: Session = Depends(get_db)):
    b = tenant.business
    before = snapshot(b, ["name", "phone", "email", "address"])
    changes = data.model_dump(exclude_unset=True)
    if changes.get("phone"):
        changes["phone"] = normalize_phone(changes["phone"])
    for k, v in changes.items():
        setattr(b, k, v)
    audit(
        db,
        business_id=b.id,
        actor_id=tenant.user.id,
        action="business.updated",
        entity_type="business",
        entity_id=b.id,
        before=before,
        after=snapshot(b, ["name", "phone", "email", "address"]),
        ip=tenant.ip,
    )
    db.commit()
    return b


@router.get("/settings", response_model=SettingsOut)
def get_settings_(tenant: Tenant = Depends(get_tenant)):
    return tenant.settings


@router.patch("/settings", response_model=SettingsOut)
def update_settings(data: SettingsUpdate, tenant: Tenant = Depends(manager_only), db: Session = Depends(get_db)):
    s = tenant.settings
    before = snapshot(s, SETTINGS_FIELDS)
    changes = data.model_dump(exclude_unset=True, mode="json")
    if "reminder_offsets" in changes:
        changes["reminder_offsets"] = sorted(set(changes["reminder_offsets"]), reverse=True)
    if "payment_methods" in changes and not changes["payment_methods"]:
        raise BusinessRuleError("At least one payment method must be enabled")
    for k, v in changes.items():
        setattr(s, k, v)
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="settings.updated",
        entity_type="business_settings",
        entity_id=tenant.business_id,
        before=before,
        after=snapshot(s, SETTINGS_FIELDS),
        ip=tenant.ip,
    )
    db.commit()
    return s


# --------------------------------------------------------------------------- staff


def _staff_out(m: BusinessMembership) -> StaffOut:
    return StaffOut(
        membership_id=m.id,
        user_id=m.user_id,
        full_name=m.user.full_name,
        email=m.user.email,
        phone=m.user.phone,
        role=m.role,
        is_active=m.is_active,
    )


@router.get("/staff", response_model=list[StaffOut])
def list_staff(tenant: Tenant = Depends(manager_only), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(BusinessMembership)
        .where(BusinessMembership.business_id == tenant.business_id)
        .order_by(BusinessMembership.created_at)
    ).all()
    return [_staff_out(m) for m in rows]


@router.post("/staff", status_code=201, response_model=StaffOut)
def add_staff(data: StaffCreate, tenant: Tenant = Depends(owner_only), db: Session = Depends(get_db)):
    """Create a staff login with a temporary password the owner shares in person.
    The staff member must change it at first sign-in."""
    email = data.email.lower()
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None:
        user = User(
            email=email,
            full_name=data.full_name.strip(),
            phone=normalize_phone(data.phone) if data.phone else None,
            password_hash=hash_password(data.temporary_password),
            must_change_password=True,
        )
        db.add(user)
        db.flush()
    elif db.scalar(
        select(BusinessMembership.id).where(
            BusinessMembership.business_id == tenant.business_id, BusinessMembership.user_id == user.id
        )
    ):
        raise Conflict("This person is already a member of the business", code="already_member")
    m = BusinessMembership(business_id=tenant.business_id, user_id=user.id, role=Role(data.role))
    db.add(m)
    db.flush()
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="staff.added",
        entity_type="membership",
        entity_id=m.id,
        after={"email": email, "role": data.role},
        ip=tenant.ip,
    )
    db.commit()
    db.refresh(m)
    return _staff_out(m)


@router.patch("/staff/{membership_id}", response_model=StaffOut)
def update_staff(
    membership_id: uuid.UUID, data: StaffUpdate, tenant: Tenant = Depends(owner_only), db: Session = Depends(get_db)
):
    m = db.scalar(
        select(BusinessMembership).where(
            BusinessMembership.id == membership_id, BusinessMembership.business_id == tenant.business_id
        )
    )
    if m is None:
        raise NotFound("Staff member not found")
    if m.role == Role.owner:
        raise BusinessRuleError("The owner's access cannot be changed here")
    before = snapshot(m, ["role", "is_active"])
    if data.role:
        m.role = Role(data.role)
    if data.is_active is not None:
        m.is_active = data.is_active
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="staff.updated",
        entity_type="membership",
        entity_id=m.id,
        before=before,
        after=snapshot(m, ["role", "is_active"]),
        ip=tenant.ip,
    )
    db.commit()
    return _staff_out(m)


# --------------------------------------------------------------------------- templates


@router.get("/reminder-templates", response_model=list[TemplateOut])
def list_templates(tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    rows = {
        r.kind: r
        for r in db.scalars(select(ReminderTemplate).where(ReminderTemplate.business_id == tenant.business_id))
    }
    return [TemplateOut(kind=k, body=rows[k].body if k in rows else v) for k, v in DEFAULT_TEMPLATES.items()]


@router.put("/reminder-templates/{kind}", response_model=TemplateOut)
def update_template(
    kind: Literal["upcoming", "due_today", "overdue"],
    data: TemplateUpdate,
    tenant: Tenant = Depends(manager_only),
    db: Session = Depends(get_db),
):
    try:
        validate_template(data.body)
    except ValueError as e:
        raise BusinessRuleError(str(e), code="invalid_template") from None
    t = db.scalar(
        select(ReminderTemplate).where(
            ReminderTemplate.business_id == tenant.business_id, ReminderTemplate.kind == kind
        )
    )
    before = {"body": t.body} if t else None
    if t is None:
        t = ReminderTemplate(business_id=tenant.business_id, kind=kind, body=data.body)
        db.add(t)
    else:
        t.body = data.body
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="template.updated",
        entity_type="reminder_template",
        entity_id=None,
        before=before,
        after={"kind": kind, "body": data.body},
        ip=tenant.ip,
    )
    db.commit()
    return TemplateOut(kind=kind, body=t.body)


# --------------------------------------------------------------------------- audit & notifications


@router.get("/audit-logs", response_model=Page[AuditOut])
def audit_logs(
    entity_type: str | None = Query(default=None, max_length=32),
    entity_id: uuid.UUID | None = None,
    actor_user_id: uuid.UUID | None = None,
    action: str | None = Query(default=None, max_length=64),
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: Tenant = Depends(manager_only),
    db: Session = Depends(get_db),
):
    stmt = select(AuditLog).where(AuditLog.business_id == tenant.business_id)
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if actor_user_id:
        stmt = stmt.where(AuditLog.actor_user_id == actor_user_id)
    if action:
        stmt = stmt.where(AuditLog.action.startswith(action))
    if date_from:
        stmt = stmt.where(AuditLog.created_at >= datetime.combine(date_from, time.min, tzinfo=UTC))
    if date_to:
        stmt = stmt.where(AuditLog.created_at < datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=UTC))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(AuditLog.created_at.desc()).limit(limit).offset(offset)).all()
    return Page(items=[AuditOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset)


def _notifications_stmt(tenant: Tenant):
    return select(Notification).where(
        Notification.business_id == tenant.business_id,
        or_(Notification.user_id.is_(None), Notification.user_id == tenant.user.id),
    )


@router.get("/notifications", response_model=Page[NotificationOut])
def notifications(
    unread_only: bool = False,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: Tenant = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    stmt = _notifications_stmt(tenant)
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Notification.created_at.desc()).limit(limit).offset(offset)).all()
    return Page(items=[NotificationOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset)


@router.post("/notifications/read-all", status_code=204)
def mark_all_read(tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    for n in db.scalars(_notifications_stmt(tenant).where(Notification.read_at.is_(None))):
        n.read_at = datetime.now(UTC)
    db.commit()


@router.post("/notifications/{notification_id}/read", status_code=204)
def mark_read(notification_id: uuid.UUID, tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    n = db.scalar(_notifications_stmt(tenant).where(Notification.id == notification_id))
    if n is None:
        raise NotFound("Notification not found")
    n.read_at = n.read_at or datetime.now(UTC)
    db.commit()
