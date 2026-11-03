import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, get_auth
from app.config import get_settings
from app.db import get_db, set_tenant
from app.errors import Conflict, TooManyRequests, Unauthorized
from app.models import (
    Business,
    BusinessMembership,
    BusinessSettings,
    DeviceToken,
    PasswordResetToken,
    ReminderTemplate,
    Role,
    User,
    UserSession,
)
from app.schemas import (
    ChangePasswordIn,
    DeviceTokenIn,
    LoginIn,
    MembershipOut,
    PasswordResetConfirmIn,
    PasswordResetRequestIn,
    RefreshIn,
    RegisterIn,
    TokenOut,
    UserOut,
)
from app.security import (
    DUMMY_HASH,
    create_access_token,
    hash_password,
    new_opaque_token,
    rate_limiter,
    sha256,
    verify_password,
)
from app.services.common import audit, normalize_phone
from app.services.reminders import DEFAULT_TEMPLATES

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("denitrack.auth")


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _memberships(db: Session, user: User) -> list[MembershipOut]:
    rows = db.scalars(
        select(BusinessMembership).where(BusinessMembership.user_id == user.id, BusinessMembership.is_active.is_(True))
    ).all()
    return [MembershipOut(business_id=m.business_id, business_name=m.business.name, role=m.role) for m in rows]


def _issue_tokens(db: Session, user: User, request: Request) -> TokenOut:
    s = get_settings()
    refresh = new_opaque_token()
    session = UserSession(
        user_id=user.id,
        refresh_token_hash=sha256(refresh),
        expires_at=datetime.now(UTC) + timedelta(days=s.refresh_token_days),
        user_agent=(request.headers.get("user-agent") or "")[:200],
    )
    db.add(session)
    db.flush()
    return TokenOut(
        access_token=create_access_token(user.id, session.id),
        refresh_token=refresh,
        expires_in=s.access_token_minutes * 60,
        user=UserOut.model_validate(user),
        memberships=_memberships(db, user),
    )


@router.post("/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
def register(data: RegisterIn, request: Request, db: Session = Depends(get_db)):
    """Create an owner account together with their first business."""
    if not rate_limiter.hit(f"register:{_client_ip(request)}", 10, 3600):
        raise TooManyRequests("Too many sign-up attempts. Try again later.")
    email = data.email.lower()
    if db.scalar(select(User.id).where(func.lower(User.email) == email)):
        raise Conflict("An account with this email already exists", code="email_taken")
    phone = normalize_phone(data.phone) if data.phone else None
    user = User(email=email, full_name=data.full_name.strip(), phone=phone, password_hash=hash_password(data.password))
    business = Business(name=data.business_name.strip(), phone=phone, email=email)
    db.add_all([user, business])
    db.flush()
    set_tenant(db, business.id)
    db.add(BusinessMembership(business_id=business.id, user_id=user.id, role=Role.owner))
    db.add(BusinessSettings(business_id=business.id))
    for kind, body in DEFAULT_TEMPLATES.items():
        db.add(ReminderTemplate(business_id=business.id, kind=kind, body=body))
    audit(
        db,
        business_id=business.id,
        actor_id=user.id,
        action="business.created",
        entity_type="business",
        entity_id=business.id,
        after={"name": business.name},
        ip=_client_ip(request),
    )
    tokens = _issue_tokens(db, user, request)
    db.commit()
    return tokens


@router.post("/login", response_model=TokenOut)
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)):
    s = get_settings()
    email = data.email.lower()
    if not rate_limiter.hit(f"login:{_client_ip(request)}:{email}", s.login_rate_limit_per_minute):
        raise TooManyRequests("Too many sign-in attempts. Wait a minute and try again.")
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    # Always run one hash verification so response time does not reveal whether the email exists.
    ok = verify_password(data.password, user.password_hash if user else DUMMY_HASH)
    if not user or not ok or not user.is_active:
        log.info("failed login", extra={"ip": _client_ip(request)})
        raise Unauthorized("Email or password is incorrect", code="invalid_credentials")
    tokens = _issue_tokens(db, user, request)
    db.commit()
    return tokens


@router.post("/refresh", response_model=TokenOut)
def refresh(data: RefreshIn, request: Request, db: Session = Depends(get_db)):
    session = db.scalar(
        select(UserSession).where(UserSession.refresh_token_hash == sha256(data.refresh_token)).with_for_update()
    )
    now = datetime.now(UTC)
    if session is None:
        raise Unauthorized("Your session has ended. Please sign in again.")
    if session.revoked_at is not None:
        # A revoked refresh token being replayed suggests theft: end every session for this user.
        db.execute(
            update(UserSession)
            .where(UserSession.user_id == session.user_id, UserSession.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        db.commit()
        raise Unauthorized("Your session has ended. Please sign in again.")
    expires = session.expires_at if session.expires_at.tzinfo else session.expires_at.replace(tzinfo=UTC)
    user = db.get(User, session.user_id)
    if expires < now or user is None or not user.is_active:
        raise Unauthorized("Your session has ended. Please sign in again.")
    session.revoked_at = now  # rotation: each refresh token works once
    tokens = _issue_tokens(db, user, request)
    db.commit()
    return tokens


@router.post("/logout", status_code=204)
def logout(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    session = db.get(UserSession, auth.session_id)
    if session and session.revoked_at is None:
        session.revoked_at = datetime.now(UTC)
    db.commit()


@router.post("/logout-all", status_code=204)
def logout_all(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    db.execute(
        update(UserSession)
        .where(UserSession.user_id == auth.user.id, UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    db.commit()


@router.get("/me", response_model=UserOut)
def me(auth: AuthContext = Depends(get_auth)):
    return UserOut.model_validate(auth.user)


@router.get("/memberships", response_model=list[MembershipOut])
def memberships(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    return _memberships(db, auth.user)


@router.post("/change-password", status_code=204)
def change_password(data: ChangePasswordIn, auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    if not verify_password(data.current_password, auth.user.password_hash):
        raise Unauthorized("Current password is incorrect", code="invalid_credentials")
    auth.user.password_hash = hash_password(data.new_password)
    auth.user.must_change_password = False
    # Sign out every other device.
    db.execute(
        update(UserSession)
        .where(UserSession.user_id == auth.user.id, UserSession.id != auth.session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    db.commit()


@router.post("/password-reset/request", status_code=202)
def request_password_reset(data: PasswordResetRequestIn, request: Request, db: Session = Depends(get_db)):
    """Always returns 202 so the response never reveals whether an account exists."""
    if not rate_limiter.hit(f"reset:{_client_ip(request)}", 5, 3600):
        raise TooManyRequests("Too many reset requests. Try again later.")
    user = db.scalar(select(User).where(func.lower(User.email) == data.email.lower()))
    if user and user.is_active:
        token = new_opaque_token()
        db.add(
            PasswordResetToken(
                user_id=user.id,
                token_hash=sha256(token),
                expires_at=datetime.now(UTC) + timedelta(minutes=get_settings().password_reset_minutes),
            )
        )
        db.commit()
        from app.integrations.messaging import send_password_reset

        send_password_reset(user, token)
    return {"detail": "If that account exists, a reset code has been sent."}


@router.post("/password-reset/confirm", status_code=204)
def confirm_password_reset(data: PasswordResetConfirmIn, db: Session = Depends(get_db)):
    rec = db.scalar(select(PasswordResetToken).where(PasswordResetToken.token_hash == sha256(data.token)))
    now = datetime.now(UTC)
    if rec is None or rec.used_at is not None:
        raise Unauthorized("This reset code is invalid or has already been used", code="invalid_reset_token")
    expires = rec.expires_at if rec.expires_at.tzinfo else rec.expires_at.replace(tzinfo=UTC)
    if expires < now:
        raise Unauthorized("This reset code has expired", code="invalid_reset_token")
    user = db.get(User, rec.user_id)
    if user is None or not user.is_active:
        raise Unauthorized("This reset code is invalid or has already been used", code="invalid_reset_token")
    user.password_hash = hash_password(data.new_password)
    user.must_change_password = False
    rec.used_at = now
    db.execute(
        update(UserSession)
        .where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    db.commit()


@router.post("/device-tokens", status_code=204)
def register_device(data: DeviceTokenIn, auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    existing = db.scalar(select(DeviceToken).where(DeviceToken.token == data.token))
    if existing:
        existing.user_id = auth.user.id
    else:
        db.add(DeviceToken(user_id=auth.user.id, token=data.token, platform=data.platform))
    db.commit()
