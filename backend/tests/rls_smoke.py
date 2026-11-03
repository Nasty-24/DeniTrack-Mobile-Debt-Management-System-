"""Run by test_postgres_rls.py in a subprocess: drives the real API while connected as the
restricted `dt_app` role, so every query is subject to row-level security."""

import uuid

from fastapi.testclient import TestClient

from app.main import app
from app.workers.scheduler import run_once

c = TestClient(app)


def reg(email, biz):
    r = c.post(
        "/api/v1/auth/register",
        json={"full_name": "Owner Name", "email": email, "password": "Correct-Horse-9", "business_name": biz},
    )
    assert r.status_code == 201, r.text
    b = r.json()
    return {"Authorization": f"Bearer {b['access_token']}"}, f"/api/v1/businesses/{b['memberships'][0]['business_id']}"


h, base = reg(f"{uuid.uuid4().hex[:8]}@example.com", "RLS Shop A")
h2, base2 = reg(f"{uuid.uuid4().hex[:8]}@example.com", "RLS Shop B")
cust = c.post(f"{base}/customers", headers=h, json={"name": "Jane Wambui", "phone": "0712345678"}).json()
debt = c.post(
    f"{base}/debts",
    headers=h | {"Idempotency-Key": str(uuid.uuid4())},
    json={
        "customer_id": cust["id"],
        "description": "Flour",
        "principal": "900.00",
        "incurred_on": "2026-01-01",
        "due_date": "2026-01-15",
    },
)
assert debt.status_code == 201, debt.text
pay = c.post(
    f"{base}/payments",
    headers=h | {"Idempotency-Key": str(uuid.uuid4())},
    json={"customer_id": cust["id"], "amount": "400.00", "method": "cash"},
)
assert pay.status_code == 201, pay.text
dash = c.get(f"{base}/dashboard", headers=h).json()
assert dash["total_outstanding"] == "500.00" and dash["total_overdue"] == "500.00", dash
assert c.get(f"{base}/reports/aging", headers=h).status_code == 200
assert c.get(f"{base2}/customers/{cust['id']}", headers=h2).status_code == 404
assert c.get(f"{base2}/dashboard", headers=h2).json()["total_outstanding"] == "0.00"
stats = run_once()
assert stats["businesses"] >= 2, stats
print("RLS smoke OK", stats)
