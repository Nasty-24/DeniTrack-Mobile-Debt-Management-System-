"""End-to-end debt and payment workflows through the HTTP API."""

import uuid

from tests.conftest import days


class TestCustomers:
    def test_phone_is_normalised_to_e164(self, owner):
        c = owner.customer(phone="0712 345 670")
        assert c["phone"] == "+254712345670"
        assert c["customer_number"] == "C-00001"

    def test_invalid_phone_rejected(self, owner):
        r = owner.post("/customers", {"name": "Bad Phone", "phone": "12345"})
        assert r.status_code == 422
        assert r.json()["error"]["code"] in ("invalid_phone", "validation_error")

    def test_duplicate_detection_and_override(self, owner):
        owner.customer(name="Achieng Atieno", phone="0712345670")
        r = owner.post("/customers", {"name": "Someone Else", "phone": "+254712345670"})
        assert r.status_code == 409
        assert r.json()["error"]["code"] == "possible_duplicate"
        r = owner.post("/customers", {"name": "achieng  ATIENO", "phone": "0722000111"})
        assert r.status_code == 409
        r = owner.post("/customers", {"name": "Achieng Atieno", "phone": "0722000111", "allow_duplicate": True})
        assert r.status_code == 201

    def test_search_by_name_phone_and_number(self, owner):
        a = owner.customer(name="Kiprono Kirui", phone="0711333444")
        owner.customer(name="Fatuma Hassan", phone="0701444555")
        for q in ("kipro", "711333", a["customer_number"]):
            items = owner.get("/customers", params={"q": q}).json()["items"]
            assert [i["id"] for i in items] == [a["id"]], q

    def test_archive_preserves_history_and_blocks_new_credit(self, owner):
        c = owner.customer()
        d = owner.debt(c["id"], "500.00")
        owner.pay(c["id"], "200.00")
        assert owner.post(f"/customers/{c['id']}/archive").status_code == 200
        assert owner.get(f"/debts/{d['id']}").json()["paid"] == "200.00"
        r = owner.post(
            "/debts",
            {
                "customer_id": c["id"],
                "description": "More",
                "principal": "10.00",
                "incurred_on": days(0),
                "due_date": days(5),
            },
            key=str(uuid.uuid4()),
        )
        assert r.status_code == 422 and r.json()["error"]["code"] == "customer_archived"

    def test_optimistic_concurrency_on_update(self, owner):
        c = owner.customer()
        assert (
            owner.patch(f"/customers/{c['id']}", {"version": c["version"], "notes": "Pays on Fridays"}).status_code
            == 200
        )
        r = owner.patch(f"/customers/{c['id']}", {"version": c["version"], "notes": "stale edit"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"


class TestDebtsAndPayments:
    def test_partial_then_full_payment(self, owner):
        c = owner.customer()
        d = owner.debt(c["id"], "1000.00")
        assert d["status"] == "open" and d["balance"] == "1000.00"

        owner.pay(c["id"], "250.50")
        d = owner.get(f"/debts/{d['id']}").json()
        assert d["status"] == "partially_paid"
        assert (d["paid"], d["balance"]) == ("250.50", "749.50")

        p = owner.pay(c["id"], "749.50")
        d = owner.get(f"/debts/{d['id']}").json()
        assert d["status"] == "paid" and d["balance"] == "0.00"
        assert p["receipt_number"].startswith("RCT-")
        assert owner.get(f"/customers/{c['id']}").json()["outstanding_balance"] == "0.00"

    def test_overpayment_rejected(self, owner):
        c = owner.customer()
        owner.debt(c["id"], "100.00")
        r = owner.post("/payments", {"customer_id": c["id"], "amount": "100.01", "method": "cash"}, key="k-overpay-1")
        assert r.status_code == 422 and r.json()["error"]["code"] == "overpayment"

    def test_negative_zero_and_float_amounts_rejected(self, owner):
        c = owner.customer()
        owner.debt(c["id"], "100.00")
        for amount in ("-5.00", "0", 10.5, "1.234"):
            r = owner.post(
                "/payments", {"customer_id": c["id"], "amount": amount, "method": "cash"}, key=str(uuid.uuid4())
            )
            assert r.status_code == 422, amount

    def test_idempotency_key_is_required_and_replays(self, owner):
        c = owner.customer()
        owner.debt(c["id"], "500.00")
        body = {"customer_id": c["id"], "amount": "100.00", "method": "cash"}
        assert owner.post("/payments", body).status_code == 400
        first = owner.post("/payments", body, key="retry-key-123")
        again = owner.post("/payments", body, key="retry-key-123")
        assert first.status_code == again.status_code == 201
        assert first.json()["id"] == again.json()["id"]
        assert again.headers.get("Idempotent-Replayed") == "true"
        assert owner.get("/payments").json()["total"] == 1
        other = owner.post("/payments", body | {"amount": "50.00"}, key="retry-key-123")
        assert other.status_code == 409 and other.json()["error"]["code"] == "idempotency_key_reused"

    def test_oldest_due_debt_paid_first(self, owner):
        c = owner.customer()
        later = owner.debt(c["id"], "300.00", due=30)
        sooner = owner.debt(c["id"], "200.00", due=5)
        p = owner.pay(c["id"], "250.00")
        alloc = {a["debt_id"]: a["amount"] for a in p["allocations"]}
        assert alloc == {sooner["id"]: "200.00", later["id"]: "50.00"}

    def test_explicit_allocation(self, owner):
        c = owner.customer()
        a = owner.debt(c["id"], "300.00", due=30)
        owner.debt(c["id"], "200.00", due=5)
        p = owner.pay(c["id"], "100.00", allocations=[{"debt_id": a["id"], "amount": "100.00"}])
        assert p["allocations"] == [{"debt_id": a["id"], "amount": "100.00"}]

    def test_overdue_identification(self, owner):
        c = owner.customer()
        overdue = owner.debt(c["id"], "400.00", incurred=-30, due=-1)
        due_today = owner.debt(c["id"], "100.00", incurred=-5, due=0)
        assert overdue["status"] == "overdue" and overdue["days_overdue"] == 1
        assert overdue["overdue_amount"] == "400.00"
        assert due_today["status"] == "open"
        listed = owner.get("/debts", params={"status": "overdue"}).json()["items"]
        assert [d["id"] for d in listed] == [overdue["id"]]
        # Settling an overdue debt makes it paid, not overdue.
        owner.pay(c["id"], "400.00", allocations=[{"debt_id": overdue["id"], "amount": "400.00"}])
        assert owner.get(f"/debts/{overdue['id']}").json()["status"] == "paid"

    def test_installment_plan(self, owner):
        c = owner.customer()
        d = owner.debt(
            c["id"],
            "1000.00",
            incurred=-60,
            due=60,
            installment_plan={"count": 3, "frequency": "monthly", "first_due_date": days(-30)},
        )
        assert [s["amount"] for s in d["schedule"]] == ["333.33", "333.33", "333.34"]
        assert d["status"] == "overdue" and d["overdue_amount"] == "333.33"
        owner.pay(c["id"], "333.33")
        d = owner.get(f"/debts/{d['id']}").json()
        assert d["status"] == "partially_paid"
        assert [s["status"] for s in d["schedule"]] == ["paid", "due", "due"]

    def test_invalid_explicit_installments(self, owner):
        c = owner.customer()
        r = owner.post(
            "/debts",
            {
                "customer_id": c["id"],
                "description": "x" * 5,
                "principal": "100.00",
                "incurred_on": days(0),
                "due_date": days(30),
                "installments": [{"due_date": days(10), "amount": "40.00"}, {"due_date": days(20), "amount": "40.00"}],
            },
            key=str(uuid.uuid4()),
        )
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_schedule"

    def test_due_before_incurred_rejected(self, owner):
        c = owner.customer()
        r = owner.post(
            "/debts",
            {
                "customer_id": c["id"],
                "description": "Bad",
                "principal": "100.00",
                "incurred_on": days(0),
                "due_date": days(-1),
            },
            key=str(uuid.uuid4()),
        )
        assert r.status_code == 422

    def test_adjustment_changes_total_due_but_not_below_paid(self, owner):
        c = owner.customer()
        d = owner.debt(c["id"], "1000.00")
        owner.pay(c["id"], "600.00")
        r = owner.post(f"/debts/{d['id']}/adjustments", {"amount": "-200.00", "reason": "Returned 2 bags"})
        assert r.status_code == 201
        assert (r.json()["total_due"], r.json()["balance"]) == ("800.00", "200.00")
        r = owner.post(f"/debts/{d['id']}/adjustments", {"amount": "-300.00", "reason": "Too much returned"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "adjustment_below_paid"

    def test_cancel_only_without_payments(self, owner):
        c = owner.customer()
        a = owner.debt(c["id"], "100.00")
        assert (
            owner.post(f"/debts/{a['id']}/flag", {"flag": "cancelled", "reason": "Entered twice"}).json()["status"]
            == "cancelled"
        )
        b = owner.debt(c["id"], "100.00")
        owner.pay(c["id"], "10.00")
        r = owner.post(f"/debts/{b['id']}/flag", {"flag": "cancelled", "reason": "Changed mind"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "debt_has_payments"

    def test_disputed_debt_not_counted_as_overdue(self, owner):
        c = owner.customer()
        d = owner.debt(c["id"], "100.00", incurred=-20, due=-5)
        d = owner.post(
            f"/debts/{d['id']}/flag", {"flag": "disputed", "reason": "Customer disputes the quantity"}
        ).json()
        assert d["status"] == "disputed" and d["overdue_amount"] == "0.00"


class TestVerificationAndReversal:
    def test_mpesa_code_required_and_pending_until_verified(self, owner):
        c = owner.customer()
        d = owner.debt(c["id"], "1000.00")
        r = owner.post("/payments", {"customer_id": c["id"], "amount": "300.00", "method": "mpesa"}, key="mp-1-nocode")
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_mpesa_code"

        p = owner.pay(c["id"], "300.00", method="mpesa", external_reference="slk4h7r2qx")
        assert p["verification_status"] == "pending" and p["receipt_number"] is None
        assert p["external_reference"] == "SLK4H7R2QX"
        d = owner.get(f"/debts/{d['id']}").json()
        assert (d["balance"], d["pending_verification"]) == ("1000.00", "300.00")
        # Pending money reserves headroom, so the debt cannot be overpaid meanwhile.
        owner.pay(c["id"], "700.01", expect=422)
        assert owner.get(f"/payments/{p['id']}/receipt").status_code == 404

        v = owner.post(f"/payments/{p['id']}/verify", {"approve": True}).json()
        assert v["verification_status"] == "verified" and v["receipt_number"]
        assert owner.get(f"/debts/{d['id']}").json()["balance"] == "700.00"

    def test_duplicate_transaction_reference_rejected(self, owner):
        c = owner.customer()
        owner.debt(c["id"], "1000.00")
        owner.pay(c["id"], "100.00", method="mpesa", external_reference="QWE1234567")
        r = owner.post(
            "/payments",
            {"customer_id": c["id"], "amount": "100.00", "method": "mpesa", "external_reference": "qwe1234567"},
            key=str(uuid.uuid4()),
        )
        assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_reference"

    def test_rejected_verification_never_counts(self, owner):
        c = owner.customer()
        d = owner.debt(c["id"], "500.00")
        p = owner.pay(c["id"], "500.00", method="bank_transfer", external_reference="FT2611ABC")
        owner.post(f"/payments/{p['id']}/verify", {"approve": False, "note": "Not on statement"})
        d = owner.get(f"/debts/{d['id']}").json()
        assert (d["balance"], d["pending_verification"]) == ("500.00", "0.00")

    def test_reversal_restores_balance_and_is_audited(self, owner):
        c = owner.customer()
        d = owner.debt(c["id"], "800.00")
        p = owner.pay(c["id"], "800.00")
        assert owner.get(f"/debts/{d['id']}").json()["status"] == "paid"
        r = owner.post(f"/payments/{p['id']}/reverse", {"reason": "Wrong customer selected"})
        assert r.json()["status"] == "reversed"
        assert owner.get(f"/debts/{d['id']}").json()["balance"] == "800.00"
        again = owner.post(f"/payments/{p['id']}/reverse", {"reason": "Wrong customer selected"})
        assert again.status_code == 422
        receipt = owner.get(f"/payments/{p['id']}/receipt").json()
        assert receipt["payment_status"] == "reversed" and "REVERSED" in receipt["share_text"]
        actions = [a["action"] for a in owner.get("/audit-logs", params={"entity_id": p["id"]}).json()["items"]]
        assert actions == ["payment.reversed", "payment.recorded"]
        # The payment is still in the ledger, not deleted.
        assert owner.get("/payments", params={"status": "reversed"}).json()["total"] == 1

    def test_reversed_reference_can_be_reused_for_corrected_payment(self, owner):
        c = owner.customer()
        owner.debt(c["id"], "1000.00")
        p = owner.pay(c["id"], "100.00", method="mpesa", external_reference="ABC1234567")
        owner.post(f"/payments/{p['id']}/reverse", {"reason": "Amount entered wrongly"})
        owner.pay(c["id"], "150.00", method="mpesa", external_reference="ABC1234567")

    def test_receipt_numbers_are_unique_and_sequential(self, owner):
        c = owner.customer()
        owner.debt(c["id"], "1000.00")
        numbers = [owner.pay(c["id"], "10.00")["receipt_number"] for _ in range(3)]
        assert len(set(numbers)) == 3
        assert [int(n.rsplit("-", 1)[1]) for n in numbers] == [1, 2, 3]
        r = owner.get(f"/receipts/{numbers[1]}").json()
        assert r["snapshot"]["amount"] == "10.00" and r["snapshot"]["customer"]["name"] == "Achieng Atieno"

    def test_payment_without_debts_is_refused(self, owner):
        c = owner.customer()
        owner.pay(c["id"], "10.00", expect=422)
