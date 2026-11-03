"""M-Pesa STK Push flow against the mock provider, including hostile callbacks."""

from decimal import Decimal

import pytest

from app.integrations import mpesa

CALLBACK = "/api/v1/integrations/mpesa/callback/test-callback-token"


@pytest.fixture
def provider():
    p = mpesa.MockMpesa()
    mpesa.set_mpesa(p)
    return p


@pytest.fixture
def setup(owner, provider):
    c = owner.customer(phone="0712345670")
    d = owner.debt(c["id"], "1000.00")
    req = owner.post("/payment-requests/mpesa", {"debt_id": d["id"], "amount": "400.00"})
    assert req.status_code == 201, req.text
    req = req.json()
    assert req["status"] == "pending" and req["provider_mode"] == "mock"
    cid = next(iter(provider.requests))
    return owner, c, d, req, cid


def _debt(owner, d):
    return owner.get(f"/debts/{d['id']}").json()


def test_request_alone_creates_no_payment(setup):
    owner, c, d, req, cid = setup
    assert _debt(owner, d)["balance"] == "1000.00"
    assert owner.get("/payments").json()["total"] == 0


def test_successful_callback_posts_verified_payment(client, setup, provider):
    owner, c, d, req, cid = setup
    r = client.post(CALLBACK, json=provider.complete(cid, receipt="TJK8H2LM3P"))
    assert r.status_code == 200 and r.json()["outcome"] == "succeeded"
    assert _debt(owner, d)["balance"] == "600.00"
    payments = owner.get("/payments").json()["items"]
    assert len(payments) == 1
    p = payments[0]
    assert (p["verification_status"], p["external_reference"], p["method"]) == ("verified", "TJK8H2LM3P", "mpesa")
    assert p["receipt_number"]
    assert owner.get(f"/payment-requests/{req['id']}").json()["status"] == "succeeded"


def test_repeated_callback_is_processed_once(client, setup, provider):
    owner, c, d, req, cid = setup
    cb = provider.complete(cid, receipt="TJK8H2LM3P")
    outcomes = [client.post(CALLBACK, json=cb).json()["outcome"] for _ in range(3)]
    assert outcomes == ["succeeded", "duplicate", "duplicate"]
    assert owner.get("/payments").json()["total"] == 1
    assert _debt(owner, d)["balance"] == "600.00"


def test_failed_payment_marks_request_failed(client, setup, provider):
    owner, c, d, req, cid = setup
    assert client.post(CALLBACK, json=provider.complete(cid, result_code=1032)).json()["outcome"] == "failed"
    assert owner.get(f"/payment-requests/{req['id']}").json()["status"] == "failed"
    assert _debt(owner, d)["balance"] == "1000.00"


def test_amount_mismatch_is_not_posted(client, setup, provider):
    owner, c, d, req, cid = setup
    r = client.post(CALLBACK, json=provider.complete(cid, amount=Decimal("4.00")))
    assert r.json()["outcome"] == "rejected"
    assert owner.get("/payments").json()["total"] == 0
    notes = owner.get("/notifications").json()["items"]
    assert any(n["kind"] == "payment_review" for n in notes)


def test_callback_not_confirmed_by_status_query_is_not_posted(client, setup, provider):
    owner, c, d, req, cid = setup
    cb = provider.complete(cid)
    provider.outcomes[cid] = 1  # provider's own status query disagrees with the callback
    assert client.post(CALLBACK, json=cb).json()["outcome"] == "rejected"
    assert owner.get("/payments").json()["total"] == 0


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"Body": {}},
        {"Body": {"stkCallback": {"CheckoutRequestID": "x", "ResultCode": "not-a-number"}}},
        {"Body": {"stkCallback": {"CheckoutRequestID": "ws_CO_unknown", "ResultCode": 0}}},
        ["not", "an", "object"],
    ],
)
def test_malformed_or_forged_callbacks_rejected(client, setup, payload):
    owner, *_ = setup
    r = client.post(CALLBACK, json=payload)
    assert r.status_code == 200 and r.json()["outcome"] == "rejected"
    assert owner.get("/payments").json()["total"] == 0


def test_unknown_checkout_id_rejected(client, setup, provider):
    owner, *_ = setup
    fake = provider.stk_push("+254700000000", Decimal("400.00"), "X", "y")
    assert client.post(CALLBACK, json=provider.complete(fake.checkout_request_id)).json()["outcome"] == "rejected"
    assert owner.get("/payments").json()["total"] == 0


def test_wrong_callback_token_is_404(client, setup, provider):
    *_, cid = setup
    r = client.post("/api/v1/integrations/mpesa/callback/guess", json=provider.complete(cid))
    assert r.status_code == 404


def test_money_arriving_for_settled_debt_is_flagged_not_lost(client, setup, provider):
    owner, c, d, req, cid = setup
    owner.pay(c["id"], "1000.00")  # paid in cash meanwhile
    assert client.post(CALLBACK, json=provider.complete(cid)).json()["outcome"] == "needs_review"
    assert owner.get(f"/payment-requests/{req['id']}").json()["status"] == "needs_review"
    assert any("manual review" in n["body"] for n in owner.get("/notifications").json()["items"])


def test_stk_push_cannot_exceed_balance(setup):
    owner, c, d, *_ = setup
    r = owner.post("/payment-requests/mpesa", {"debt_id": d["id"], "amount": "1000.01"})
    assert r.status_code == 422
