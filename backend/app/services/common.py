"""Shared helpers: audit logging, numbering, phone normalisation, idempotency, time."""

import hashlib
import json
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import Enum
from zoneinfo import ZoneInfo

import phonenumbers
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import BusinessRuleError, Conflict
from app.models import AuditLog, Business, Counter, IdempotencyRecord


def _jsonable(value):
    if isinstance(value, (Decimal,)):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def snapshot(obj, fields: list[str]) -> dict:
    return {f: _jsonable(getattr(obj, f)) for f in fields}


def audit(
    db: Session,
    *,
    business_id: uuid.UUID,
    actor_id: uuid.UUID | None,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | None,
    before: dict | None = None,
    after: dict | None = None,
    reason: str | None = None,
    ip: str | None = None,
) -> None:
    db.add(
        AuditLog(
            business_id=business_id,
            actor_user_id=actor_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            before=_jsonable(before) if before else None,
            after=_jsonable(after) if after else None,
            reason=reason,
            ip_address=ip,
        )
    )


def next_number(db: Session, business_id: uuid.UUID, name: str) -> int:
    """Gapless per-business counter. The UPDATE takes a row lock in PostgreSQL, so
    concurrent transactions serialise here and never get the same number."""
    result = db.execute(
        update(Counter)
        .where(Counter.business_id == business_id, Counter.name == name)
        .values(value=Counter.value + 1)
        .returning(Counter.value)
    ).scalar_one_or_none()
    if result is not None:
        return result
    try:
        with db.begin_nested():
            db.add(Counter(business_id=business_id, name=name, value=1))
        return 1
    except IntegrityError:  # another transaction created it first
        return next_number(db, business_id, name)


def normalize_phone(raw: str) -> str:
    """Return E.164. Accepts 0712..., 712..., 254712..., +254712..., and foreign +numbers."""
    cleaned = raw.strip()
    try:
        parsed = phonenumbers.parse(cleaned, "KE")
    except phonenumbers.NumberParseException:
        raise BusinessRuleError("Enter a valid phone number, e.g. 0712 345 678", code="invalid_phone") from None
    if not phonenumbers.is_valid_number(parsed):
        raise BusinessRuleError("Enter a valid phone number, e.g. 0712 345 678", code="invalid_phone")
    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)


def normalize_name(name: str) -> str:
    return " ".join(name.lower().split())


def business_today(business: Business) -> date:
    return datetime.now(ZoneInfo(business.timezone)).date()


def utcnow() -> datetime:
    return datetime.now(UTC)


def request_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(_jsonable(payload), sort_keys=True).encode()).hexdigest()


def find_idempotent_response(
    db: Session, business_id: uuid.UUID, user_id: uuid.UUID, key: str, req_hash: str
) -> IdempotencyRecord | None:
    rec = db.scalar(
        select(IdempotencyRecord).where(
            IdempotencyRecord.business_id == business_id,
            IdempotencyRecord.user_id == user_id,
            IdempotencyRecord.key == key,
        )
    )
    if rec and rec.request_hash != req_hash:
        raise Conflict(
            "This Idempotency-Key was already used for a different request",
            code="idempotency_key_reused",
        )
    return rec


def store_idempotent_response(
    db: Session,
    business_id: uuid.UUID,
    user_id: uuid.UUID,
    key: str,
    req_hash: str,
    status: int,
    body: dict,
) -> None:
    db.add(
        IdempotencyRecord(
            business_id=business_id,
            user_id=user_id,
            key=key,
            request_hash=req_hash,
            response_status=status,
            response_body=_jsonable(body),
        )
    )
