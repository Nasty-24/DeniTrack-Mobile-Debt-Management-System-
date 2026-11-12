"""Reminder planning and delivery.

Planning is idempotent: each (debt, target date, offset, channel) has a unique key, so
running the scheduler twice, or on two workers at once, never creates a second reminder.
Amounts are re-read from the ledger at send time; a debt paid after planning is skipped.
"""

import logging
import string
import uuid
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import BusinessRuleError, NotFound
from app.integrations.messaging import DeliveryError, get_push, get_sms
from app.models import (
    Business,
    BusinessMembership,
    BusinessSettings,
    Customer,
    Debt,
    DebtFlag,
    DeviceToken,
    Notification,
    ReminderChannel,
    ReminderHistory,
    ReminderStatus,
    ReminderTemplate,
)
from app.repositories.debts import DebtView, load_view, load_views
from app.services.ledger import next_installment_due

log = logging.getLogger("denitrack.reminders")

MAX_ATTEMPTS = 3
# How long a phone has to send a reminder it collected before it is offered again.
PHONE_LEASE = timedelta(minutes=15)
MANUAL_PREFIX = "manual:"
# Credit notices: one SMS when a debt is recorded, telling the customer what they took on credit.
# They are receipts rather than reminders, so quiet hours and the weekly limit do not apply.
NOTICE_PREFIX = "notice:"
NOTICE_ITEMS_MAX = 100  # characters of the debt description quoted in the SMS
CUSTOMER_CHANNELS = {ReminderChannel.sms, ReminderChannel.whatsapp}
ALLOWED_PLACEHOLDERS = {"customer_name", "business_name", "amount", "due_date", "business_phone"}
NOTICE_PLACEHOLDERS = ALLOWED_PLACEHOLDERS | {"items", "credit_date"}

DEFAULT_TEMPLATES = {
    "upcoming": (
        "Hello {customer_name}, this is a friendly reminder that your outstanding balance with "
        "{business_name} is KSh {amount}, due on {due_date}. If you have already paid, please "
        "contact us so we can confirm the transaction. Thank you."
    ),
    "due_today": (
        "Hello {customer_name}, this is a friendly reminder that your balance of KSh {amount} with "
        "{business_name} is due today, {due_date}. If you have already paid, please contact us so "
        "we can confirm the transaction. Thank you."
    ),
    "overdue": (
        "Hello {customer_name}, our records show a balance of KSh {amount} with {business_name} that "
        "was due on {due_date}. If you have already paid, please contact us on {business_phone} so we "
        "can confirm the transaction. Thank you."
    ),
    "credit_notice": (
        "Hello {customer_name}, {business_name} has recorded {items} taken on credit on {credit_date}, "
        "worth KSh {amount}. Please pay by {due_date}. Thank you."
    ),
}


def validate_template(body: str, kind: str = "upcoming") -> None:
    allowed = NOTICE_PLACEHOLDERS if kind == "credit_notice" else ALLOWED_PLACEHOLDERS
    fields = {f for _, f, _, _ in string.Formatter().parse(body) if f is not None}
    unknown = fields - allowed
    if unknown:
        raise ValueError(f"Unknown placeholders: {', '.join(sorted(unknown))}")
    if "{amount}" not in body:
        raise ValueError("Template must include {amount}")


def render(body: str, values: dict) -> str:
    return body.format_map({k: values.get(k, "") for k in NOTICE_PLACEHOLDERS})


def is_notice(rec: ReminderHistory) -> bool:
    return rec.idempotency_key.startswith(NOTICE_PREFIX)


def in_quiet_hours(hour: int, start: int, end: int) -> bool:
    if start == end:
        return False
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def next_send_time(now_utc: datetime, s: BusinessSettings, tz: str) -> datetime:
    local = now_utc.astimezone(ZoneInfo(tz))
    if not in_quiet_hours(local.hour, s.quiet_hours_start, s.quiet_hours_end):
        return now_utc
    resume = datetime.combine(local.date(), time(s.quiet_hours_end), tzinfo=local.tzinfo)
    if resume <= local:
        resume += timedelta(days=1)
    return resume.astimezone(UTC)


def _targets(v: DebtView) -> list[tuple[date, Decimal]]:
    """Dates a reminder can be anchored to, with the amount relevant to each."""
    if not v.schedule:
        return [(v.debt.due_date, v.figures.balance)]
    out = []
    covered = v.figures.paid
    for inst in v.schedule:
        remaining = inst.amount - min(inst.amount, max(covered, Decimal(0)))
        covered -= inst.amount
        if remaining > 0:
            out.append((inst.due_date, remaining))
    return out


def _template_kind(offset: int) -> str:
    return "upcoming" if offset > 0 else "due_today" if offset == 0 else "overdue"


def _templates(db: Session, business_id) -> dict[str, str]:
    rows = db.scalars(select(ReminderTemplate).where(ReminderTemplate.business_id == business_id)).all()
    return DEFAULT_TEMPLATES | {r.kind: r.body for r in rows}


def _message(templates, business: Business, v: DebtView, offset: int, target: date, amount: Decimal) -> str:
    if offset < 0:
        amount = v.overdue_amount or amount
    return render(
        templates[_template_kind(offset)],
        {
            "customer_name": v.debt.customer.name.split(" ")[0] if offset >= 0 else v.debt.customer.name,
            "business_name": business.name,
            "amount": f"{amount:,.2f}",
            "due_date": target.strftime("%d %b %Y"),
            "business_phone": business.phone or "",
        },
    )


def plan_reminders(db: Session, business: Business, now_utc: datetime) -> int:
    settings = db.get(BusinessSettings, business.id)
    if settings is None or not settings.reminders_enabled:
        return 0
    today = now_utc.astimezone(ZoneInfo(business.timezone)).date()
    templates = _templates(db, business.id)
    send_at = next_send_time(now_utc, settings, business.timezone)
    offsets = set(settings.reminder_offsets)
    channels = [ReminderChannel(c) for c in settings.reminder_channels]
    created = 0
    for v in load_views(db, business.id, today, Debt.flag == DebtFlag.none):
        if v.figures.balance <= 0:
            continue
        for target, amount in _targets(v):
            offset = (target - today).days
            if offset not in offsets:
                continue
            for channel in channels:
                key = f"{v.debt.id}:{target.isoformat()}:{offset}:{channel.value}"
                rec = ReminderHistory(
                    business_id=business.id,
                    debt_id=v.debt.id,
                    customer_id=v.debt.customer_id,
                    channel=channel,
                    target_date=target,
                    offset_days=offset,
                    idempotency_key=key,
                    status=ReminderStatus.queued,
                    message=_message(templates, business, v, offset, target, amount),
                    next_attempt_at=send_at if channel in CUSTOMER_CHANNELS else now_utc,
                )
                if channel in CUSTOMER_CHANNELS and not v.debt.customer.sms_opt_in:
                    rec.status, rec.last_error, rec.next_attempt_at = ReminderStatus.skipped, "Customer opted out", None
                try:
                    with db.begin_nested():
                        db.add(rec)
                    created += 1
                except IntegrityError:
                    pass  # already planned
    return created


def _weekly_count(db: Session, business_id, customer_id, now_utc: datetime) -> int:
    db.flush()  # include messages sent earlier in this same run
    return (
        db.scalar(
            select(func.count(ReminderHistory.id)).where(
                ReminderHistory.business_id == business_id,
                ReminderHistory.customer_id == customer_id,
                ReminderHistory.channel.in_(CUSTOMER_CHANNELS),
                ReminderHistory.status == ReminderStatus.sent,
                ReminderHistory.sent_at >= now_utc - timedelta(days=7),
                ReminderHistory.idempotency_key.not_like(f"{NOTICE_PREFIX}%"),
            )
        )
        or 0
    )


def dispatch_due(db: Session, business: Business, now_utc: datetime) -> dict[str, int]:
    settings = db.get(BusinessSettings, business.id)
    if settings is None:
        return {"sent": 0, "failed": 0, "skipped": 0, "deferred": 0}
    today = now_utc.astimezone(ZoneInfo(business.timezone)).date()
    templates = _templates(db, business.id)
    stats = {"sent": 0, "failed": 0, "skipped": 0, "deferred": 0}
    stmt = select(ReminderHistory).where(
        ReminderHistory.business_id == business.id,
        ReminderHistory.status == ReminderStatus.queued,
        ReminderHistory.next_attempt_at <= now_utc,
        # Reminders a staff member sends from their own phone are never sent again by the server.
        ReminderHistory.idempotency_key.not_like(f"{MANUAL_PREFIX}%"),
    )
    if settings.sms_sender == "phone":
        # The owner's phone collects these (claim_for_phone) and sends them from its own SIM.
        stmt = stmt.where(ReminderHistory.channel != ReminderChannel.sms)
    due = db.scalars(stmt.order_by(ReminderHistory.created_at).with_for_update(skip_locked=True)).all()
    for rec in due:
        v = load_view(db, business.id, rec.debt_id, today)
        if v is None or v.debt.flag != DebtFlag.none or v.figures.balance <= 0:
            rec.status, rec.last_error = ReminderStatus.skipped, "Debt no longer outstanding"
            stats["skipped"] += 1
            continue
        notice = is_notice(rec)
        if not notice:
            amount = next((amt for tgt, amt in _targets(v) if tgt == rec.target_date), v.figures.balance)
            # Re-render so the message reflects the ledger right now, not at planning time.
            rec.message = _message(templates, business, v, rec.offset_days, rec.target_date, amount)
        try:
            if rec.channel in CUSTOMER_CHANNELS:
                local_hour = now_utc.astimezone(ZoneInfo(business.timezone)).hour
                if not notice and in_quiet_hours(local_hour, settings.quiet_hours_start, settings.quiet_hours_end):
                    rec.next_attempt_at = next_send_time(now_utc, settings, business.timezone)
                    stats["deferred"] += 1
                    continue
                if not v.debt.customer.sms_opt_in:
                    rec.status, rec.last_error = ReminderStatus.skipped, "Customer opted out"
                    stats["skipped"] += 1
                    continue
                if (
                    not notice
                    and _weekly_count(db, business.id, rec.customer_id, now_utc)
                    >= settings.max_reminders_per_customer_per_week
                ):
                    rec.status, rec.last_error = ReminderStatus.skipped, "Weekly reminder limit reached"
                    stats["skipped"] += 1
                    continue
                if rec.channel == ReminderChannel.whatsapp:
                    raise DeliveryError("WhatsApp Business provider is not configured", retryable=False)
                if not rec.message:  # notices keep the text written when the debt was recorded
                    raise DeliveryError("The message is empty", retryable=False)
                rec.attempts += 1
                rec.provider_message_id = get_sms().send(v.debt.customer.phone, rec.message)
            else:
                rec.attempts += 1
                _notify_staff(db, business, rec, v)
            rec.status, rec.sent_at, rec.last_error = ReminderStatus.sent, now_utc, None
            stats["sent"] += 1
        except DeliveryError as e:
            rec.last_error = str(e)[:300]
            if e.retryable and rec.attempts < MAX_ATTEMPTS:
                rec.next_attempt_at = now_utc + timedelta(minutes=15 * 2**rec.attempts)
            else:
                rec.status = ReminderStatus.failed
                stats["failed"] += 1
                _failure_alert(db, business.id, rec, v.debt.customer.name, v.debt.debt_number)
    return stats


def _failure_alert(db: Session, business_id, rec: ReminderHistory, customer_name: str, debt_number: str) -> None:
    what = "Credit notice" if is_notice(rec) else "Reminder"
    db.add(
        Notification(
            business_id=business_id,
            kind="reminder_failed",
            title=f"{what} not delivered",
            body=f"{what} to {customer_name} for {debt_number} failed: {rec.last_error}"[:500],
            entity_type="debt",
            entity_id=rec.debt_id,
        )
    )


def waiting_for_phone(db: Session, business: Business, now_utc: datetime) -> int:
    """SMS reminders that are due and waiting for the owner's phone to send them."""
    settings = db.get(BusinessSettings, business.id)
    if settings is None or settings.sms_sender != "phone":
        return 0
    return (
        db.scalar(
            select(func.count(ReminderHistory.id)).where(
                ReminderHistory.business_id == business.id,
                ReminderHistory.channel == ReminderChannel.sms,
                ReminderHistory.status == ReminderStatus.queued,
                ReminderHistory.next_attempt_at <= now_utc,
            )
        )
        or 0
    )


# --------------------------------------------------------------------------- SMS sent by the owner's phone


def claim_for_phone(
    db: Session, business: Business, now_utc: datetime, limit: int = 20
) -> list[tuple[ReminderHistory, Customer]]:
    """Hand due SMS reminders to the owner's phone to send from its own SIM.

    Applies the same rules as server sending (quiet hours, opt-out, weekly limit, current
    balance); credit notices are exempt from quiet hours and the weekly limit. Each SMS is
    leased to the phone for PHONE_LEASE; if the phone never reports back it is offered
    again, up to MAX_ATTEMPTS times.
    """
    settings = db.get(BusinessSettings, business.id)
    if settings is None or settings.sms_sender != "phone":
        return []
    local_hour = now_utc.astimezone(ZoneInfo(business.timezone)).hour
    quiet = in_quiet_hours(local_hour, settings.quiet_hours_start, settings.quiet_hours_end)
    today = now_utc.astimezone(ZoneInfo(business.timezone)).date()
    templates = _templates(db, business.id)
    stmt = select(ReminderHistory).where(
        ReminderHistory.business_id == business.id,
        ReminderHistory.channel == ReminderChannel.sms,
        ReminderHistory.status == ReminderStatus.queued,
        ReminderHistory.next_attempt_at <= now_utc,
    )
    if quiet:
        stmt = stmt.where(ReminderHistory.idempotency_key.like(f"{NOTICE_PREFIX}%"))
    due = db.scalars(stmt.order_by(ReminderHistory.created_at).limit(100).with_for_update(skip_locked=True)).all()
    claimed: list[tuple[ReminderHistory, Customer]] = []
    in_batch: dict[uuid.UUID, int] = {}
    for rec in due:
        if len(claimed) >= limit:
            break
        v = load_view(db, business.id, rec.debt_id, today)
        if rec.attempts >= MAX_ATTEMPTS:
            rec.status, rec.last_error = ReminderStatus.failed, "The phone did not confirm sending this SMS"
            if not rec.idempotency_key.startswith(MANUAL_PREFIX) and v is not None:
                _failure_alert(db, business.id, rec, v.debt.customer.name, v.debt.debt_number)
            continue
        if v is None or v.debt.flag != DebtFlag.none or v.figures.balance <= 0:
            rec.status, rec.last_error = ReminderStatus.skipped, "Debt no longer outstanding"
            continue
        if not v.debt.customer.sms_opt_in:
            rec.status, rec.last_error = ReminderStatus.skipped, "Customer opted out"
            continue
        if not is_notice(rec):
            sent_this_week = _weekly_count(db, business.id, rec.customer_id, now_utc) + in_batch.get(rec.customer_id, 0)
            if sent_this_week >= settings.max_reminders_per_customer_per_week:
                rec.status, rec.last_error = ReminderStatus.skipped, "Weekly reminder limit reached"
                continue
            amount = next((amt for tgt, amt in _targets(v) if tgt == rec.target_date), v.figures.balance)
            rec.message = _message(templates, business, v, rec.offset_days, rec.target_date, amount)
            in_batch[rec.customer_id] = in_batch.get(rec.customer_id, 0) + 1
        rec.attempts += 1
        rec.next_attempt_at = now_utc + PHONE_LEASE
        claimed.append((rec, v.debt.customer))
    return claimed


def record_phone_result(
    db: Session, business: Business, rec: ReminderHistory, sent: bool, error: str | None, now_utc: datetime
) -> ReminderHistory:
    """The phone reports whether it sent an SMS it collected. Safe to repeat."""
    if sent:
        if rec.status in (ReminderStatus.queued, ReminderStatus.failed):
            rec.status, rec.sent_at, rec.last_error = ReminderStatus.sent, now_utc, None
            rec.provider_message_id = "phone"
        return rec
    if rec.status != ReminderStatus.queued:
        return rec
    rec.last_error = (error or "The phone could not send the SMS")[:300]
    if rec.attempts < MAX_ATTEMPTS:
        rec.next_attempt_at = now_utc + timedelta(minutes=15 * 2**rec.attempts)
    else:
        rec.status = ReminderStatus.failed
        if not rec.idempotency_key.startswith(MANUAL_PREFIX):
            customer = db.get(Customer, rec.customer_id)
            debt = db.get(Debt, rec.debt_id)
            _failure_alert(db, business.id, rec, customer.name if customer else "", debt.debt_number if debt else "")
    return rec


def manual_reminder(
    db: Session, business: Business, customer_id: uuid.UUID, channel: ReminderChannel, now_utc: datetime
) -> tuple[ReminderHistory, Customer]:
    """A reminder a staff member sends now from their phone, by SMS or WhatsApp.

    Uses the business's own message wording and the customer's current balance. It counts
    towards the customer's weekly limit for automatic reminders.
    """
    customer = db.scalar(select(Customer).where(Customer.id == customer_id, Customer.business_id == business.id))
    if customer is None:
        raise NotFound("Customer not found")
    if not customer.sms_opt_in:
        raise BusinessRuleError(
            f"{customer.name} asked not to receive reminders. Turn on SMS reminders in their profile first.",
            code="opted_out",
        )
    today = now_utc.astimezone(ZoneInfo(business.timezone)).date()
    views = [
        v
        for v in load_views(db, business.id, today, Debt.customer_id == customer.id, Debt.flag == DebtFlag.none)
        if v.figures.balance > 0
    ]
    if not views:
        raise BusinessRuleError(f"{customer.name} has nothing outstanding", code="nothing_owed")
    targets = [(t, amt, v) for v in views for t, amt in _targets(v)]
    past = [x for x in targets if x[0] < today]
    overdue_total = sum((v.overdue_amount for v in views), Decimal(0))
    if past and overdue_total > 0:
        target, _, anchor = min(past, key=lambda x: x[0])
        amount = overdue_total
    else:
        target, _, anchor = min(targets, key=lambda x: x[0])
        amount = sum((amt for t, amt, _ in targets if t == target), Decimal(0))
    offset = (target - today).days
    message = render(
        _templates(db, business.id)[_template_kind(offset)],
        {
            "customer_name": customer.name.split(" ")[0] if offset >= 0 else customer.name,
            "business_name": business.name,
            "amount": f"{amount:,.2f}",
            "due_date": target.strftime("%d %b %Y"),
            "business_phone": business.phone or "",
        },
    )
    rec = ReminderHistory(
        business_id=business.id,
        debt_id=anchor.debt.id,
        customer_id=customer.id,
        channel=channel,
        target_date=target,
        offset_days=offset,
        idempotency_key=f"{MANUAL_PREFIX}{uuid.uuid4()}",
        message=message,
    )
    if channel == ReminderChannel.whatsapp:
        # WhatsApp opens with the message ready; the person taps send there.
        rec.status, rec.sent_at, rec.attempts, rec.provider_message_id = ReminderStatus.sent, now_utc, 1, "whatsapp"
    else:
        # The phone sends it right away and reports back; it is never retried automatically.
        rec.status, rec.attempts, rec.next_attempt_at = ReminderStatus.queued, MAX_ATTEMPTS, now_utc + PHONE_LEASE
    db.add(rec)
    db.flush()
    return rec, customer


def queue_credit_notice(db: Session, business: Business, debt: Debt, now_utc: datetime) -> ReminderHistory:
    """Queue the SMS telling a customer what they just took on credit and when to pay.

    It goes out like a reminder SMS (from the owner's phone or the SMS provider), at once and
    whatever the time of day. Customers who opted out of SMS get none. One per debt.
    """
    customer = debt.customer
    # Items are typed one per line in the app; the SMS lists them on one line with commas.
    lines = (" ".join(line.split()).rstrip(",;") for line in debt.description.splitlines())
    items = ", ".join(line for line in lines if line)
    if len(items) > NOTICE_ITEMS_MAX:
        items = items[: NOTICE_ITEMS_MAX - 1].rstrip(" ,;.") + "…"
    message = render(
        _templates(db, business.id)["credit_notice"],
        {
            "customer_name": customer.name.split(" ")[0],
            "business_name": business.name,
            "amount": f"{debt.principal:,.2f}",
            "items": items,
            "credit_date": debt.incurred_on.strftime("%d %b %Y"),
            "due_date": debt.due_date.strftime("%d %b %Y"),
            "business_phone": business.phone or "",
        },
    )
    today = now_utc.astimezone(ZoneInfo(business.timezone)).date()
    rec = ReminderHistory(
        business_id=business.id,
        debt_id=debt.id,
        customer_id=customer.id,
        channel=ReminderChannel.sms,
        target_date=debt.due_date,
        offset_days=(debt.due_date - today).days,
        idempotency_key=f"{NOTICE_PREFIX}{debt.id}",
        status=ReminderStatus.queued,
        message=message,
        next_attempt_at=now_utc,
    )
    if not customer.sms_opt_in:
        rec.status, rec.last_error, rec.next_attempt_at = ReminderStatus.skipped, "Customer opted out", None
    db.add(rec)
    db.flush()
    return rec


def _notify_staff(db: Session, business: Business, rec: ReminderHistory, v: DebtView) -> None:
    d = rec.offset_days
    when = (
        f"is due in {d} day{'s' if d != 1 else ''}"
        if d > 0
        else "is due today"
        if d == 0
        else f"is {-d} day{'s' if d != -1 else ''} overdue"
    )
    title = f"{v.debt.customer.name}: {v.debt.debt_number} {when}"
    body = f"Outstanding KSh {v.figures.balance:,.2f}."
    if rec.channel == ReminderChannel.in_app:
        db.add(
            Notification(
                business_id=business.id,
                kind="debt_due" if d >= 0 else "debt_overdue",
                title=title,
                body=body,
                entity_type="debt",
                entity_id=v.debt.id,
                dedupe_key=rec.idempotency_key,
            )
        )
    elif rec.channel == ReminderChannel.push:
        tokens = db.scalars(
            select(DeviceToken.token)
            .join(BusinessMembership, BusinessMembership.user_id == DeviceToken.user_id)
            .where(BusinessMembership.business_id == business.id, BusinessMembership.is_active.is_(True))
        ).all()
        push = get_push()
        for t in tokens:
            push.send(t, title, body)


def upcoming_installment_amount(v: DebtView) -> Decimal | None:
    nxt = next_installment_due(v.schedule, v.figures.paid) if v.schedule else None
    return nxt[1] if nxt else None
