"""Dashboard/report consistency with the ledger, exports, and offline-sync safety."""

import uuid
from decimal import Decimal

from tests.conftest import days


def _scenario(owner):
    a = owner.customer(name="Mwangi Contractors")
    b = owner.customer(name="Fatuma Hassan")
    d1 = owner.debt(a["id"], "1000.00", incurred=-40, due=-10)  # overdue
    d2 = owner.debt(b["id"], "500.00", incurred=-3, due=5)  # due soon
    owner.debt(b["id"], "250.00", incurred=-3, due=30)
    owner.pay(a["id"], "300.00")
    owner.pay(b["id"], "100.00", method="mpesa", external_reference="PEND123456")  # pending
    rev = owner.pay(b["id"], "50.00")
    owner.post(f"/payments/{rev['id']}/reverse", {"reason": "Recorded twice"})
    return a, b, d1, d2


def test_dashboard_matches_ledger(owner):
    _scenario(owner)
    dash = owner.get("/dashboard").json()
    debts = owner.get("/debts", params={"status": "all"}).json()["items"]
    assert Decimal(dash["total_outstanding"]) == sum(Decimal(d["balance"]) for d in debts) == Decimal("1450.00")
    assert dash["total_overdue"] == "700.00"
    assert dash["collected_today"] == "300.00"  # pending and reversed payments excluded
    assert dash["pending_verification"] == "100.00"
    assert dash["customers_with_balance"] == 2
    assert [x["debt_number"] for x in dash["due_soon"]] == ["D-000002"]
    assert len(dash["recent_payments"]) == 3


def test_collections_and_credit_are_reported_separately(owner):
    _scenario(owner)
    col = owner.get("/reports/collections", params={"start": days(-30), "end": days(0)}).json()
    assert col["total_collected"] == "300.00" and col["payment_count"] == 1
    assert col["by_method"] == [{"method": "cash", "amount": "300.00"}]
    credit = owner.get("/reports/credit_issued", params={"start": days(-60), "end": days(0)}).json()
    assert credit["total_issued"] == "1750.00" and credit["debt_count"] == 3
    narrow = owner.get("/reports/credit_issued", params={"start": days(-5), "end": days(0)}).json()
    assert narrow["total_issued"] == "750.00"


def test_aging_customer_balances_and_exceptions(owner):
    _scenario(owner)
    aging = owner.get("/reports/aging").json()
    buckets = {b["bucket"]: b["amount"] for b in aging["buckets"]}
    assert buckets["1-30"] == "700.00" and buckets["current"] == "750.00"
    assert aging["total"] == owner.get("/dashboard").json()["total_outstanding"]
    bal = owner.get("/reports/customer_balances").json()
    assert [c["customer_name"] for c in bal["customers"]] == ["Fatuma Hassan", "Mwangi Contractors"]
    exc = owner.get("/reports/exceptions", params={"start": days(-1), "end": days(0)}).json()
    assert exc["reversed_total"] == "50.00" and exc["reversed_payments"][0]["reason"] == "Recorded twice"
    emp = owner.get("/reports/employee_activity", params={"start": days(-60), "end": days(0)}).json()["employees"]
    assert emp[0]["amount_collected"] == "300.00" and emp[0]["debts_created"] == 3 and emp[0]["reversals"] == 1


def test_settlement_report(owner):
    c = owner.customer()
    full = owner.debt(c["id"], "100.00", due=40)
    owner.debt(c["id"], "200.00", due=50)
    owner.pay(c["id"], "150.00")
    s = owner.get("/reports/settlement", params={"start": days(-30), "end": days(0)}).json()
    assert [r["debt_number"] for r in s["fully_settled"]] == [full["debt_number"]]
    assert s["partially_settled_outstanding"] == "150.00"


def test_invalid_range_rejected(owner):
    assert owner.get("/reports/collections", params={"start": days(0), "end": days(-1)}).status_code == 422


def test_csv_export_with_formula_injection_guard(owner):
    c = owner.customer(name='=HYPERLINK("http://evil")')
    owner.debt(c["id"], "100.00")
    r = owner.get("/reports/customer_balances/export", params={"format": "csv"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    lines = r.text.strip().splitlines()
    assert lines[0].startswith("customer_number,customer_name")
    assert "'=HYPERLINK" in lines[1]
    assert any(a["action"] == "report.exported" for a in owner.get("/audit-logs").json()["items"])


def test_pdf_export(owner):
    c = owner.customer()
    owner.debt(c["id"], "100.00")
    owner.pay(c["id"], "40.00")
    r = owner.get("/reports/collections/export", params={"format": "pdf", "start": days(-1), "end": days(0)})
    assert r.status_code == 200 and r.content.startswith(b"%PDF")


class TestOfflineSync:
    def test_replayed_offline_payment_posts_once(self, owner):
        c = owner.customer()
        owner.debt(c["id"], "1000.00")
        client_ref = str(uuid.uuid4())
        body = {
            "customer_id": c["id"],
            "amount": "200.00",
            "method": "cash",
            "client_reference": client_ref,
            "paid_at": "2026-01-01T10:00:00+03:00",
        }
        first = owner.post("/payments", body, key=client_ref)
        # App crashed before seeing the response, retries with the same key
        retry = owner.post("/payments", body, key=client_ref)
        # A different key but the same client_reference (e.g. queue rebuilt) still does not double-post
        rebuilt = owner.post("/payments", body, key=str(uuid.uuid4()))
        assert first.status_code == 201
        assert first.json()["id"] == retry.json()["id"] == rebuilt.json()["id"]
        assert owner.get("/payments").json()["total"] == 1

    def test_offline_debt_creation_is_idempotent(self, owner):
        c = owner.customer()
        ref = str(uuid.uuid4())
        body = {
            "customer_id": c["id"],
            "description": "Sugar 2 bales",
            "principal": "4800.00",
            "incurred_on": days(-1),
            "due_date": days(14),
            "client_reference": ref,
        }
        a = owner.post("/debts", body, key=ref).json()
        b = owner.post("/debts", body, key=str(uuid.uuid4())).json()
        assert a["id"] == b["id"]
        assert owner.get("/debts").json()["total"] == 1

    def test_queued_payment_that_now_overpays_is_rejected_not_silently_applied(self, owner, cashier):
        c = owner.customer()
        owner.debt(c["id"], "500.00")
        # cashier queued 400 offline; meanwhile owner recorded 300 online
        owner.pay(c["id"], "300.00")
        r = cashier.post(
            "/payments",
            {"customer_id": c["id"], "amount": "400.00", "method": "cash", "client_reference": str(uuid.uuid4())},
            key=str(uuid.uuid4()),
        )
        assert r.status_code == 422 and r.json()["error"]["code"] == "overpayment"
        assert owner.get("/dashboard").json()["total_outstanding"] == "200.00"

    def test_changes_feed(self, owner):
        c = owner.customer()
        d = owner.debt(c["id"], "100.00")
        snap = owner.get("/sync/changes").json()
        assert {x["id"] for x in snap["customers"]} == {c["id"]}
        assert {x["id"] for x in snap["debts"]} == {d["id"]}
        later = owner.get("/sync/changes", params={"since": snap["server_time"]}).json()
        assert later["customers"] == []
        assert [x["id"] for x in later["debts"]] == [d["id"]]  # outstanding debts always resent
