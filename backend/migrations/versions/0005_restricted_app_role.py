"""Restricted role for platforms whose only database user is a superuser.

A superuser ignores row-level security, even with FORCE ROW LEVEL SECURITY. When migrations
run as a superuser (for example on PrimeCloud), create `denitrack_app`: no login, no
superuser, no BYPASSRLS, and only data privileges. The API switches to it after connecting
when DENITRACK_DB_ROLE=denitrack_app (see app/db.py).

Deployments that migrate as a non-superuser owner (docker-compose) are left alone: they
already connect as their own restricted login role (scripts/create_app_role.sh).

Revision ID: 0005
Revises: 0004
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

ROLE = "denitrack_app"


def _migrating_as_superuser() -> bool:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return False
    return bool(bind.exec_driver_sql("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").scalar())


def upgrade() -> None:
    if not _migrating_as_superuser():
        return
    op.execute(
        f"""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{ROLE}') THEN
                CREATE ROLE {ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
            END IF;
        END $$;
        """
    )
    op.execute(f"GRANT USAGE ON SCHEMA public TO {ROLE}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {ROLE}")
    op.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {ROLE}")
    op.execute(f"REVOKE ALL ON TABLE alembic_version FROM {ROLE}")  # migrations are not the API's business
    # Tables added by later migrations (run by this same user) get the same privileges.
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {ROLE}")
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {ROLE}")


def downgrade() -> None:
    if not _migrating_as_superuser():
        return
    # Only remove the no-login role this migration creates, never a login role an operator made.
    op.execute(
        f"""
        DO $$ BEGIN
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = '{ROLE}' AND NOT rolcanlogin) THEN
                DROP OWNED BY {ROLE};
                BEGIN
                    DROP ROLE {ROLE};
                EXCEPTION WHEN dependent_objects_still_exist THEN
                    NULL;  -- still has privileges in another database on this server
                END;
            END IF;
        END $$;
        """
    )
