"""Environment-based configuration. Secrets come only from the environment."""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

IntegrationMode = Literal["mock", "sandbox", "production"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="DENITRACK_", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    database_url: str = "sqlite:///./denitrack-dev.db"
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

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def validate_for_production(self) -> None:
        if not self.is_production:
            return
        problems = []
        if self.jwt_secret.startswith("dev-only"):
            problems.append("DENITRACK_JWT_SECRET must be set")
        if self.database_url.startswith("sqlite"):
            problems.append("DENITRACK_DATABASE_URL must point to PostgreSQL")
        if self.mpesa_callback_token == "dev-callback-token":
            problems.append("DENITRACK_MPESA_CALLBACK_TOKEN must be set")
        if problems:
            raise RuntimeError("Unsafe production configuration: " + "; ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()
