"""SQLAlchemy models. Every tenant-owned table carries ``business_id``.

Money is stored as NUMERIC(14, 2) and handled as ``decimal.Decimal`` everywhere.
"""

import enum
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from app.db import Base

Money = Numeric(14, 2, asdecimal=True)


class UTCDateTime(TypeDecorator):
    """Stores UTC; always returns timezone-aware datetimes (SQLite drops tzinfo otherwise)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None:
            if value.tzinfo is None:
                raise ValueError("Naive datetimes are not allowed; use UTC-aware values")
            value = value.astimezone(UTC)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value


def utcnow() -> datetime:
    return datetime.now(UTC)


def _enum(cls: type[enum.Enum]) -> Enum:
    return Enum(cls, native_enum=False, length=32, values_callable=lambda e: [m.value for m in e])


class Role(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    cashier = "cashier"


class CustomerStatus(str, enum.Enum):
    active = "active"
    archived = "archived"


class DebtFlag(str, enum.Enum):
    """Manually set states. Open/partially paid/paid/overdue are always derived."""

    none = "none"
    cancelled = "cancelled"
    disputed = "disputed"


class PaymentMethod(str, enum.Enum):
    cash = "cash"
    mpesa = "mpesa"
    bank_transfer = "bank_transfer"
    card = "card"
    other = "other"


class VerificationStatus(str, enum.Enum):
    not_required = "not_required"  # e.g. cash received in hand by the recorder
    pending = "pending"  # awaiting reconciliation (e.g. manually-entered M-Pesa code)
    verified = "verified"
    rejected = "rejected"


class PaymentStatus(str, enum.Enum):
    posted = "posted"
    reversed = "reversed"


class ReminderStatus(str, enum.Enum):
    queued = "queued"
    sent = "sent"
    failed = "failed"
    skipped = "skipped"


class ReminderChannel(str, enum.Enum):
    in_app = "in_app"
    push = "push"
    sms = "sms"
    whatsapp = "whatsapp"


class MpesaSmsStatus(str, enum.Enum):
    applied = "applied"  # recorded automatically as a verified payment
    confirmed = "confirmed"  # confirmed a payment staff had already entered with this code
    already_recorded = "already_recorded"
    needs_review = "needs_review"  # money arrived but no single customer matched by number and name
    dismissed = "dismissed"  # an owner marked it as not a debt repayment


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


# --------------------------------------------------------------------------- identity


class Business(TimestampMixin, Base):
    __tablename__ = "businesses"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(160))
    phone: Mapped[str | None] = mapped_column(String(20))
    email: Mapped[str | None] = mapped_column(String(254))
    address: Mapped[str | None] = mapped_column(String(300))
    currency: Mapped[str] = mapped_column(String(3), default="KES")
    timezone: Mapped[str] = mapped_column(String(64), default="Africa/Nairobi")


class User(TimestampMixin, Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    full_name: Mapped[str] = mapped_column(String(160))
    phone: Mapped[str | None] = mapped_column(String(20))
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)


class BusinessMembership(TimestampMixin, Base):
    __tablename__ = "business_memberships"
    __table_args__ = (UniqueConstraint("business_id", "user_id"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[Role] = mapped_column(_enum(Role))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    business: Mapped[Business] = relationship(lazy="joined")
    user: Mapped[User] = relationship(lazy="joined")


class UserSession(Base):
    """Refresh-token session. Revoking it invalidates its access tokens too."""

    __tablename__ = "user_sessions"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    refresh_token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    user_agent: Mapped[str | None] = mapped_column(String(200))


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class BusinessSettings(TimestampMixin, Base):
    __tablename__ = "business_settings"
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), primary_key=True)
    # Positive = days before due date, 0 = due day, negative = days overdue.
    reminder_offsets: Mapped[list] = mapped_column(JSON, default=lambda: [7, 3, 1, 0, -3, -7, -14])
    reminder_channels: Mapped[list] = mapped_column(JSON, default=lambda: ["in_app", "sms"])
    reminders_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    quiet_hours_start: Mapped[int] = mapped_column(Integer, default=20)  # local hour, 0-23
    quiet_hours_end: Mapped[int] = mapped_column(Integer, default=8)
    max_reminders_per_customer_per_week: Mapped[int] = mapped_column(Integer, default=3)
    cashier_can_register_customers: Mapped[bool] = mapped_column(Boolean, default=True)
    cashier_can_view_reports: Mapped[bool] = mapped_column(Boolean, default=False)
    payment_methods: Mapped[list] = mapped_column(JSON, default=lambda: ["cash", "mpesa", "bank_transfer", "other"])
    receipt_footer: Mapped[str | None] = mapped_column(String(300))
    # "phone": customer SMS reminders are sent by the owner's phone running the app.
    # "provider": sent by the configured SMS gateway (Africa's Talking).
    sms_sender: Mapped[str] = mapped_column(String(16), default="phone", server_default="phone")


class Counter(Base):
    """Per-business gapless sequence (receipts, customer and debt numbers)."""

    __tablename__ = "counters"
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), primary_key=True)
    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)


# --------------------------------------------------------------------------- customers


class Customer(TimestampMixin, Base):
    __tablename__ = "customers"
    __table_args__ = (
        UniqueConstraint("business_id", "customer_number"),
        UniqueConstraint("business_id", "client_reference"),
        Index("ix_customers_business_phone", "business_id", "phone"),
        Index("ix_customers_business_name", "business_id", "name_normalized"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    customer_number: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(160))
    name_normalized: Mapped[str] = mapped_column(String(160))
    phone: Mapped[str] = mapped_column(String(16))  # E.164, e.g. +254712345678
    email: Mapped[str | None] = mapped_column(String(254))
    address: Mapped[str | None] = mapped_column(String(300))
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[CustomerStatus] = mapped_column(_enum(CustomerStatus), default=CustomerStatus.active)
    sms_opt_in: Mapped[bool] = mapped_column(Boolean, default=True)
    client_reference: Mapped[str | None] = mapped_column(String(64))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    version: Mapped[int] = mapped_column(Integer, default=1)


# --------------------------------------------------------------------------- debts


class Debt(TimestampMixin, Base):
    __tablename__ = "debts"
    __table_args__ = (
        UniqueConstraint("business_id", "debt_number"),
        UniqueConstraint("business_id", "client_reference"),
        CheckConstraint("principal > 0", name="ck_debts_principal_positive"),
        CheckConstraint("due_date >= incurred_on", name="ck_debts_due_after_incurred"),
        Index("ix_debts_business_due", "business_id", "due_date"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customers.id"), index=True)
    debt_number: Mapped[str] = mapped_column(String(20))
    description: Mapped[str] = mapped_column(String(500))
    principal: Mapped[Decimal] = mapped_column(Money)
    currency: Mapped[str] = mapped_column(String(3), default="KES")
    incurred_on: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date] = mapped_column(Date)
    terms: Mapped[str | None] = mapped_column(String(500))
    reference: Mapped[str | None] = mapped_column(String(64))
    flag: Mapped[DebtFlag] = mapped_column(_enum(DebtFlag), default=DebtFlag.none)
    flag_reason: Mapped[str | None] = mapped_column(String(500))
    client_reference: Mapped[str | None] = mapped_column(String(64))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    version: Mapped[int] = mapped_column(Integer, default=1)

    customer: Mapped[Customer] = relationship(lazy="joined")
    schedule: Mapped[list["RepaymentSchedule"]] = relationship(
        order_by="RepaymentSchedule.installment_number", lazy="selectin"
    )


class DebtAdjustment(Base):
    """Signed correction to what is owed (e.g. returned goods = negative)."""

    __tablename__ = "debt_adjustments"
    __table_args__ = (CheckConstraint("amount <> 0", name="ck_adjustment_nonzero"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    debt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("debts.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Money)
    reason: Mapped[str] = mapped_column(String(500))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class RepaymentSchedule(Base):
    __tablename__ = "repayment_schedules"
    __table_args__ = (
        UniqueConstraint("debt_id", "installment_number"),
        CheckConstraint("amount > 0", name="ck_installment_positive"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    debt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("debts.id"), index=True)
    installment_number: Mapped[int] = mapped_column(Integer)
    due_date: Mapped[date] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Money)


# --------------------------------------------------------------------------- payments


class Payment(Base):
    __tablename__ = "payments"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_payment_positive"),
        UniqueConstraint("business_id", "client_reference"),
        # The same M-Pesa / bank reference can never be *posted* twice in one business.
        # Reversed payments are excluded so a corrected payment can reuse the real code.
        Index(
            "uq_payment_ext_ref_posted",
            "business_id",
            "method",
            "external_reference",
            unique=True,
            postgresql_where=text("status = 'posted' AND external_reference IS NOT NULL"),
            sqlite_where=text("status = 'posted' AND external_reference IS NOT NULL"),
        ),
        Index("ix_payments_business_paid_at", "business_id", "paid_at"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customers.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Money)
    currency: Mapped[str] = mapped_column(String(3), default="KES")
    paid_at: Mapped[datetime] = mapped_column(UTCDateTime())
    method: Mapped[PaymentMethod] = mapped_column(_enum(PaymentMethod))
    external_reference: Mapped[str | None] = mapped_column(String(64))
    verification_status: Mapped[VerificationStatus] = mapped_column(_enum(VerificationStatus))
    verified_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    status: Mapped[PaymentStatus] = mapped_column(_enum(PaymentStatus), default=PaymentStatus.posted)
    reversal_reason: Mapped[str | None] = mapped_column(String(500))
    reversed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    notes: Mapped[str | None] = mapped_column(String(500))
    receipt_number: Mapped[str | None] = mapped_column(String(32))
    client_reference: Mapped[str | None] = mapped_column(String(64))
    recorded_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    customer: Mapped[Customer] = relationship(lazy="joined")
    allocations: Mapped[list["PaymentAllocation"]] = relationship(lazy="selectin")


class PaymentAllocation(Base):
    __tablename__ = "payment_allocations"
    __table_args__ = (
        UniqueConstraint("payment_id", "debt_id"),
        CheckConstraint("amount > 0", name="ck_allocation_positive"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    payment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payments.id"), index=True)
    debt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("debts.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Money)


class Receipt(Base):
    __tablename__ = "receipts"
    __table_args__ = (UniqueConstraint("business_id", "receipt_number"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    payment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payments.id"), unique=True)
    receipt_number: Mapped[str] = mapped_column(String(32))
    issued_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    # Immutable snapshot of what was printed, so later edits never change a receipt.
    snapshot: Mapped[dict] = mapped_column(JSON)


class PaymentRequest(TimestampMixin, Base):
    """An STK Push (or other provider) collection request. Not a payment until confirmed."""

    __tablename__ = "payment_requests"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customers.id"))
    debt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("debts.id"))
    amount: Mapped[Decimal] = mapped_column(Money)
    phone: Mapped[str] = mapped_column(String(16))
    provider: Mapped[str] = mapped_column(String(32))
    provider_mode: Mapped[str] = mapped_column(String(16))
    checkout_request_id: Mapped[str | None] = mapped_column(String(100), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending/succeeded/failed
    failure_reason: Mapped[str | None] = mapped_column(String(300))
    payment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("payments.id"))
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))


class PaymentProviderEvent(Base):
    __tablename__ = "payment_provider_events"
    __table_args__ = (UniqueConstraint("provider", "event_key"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("businesses.id"), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    event_key: Mapped[str] = mapped_column(String(150))  # dedupe key for repeated callbacks
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16))  # processed / rejected / ignored
    detail: Mapped[str | None] = mapped_column(String(300))
    received_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class MpesaSmsMessage(Base):
    """An M-Pesa "you have received" SMS read on the owner's phone, and what was done with it.

    The transaction code is unique per business, so the same SMS is never applied twice,
    however many times the phone sends it.
    """

    __tablename__ = "mpesa_sms_messages"
    __table_args__ = (
        UniqueConstraint("business_id", "transaction_code"),
        Index("ix_mpesa_sms_business_status", "business_id", "status"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    transaction_code: Mapped[str] = mapped_column(String(10))
    amount: Mapped[Decimal] = mapped_column(Money)
    payer_name: Mapped[str] = mapped_column(String(160))
    payer_phone: Mapped[str | None] = mapped_column(String(20))  # as shown; may be partly masked
    received_at: Mapped[datetime] = mapped_column(UTCDateTime())
    status: Mapped[MpesaSmsStatus] = mapped_column(_enum(MpesaSmsStatus))
    detail: Mapped[str | None] = mapped_column(String(300))
    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("customers.id"))
    suggested_customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("customers.id"))
    payment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("payments.id"))
    message_text: Mapped[str] = mapped_column(String(1000))  # M-Pesa balance redacted
    submitted_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


# --------------------------------------------------------------------------- reminders


class ReminderTemplate(TimestampMixin, Base):
    __tablename__ = "reminder_templates"
    __table_args__ = (UniqueConstraint("business_id", "kind"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # upcoming / due_today / overdue
    body: Mapped[str] = mapped_column(String(480))


class ReminderHistory(Base):
    __tablename__ = "reminder_history"
    __table_args__ = (UniqueConstraint("idempotency_key"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    debt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("debts.id"), index=True)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customers.id"), index=True)
    channel: Mapped[ReminderChannel] = mapped_column(_enum(ReminderChannel))
    target_date: Mapped[date] = mapped_column(Date)
    offset_days: Mapped[int] = mapped_column(Integer)
    idempotency_key: Mapped[str] = mapped_column(String(200))
    status: Mapped[ReminderStatus] = mapped_column(_enum(ReminderStatus))
    message: Mapped[str | None] = mapped_column(String(640))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String(300))
    next_attempt_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    provider_message_id: Mapped[str | None] = mapped_column(String(100))
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))  # None = all staff
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(String(500))
    entity_type: Mapped[str | None] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    dedupe_key: Mapped[str | None] = mapped_column(String(200), unique=True)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class DeviceToken(Base):
    __tablename__ = "device_tokens"
    __table_args__ = (UniqueConstraint("token"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    token: Mapped[str] = mapped_column(String(300))
    platform: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


# --------------------------------------------------------------------------- audit / idempotency


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_business_created", "business_id", "created_at"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"))
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    before: Mapped[dict | None] = mapped_column(JSON)
    after: Mapped[dict | None] = mapped_column(JSON)
    reason: Mapped[str | None] = mapped_column(String(500))
    ip_address: Mapped[str | None] = mapped_column(String(45))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_records"
    __table_args__ = (UniqueConstraint("business_id", "user_id", "key"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("businesses.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    key: Mapped[str] = mapped_column(String(100))
    request_hash: Mapped[str] = mapped_column(String(64))
    response_status: Mapped[int] = mapped_column(Integer)
    response_body: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


TENANT_TABLES = [
    "customers",
    "debts",
    "debt_adjustments",
    "repayment_schedules",
    "payments",
    "payment_allocations",
    "receipts",
    "payment_requests",
    "mpesa_sms_messages",
    "reminder_templates",
    "reminder_history",
    "notifications",
    "audit_logs",
    "business_settings",
    "idempotency_records",
    "counters",
]
