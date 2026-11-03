"""Authentication and tenant-scoping dependencies.

The business id in the URL is never trusted on its own: it is accepted only if the
authenticated user holds an active membership in that business.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

import jwt
from fastapi import Depends, Header, Path, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db, set_tenant
from app.errors import Forbidden, NotFound, Unauthorized
from app.models import (
    Business,
    BusinessMembership,
    BusinessSettings,
    Role,
    User,
    UserSession,
)
from app.security import decode_access_token

bearer = HTTPBearer(auto_error=False)


@dataclass
class AuthContext:
    user: User
    session_id: uuid.UUID


def get_auth(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> AuthContext:
    if creds is None or creds.scheme.lower() != "bearer":
        raise Unauthorized("Sign in required")
    try:
        payload = decode_access_token(creds.credentials)
        user_id = uuid.UUID(payload["sub"])
        session_id = uuid.UUID(payload["sid"])
    except (jwt.PyJWTError, ValueError, KeyError):
        raise Unauthorized("Your session is invalid or has expired") from None
    session = db.get(UserSession, session_id)
    now = datetime.now(UTC)
    if (
        session is None
        or session.user_id != user_id
        or session.revoked_at is not None
        or _aware(session.expires_at) < now
    ):
        raise Unauthorized("Your session has ended. Please sign in again.")
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise Unauthorized("Account disabled")
    return AuthContext(user=user, session_id=session_id)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


@dataclass
class Tenant:
    business: Business
    user: User
    role: Role
    settings: BusinessSettings
    ip: str | None

    @property
    def business_id(self) -> uuid.UUID:
        return self.business.id

    @property
    def is_manager(self) -> bool:
        return self.role in (Role.owner, Role.admin)


def get_tenant(
    request: Request,
    business_id: uuid.UUID = Path(...),
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
) -> Tenant:
    membership = db.scalar(
        select(BusinessMembership).where(
            BusinessMembership.business_id == business_id,
            BusinessMembership.user_id == auth.user.id,
            BusinessMembership.is_active.is_(True),
        )
    )
    if membership is None:
        # 404 rather than 403 so business ids cannot be probed.
        raise NotFound("Business not found")
    set_tenant(db, business_id)
    settings = db.get(BusinessSettings, business_id)
    if settings is None:  # pragma: no cover - created with the business
        settings = BusinessSettings(business_id=business_id)
        db.add(settings)
        db.flush()
    return Tenant(
        business=membership.business,
        user=auth.user,
        role=membership.role,
        settings=settings,
        ip=request.client.host if request.client else None,
    )


def require_roles(*roles: Role):
    def _check(tenant: Tenant = Depends(get_tenant)) -> Tenant:
        if tenant.role not in roles:
            raise Forbidden("You do not have permission to perform this action")
        return tenant

    return _check


manager_only = require_roles(Role.owner, Role.admin)
owner_only = require_roles(Role.owner)


def idempotency_key(
    key: str | None = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=100),
) -> str | None:
    return key


def require_idempotency_key(
    key: str | None = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=100),
) -> str:
    if not key:
        from app.errors import AppError

        raise AppError(
            "An Idempotency-Key header is required for financial operations",
            code="idempotency_key_required",
        )
    return key
