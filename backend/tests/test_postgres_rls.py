"""Verifies the Alembic migrations and PostgreSQL row-level security.

Skipped unless DENITRACK_PG_ADMIN_URL points at a PostgreSQL superuser connection to a
scratch database, e.g.  postgresql+psycopg://postgres@127.0.0.1:5432/dt_migrate
The database's public schema is dropped and rebuilt by this test.
"""

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

ADMIN_URL = os.environ.get("DENITRACK_PG_ADMIN_URL")
pytestmark = pytest.mark.skipif(not ADMIN_URL, reason="DENITRACK_PG_ADMIN_URL not set")
BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def migrated():
    admin = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
        c.execute(
            text(
                "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dt_app') "
                "THEN CREATE ROLE dt_app LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;"
            )
        )
    env = os.environ | {"DENITRACK_DATABASE_URL": ADMIN_URL}
    for args in (["upgrade", "head"], ["downgrade", "base"], ["upgrade", "head"], ["check"]):
        r = subprocess.run(
            [sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=env, capture_output=True, text=True
        )
        assert r.returncode == 0, r.stderr
    with admin.connect() as c:
        c.execute(
            text(
                "GRANT USAGE ON SCHEMA public TO dt_app; "
                "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dt_app;"
            )
        )
    ids = {"a": uuid.uuid4(), "b": uuid.uuid4(), "u": uuid.uuid4()}
    with admin.begin() as c:
        c.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        c.execute(
            text(
                "INSERT INTO users (id, email, full_name, password_hash, is_active, must_change_password, "
                "created_at, updated_at) VALUES (:u, 'x@example.com', 'X', 'h', true, false, now(), now())"
            ),
            ids,
        )
        for key in ("a", "b"):
            c.execute(
                text(
                    "INSERT INTO businesses (id, name, currency, timezone, created_at, updated_at) "
                    "VALUES (:id, :n, 'KES', 'Africa/Nairobi', now(), now())"
                ),
                {"id": ids[key], "n": key},
            )
            c.execute(
                text(
                    "INSERT INTO customers (id, business_id, customer_number, name, name_normalized, phone, "
                    "status, sms_opt_in, created_by, version, created_at, updated_at) VALUES "
                    "(:id, :b, 'C-1', :n, :n, '+254700000000', 'active', true, :u, 1, now(), now())"
                ),
                {"id": uuid.uuid4(), "b": ids[key], "n": f"cust-{key}", "u": ids["u"]},
            )
    app_url = make_url(ADMIN_URL).set(username="dt_app", password=None)
    yield create_engine(app_url), ids


def test_no_tenant_set_sees_nothing(migrated):
    engine, _ = migrated
    with engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM customers")).scalar() == 0


def test_tenant_sees_only_its_rows(migrated):
    engine, ids = migrated
    with engine.begin() as c:
        c.execute(text("SELECT set_config('app.business_id', :b, true)"), {"b": str(ids["a"])})
        names = c.execute(text("SELECT name FROM customers")).scalars().all()
        assert names == ["cust-a"]
        updated = c.execute(text("UPDATE customers SET notes = 'x' WHERE business_id = :b"), {"b": ids["b"]})
        assert updated.rowcount == 0


def test_tenant_cannot_write_into_another_business(migrated):
    engine, ids = migrated
    with pytest.raises(DBAPIError, match="row-level security"), engine.begin() as c:
        c.execute(text("SELECT set_config('app.business_id', :b, true)"), {"b": str(ids["a"])})
        c.execute(
            text(
                "INSERT INTO customers (id, business_id, customer_number, name, name_normalized, phone, "
                "status, sms_opt_in, created_by, version, created_at, updated_at) VALUES "
                "(:id, :b, 'C-2', 'evil', 'evil', '+254700000001', 'active', true, :u, 1, now(), now())"
            ),
            {"id": uuid.uuid4(), "b": ids["b"], "u": ids["u"]},
        )


def test_bypass_is_only_for_system_jobs(migrated):
    engine, _ = migrated
    with engine.begin() as c:
        c.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        assert c.execute(text("SELECT count(*) FROM customers")).scalar() == 2


def test_full_api_runs_under_rls_as_restricted_role(migrated):
    engine, _ = migrated
    env = os.environ | {
        "DENITRACK_DATABASE_URL": engine.url.render_as_string(hide_password=False),
        "DENITRACK_ENVIRONMENT": "test",
        "DENITRACK_JWT_SECRET": "x" * 40,
    }
    r = subprocess.run([sys.executable, "-m", "tests.rls_smoke"], cwd=BACKEND, env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-3000:]
    assert "RLS smoke OK" in r.stdout
