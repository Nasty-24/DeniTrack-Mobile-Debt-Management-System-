"""Reminder SMS sent from the owner's own phone, and one-tap reminders by SMS or WhatsApp."""

from datetime import timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.integrations import messaging
from app.models import Business, ReminderHistory
from app.services.reminders import MAX_ATTEMPTS, claim_for_phone, record_phone_result
from app.workers.scheduler import run_once
from tests.test_reminders import at_local, rows


@pytest.fixture
def gateway():
    s = messaging.MockSms()
    messaging.set_providers(s, messaging.MockPush())
    return s


def overdue_debt(owner, name="Achieng Atieno", phone="0712345670", principal="1500.00", **customer):
    c = owner.customer(name=name, phone=phone, **customer)
    owner.debt(c["id"], principal, incurred=-20, due=-3)
    return c


def anytime(owner):
    """API tests run at the real time of day; switch quiet hours off so they never wait."""
    assert owner.patch("/settings", {"quiet_hours_start": 0, "quiet_hours_end": 0}).status_code == 200


def claim(now):
    with SessionLocal() as db:
        business = db.scalars(select(Business)).one()
        out = [(rec.id, c.phone, rec.message) for rec, c in claim_for_phone(db, business, now)]
        db.commit()
        return out


def test_phone_is_the_default_and_the_server_does_not_send(owner, gateway):
    assert owner.get("/settings").json()["sms_sender"] == "phone"
    overdue_debt(owner)
    run_once(at_local(10))
    assert gateway.outbox == []
    assert len(rows(status="queued", channel="sms")) == 1
    assert len(rows(status="sent", channel="in_app")) == 1


def test_phone_collects_sends_and_reports(owner, gateway):
    anytime(owner)
    overdue_debt(owner)
    queue = owner.get("/reminders/phone-queue").json()
    assert len(queue) == 1
    item = queue[0]
    assert item["phone"] == "+254712345670" and "KSh 1,500.00" in item["message"]
    # Reserved for this phone: asking again does not hand it out twice.
    assert owner.get("/reminders/phone-queue").json() == []
    r = owner.post(f"/reminders/{item['reminder_id']}/phone-result", {"sent": True})
    assert r.status_code == 200 and r.json()["status"] == "sent"
    # Reporting twice is harmless.
    assert owner.post(f"/reminders/{item['reminder_id']}/phone-result", {"sent": True}).json()["status"] == "sent"
    assert gateway.outbox == []


def test_quiet_hours_and_rules_still_apply(owner):
    overdue_debt(owner)
    overdue_debt(owner, name="Opted Out", phone="0712345671", sms_opt_in=False)
    run_once(at_local(10))
    assert claim(at_local(21)) == []  # quiet hours: nothing handed out
    claimed = claim(at_local(10, 0) + timedelta(minutes=1))
    assert [p for _, p, _ in claimed] == ["+254712345670"]
    assert rows(status="skipped", channel="sms")[0].last_error == "Customer opted out"


def test_lease_expires_then_gives_up_after_three_tries(owner):
    overdue_debt(owner)
    run_once(at_local(9))
    t = at_local(9)
    for attempt in range(MAX_ATTEMPTS):
        assert len(claim(t)) == 1, f"attempt {attempt + 1}"
        assert claim(t) == []
        t += timedelta(minutes=16)
    assert claim(t) == []
    [rec] = rows(channel="sms")
    assert rec.status.value == "failed" and "did not confirm" in rec.last_error
    titles = [n["title"] for n in owner.get("/notifications").json()["items"]]
    assert "Reminder not delivered" in titles


def test_failed_send_is_retried_later(owner):
    overdue_debt(owner)
    run_once(at_local(9))
    [(rid, _, _)] = claim(at_local(9))
    with SessionLocal() as db:
        rec = db.get(ReminderHistory, rid)
        business = db.get(Business, rec.business_id)
        record_phone_result(db, business, rec, False, "No signal", at_local(9))
        db.commit()
    [rec] = rows(channel="sms")
    assert rec.status.value == "queued" and rec.last_error == "No signal"
    assert claim(at_local(9) + timedelta(minutes=5)) == []
    assert len(claim(at_local(11))) == 1


def test_switching_back_to_the_gateway(owner, gateway):
    anytime(owner)
    overdue_debt(owner)
    assert owner.patch("/settings", {"sms_sender": "provider"}).json()["sms_sender"] == "provider"
    run_once(at_local(10))
    assert len(gateway.outbox) == 1
    assert owner.get("/reminders/phone-queue").json() == []


# --------------------------------------------------------------------------- one-tap reminders


def test_manual_sms_reminder_from_a_cashiers_phone(owner, cashier):
    anytime(owner)
    c = overdue_debt(owner)
    r = cashier.post("/reminders/manual", {"customer_id": c["id"], "channel": "sms"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["phone"] == "+254712345670" and body["whatsapp_url"] is None
    assert "KSh 1,500.00" in body["message"] and "Achieng Atieno" in body["message"]
    done = cashier.post(f"/reminders/{body['reminder_id']}/phone-result", {"sent": True})
    assert done.status_code == 200 and done.json()["status"] == "sent"
    # It is not handed to the owner's phone or the scheduler to send again (only the
    # scheduled reminder for the overdue debt is).
    queue = owner.get("/reminders/phone-queue").json()
    assert body["reminder_id"] not in [q["reminder_id"] for q in queue]
    assert len(queue) == 1
    actions = [a["action"] for a in owner.get("/audit-logs").json()["items"]]
    assert "reminder.manual" in actions


def test_manual_whatsapp_reminder_opens_a_ready_message(owner):
    c = overdue_debt(owner)
    body = owner.post("/reminders/manual", {"customer_id": c["id"], "channel": "whatsapp"}).json()
    assert body["whatsapp_url"].startswith("https://wa.me/254712345670?text=")
    assert "KSh%201%2C500.00" in body["whatsapp_url"]
    [rec] = rows(channel="whatsapp")
    assert rec.status.value == "sent"


def test_manual_reminder_for_an_upcoming_debt_uses_the_due_amount(owner):
    c = owner.customer(name="Juma Hamisi", phone="0712345672")
    owner.debt(c["id"], "700.00", incurred=-2, due=5)
    msg = owner.post("/reminders/manual", {"customer_id": c["id"], "channel": "sms"}).json()["message"]
    assert msg.startswith("Hello Juma") and "KSh 700.00" in msg


def test_manual_reminder_respects_opt_out_and_needs_a_balance(owner):
    c = overdue_debt(owner, sms_opt_in=False)
    r = owner.post("/reminders/manual", {"customer_id": c["id"], "channel": "sms"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "opted_out"
    paid = owner.customer(name="No Debt", phone="0712345673")
    r = owner.post("/reminders/manual", {"customer_id": paid["id"], "channel": "whatsapp"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "nothing_owed"


def test_cashier_cannot_collect_or_report_scheduled_reminders(owner, cashier):
    anytime(owner)
    overdue_debt(owner)
    assert cashier.get("/reminders/phone-queue").status_code == 403
    [item] = owner.get("/reminders/phone-queue").json()
    r = cashier.post(f"/reminders/{item['reminder_id']}/phone-result", {"sent": True})
    assert r.status_code == 403
