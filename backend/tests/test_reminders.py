"""Reminder scheduling: offsets, idempotency, quiet hours, opt-outs, caps, retries."""

from datetime import UTC, datetime, time, timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.integrations import messaging
from app.models import Business, ReminderHistory
from app.services.reminders import in_quiet_hours, render, validate_template
from app.workers.scheduler import run_once
from tests.conftest import TZ, today


def at_local(hour: int, day_offset: int = 0) -> datetime:
    """A moment at `hour` local time on today + day_offset (in UTC)."""
    d = today() + timedelta(days=day_offset)
    return datetime.combine(d, time(hour), tzinfo=TZ).astimezone(UTC)


def rows(status=None, channel=None):
    with SessionLocal() as db:
        stmt = select(ReminderHistory)
        if status:
            stmt = stmt.where(ReminderHistory.status == status)
        if channel:
            stmt = stmt.where(ReminderHistory.channel == channel)
        return list(db.scalars(stmt))


@pytest.fixture
def sms():
    s = messaging.MockSms()
    messaging.set_providers(s, messaging.MockPush())
    return s


class TestUnits:
    @pytest.mark.parametrize("hour,quiet", [(21, True), (2, True), (7, True), (8, False), (13, False), (19, False)])
    def test_quiet_hours_wrap_midnight(self, hour, quiet):
        assert in_quiet_hours(hour, 20, 8) is quiet

    def test_template_validation(self):
        validate_template("Hi {customer_name}, KSh {amount} due {due_date}.")
        with pytest.raises(ValueError):
            validate_template("Hi {customer_name}, pay {amount} or {threat}")
        with pytest.raises(ValueError):
            validate_template("Hi {customer_name}, please pay soon.")

    def test_render_only_known_fields(self):
        assert (
            render("{customer_name} owes {amount}", {"customer_name": "Ann", "amount": "1.00", "x": 1})
            == "Ann owes 1.00"
        )


def test_reminders_for_each_configured_offset(owner, sms):
    c = owner.customer(name="Achieng Atieno", phone="0712345670")
    owner.debt(c["id"], "1500.00", incurred=-5, due=3)
    owner.debt(c["id"], "200.00", incurred=-5, due=2)  # 2 is not a configured offset
    run_once(at_local(10))
    sent = rows(status="sent")
    assert {r.channel.value for r in sent} == {"sms", "in_app"}
    assert all(r.offset_days == 3 for r in sent)
    assert len(sms.outbox) == 1
    msg = sms.outbox[0]
    assert msg.to == "+254712345670"
    assert "KSh 1,500.00" in msg.body and "Duka la Mama" in msg.body
    assert "If you have already paid" in msg.body
    notes = owner.get("/notifications").json()["items"]
    assert any("due in 3 days" in n["title"] for n in notes)


def test_running_twice_never_duplicates(owner, sms):
    c = owner.customer()
    owner.debt(c["id"], "500.00", incurred=-5, due=1)
    run_once(at_local(10))
    run_once(at_local(10))
    run_once(at_local(11))
    assert len(sms.outbox) == 1
    assert len(rows(channel="sms")) == 1


def test_quiet_hours_defer_customer_messages(owner, sms):
    c = owner.customer()
    owner.debt(c["id"], "500.00", incurred=-5, due=0)
    run_once(at_local(22))
    assert sms.outbox == []
    assert len(rows(status="queued", channel="sms")) == 1
    run_once(at_local(9, day_offset=1))
    assert len(sms.outbox) == 1


def test_opted_out_customer_gets_no_sms(owner, sms):
    c = owner.customer(sms_opt_in=False)
    owner.debt(c["id"], "500.00", incurred=-5, due=7)
    run_once(at_local(10))
    assert sms.outbox == []
    assert rows(channel="sms")[0].status.value == "skipped"


def test_debt_paid_after_planning_is_skipped(owner, sms):
    c = owner.customer()
    owner.debt(c["id"], "500.00", incurred=-5, due=0)
    with SessionLocal() as db:
        from app.services.reminders import plan_reminders

        plan_reminders(db, db.scalar(select(Business)), at_local(22))
        db.commit()
    owner.pay(c["id"], "500.00")
    run_once(at_local(9, day_offset=1))
    assert sms.outbox == []
    assert rows(channel="sms")[0].last_error == "Debt no longer outstanding"


def test_message_uses_current_ledger_amount(owner, sms):
    c = owner.customer()
    owner.debt(c["id"], "1000.00", incurred=-5, due=0)
    with SessionLocal() as db:
        from app.services.reminders import plan_reminders

        plan_reminders(db, db.scalar(select(Business)), at_local(22))
        db.commit()
    owner.pay(c["id"], "400.00")
    run_once(at_local(9, day_offset=1))
    assert "KSh 600.00" in sms.outbox[0].body


def test_overdue_offsets_and_weekly_cap(owner, sms):
    owner.patch("/settings", {"max_reminders_per_customer_per_week": 1, "reminder_offsets": [-3, -7]})
    c = owner.customer()
    owner.debt(c["id"], "100.00", incurred=-20, due=-3)
    owner.debt(c["id"], "200.00", incurred=-20, due=-7)
    run_once(at_local(10))
    assert len(sms.outbox) == 1
    assert "was due on" in sms.outbox[0].body
    skipped = rows(status="skipped", channel="sms")
    assert len(skipped) == 1 and skipped[0].last_error == "Weekly reminder limit reached"


def test_failures_retry_with_backoff_then_alert(owner, sms):
    c = owner.customer()
    owner.debt(c["id"], "100.00", incurred=-5, due=1)
    sms.fail_next = 10
    t = at_local(10)
    run_once(t)
    r = rows(channel="sms")[0]
    assert (r.status.value, r.attempts) == ("queued", 1)
    run_once(t + timedelta(minutes=31))
    run_once(t + timedelta(hours=3))
    r = rows(channel="sms")[0]
    assert (r.status.value, r.attempts) == ("failed", 3)
    assert any(n["kind"] == "reminder_failed" for n in owner.get("/notifications").json()["items"])
    # Manual, safe retry
    sms.fail_next = 0
    assert owner.post(f"/reminders/{r.id}/retry").status_code == 200
    run_once(t + timedelta(hours=3, minutes=1))
    assert rows(channel="sms")[0].status.value == "sent"


def test_installment_dates_trigger_reminders(owner, sms):
    c = owner.customer()
    owner.debt(
        c["id"],
        "900.00",
        incurred=-10,
        due=90,
        installment_plan={
            "count": 3,
            "frequency": "monthly",
            "first_due_date": (today() + timedelta(days=7)).isoformat(),
        },
    )
    run_once(at_local(10))
    assert len(sms.outbox) == 1 and "KSh 300.00" in sms.outbox[0].body


def test_disabled_reminders(owner, sms):
    owner.patch("/settings", {"reminders_enabled": False})
    c = owner.customer()
    owner.debt(c["id"], "100.00", incurred=-5, due=1)
    run_once(at_local(10))
    assert sms.outbox == [] and rows() == []


def test_custom_template_and_history_api(owner, sms):
    r = owner.put(
        "/reminder-templates/upcoming", {"body": "Habari {customer_name}, salio ni KSh {amount} kufikia {due_date}."}
    )
    assert r.status_code == 200
    bad = owner.put("/reminder-templates/upcoming", {"body": "Pay {amount} now or {consequence} will follow"})
    assert bad.status_code == 422
    c = owner.customer(name="Juma Bakari")
    owner.debt(c["id"], "100.00", incurred=-5, due=7)
    run_once(at_local(10))
    assert sms.outbox[0].body.startswith("Habari Juma")
    hist = owner.get("/reminders", params={"channel": "sms"}).json()
    assert hist["total"] == 1 and hist["items"][0]["status"] == "sent"
