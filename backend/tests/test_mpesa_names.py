"""Learned M-Pesa names: customers added from phone contacts often have nicknames, while M-Pesa
shows the name on the payer's ID. Matching a payment by hand teaches the app that name."""

import uuid

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, CustomerMpesaName
from app.services.mpesa_sms import learned_names
from tests.test_mpesa_sms import balance, received, submit

PAYER = "NJERI WAMBUI"


def pochi(code: str, party: str = PAYER) -> str:
    """A payment that shows the payer's name but no phone number, as Pochi la Biashara does."""
    return received(code=code, party=party)


def needs_review(api, code: str) -> dict:
    items = api.get("/mpesa-sms", params={"status": "needs_review"}).json()["items"]
    return next(i for i in items if i["transaction_code"] == code)


def teach(api, customer: dict, code: str, party: str = PAYER) -> None:
    """Submit a payment that waits for matching, then match it to `customer` by hand."""
    [res] = submit(api, received(code=code, party=party))
    assert res["status"] == "needs_review", res
    item = needs_review(api, code)
    r = api.post(f"/mpesa-sms/{item['id']}/assign", {"customer_id": customer["id"]})
    assert r.status_code == 200, r.text


@pytest.fixture
def mama(owner):
    # A phone-book nickname that shares no name with what M-Pesa shows.
    c = owner.customer(name="Mama Mboga", phone="0722000712")
    owner.debt(c["id"], "5000.00")
    return c


def test_matching_by_hand_teaches_the_name(owner, mama):
    teach(owner, mama, "TTEACH0001", party=f"{PAYER} 0722***712")
    with SessionLocal() as db:
        assert learned_names(db, uuid.UUID(owner.bid)) == {uuid.UUID(mama["id"]): {PAYER}}
        entry = db.scalars(select(AuditLog).where(AuditLog.action == "mpesa_sms.assigned")).one()
        assert entry.after["learned_name"] == PAYER
    [res] = submit(owner, received(code="TCK1ABC2DF", party=f"{PAYER} 0722***712"))
    assert res["status"] == "applied" and res["customer_name"] == "Mama Mboga"


def test_a_name_is_learned_once_and_never_unknown(owner, mama):
    teach(owner, mama, "TTEACH0001")
    teach(owner, mama, "TTEACH0002")
    teach(owner, mama, "TTEACH0003", party="0722***712")  # no name in the message
    with SessionLocal() as db:
        names = db.scalars(select(CustomerMpesaName.name)).all()
    assert names == [PAYER]


def test_pochi_payment_waits_with_the_learned_customer_chosen(owner, mama):
    teach(owner, mama, "TTEACH0001")
    d = owner.get(f"/customers/{mama['id']}/debts").json()[0]
    before = balance(owner, d["id"])
    [res] = submit(owner, pochi("TPOCHI0001"))
    assert res["status"] == "needs_review"
    item = needs_review(owner, "TPOCHI0001")
    assert item["suggested_customer_name"] == "Mama Mboga"
    assert item["detail"] == (
        "No phone number in this payment (for example Pochi la Biashara). NJERI WAMBUI has paid for Mama Mboga before."
    )
    assert balance(owner, d["id"]) == before


def test_unknown_number_with_learned_name_is_suggested_not_applied(owner, mama):
    teach(owner, mama, "TTEACH0001")
    [res] = submit(owner, received(code="TCK1ABC2DF", party=f"{PAYER} 0733***999"))
    assert res["status"] == "needs_review"
    item = needs_review(owner, "TCK1ABC2DF")
    assert item["suggested_customer_name"] == "Mama Mboga"
    assert item["detail"] == "This number isn't saved for any customer. NJERI WAMBUI has paid for Mama Mboga before."


def test_learned_name_shared_by_two_customers_gives_no_suggestion(owner, mama):
    other = owner.customer(name="Wanjiru Otieno", phone="0711000000")
    owner.debt(other["id"], "5000.00")
    teach(owner, mama, "TTEACH0001")
    teach(owner, other, "TTEACH0002")
    submit(owner, pochi("TPOCHI0001"))
    item = needs_review(owner, "TPOCHI0001")
    assert item["suggested_customer_name"] is None
    assert item["detail"] == "2 customers have paid under the M-Pesa name NJERI WAMBUI. Choose the right one."


def test_archived_customers_learned_names_are_ignored(owner, mama):
    teach(owner, mama, "TTEACH0001")
    submit(owner, pochi("TPOCHI0001"))
    assert needs_review(owner, "TPOCHI0001")["suggested_customer_name"] == "Mama Mboga"
    assert owner.post(f"/customers/{mama['id']}/archive").status_code == 200
    submit(owner, pochi("TPOCHI0002"))
    assert needs_review(owner, "TPOCHI0002")["suggested_customer_name"] is None


def test_learned_name_wins_when_a_number_fits_two_customers(owner, mama):
    # "Njeri Kamau" shares one name with the payer and fits the masked number too.
    njeri = owner.customer(name="Njeri Kamau", phone="0722111712")
    owner.debt(njeri["id"], "5000.00")
    teach(owner, mama, "TTEACH0001")
    [res] = submit(owner, received(code="TCK1ABC2DF", party=f"{PAYER} 0722***712"))
    assert res["status"] == "applied" and res["customer_name"] == "Mama Mboga"


def test_long_names_fit_the_detail(owner):
    long_customer = owner.customer(name="Mama " + "N" * 150, phone="0722000713")
    owner.debt(long_customer["id"], "5000.00")
    payer = "A" * 75 + " " + "B" * 75
    teach(owner, long_customer, "TTEACH0001", party=payer)
    [res] = submit(owner, pochi("TPOCHI0001", party=payer))
    assert res["status"] == "needs_review"
    item = needs_review(owner, "TPOCHI0001")
    assert item["suggested_customer_name"] == long_customer["name"]
    assert item["detail"].startswith("No phone number in this payment") and len(item["detail"]) <= 300


# --------------------------------------------------------------------------- seeing and removing names


def names_of(api, customer: dict):
    return api.get(f"/customers/{customer['id']}/mpesa-names")


def remove(api, customer: dict, name_id: str):
    return api.post(f"/customers/{customer['id']}/mpesa-names/{name_id}/remove")


def test_owner_sees_and_removes_learned_names(owner, mama):
    teach(owner, mama, "TTEACH0001")
    r = names_of(owner, mama)
    assert r.status_code == 200, r.text
    [item] = r.json()
    assert item["name"] == PAYER
    gone = remove(owner, mama, item["id"])
    assert gone.status_code == 200, gone.text
    assert gone.json() == []
    submit(owner, pochi("TPOCHI0001"))
    assert needs_review(owner, "TPOCHI0001")["suggested_customer_name"] is None
    with SessionLocal() as db:
        entry = db.scalars(select(AuditLog).where(AuditLog.action == "customer.mpesa_name_removed")).one()
        assert entry.before == {"name": PAYER}


def test_removing_twice_returns_404(owner, mama):
    teach(owner, mama, "TTEACH0001")
    [item] = names_of(owner, mama).json()
    assert remove(owner, mama, item["id"]).status_code == 200
    assert remove(owner, mama, item["id"]).status_code == 404


def test_cashiers_cannot_see_or_remove_names(owner, cashier, mama):
    teach(owner, mama, "TTEACH0001")
    [item] = names_of(owner, mama).json()
    assert names_of(cashier, mama).status_code == 403
    assert remove(cashier, mama, item["id"]).status_code == 403


def test_other_business_gets_404(client, owner, mama):
    from tests.conftest import register

    teach(owner, mama, "TTEACH0001")
    [item] = names_of(owner, mama).json()
    other = register(client, email="other@example.com", business="Other Shop")
    assert names_of(other, mama).status_code == 404
    assert remove(other, mama, item["id"]).status_code == 404
    assert len(names_of(owner, mama).json()) == 1


def test_learned_name_ties_with_a_full_name_match(owner, mama):
    # Both numbers fit the masked one; one customer's own name is exactly the M-Pesa name.
    namesake = owner.customer(name="Njeri Wambui", phone="0722111712")
    owner.debt(namesake["id"], "5000.00")
    teach(owner, mama, "TTEACH0001")
    [res] = submit(owner, received(code="TCK1ABC2DF", party=f"{PAYER} 0722***712"))
    assert res["status"] == "needs_review"
    assert (
        needs_review(owner, "TCK1ABC2DF")["detail"] == "2 customers match this number and name. Choose the right one."
    )
