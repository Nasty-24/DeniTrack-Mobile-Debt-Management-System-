"""M-Pesa "you have received" SMS read on the owner's phone, applied to the right customer.

The phone reads messages from the sender M-PESA and sends them here. Each one is parsed,
de-duplicated by its transaction code, and matched to a customer by phone number AND name:

- Only a match on both (and a single best customer) is recorded automatically, as a
  verified M-Pesa payment allocated oldest-debt-first, with a receipt.
- If staff already typed in that M-Pesa code, the SMS confirms that payment instead of
  recording it twice.
- Anything else (unknown payer, number without name, overpayment) is kept for an owner to
  match by hand. Money that arrived is never dropped and never guessed onto an account.

Safaricom hides part of the payer's number (e.g. 0722***712) and sends only two names,
so masked numbers are matched on the digits that are shown.
"""

import re
import uuid
from collections.abc import Mapping
from collections.abc import Set as AbstractSet
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import Tenant
from app.errors import AppError, BusinessRuleError, NotFound
from app.models import (
    Customer,
    CustomerMpesaName,
    CustomerStatus,
    MpesaSmsMessage,
    MpesaSmsStatus,
    Notification,
    Payment,
    PaymentMethod,
    PaymentStatus,
    VerificationStatus,
)
from app.schemas import PaymentCreate
from app.services.common import audit, utcnow
from app.services.payments import record_payment, verify_payment

MPESA_SENDERS = {"MPESA", "M-PESA"}
UNKNOWN_PAYER = "UNKNOWN"  # the message showed a number but no name

_AMOUNT = r"Ksh\s?(?P<amount>\d[\d,]*(?:\.\d{1,2})?)"
# Where the payer's details end: the date, "via ...", the end of a sentence, or "New ... balance".
_PARTY_END = r"(?=\s+on\s+\d{1,2}/\d{1,2}/\d{2,4}|\s+via\s|\.\s|\.?\s*$|\s+New\s)"
_RECEIVED = [
    # "You have received Ksh500.00 from JOHN MWANGI 0722***712 on 24/3/26 at 10:32 AM"
    re.compile(r"received\s+" + _AMOUNT + r"\s+from\s+(?P<party>.+?)" + _PARTY_END, re.I | re.S),
    # "Ksh500.00 received from 2547******123 JOHN DOE. New Account balance ..."
    re.compile(_AMOUNT + r"\s+(?:has\s+been\s+)?received\s+from\s+(?P<party>.+?)" + _PARTY_END, re.I | re.S),
]
_NOT_A_RECEIPT = re.compile(r"has been reversed|reversal|sent to|paid to|withdrawn|you bought", re.I)
_CODE_FIRST = re.compile(r"^\s*([A-Z0-9]{10})\b")
_CODE_REF = re.compile(r"(?i:\bref(?:erence)?)[:.]?\s*([A-Z0-9]{10})\b")
_CODE_ANY = re.compile(r"\b([A-Z0-9]{10})\b")
_PHONE = re.compile(r"\+?\d[\d*xX•]{5,14}\d")
_BALANCE = re.compile(r"(balance\s+is\s*:?\s*)Ksh\s?[\d,]+(?:\.\d{1,2})?", re.I)


@dataclass(frozen=True)
class ParsedSms:
    code: str
    amount: Decimal
    payer_name: str
    payer_phone: str | None


def _is_code(s: str) -> bool:
    return any(ch.isalpha() for ch in s) and any(ch.isdigit() for ch in s)


def _transaction_code(text: str) -> str | None:
    for rx in (_CODE_FIRST, _CODE_REF):
        m = rx.search(text)
        if m and _is_code(m.group(1)):
            return m.group(1)
    return next((m.group(1) for m in _CODE_ANY.finditer(text) if _is_code(m.group(1))), None)


def parse_mpesa_sms(text: str) -> ParsedSms | None:
    """Parse an M-Pesa money-received SMS. Returns None for anything else."""
    flat = " ".join(text.split())
    if _NOT_A_RECEIPT.search(flat):
        return None
    m = next((m for rx in _RECEIVED if (m := rx.search(flat))), None)
    if m is None:
        return None
    code = _transaction_code(flat)
    if code is None:
        return None
    try:
        amount = Decimal(m.group("amount").replace(",", "")).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None
    if amount <= 0:
        return None
    party = m.group("party").strip(" .,")
    pm = _PHONE.search(party)
    phone = pm.group(0) if pm else None
    name_part = party.replace(phone, " ") if phone else party
    name = " ".join(re.sub(r"[^A-Za-z' -]", " ", name_part).split()).upper()
    if not name and not phone:
        return None
    return ParsedSms(code, amount, (name or UNKNOWN_PAYER)[:160], phone)


def redact_balance(text: str) -> str:
    """The owner's own M-Pesa balance is none of the server's business."""
    return _BALANCE.sub(r"\1Ksh ***", text)


# --------------------------------------------------------------------------- matching


def phone_pattern(shown: str) -> str | None:
    """International digits with '*' for hidden ones: '0722***712' -> '254722***712'."""
    s = re.sub(r"[\s-]", "", shown).lstrip("+")
    s = re.sub(r"[xX•]", "*", s)
    if s.startswith("0"):
        s = "254" + s[1:]
    elif len(s) == 9 and s[0] in "17":
        s = "254" + s
    return s if re.fullmatch(r"[\d*]{9,15}", s) else None


def phone_matches(pattern: str, e164: str) -> bool:
    digits = e164.lstrip("+")
    if "*" not in pattern:
        return digits == pattern
    head, tail = pattern[: pattern.index("*")], pattern[pattern.rindex("*") + 1 :]
    # Masks do not always use one '*' per hidden digit, so match the shown digits only.
    return (
        len(head) + len(tail) >= 6
        and len(head) + len(tail) < len(digits)
        and (digits.startswith(head) and digits.endswith(tail))
    )


def learned_names(db: Session, business_id: uuid.UUID) -> dict[uuid.UUID, set[str]]:
    """Customer id -> the M-Pesa names learned for that customer."""
    out: dict[uuid.UUID, set[str]] = {}
    rows = db.execute(
        select(CustomerMpesaName.customer_id, CustomerMpesaName.name).where(
            CustomerMpesaName.business_id == business_id
        )
    )
    for customer_id, name in rows:
        out.setdefault(customer_id, set()).add(name)
    return out


def _name_tokens(name: str) -> set[str]:
    return {w.replace("'", "") for w in re.findall(r"[A-Za-z']+", name.upper()) if len(w) >= 2}


def name_score(sms_name: str, customer_name: str) -> int:
    """How many of the M-Pesa names appear in the customer's name."""
    return len(_name_tokens(sms_name) & _name_tokens(customer_name))


def _full_name_match(sms_name: str, customer_name: str) -> bool:
    tokens = _name_tokens(sms_name)
    return len(tokens) >= 2 and tokens <= _name_tokens(customer_name)


@dataclass
class Match:
    customer: Customer | None
    suggestion: Customer | None = None
    reason: str = ""


def match_customer(
    parsed: ParsedSms,
    customers: list[Customer],
    learned: Mapping[uuid.UUID, AbstractSet[str]] | None = None,
) -> Match:
    """Only a phone-number match is ever applied automatically. A learned M-Pesa name counts as
    the customer's name; without a matching number it can only suggest the customer."""
    learned = learned or {}
    payer = parsed.payer_name
    # A learned name counts as a full-name match: it beats a partial match, but ties with a
    # customer whose own name is the M-Pesa name, so that payment waits for a person.
    full_match = len(_name_tokens(payer))

    def score(c: Customer) -> int:
        return full_match if payer in learned.get(c.id, ()) else name_score(payer, c.name)

    pattern = phone_pattern(parsed.payer_phone) if parsed.payer_phone else None
    by_phone = [c for c in customers if pattern and phone_matches(pattern, c.phone)]
    both = sorted(((s, c) for c in by_phone if (s := score(c)) > 0), key=lambda t: -t[0])
    if len(both) == 1 or (len(both) > 1 and both[0][0] > both[1][0]):
        return Match(both[0][1])
    if both:
        return Match(None, None, f"{len(both)} customers match this number and name. Choose the right one.")
    if len(by_phone) == 1:
        c = by_phone[0]
        return Match(None, c, f"The number matches {c.name}, but the M-Pesa name {payer} does not.")
    if by_phone:
        return Match(None, None, f"{len(by_phone)} customers match this number, but none by name.")
    # No number (e.g. Pochi la Biashara), or a number no customer has.
    paid_before = [c for c in customers if payer in learned.get(c.id, ())]
    if len(paid_before) == 1:
        c = paid_before[0]
        why = (
            "No phone number in this payment (for example Pochi la Biashara)."
            if parsed.payer_phone is None
            else "This number isn't saved for any customer."
        )
        return Match(None, c, f"{why} {payer} has paid for {c.name} before.")
    if paid_before:
        return Match(
            None, None, f"{len(paid_before)} customers have paid under the M-Pesa name {payer}. Choose the right one."
        )
    named = [c for c in customers if _full_name_match(parsed.payer_name, c.name)]
    if len(named) == 1:
        return Match(None, named[0], f"No customer has this number. {named[0].name} has the same name.")
    return Match(None, None, "No customer matches this phone number and name.")


# --------------------------------------------------------------------------- processing


@dataclass
class SmsOutcome:
    status: str  # an MpesaSmsStatus value, or "ignored" / "duplicate"
    code: str | None = None
    amount: Decimal | None = None
    customer_name: str | None = None
    detail: str | None = None


def _payer(rec: MpesaSmsMessage) -> str:
    return f"{rec.payer_name} {rec.payer_phone}" if rec.payer_phone else rec.payer_name


def _apply(db: Session, tenant: Tenant, rec: MpesaSmsMessage, customer: Customer) -> Payment:
    return record_payment(
        db,
        tenant,
        PaymentCreate(
            customer_id=customer.id,
            amount=rec.amount,
            method=PaymentMethod.mpesa,
            paid_at=rec.received_at,
            external_reference=rec.transaction_code,
            notes=f"M-Pesa from {_payer(rec)} (read from SMS)"[:500],
        ),
        verification=VerificationStatus.verified,
    )


def _decide(
    db: Session,
    tenant: Tenant,
    rec: MpesaSmsMessage,
    parsed: ParsedSms,
    customers: list[Customer],
    learned: Mapping[uuid.UUID, AbstractSet[str]] | None,
) -> None:
    entered = db.scalar(
        select(Payment).where(
            Payment.business_id == tenant.business_id,
            Payment.method == PaymentMethod.mpesa,
            Payment.external_reference == rec.transaction_code,
            Payment.status == PaymentStatus.posted,
        )
    )
    if entered is not None:
        rec.customer_id = entered.customer_id
        name = entered.customer.name
        if entered.verification_status == VerificationStatus.pending and entered.amount == rec.amount:
            verify_payment(db, tenant, entered.id, True, f"Confirmed by M-Pesa SMS {rec.transaction_code}")
            rec.status, rec.payment_id = MpesaSmsStatus.confirmed, entered.id
            rec.detail = f"Confirmed the payment already entered for {name}."
        elif entered.verification_status == VerificationStatus.pending:
            rec.status, rec.suggested_customer_id = MpesaSmsStatus.needs_review, entered.customer_id
            rec.detail = (
                f"This code was entered for {name} as KSh {entered.amount:,.2f}, but M-Pesa says KSh {rec.amount:,.2f}."
            )
        elif entered.verification_status == VerificationStatus.rejected:
            rec.status, rec.suggested_customer_id = MpesaSmsStatus.needs_review, entered.customer_id
            rec.detail = f"A payment with this code for {name} was rejected earlier, but M-Pesa shows it was received."
        else:
            rec.status, rec.payment_id = MpesaSmsStatus.already_recorded, entered.id
            rec.detail = f"Already recorded for {name}."
        return

    match = match_customer(parsed, customers, learned)
    if match.customer is None:
        rec.status = MpesaSmsStatus.needs_review
        rec.suggested_customer_id = match.suggestion.id if match.suggestion else None
        rec.detail = match.reason[:300]  # names can be long; the column holds 300
        return
    try:
        with db.begin_nested():
            payment = _apply(db, tenant, rec, match.customer)
    except AppError as e:
        rec.status, rec.suggested_customer_id = MpesaSmsStatus.needs_review, match.customer.id
        rec.detail = f"Matched {match.customer.name}, but it could not be applied: {e.message}"[:300]
        return
    rec.status, rec.customer_id, rec.payment_id = MpesaSmsStatus.applied, match.customer.id, payment.id
    rec.detail = f"Matched {match.customer.name} by phone number and name."


def _notify(db: Session, rec: MpesaSmsMessage, customer_name: str | None) -> None:
    amount = f"KSh {rec.amount:,.2f}"
    if rec.status == MpesaSmsStatus.applied:
        title, kind = "M-Pesa payment recorded", "mpesa_payment"
        body = f"{amount} from {_payer(rec)} ({rec.transaction_code}) was recorded for {customer_name}."
        entity = ("payment", rec.payment_id)
    elif rec.status == MpesaSmsStatus.confirmed:
        title, kind = "M-Pesa payment confirmed", "mpesa_payment"
        body = f"{amount} ({rec.transaction_code}) for {customer_name} is confirmed by the M-Pesa SMS."
        entity = ("payment", rec.payment_id)
    elif rec.status == MpesaSmsStatus.needs_review:
        title, kind = "M-Pesa payment needs matching", "payment_review"
        body = f"{amount} from {_payer(rec)} ({rec.transaction_code}). {rec.detail}"
        entity = ("mpesa_sms", rec.id)
    else:
        return
    db.add(
        Notification(
            business_id=rec.business_id,
            kind=kind,
            title=title,
            body=body[:500],
            entity_type=entity[0],
            entity_id=entity[1],
        )
    )


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def process_message(
    db: Session,
    tenant: Tenant,
    sender: str,
    body: str,
    received_at: datetime,
    customers: list[Customer],
    learned: Mapping[uuid.UUID, AbstractSet[str]] | None = None,
) -> SmsOutcome:
    if sender.strip().upper() not in MPESA_SENDERS:
        return SmsOutcome("ignored", detail="Not sent by M-PESA.")
    parsed = parse_mpesa_sms(body)
    if parsed is None:
        return SmsOutcome("ignored", detail="Not an M-Pesa payment received.")
    existing = db.scalar(
        select(MpesaSmsMessage).where(
            MpesaSmsMessage.business_id == tenant.business_id,
            MpesaSmsMessage.transaction_code == parsed.code,
        )
    )
    if existing is not None:
        return SmsOutcome("duplicate", parsed.code, parsed.amount, detail="Already processed.")

    rec = MpesaSmsMessage(
        id=uuid.uuid4(),
        business_id=tenant.business_id,
        transaction_code=parsed.code,
        amount=parsed.amount,
        payer_name=parsed.payer_name,
        payer_phone=parsed.payer_phone,
        received_at=min(_aware(received_at), utcnow()),
        status=MpesaSmsStatus.needs_review,
        message_text=redact_balance(" ".join(body.split()))[:1000],
        submitted_by=tenant.user.id,
    )
    try:
        with db.begin_nested():
            _decide(db, tenant, rec, parsed, customers, learned)
            db.add(rec)
            db.flush()
    except IntegrityError:
        # The same SMS arrived twice at the same moment (two phones, or a retry); one wins.
        return SmsOutcome("duplicate", parsed.code, parsed.amount, detail="Already processed.")
    customer = db.get(Customer, rec.customer_id) if rec.customer_id else None
    _notify(db, rec, customer.name if customer else None)
    return SmsOutcome(
        rec.status.value, rec.transaction_code, rec.amount, customer.name if customer else None, rec.detail
    )


def process_batch(db: Session, tenant: Tenant, messages: list[tuple[str, str, datetime]]) -> list[SmsOutcome]:
    customers = list(
        db.scalars(
            select(Customer).where(Customer.business_id == tenant.business_id, Customer.status == CustomerStatus.active)
        )
    )
    learned = learned_names(db, tenant.business_id)
    return [process_message(db, tenant, s, b, r, customers, learned) for s, b, r in messages]


# --------------------------------------------------------------------------- review


def get_message(db: Session, business_id: uuid.UUID, message_id: uuid.UUID) -> MpesaSmsMessage:
    rec = db.scalar(
        select(MpesaSmsMessage)
        .where(MpesaSmsMessage.id == message_id, MpesaSmsMessage.business_id == business_id)
        .with_for_update()
    )
    if rec is None:
        raise NotFound("M-Pesa message not found")
    return rec


def assign(db: Session, tenant: Tenant, message_id: uuid.UUID, customer_id: uuid.UUID) -> MpesaSmsMessage:
    rec = get_message(db, tenant.business_id, message_id)
    if rec.status != MpesaSmsStatus.needs_review:
        raise BusinessRuleError("This M-Pesa payment has already been handled", code="already_handled")
    customer = db.scalar(select(Customer).where(Customer.id == customer_id, Customer.business_id == tenant.business_id))
    if customer is None:
        raise NotFound("Customer not found")
    payment = _apply(db, tenant, rec, customer)
    rec.status, rec.customer_id, rec.payment_id = MpesaSmsStatus.applied, customer.id, payment.id
    rec.resolved_by, rec.resolved_at = tenant.user.id, utcnow()
    rec.detail = f"Matched to {customer.name} by {tenant.user.full_name}."[:300]
    learned = learn_name(db, tenant, customer, rec)
    after = {"code": rec.transaction_code, "customer": customer.customer_number, "payment": str(payment.id)}
    if learned:
        after["learned_name"] = learned
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="mpesa_sms.assigned",
        entity_type="mpesa_sms",
        entity_id=rec.id,
        after=after,
        ip=tenant.ip,
    )
    return rec


def learn_name(db: Session, tenant: Tenant, customer: Customer, rec: MpesaSmsMessage) -> str | None:
    """Remember the M-Pesa name on a payment staff matched to `customer` by hand.

    Returns the name when it is new for this customer, otherwise None."""
    name = rec.payer_name
    if name == UNKNOWN_PAYER:
        return None
    known = db.scalar(
        select(CustomerMpesaName.id).where(
            CustomerMpesaName.business_id == tenant.business_id,
            CustomerMpesaName.customer_id == customer.id,
            CustomerMpesaName.name == name,
        )
    )
    if known is not None:
        return None
    try:
        with db.begin_nested():
            db.add(
                CustomerMpesaName(
                    business_id=tenant.business_id,
                    customer_id=customer.id,
                    name=name,
                    source_message_id=rec.id,
                    created_by=tenant.user.id,
                )
            )
    except IntegrityError:  # learned at the same moment by another request
        return None
    return name


def dismiss(db: Session, tenant: Tenant, message_id: uuid.UUID, reason: str | None) -> MpesaSmsMessage:
    rec = get_message(db, tenant.business_id, message_id)
    if rec.status != MpesaSmsStatus.needs_review:
        raise BusinessRuleError("This M-Pesa payment has already been handled", code="already_handled")
    rec.status = MpesaSmsStatus.dismissed
    rec.resolved_by, rec.resolved_at = tenant.user.id, utcnow()
    rec.detail = (reason or "Not a debt repayment.")[:300]
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="mpesa_sms.dismissed",
        entity_type="mpesa_sms",
        entity_id=rec.id,
        after={"code": rec.transaction_code},
        reason=reason,
        ip=tenant.ip,
    )
    return rec
