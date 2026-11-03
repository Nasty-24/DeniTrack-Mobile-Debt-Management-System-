"""Authentication, authorisation, tenant isolation and data-exposure tests."""

import uuid
from datetime import UTC, datetime, timedelta

import jwt

from app.integrations import messaging
from tests.conftest import PASSWORD, Api, login, register


class TestAuthentication:
    def test_wrong_password_and_unknown_email_look_identical(self, client, owner):
        a = client.post("/api/v1/auth/login", json={"email": "owner@example.com", "password": "wrong-password"})
        b = client.post("/api/v1/auth/login", json={"email": "nobody@example.com", "password": "wrong-password"})
        assert a.status_code == b.status_code == 401
        assert a.json() == b.json()

    def test_login_rate_limited(self, client, owner):
        codes = [
            client.post("/api/v1/auth/login", json={"email": "owner@example.com", "password": "nope-nope"}).status_code
            for _ in range(7)
        ]
        assert codes[:5] == [401] * 5 and codes[-1] == 429

    def test_weak_password_rejected(self, client):
        r = client.post(
            "/api/v1/auth/register",
            json={"full_name": "A B", "email": "x@example.com", "password": "short", "business_name": "Shop"},
        )
        assert r.status_code == 422

    def test_no_password_hash_in_responses(self, client, owner):
        r = client.post("/api/v1/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
        assert "password" not in r.text.lower().replace("must_change_password", "")
        assert "argon2" not in r.text

    def test_missing_malformed_expired_and_forged_tokens(self, client, owner):
        url = owner.url("/customers")
        assert client.get(url).status_code == 401
        assert client.get(url, headers={"Authorization": "Bearer not-a-jwt"}).status_code == 401
        claims = jwt.decode(owner.token, options={"verify_signature": False})
        expired = jwt.encode(
            claims | {"exp": datetime.now(UTC) - timedelta(minutes=1)},
            "test-secret-at-least-32-characters-long",
            algorithm="HS256",
        )
        assert client.get(url, headers={"Authorization": f"Bearer {expired}"}).status_code == 401
        forged = jwt.encode(claims, "attacker-secret-attacker-secret!!", algorithm="HS256")
        assert client.get(url, headers={"Authorization": f"Bearer {forged}"}).status_code == 401
        none_alg = jwt.encode(claims, key=None, algorithm="none")
        assert client.get(url, headers={"Authorization": f"Bearer {none_alg}"}).status_code == 401

    def test_logout_revokes_access_token(self, client, owner):
        assert owner.get("/customers").status_code == 200
        client.post("/api/v1/auth/logout", headers=owner.h)
        assert owner.get("/customers").status_code == 401

    def test_refresh_rotation_and_replay_detection(self, client, owner):
        r1 = client.post("/api/v1/auth/refresh", json={"refresh_token": owner.refresh})
        assert r1.status_code == 200
        new = r1.json()
        # Reusing the old refresh token is treated as theft: all sessions end.
        assert client.post("/api/v1/auth/refresh", json={"refresh_token": owner.refresh}).status_code == 401
        assert (
            client.get(owner.url("/customers"), headers={"Authorization": f"Bearer {new['access_token']}"}).status_code
            == 401
        )

    def test_password_reset_flow(self, client, owner):
        sms = messaging.MockSms()
        messaging.set_providers(sms, messaging.MockPush())
        r = client.post("/api/v1/auth/password-reset/request", json={"email": "owner@example.com"})
        assert r.status_code == 202
        assert (
            client.post("/api/v1/auth/password-reset/request", json={"email": "ghost@example.com"}).status_code == 202
        )
        assert len(sms.outbox) == 1 and sms.outbox[0].to == "+254712345678"
        token = sms.outbox[0].body.split(": ")[1].split("\n")[0]
        ok = client.post(
            "/api/v1/auth/password-reset/confirm", json={"token": token, "new_password": "Brand-New-Pass-7"}
        )
        assert ok.status_code == 204
        assert owner.get("/customers").status_code == 401  # old sessions revoked
        login(client, "owner@example.com", "Brand-New-Pass-7")
        reuse = client.post(
            "/api/v1/auth/password-reset/confirm", json={"token": token, "new_password": "Another-Pass-77"}
        )
        assert reuse.status_code == 401

    def test_staff_must_change_temporary_password(self, client, cashier):
        me = client.get("/api/v1/auth/me", headers=cashier.h).json()
        assert me["must_change_password"] is True
        r = client.post(
            "/api/v1/auth/change-password",
            headers=cashier.h,
            json={"current_password": "Temporary-Pass-1", "new_password": "My-Own-Pass-123"},
        )
        assert r.status_code == 204
        assert client.get("/api/v1/auth/me", headers=cashier.h).json()["must_change_password"] is False


class TestRoles:
    def test_cashier_can_do_daily_work(self, owner, cashier):
        c = cashier.customer()
        cashier.debt(c["id"], "500.00")
        p = cashier.pay(c["id"], "100.00")
        assert p["recorded_by"] != owner.bid

    def test_cashier_cannot_perform_privileged_actions(self, owner, cashier):
        c = owner.customer()
        d = owner.debt(c["id"], "500.00")
        p = owner.pay(c["id"], "100.00")
        forbidden = [
            cashier.post(f"/payments/{p['id']}/reverse", {"reason": "I want to"}),
            cashier.post(f"/payments/{p['id']}/verify", {"approve": True}),
            cashier.post(f"/debts/{d['id']}/adjustments", {"amount": "-10.00", "reason": "discount"}),
            cashier.post(f"/debts/{d['id']}/flag", {"flag": "cancelled", "reason": "cancel it"}),
            cashier.patch(f"/debts/{d['id']}", {"version": d["version"], "description": "edited"}),
            cashier.patch(f"/customers/{c['id']}", {"version": c["version"], "name": "Renamed"}),
            cashier.get("/audit-logs"),
            cashier.get("/staff"),
            cashier.get("/reports/collections"),
            cashier.patch("/settings", {"reminders_enabled": False}),
            cashier.post(
                "/staff",
                {
                    "full_name": "Sneaky",
                    "email": "s@example.com",
                    "role": "admin",
                    "temporary_password": "Temporary-Pass-1",
                },
            ),
            cashier.post("/reminders/run"),
        ]
        assert [r.status_code for r in forbidden] == [403] * len(forbidden)

    def test_owner_can_disable_cashier_customer_registration(self, owner, cashier):
        owner.patch("/settings", {"cashier_can_register_customers": False})
        assert cashier.post("/customers", {"name": "New Person", "phone": "0711000999"}).status_code == 403

    def test_deactivated_staff_lose_access(self, owner, cashier):
        staff = owner.get("/staff").json()
        m = next(s for s in staff if s["role"] == "cashier")
        owner.patch(f"/staff/{m['membership_id']}", {"is_active": False})
        assert cashier.get("/customers").status_code == 404


class TestTenantIsolation:
    def test_business_cannot_read_or_write_another_business(self, client, owner):
        c = owner.customer()
        d = owner.debt(c["id"], "1000.00")
        p = owner.pay(c["id"], "100.00")
        other = register(client, email="rival@example.com", business="Rival Shop")

        # Using the other business's URL directly
        intruder = Api(client, other.token, owner.bid)
        for path in (
            "/customers",
            f"/customers/{c['id']}",
            f"/debts/{d['id']}",
            f"/payments/{p['id']}",
            "/dashboard",
            "/payments",
            f"/payments/{p['id']}/receipt",
            "/sync/changes",
        ):
            assert intruder.get(path).status_code == 404, path
        assert (
            intruder.post(
                "/payments", {"customer_id": c["id"], "amount": "1.00", "method": "cash"}, key=str(uuid.uuid4())
            ).status_code
            == 404
        )

        # Using its own URL but someone else's record ids (IDOR)
        for path in (
            f"/customers/{c['id']}",
            f"/debts/{d['id']}",
            f"/payments/{p['id']}",
            f"/customers/{c['id']}/debts",
            f"/receipts/{p['receipt_number']}",
        ):
            assert other.get(path).status_code == 404, path
        r = other.post("/payments", {"customer_id": c["id"], "amount": "1.00", "method": "cash"}, key=str(uuid.uuid4()))
        assert r.status_code == 404
        r = other.post(f"/payments/{p['id']}/reverse", {"reason": "malicious reversal"})
        assert r.status_code == 404
        r = other.post(
            "/debts",
            {
                "customer_id": c["id"],
                "description": "x" * 5,
                "principal": "1.00",
                "incurred_on": "2026-01-01",
                "due_date": "2026-02-01",
            },
            key=str(uuid.uuid4()),
        )
        assert r.status_code == 404
        # Allocating to another business's debt from your own customer
        mine = other.customer()
        other.debt(mine["id"], "50.00")
        r = other.post(
            "/payments",
            {
                "customer_id": mine["id"],
                "amount": "10.00",
                "method": "cash",
                "allocations": [{"debt_id": d["id"], "amount": "10.00"}],
            },
            key=str(uuid.uuid4()),
        )
        assert r.status_code == 422

        assert other.get("/customers").json()["total"] == 1
        assert owner.get(f"/debts/{d['id']}").json()["balance"] == "900.00"

    def test_dashboard_totals_are_per_business(self, client, owner):
        c = owner.customer()
        owner.debt(c["id"], "1000.00")
        other = register(client, email="rival@example.com", business="Rival Shop")
        assert other.get("/dashboard").json()["total_outstanding"] == "0.00"
        assert owner.get("/dashboard").json()["total_outstanding"] == "1000.00"


class TestInputHandling:
    def test_sql_injection_in_search_is_inert(self, owner):
        owner.customer(name="Real Customer")
        for q in ("' OR '1'='1", "%' OR 1=1 --", "'; DROP TABLE customers; --"):
            r = owner.get("/customers", params={"q": q})
            assert r.status_code == 200 and r.json()["total"] == 0
        assert owner.get("/customers").json()["total"] == 1

    def test_errors_are_structured_and_do_not_leak_internals(self, owner):
        r = owner.get(f"/debts/{uuid.uuid4()}")
        assert r.status_code == 404
        assert set(r.json()["error"]) == {"code", "message", "details"}
        r = owner.get("/debts/not-a-uuid")
        assert r.status_code == 422 and "Traceback" not in r.text

    def test_security_headers(self, owner):
        r = owner.get("/customers")
        assert r.headers["X-Content-Type-Options"] == "nosniff"
        assert r.headers["Cache-Control"] == "no-store"
