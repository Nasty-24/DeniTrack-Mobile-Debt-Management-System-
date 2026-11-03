"""Backup / restore drill.

Dumps a PostgreSQL database with pg_dump, restores it into a scratch database with
pg_restore, and verifies that every business's ledger figures are identical afterwards.
Run monthly against a recent production backup (into a non-production server).

    python scripts/backup_restore_check.py \
        --source postgresql://postgres@localhost:5432/denitrack \
        --scratch-db denitrack_restore_check [--pg-bin "C:/Program Files/PostgreSQL/17/bin"]

Connect as a role that can read every tenant (the schema owner or a superuser); the
script sets app.bypass_rls for its own read-only comparison queries.
"""

import argparse
import os
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit, urlunsplit

import psycopg

LEDGER_SQL = """
SELECT b.id::text AS business,
  (SELECT count(*) FROM customers c WHERE c.business_id = b.id) AS customers,
  (SELECT count(*) FROM debts d WHERE d.business_id = b.id) AS debts,
  (SELECT coalesce(sum(principal), 0) FROM debts d WHERE d.business_id = b.id AND d.flag <> 'cancelled') AS principal,
  (SELECT coalesce(sum(amount), 0) FROM debt_adjustments a WHERE a.business_id = b.id) AS adjustments,
  (SELECT coalesce(sum(pa.amount), 0) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
     WHERE p.business_id = b.id AND p.status = 'posted' AND p.verification_status IN ('verified', 'not_required')) AS paid,
  (SELECT count(*) FROM payments p WHERE p.business_id = b.id) AS payments,
  (SELECT count(*) FROM payments p WHERE p.business_id = b.id AND p.status = 'reversed') AS reversals,
  (SELECT count(*) FROM receipts r WHERE r.business_id = b.id) AS receipts,
  (SELECT max(receipt_number) FROM receipts r WHERE r.business_id = b.id) AS last_receipt,
  (SELECT count(*) FROM audit_logs l WHERE l.business_id = b.id) AS audit_entries
FROM businesses b ORDER BY b.id
"""


def libpq(url: str, dbname: str | None = None) -> str:
    url = url.replace("postgresql+psycopg://", "postgresql://")
    parts = urlsplit(url)
    if dbname:
        parts = parts._replace(path=f"/{dbname}")
    return urlunsplit(parts)


def snapshot(url: str) -> list[tuple]:
    with psycopg.connect(url) as conn:
        conn.execute("SELECT set_config('app.bypass_rls', 'on', false)")
        return [tuple(r) for r in conn.execute(LEDGER_SQL).fetchall()]


def tool(pg_bin: str | None, name: str) -> str:
    return os.path.join(pg_bin, name) if pg_bin else name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--scratch-db", required=True)
    ap.add_argument("--pg-bin")
    args = ap.parse_args()

    source = libpq(args.source)
    if urlsplit(source).path.strip("/") == args.scratch_db:
        print("Refusing: scratch database must differ from the source")
        return 2

    before = snapshot(source)
    with tempfile.TemporaryDirectory() as tmp:
        dump = os.path.join(tmp, "backup.dump")
        subprocess.run([tool(args.pg_bin, "pg_dump"), "-Fc", "-f", dump, "-d", source], check=True)
        size = os.path.getsize(dump)
        with psycopg.connect(libpq(args.source, "postgres"), autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{args.scratch_db}"')
            admin.execute(f'CREATE DATABASE "{args.scratch_db}"')
        restored = libpq(args.source, args.scratch_db)
        subprocess.run([tool(args.pg_bin, "pg_restore"), "--no-owner", "-d", restored, dump], check=True)

    after = snapshot(restored)
    with psycopg.connect(restored) as conn:
        policies = conn.execute("SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation'").fetchone()[0]

    print(f"Backup size: {size:,} bytes; businesses: {len(before)}; RLS policies after restore: {policies}")
    if before != after:
        print("MISMATCH between source and restored ledger totals:")
        for b, a in zip(before, after, strict=False):
            if b != a:
                print("  source  ", b)
                print("  restored", a)
        return 1
    for row in after:
        print(
            f"  business {row[0][:8]}... customers={row[1]} debts={row[2]} paid={row[5]} receipts={row[8]} last={row[9]}"
        )
    print("OK: restored ledger matches the source exactly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
