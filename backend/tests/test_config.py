"""Settings: database URLs from hosting platforms, and refusing unsafe production values."""

import pytest

from app.config import Settings
from app.db import make_engine


def settings(**values) -> Settings:
    return Settings(_env_file=None, **values)


REAL = {
    "environment": "production",
    "database_url": "postgresql+psycopg://denitrack_app:Xq7vR2mP9sLk4tWz@db:5432/denitrack",
    "jwt_secret": "u8Jx2kQe9VmN3pLr7TcY5wHa1ZsDf6Gb",
    "mpesa_callback_token": "Lp4Rt8Vw2Xn6Kq9Mz3Bc7Hd1Jf5Gs0Ya",
}


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        # Platform-style URL: no driver, plus pool options that libpq would reject.
        (
            "postgresql://primecloud_app:s3cr%40t@denitrack-db.internal:5432/appdb?connection_limit=10&pool_timeout=20",
            "postgresql+psycopg://primecloud_app:s3cr%40t@denitrack-db.internal:5432/appdb",
        ),
        (
            "postgres://u:p@db.internal/appdb?sslmode=require&connection_limit=5",
            "postgresql+psycopg://u:p@db.internal/appdb?sslmode=require",
        ),
        # Already in our format: left exactly as given.
        (
            "postgresql+psycopg://u:p@db/denitrack?sslmode=require",
            "postgresql+psycopg://u:p@db/denitrack?sslmode=require",
        ),
        ("sqlite:///./denitrack-dev.db", "sqlite:///./denitrack-dev.db"),
    ],
)
def test_database_url_from_hosting_platform_is_accepted(given, expected):
    assert settings(database_url=given).database_url == expected


def test_normalized_platform_url_uses_installed_driver():
    url = settings(database_url="postgresql://u:p@db.internal:5432/appdb?pool_timeout=20").database_url
    engine = make_engine(url)  # does not connect
    assert engine.dialect.driver == "psycopg"
    assert "pool_timeout" not in engine.url.query


def test_production_accepts_real_values():
    settings(**REAL).validate_for_production()


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("jwt_secret", "change-me-to-a-long-random-string", "DENITRACK_JWT_SECRET"),
        ("jwt_secret", "dev-only-insecure-secret-change-me", "DENITRACK_JWT_SECRET"),
        ("mpesa_callback_token", "change-me-random-callback-token", "DENITRACK_MPESA_CALLBACK_TOKEN"),
        ("mpesa_callback_token", "dev-callback-token", "DENITRACK_MPESA_CALLBACK_TOKEN"),
        (
            "database_url",
            "postgresql+psycopg://denitrack_app:change-me-app-password@db:5432/denitrack",
            "DENITRACK_DATABASE_URL",
        ),
        ("database_url", "sqlite:///./denitrack-dev.db", "DENITRACK_DATABASE_URL"),
    ],
)
def test_production_refuses_example_and_default_values(field, value, message):
    with pytest.raises(RuntimeError, match=message):
        settings(**{**REAL, field: value}).validate_for_production()


def test_development_allows_defaults():
    settings(environment="development").validate_for_production()


@pytest.mark.parametrize("role", ["", "denitrack_app", "app_role2"])
def test_database_role_accepts_plain_role_names(role):
    assert settings(db_role=role).db_role == role


@pytest.mark.parametrize("role", ["denitrack_app; DROP TABLE users", 'x"y', "Denitrack", "1role", "a" * 64])
def test_database_role_refuses_anything_but_a_plain_role_name(role):
    with pytest.raises(ValueError, match="DENITRACK_DB_ROLE"):
        settings(db_role=role)
