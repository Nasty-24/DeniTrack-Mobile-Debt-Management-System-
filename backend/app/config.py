"""Environment-based configuration. Secrets come only from the environment."""

import re
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url

IntegrationMode = Literal["mock", "sandbox", "production"]

# Connection options libpq accepts. psycopg hands URL query options to libpq, which refuses
# any others, such as the connection_limit / pool_timeout some hosting platforms append.
LIBPQ_OPTIONS = frozenset(
    {
        "host", "hostaddr", "port", "dbname", "user", "password", "passfile", "require_auth",
        "channel_binding", "connect_timeout", "client_encoding", "options", "application_name",
        "fallback_application_name", "keepalives", "keepalives_idle", "keepalives_interval",
        "keepalives_count", "tcp_user_timeout", "replication", "gssencmode", "sslmode",
        "requiressl", "sslnegotiation", "sslcompression", "sslcert", "sslkey", "sslpassword",
        "sslcertmode", "sslrootcert", "sslcrl", "sslcrldir", "sslsni", "requirepeer",
        "ssl_min_protocol_version", "ssl_max_protocol_version", "krbsrvname", "gsslib",
        "gssdelegation", "service", "target_session_attrs", "load_balance_hosts",
    }
)  # fmt: skip

# .env.example ships values containing this marker; production refuses them.
PLACEHOLDER_MARKER = "change-me"


def normalize_database_url(url: str) -> str:
    """Accept the plain postgres:// or postgresql:// URLs hosting platforms provide.

    They name no driver (SQLAlchemy would look for psycopg2, which is not installed) and may
    carry pool options meant for other libraries. URLs that need neither fix are returned as is.
    """
    if not url.startswith(("postgres://", "postgresql://", "postgresql+")):
        return url
    parsed = make_url(url)
    changed = False
    if parsed.drivername in ("postgres", "postgresql"):
        parsed = parsed.set(drivername="postgresql+psycopg")
        changed = True
    kept = {key: value for key, value in parsed.query.items() if key in LIBPQ_OPTIONS}
    if len(kept) != len(parsed.query):
        parsed = parsed.set(query=kept)
        changed = True
    return parsed.render_as_string(hide_password=False) if changed else url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="DENITRACK_", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    database_url: str = "sqlite:///./denitrack-dev.db"
    # PostgreSQL role the API switches to after connecting. For platforms whose only database
    # user is a superuser, which ignores row-level security; migration 0005 creates the role.
    db_role: str = ""
    # Must be overridden in production; startup refuses the default there.
    jwt_secret: str = Field(default="dev-only-insecure-secret-change-me", min_length=16)
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    password_reset_minutes: int = 30
    cors_origins: list[str] = []
    login_rate_limit_per_minute: int = 5
    enable_rls: bool = True

    # SMS (Africa's Talking is the reference provider)
    sms_mode: IntegrationMode = "mock"
    sms_username: str = ""
    sms_api_key: str = ""
    sms_sender_id: str = ""

    # Push notifications (Firebase Cloud Messaging)
    push_mode: IntegrationMode = "mock"
    fcm_service_account_file: str = ""

    # M-Pesa (Safaricom Daraja)
    mpesa_mode: IntegrationMode = "mock"
    mpesa_consumer_key: str = ""
    mpesa_consumer_secret: str = ""
    mpesa_shortcode: str = ""
    mpesa_passkey: str = ""
    mpesa_callback_base_url: str = ""
    # Daraja callbacks are not signed; an unguessable path token is one layer of defence.
    mpesa_callback_token: str = "dev-callback-token"

    @field_validator("database_url")
    @classmethod
    def _normalize_database_url(cls, value: str) -> str:
        return normalize_database_url(value)

    @field_validator("db_role")
    @classmethod
    def _plain_role_name(cls, value: str) -> str:
        # Used in SET ROLE, so allow only a plain lower-case identifier.
        if value and not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", value):
            raise ValueError("DENITRACK_DB_ROLE must be a plain role name such as denitrack_app")
        return value

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def validate_for_production(self) -> None:
        if not self.is_production:
            return
        problems = []
        if self.jwt_secret.startswith("dev-only") or PLACEHOLDER_MARKER in self.jwt_secret:
            problems.append("DENITRACK_JWT_SECRET must be set to your own random value")
        if self.database_url.startswith("sqlite"):
            problems.append("DENITRACK_DATABASE_URL must point to PostgreSQL")
        elif PLACEHOLDER_MARKER in self.database_url:
            problems.append("DENITRACK_DATABASE_URL still uses the example database password")
        if self.mpesa_callback_token == "dev-callback-token" or PLACEHOLDER_MARKER in self.mpesa_callback_token:
            problems.append("DENITRACK_MPESA_CALLBACK_TOKEN must be set to your own random value")
        if problems:
            raise RuntimeError("Unsafe production configuration: " + "; ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()
