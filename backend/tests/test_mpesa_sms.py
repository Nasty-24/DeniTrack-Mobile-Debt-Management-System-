"""M-Pesa SMS read on the owner's phone: parsing, matching by number and name, and safety."""

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from app.services.mpesa_sms import (
    name_score,
    parse_mpesa_sms,
    phone_matches,
    phone_pattern,
    redact_balance,
)

NOW = datetime.now(UTC).isoformat()


def received(code="TCK1ABC2DE", amount="500.00", party="JOHN MWANGI 0722***712"):
    return (
        f"{code} Confirmed.You have received Ksh{amount} from {party} on 24/3/26 at 10:32 AM "
        "New M-PESA balance is Ksh1,200.00. Transaction cost, Ksh0.00."
    )


def submit(api, *bodies, sender="MPESA", expect=200):
    r = api.post("/mpesa-sms", {"messages": [{"sender": sender, "body": b, "received_at": NOW} for b in bodies]})
    assert r.status_code == expect, r.text
    return r.json()["results"] if expect == 200 else r.json()


def balance(api, debt_id) -> str:
    return api.get(f"/debts/{debt_id}").json()["balance"]


class TestParsing:
    def test_masked_number_format(self):
        p = parse_mpesa_sms(received())
        assert p is not None
        assert (p.code, p.amount, p.payer_name, p.payer_phone) == (
            "TCK1ABC2DE",
            Decimal("500.00"),
            "JOHN MWANGI",
            "0722***712",
        )

    def test_full_number_and_three_names(self):
        p = parse_mpesa_sms(received("OB57V1MMEV", "1,000.00", "JANE RITA DOE 254721345654"))
        assert p is not None
        assert (p.amount, p.payer_name, p.payer_phone) == (Decimal("1000.00"), "JANE RITA DOE", "254721345654")

    def test_till_format_number_before_name(self):
        p = parse_mpesa_sms(
            "SGH4K2L9PQ Confirmed. on 6/11/26 at 10:15 AM Ksh2,500.00 received from 2547******123 PETER OTIENO. "
            "New Account balance is Ksh10,000.00."
        )
        assert p is not None
        assert (p.code, p.amount, p.payer_name, p.payer_phone) == (
            "SGH4K2L9PQ",
            Decimal("2500.00"),
            "PETER OTIENO",
            "2547******123",
        )

    def test_reference_at_the_end(self):
        p = parse_mpesa_sms(
            "M-PESA You have received Ksh500.00 from JOHN MWANGI 0722***712 on 24/3/26 at 10:32 AM. "
            "New M-PESA balance is Ksh1,200.00. Transaction cost, Ksh0.00. Ref: QHJ7K9LMN1"
        )
        assert p is not None and p.code == "QHJ7K9LMN1"

    def test_bank_transfer_without_phone(self):
        p = parse_mpesa_sms("TCK1ABC2DE Confirmed. You have received Ksh5,000.00 from KCB BANK on 1/11/26 at 9:00 AM")
        assert p is not None and (p.payer_name, p.payer_phone) == ("KCB BANK", None)

    @pytest.mark.parametrize(
        "text",
        [
            "TCK1ABC2DF Confirmed. Ksh200.00 sent to MARY WANJIKU 0711222333 on 2/11/26 at 1:00 PM.",
            "TCK1ABC2DG Confirmed. Ksh300.00 paid to NAIVAS. on 2/11/26 at 1:00 PM.",
            "Transaction TCK1ABC2DE has been reversed. Your account balance is now Ksh700.00.",
            "Your M-PESA balance is Ksh1,200.00. Dial *334# for more.",
            "You have received Ksh500.00 from JOHN MWANGI 0722***712 on 24/3/26",  # no transaction code
        ],
    )
    def test_ignores_everything_that_is_not_money_received(self, text):
        assert parse_mpesa_sms(text) is None

    def test_balance_is_redacted(self):
        assert "1,200" not in redact_balance(received())
        assert "Ksh500.00" in redact_balance(received())


class TestMatchingRules:
    def test_masked_and_full_numbers(self):
        assert phone_pattern("0722***712") == "254722***712"
        assert phone_matches("254722***712", "+254722000712")
        assert not phone_matches("254722***712", "+254723000712")
        assert phone_matches(phone_pattern("254721345654"), "+254721345654")
        assert phone_matches(phone_pattern("0722XXXX89"), "+254722123489")
        # Too few digits shown to mean anything
        assert not phone_matches(phone_pattern("07*****2"), "+254700000002")

    def test_names(self):
        assert name_score("JOHN MWANGI", "John Kamau Mwangi") == 2
        assert name_score("JOHN MWANGI", "Mama Njeri") == 0


# --------------------------------------------------------------------------- through the API


def test_matching_number_and_name_clears_the_debt_automatically(owner):
    c = owner.customer(name="John Kamau Mwangi", phone="0722000712")
    d = owner.debt(c["id"], "1000.00")
    [res] = submit(owner, received())
    assert res["status"] == "applied" and res["customer_name"] == "John Kamau Mwangi"
    assert res["amount"] == "500.00"
    assert balance(owner, d["id"]) == "500.00"
    [p] = owner.get("/payments", params={"customer_id": c["id"]}).json()["items"]
    assert p["method"] == "mpesa" and p["external_reference"] == "TCK1ABC2DE"
    assert p["verification_status"] == "verified" and p["receipt_number"]
    notes = owner.get("/notifications").json()["items"]
    assert any(n["title"] == "M-Pesa payment recorded" for n in notes)


def test_the_same_sms_is_never_applied_twice(owner):
    c = owner.customer(name="John Mwangi", phone="0722000712")
    d = owner.debt(c["id"], "1000.00")
    assert submit(owner, received())[0]["status"] == "applied"
    assert [r["status"] for r in submit(owner, received(), received())] == ["duplicate", "duplicate"]
    assert balance(owner, d["id"]) == "500.00"
    assert owner.get("/payments", params={"customer_id": c["id"]}).json()["total"] == 1


def test_masked_number_shared_by_two_customers_is_settled_by_name(owner):
    owner.customer(name="Grace Achieng", phone="0722111712")
    john = owner.customer(name="John Mwangi", phone="0722000712")
    d = owner.debt(john["id"], "800.00")
    [res] = submit(owner, received())
    assert res["status"] == "applied" and res["customer_name"] == "John Mwangi"
    assert balance(owner, d["id"]) == "300.00"


def test_number_without_matching_name_waits_for_review_then_owner_assigns(owner):
    c = owner.customer(name="Mama Njeri", phone="0722000712")
    d = owner.debt(c["id"], "1000.00")
    [res] = submit(owner, received())
    assert res["status"] == "needs_review"
    assert balance(owner, d["id"]) == "1000.00"
    [item] = owner.get("/mpesa-sms", params={"status": "needs_review"}).json()["items"]
    assert item["suggested_customer_name"] == "Mama Njeri"
    assert "does not" in item["detail"]
    r = owner.post(f"/mpesa-sms/{item['id']}/assign", {"customer_id": c["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "applied" and r.json()["customer_name"] == "Mama Njeri"
    assert balance(owner, d["id"]) == "500.00"
    again = owner.post(f"/mpesa-sms/{item['id']}/assign", {"customer_id": c["id"]})
    assert again.status_code == 422 and again.json()["error"]["code"] == "already_handled"


def test_name_only_match_is_suggested_not_applied(owner):
    c = owner.customer(name="John Mwangi", phone="0733000000")
    owner.debt(c["id"], "1000.00")
    [res] = submit(owner, received())
    assert res["status"] == "needs_review"
    [item] = owner.get("/mpesa-sms").json()["items"]
    assert item["suggested_customer_name"] == "John Mwangi"


def test_unknown_payer_can_be_dismissed(owner):
    [res] = submit(owner, received(party="KCB BANK"))
    assert res["status"] == "needs_review"
    [item] = owner.get("/mpesa-sms").json()["items"]
    r = owner.post(f"/mpesa-sms/{item['id']}/dismiss", {"reason": "Cash sale paid by M-Pesa"})
    assert r.status_code == 200 and r.json()["status"] == "dismissed"
    notes = owner.get("/notifications").json()["items"]
    assert any(n["title"] == "M-Pesa payment needs matching" for n in notes)


def test_sms_confirms_a_code_the_cashier_typed_in(owner, cashier):
    c = owner.customer(name="John Mwangi", phone="0722000712")
    d = owner.debt(c["id"], "1000.00")
    p = cashier.pay(c["id"], "500.00", method="mpesa", external_reference="TCK1ABC2DE")
    assert p["verification_status"] == "pending"
    assert balance(owner, d["id"]) == "1000.00"
    [res] = submit(owner, received())
    assert res["status"] == "confirmed"
    assert owner.get(f"/payments/{p['id']}").json()["verification_status"] == "verified"
    assert balance(owner, d["id"]) == "500.00"
    assert owner.get("/payments", params={"customer_id": c["id"]}).json()["total"] == 1


def test_typed_in_code_with_a_different_amount_is_flagged(owner, cashier):
    c = owner.customer(name="John Mwangi", phone="0722000712")
    owner.debt(c["id"], "1000.00")
    cashier.pay(c["id"], "50.00", method="mpesa", external_reference="TCK1ABC2DE")
    [res] = submit(owner, received())
    assert res["status"] == "needs_review" and "KSh 50.00" in res["detail"]


def test_overpayment_waits_for_review(owner):
    c = owner.customer(name="John Mwangi", phone="0722000712")
    d = owner.debt(c["id"], "300.00")
    [res] = submit(owner, received())
    assert res["status"] == "needs_review" and "could not be applied" in res["detail"]
    assert balance(owner, d["id"]) == "300.00"


def test_only_messages_from_mpesa_are_considered(owner):
    c = owner.customer(name="John Mwangi", phone="0722000712")
    owner.debt(c["id"], "1000.00")
    [res] = submit(owner, received(), sender="+254711000000")
    assert res["status"] == "ignored"
    assert owner.get("/mpesa-sms").json()["total"] == 0


def test_cashiers_cannot_submit_or_review(cashier):
    assert submit(cashier, received(), expect=403)
    assert cashier.get("/mpesa-sms").status_code == 403


def test_other_businesses_cannot_see_or_assign(client, owner):
    from tests.conftest import register

    other = register(client, email="other@example.com", business="Other Shop")
    submit(owner, received(party="KCB BANK"))
    [item] = owner.get("/mpesa-sms").json()["items"]
    assert other.get("/mpesa-sms").json()["total"] == 0
    c = other.customer(name="John Mwangi", phone="0722000712")
    r = other.post(f"/mpesa-sms/{item['id']}/assign", {"customer_id": c["id"]})
    assert r.status_code == 404
