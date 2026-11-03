#!/bin/sh
# Runs once when the PostgreSQL volume is first created (docker-entrypoint-initdb.d).
# Creates the restricted role the API and worker connect as. It owns nothing, cannot
# bypass row-level security, and only gets data privileges on tables the owner creates.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$DENITRACK_APP_PASSWORD" <<'SQL'
CREATE ROLE denitrack_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_password';
GRANT CONNECT ON DATABASE denitrack TO denitrack_app;
GRANT USAGE ON SCHEMA public TO denitrack_app;
ALTER DEFAULT PRIVILEGES FOR ROLE denitrack_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO denitrack_app;
SQL
