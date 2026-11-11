"""SMS telling a customer what they took on credit, how much it was, and when to pay."""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.integrations import messaging
from app.models import Business, ReminderHistory
from app.services.reminders import record_phone_result
from app.workers.scheduler import run_once
from tests.conftest import days, today
from tests.test_phone_sms import claim
from tests.test_reminders import at_local, rows


@pytest.fixture
def provider():
    s = messaging.MockSms()
    messaging.set_providers(s, messaging.MockPush())
    return s


def credit(api, customer_id, principal="2450.00", description="Cement 2 bags, nails 1kg", due=14, **extra):
    return api.debt(customer_id, principal, incurred=0, due=due, description=description, notify_customer=True, **extra)


def report_sent(reminder_id, when):
    with SessionLocal() as db:
        rec = db.get(ReminderHistory, reminder_id)
        record_phone_result(db, db.get(Business, rec.business_id), rec, True, None, when)
        db.commit()


def test_notice_names_the_goods_amount_and_due_date(owner, cashier):
    c = owner.customer(name="Achieng Atieno", phone="0712345670")
    credit(cashier, c["id"])  # recorded by a cashier, sent by the owner's phone
    [item] = owner.get("/reminders/phone-queue").json()
    msg = item["message"]
    assert item["phone"] == "+254712345670"
    assert msg.startswith("Hello Achieng,")
    assert "Cement 2 bags, nails 1kg" in msg and "KSh 2,450.00" in msg
    assert (today() + timedelta(days=14)).strftime("%d %b %Y") in msg
    assert today().strftime("%d %b %Y") in msg
    r = owner.post(f"/reminders/{item['reminder_id']}/phone-result", {"sent": True})
    assert r.json()["status"] == "sent"
    [hist] = owner.get("/reminders", params={"channel": "sms"}).json()["items"]
    assert hist["purpose"] == "credit_notice"


def test_no_notice_unless_asked(owner):
    c = owner.customer()
    owner.debt(c["id"], "500.00", incurred=0, due=7)
    assert rows(channel="sms") == []


def test_one_notice_when_the_request_is_repeated(owner):
    c = owner.customer()
    body = {
        "customer_id": c["id"],
        "description": "Sugar 2kg",
        "principal": "300.00",
        "incurred_on": days(0),
        "due_date": days(7),
        "notify_customer": True,
        "client_reference": str(uuid.uuid4()),
    }
    key = str(uuid.uuid4())
    assert owner.post("/debts", body, key=key).status_code == 201
    assert owner.post("/debts", body, key=key).status_code == 201  # same request replayed
    assert owner.post("/debts", body, key=str(uuid.uuid4())).status_code == 201  # offline replay, new key
    assert len(rows(channel="sms")) == 1


def test_sent_in_quiet_hours_and_not_counted_against_reminders(owner):
    assert owner.patch("/settings", {"max_reminders_per_customer_per_week": 1}).status_code == 200
    c = owner.customer(phone="0712345670")
    owner.debt(c["id"], "800.00", incurred=-20, due=-3)  # overdue: a reminder is planned
    run_once(at_local(10))
    credit(owner, c["id"])
    # 9 pm tomorrow is inside quiet hours: only the notice goes out.
    [(notice_id, _, msg)] = claim(at_local(21, 1))
    assert "Cement 2 bags" in msg
    report_sent(notice_id, at_local(21, 1))
    # The next morning the overdue reminder still goes, despite a limit of one per week.
    [(_, _, reminder)] = claim(at_local(10, 2))
    assert "was due on" in reminder


def test_customer_who_opted_out_gets_no_notice(owner):
    c = owner.customer(sms_opt_in=False)
    credit(owner, c["id"])
    [rec] = rows(channel="sms")
    assert rec.status.value == "skipped" and rec.last_error == "Customer opted out"
    assert claim(at_local(10, 1)) == []


def test_sent_by_the_sms_provider_when_chosen(owner, provider):
    assert owner.patch("/settings", {"sms_sender": "provider"}).status_code == 200
    c = owner.customer(phone="0712345670")
    credit(owner, c["id"])
    run_once(at_local(22, 1))  # quiet hours do not hold back a notice
    [sent] = provider.outbox
    assert sent.to == "+254712345670" and "Cement 2 bags" in sent.body


def test_long_descriptions_are_shortened(owner):
    c = owner.customer()
    credit(owner, c["id"], description="Assorted groceries " * 20)
    [rec] = rows(channel="sms")
    assert "…" in rec.message and len(rec.message) < 320


def test_wording_can_be_changed(owner):
    r = owner.put(
        "/reminder-templates/credit_notice",
        {
            "body": "Habari {customer_name}, umekopa {items} ya KSh {amount} tarehe {credit_date}. Lipa kabla ya {due_date}."
        },
    )
    assert r.status_code == 200
    kinds = [t["kind"] for t in owner.get("/reminder-templates").json()]
    assert "credit_notice" in kinds
    c = owner.customer(name="Juma Bakari")
    credit(owner, c["id"])
    [rec] = rows(channel="sms")
    assert rec.message.startswith("Habari Juma, umekopa Cement 2 bags")
    # Placeholders for credit notices are not accepted in reminder wording.
    bad = owner.put("/reminder-templates/overdue", {"body": "You owe KSh {amount} for {items}, please pay soon."})
    assert bad.status_code == 422


def test_paid_before_sending_is_skipped(owner):
    c = owner.customer()
    d = credit(owner, c["id"], principal="300.00")
    pay = owner.post(
        "/payments",
        {
            "customer_id": c["id"],
            "amount": "300.00",
            "method": "cash",
            "allocations": [{"debt_id": d["id"], "amount": "300.00"}],
        },
        key=str(uuid.uuid4()),
    )
    assert pay.status_code == 201, pay.text
    assert claim(at_local(10, 1)) == []
    with SessionLocal() as db:
        [rec] = db.scalars(select(ReminderHistory)).all()
        assert rec.status.value == "skipped"
