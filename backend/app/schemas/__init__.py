"""Request/response schemas. Money is serialised as a decimal string (e.g. "1500.00")."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    EmailStr,
    Field,
    PlainSerializer,
    field_validator,
)

from app.models import PaymentMethod, Role
from app.services.ledger import MoneyError, money


def _money_in(v):
    if isinstance(v, bool):
        raise ValueError("Invalid amount")
    try:
        return money(v)
    except MoneyError as e:
        raise ValueError(str(e)) from None


MoneyIn = Annotated[Decimal, BeforeValidator(_money_in)]
MoneyOut = Annotated[Decimal, PlainSerializer(lambda d: f"{d:.2f}", return_type=str)]
PositiveMoney = Annotated[MoneyIn, Field(gt=0, le=Decimal("999999999999.99"))]

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


Password = Annotated[str, Field(min_length=10, max_length=128)]
Name = Annotated[str, Field(min_length=2, max_length=160)]


# --------------------------------------------------------------------------- auth


class RegisterIn(BaseModel):
    full_name: Name
    email: EmailStr
    password: Password
    phone: str | None = None
    business_name: Name


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=128)


class RefreshIn(BaseModel):
    refresh_token: str = Field(max_length=200)


class PasswordResetRequestIn(BaseModel):
    email: EmailStr


class PasswordResetConfirmIn(BaseModel):
    token: str = Field(max_length=200)
    new_password: Password


class ChangePasswordIn(BaseModel):
    current_password: str = Field(max_length=128)
    new_password: Password


class UserOut(ORM):
    id: uuid.UUID
    email: str
    full_name: str
    phone: str | None
    must_change_password: bool


class MembershipOut(BaseModel):
    business_id: uuid.UUID
    business_name: str
    role: Role


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut
    memberships: list[MembershipOut]


class DeviceTokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=300)
    platform: Literal["android", "ios"]


# --------------------------------------------------------------------------- business


class BusinessOut(ORM):
    id: uuid.UUID
    name: str
    phone: str | None
    email: str | None
    address: str | None
    currency: str
    timezone: str


class BusinessUpdate(BaseModel):
    name: Name | None = None
    phone: str | None = None
    email: EmailStr | None = None
    address: str | None = Field(default=None, max_length=300)


class SettingsOut(ORM):
    reminder_offsets: list[int]
    reminder_channels: list[str]
    reminders_enabled: bool
    quiet_hours_start: int
    quiet_hours_end: int
    max_reminders_per_customer_per_week: int
    cashier_can_register_customers: bool
    cashier_can_view_reports: bool
    payment_methods: list[str]
    receipt_footer: str | None


class SettingsUpdate(BaseModel):
    reminder_offsets: list[Annotated[int, Field(ge=-90, le=60)]] | None = Field(default=None, max_length=12)
    reminder_channels: list[Literal["in_app", "push", "sms", "whatsapp"]] | None = None
    reminders_enabled: bool | None = None
    quiet_hours_start: int | None = Field(default=None, ge=0, le=23)
    quiet_hours_end: int | None = Field(default=None, ge=0, le=23)
    max_reminders_per_customer_per_week: int | None = Field(default=None, ge=0, le=14)
    cashier_can_register_customers: bool | None = None
    cashier_can_view_reports: bool | None = None
    payment_methods: list[PaymentMethod] | None = None
    receipt_footer: str | None = Field(default=None, max_length=300)


class StaffCreate(BaseModel):
    full_name: Name
    email: EmailStr
    phone: str | None = None
    role: Literal["admin", "cashier"]
    temporary_password: Password


class StaffUpdate(BaseModel):
    role: Literal["admin", "cashier"] | None = None
    is_active: bool | None = None


class StaffOut(BaseModel):
    membership_id: uuid.UUID
    user_id: uuid.UUID
    full_name: str
    email: str
    phone: str | None
    role: Role
    is_active: bool


# --------------------------------------------------------------------------- customers


class CustomerCreate(BaseModel):
    name: Name
    phone: str = Field(min_length=7, max_length=20)
    email: EmailStr | None = None
    address: str | None = Field(default=None, max_length=300)
    notes: str | None = Field(default=None, max_length=1000)
    sms_opt_in: bool = True
    allow_duplicate: bool = False
    client_reference: str | None = Field(default=None, max_length=64)


class CustomerUpdate(BaseModel):
    version: int
    name: Name | None = None
    phone: str | None = Field(default=None, min_length=7, max_length=20)
    email: EmailStr | None = None
    address: str | None = Field(default=None, max_length=300)
    notes: str | None = Field(default=None, max_length=1000)
    sms_opt_in: bool | None = None


class CustomerOut(ORM):
    id: uuid.UUID
    customer_number: str
    name: str
    phone: str
    email: str | None
    address: str | None
    notes: str | None
    status: str
    sms_opt_in: bool
    created_at: datetime
    updated_at: datetime
    version: int
    outstanding_balance: MoneyOut = Decimal("0.00")
    overdue_amount: MoneyOut = Decimal("0.00")
    pending_verification: MoneyOut = Decimal("0.00")
    open_debts: int = 0


# --------------------------------------------------------------------------- debts


class InstallmentPlanIn(BaseModel):
    count: int = Field(ge=2, le=60)
    frequency: Literal["weekly", "monthly"] = "monthly"
    first_due_date: date


class InstallmentIn(BaseModel):
    due_date: date
    amount: PositiveMoney


class DebtCreate(BaseModel):
    customer_id: uuid.UUID
    description: str = Field(min_length=2, max_length=500)
    principal: PositiveMoney
    incurred_on: date
    due_date: date
    terms: str | None = Field(default=None, max_length=500)
    reference: str | None = Field(default=None, max_length=64)
    installment_plan: InstallmentPlanIn | None = None
    installments: list[InstallmentIn] | None = Field(default=None, max_length=60)
    client_reference: str | None = Field(default=None, max_length=64)


class DebtUpdate(BaseModel):
    version: int
    description: str | None = Field(default=None, min_length=2, max_length=500)
    due_date: date | None = None
    terms: str | None = Field(default=None, max_length=500)
    reference: str | None = Field(default=None, max_length=64)


class AdjustmentCreate(BaseModel):
    amount: MoneyIn
    reason: str = Field(min_length=5, max_length=500)

    @field_validator("amount")
    @classmethod
    def _nonzero(cls, v: Decimal) -> Decimal:
        if v == 0:
            raise ValueError("Adjustment cannot be zero")
        return v


class DebtFlagIn(BaseModel):
    flag: Literal["none", "cancelled", "disputed"]
    reason: str = Field(min_length=5, max_length=500)


class InstallmentOut(BaseModel):
    number: int
    due_date: date
    amount: MoneyOut
    covered: MoneyOut
    status: Literal["paid", "partially_paid", "due", "overdue"]


class AdjustmentOut(ORM):
    id: uuid.UUID
    amount: MoneyOut
    reason: str
    created_by: uuid.UUID
    created_at: datetime


class DebtOut(BaseModel):
    id: uuid.UUID
    debt_number: str
    customer_id: uuid.UUID
    customer_name: str
    customer_phone: str
    description: str
    currency: str
    principal: MoneyOut
    adjustments_total: MoneyOut
    total_due: MoneyOut
    paid: MoneyOut
    pending_verification: MoneyOut
    balance: MoneyOut
    overdue_amount: MoneyOut
    status: str
    days_overdue: int
    incurred_on: date
    due_date: date
    next_due_date: date | None
    terms: str | None
    reference: str | None
    flag_reason: str | None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    version: int
    schedule: list[InstallmentOut] = []


class DebtDetailOut(DebtOut):
    adjustments: list[AdjustmentOut] = []
    payments: list["PaymentOut"] = []


# --------------------------------------------------------------------------- payments


class AllocationIn(BaseModel):
    debt_id: uuid.UUID
    amount: PositiveMoney


class PaymentCreate(BaseModel):
    customer_id: uuid.UUID
    amount: PositiveMoney
    method: PaymentMethod
    paid_at: datetime | None = None
    external_reference: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=500)
    allocations: list[AllocationIn] | None = Field(default=None, max_length=50)
    client_reference: str | None = Field(default=None, max_length=64)


class AllocationOut(ORM):
    debt_id: uuid.UUID
    amount: MoneyOut


class PaymentOut(BaseModel):
    id: uuid.UUID
    customer_id: uuid.UUID
    customer_name: str
    amount: MoneyOut
    currency: str
    method: str
    paid_at: datetime
    external_reference: str | None
    verification_status: str
    status: str
    receipt_number: str | None
    notes: str | None
    recorded_by: uuid.UUID
    recorded_by_name: str | None = None
    reversal_reason: str | None
    reversed_at: datetime | None
    created_at: datetime
    allocations: list[AllocationOut]


class ReverseIn(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


class VerifyIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=500)


class ReceiptOut(BaseModel):
    receipt_number: str
    issued_at: datetime
    payment_id: uuid.UUID
    payment_status: str
    snapshot: dict
    share_text: str


class StkPushIn(BaseModel):
    debt_id: uuid.UUID
    amount: PositiveMoney
    phone: str | None = None


class PaymentRequestOut(ORM):
    id: uuid.UUID
    debt_id: uuid.UUID
    amount: MoneyOut
    phone: str
    provider: str
    provider_mode: str
    status: str
    failure_reason: str | None
    payment_id: uuid.UUID | None
    created_at: datetime


# --------------------------------------------------------------------------- reminders / notifications / audit


class TemplateOut(ORM):
    kind: str
    body: str


class TemplateUpdate(BaseModel):
    body: str = Field(min_length=20, max_length=480)


class ReminderOut(ORM):
    id: uuid.UUID
    debt_id: uuid.UUID
    customer_id: uuid.UUID
    channel: str
    target_date: date
    offset_days: int
    status: str
    message: str | None
    attempts: int
    last_error: str | None
    sent_at: datetime | None
    created_at: datetime


class NotificationOut(ORM):
    id: uuid.UUID
    kind: str
    title: str
    body: str
    entity_type: str | None
    entity_id: uuid.UUID | None
    read_at: datetime | None
    created_at: datetime


class AuditOut(ORM):
    id: uuid.UUID
    actor_user_id: uuid.UUID | None
    action: str
    entity_type: str
    entity_id: uuid.UUID | None
    before: dict | None
    after: dict | None
    reason: str | None
    created_at: datetime


DebtDetailOut.model_rebuild()
