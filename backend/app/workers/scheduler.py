"""Background worker: plans and dispatches reminders every 15 minutes.

Run with:  python -m app.workers.scheduler            (long-running)
      or:  python -m app.workers.scheduler --once     (single pass, e.g. from cron)

Safe to run on several machines at once: reminder planning is idempotent (unique keys)
and dispatch locks rows with SKIP LOCKED on PostgreSQL.
"""

import argparse
import logging
from datetime import UTC, datetime

from sqlalchemy import select

from app.db import SessionLocal, bypass_tenant
from app.models import Business
from app.services.reminders import dispatch_due, plan_reminders

log = logging.getLogger("denitrack.worker")


def run_once(now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    totals = {"businesses": 0, "planned": 0, "sent": 0, "failed": 0, "skipped": 0, "deferred": 0}
    with SessionLocal() as db:
        bypass_tenant(db)
        business_ids = list(db.scalars(select(Business.id)))
    for bid in business_ids:
        # One transaction per business so a failure in one never blocks the others.
        with SessionLocal() as db:
            bypass_tenant(db)
            try:
                business = db.get(Business, bid)
                if business is None:
                    continue
                planned = plan_reminders(db, business, now)
                stats = dispatch_due(db, business, now)
                db.commit()
            except Exception:
                db.rollback()
                log.exception("reminder run failed for business %s", bid)
                continue
        totals["businesses"] += 1
        totals["planned"] += planned
        for k, v in stats.items():
            totals[k] += v
    log.info("reminder run complete: %s", totals)
    return totals


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval-minutes", type=int, default=15)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    if args.once:
        run_once()
        return
    from apscheduler.schedulers.blocking import BlockingScheduler

    sched = BlockingScheduler(timezone="UTC")
    sched.add_job(
        run_once,
        "interval",
        minutes=args.interval_minutes,
        max_instances=1,
        coalesce=True,
        next_run_time=datetime.now(UTC),
    )
    log.info("worker started; interval %s min", args.interval_minutes)
    sched.start()


if __name__ == "__main__":
    main()
