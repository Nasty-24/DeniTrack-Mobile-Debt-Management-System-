import os
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

os.environ.setdefault("DENITRACK_DATABASE_URL", "sqlite://")
os.environ["DENITRACK_ENVIRONMENT"] = "test"
os.environ["DENITRACK_JWT_SECRET"] = "test-secret-at-least-32-characters-long"
os.environ["DENITRACK_MPESA_CALLBACK_TOKEN"] = "test-callback-token"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import Base, engine  # noqa: E402
from app.integrations import messaging, mpesa  # noqa: E402
from app.main import app  # noqa: E402
from app.security import rate_limiter  # noqa: E402

TZ = ZoneInfo("Africa/Nairobi")
PASSWORD = "Correct-Horse-9"


def today() -> date:
    return datetime.now(TZ).date()


def days(n: int) -> str:
    return (today() + timedelta(days=n)).isoformat()


@pytest.fixture
def fresh_state():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    rate_limiter.reset()
    messaging.set_providers(messaging.MockSms(), messaging.MockPush())
    mpesa.set_mpesa(mpesa.MockMpesa())
    yield


@pytest.fixture
def client(fresh_state) -> TestClient:
    return TestClient(app)


class Api:
    """Small helper that remembers the signed-in user's token and business."""

    def __init__(self, client: TestClient, token: str, business_id: str, refresh: str = ""):
        self.c, self.token, self.bid, self.refresh = client, token, business_id, refresh

    @property
    def h(self):
        return {"Authorization": f"Bearer {self.token}"}

    def url(self, path: str) -> str:
        return f"/api/v1/businesses/{self.bid}{path}"

    def get(self, path, **kw):
        return self.c.get(self.url(path), headers=self.h, **kw)

    def post(self, path, json=None, key: str | None = None, **kw):
        headers = dict(self.h)
        if key:
            headers["Idempotency-Key"] = key
        return self.c.post(self.url(path), json=json, headers=headers, **kw)

    def patch(self, path, json=None):
        return self.c.patch(self.url(path), json=json, headers=self.h)

    def put(self, path, json=None):
        return self.c.put(self.url(path), json=json, headers=self.h)

    # ---- domain helpers
    def customer(self, name="Achieng Atieno", phone=None, **extra) -> dict:
        phone = phone or f"07{uuid.uuid4().int % 10**8:08d}"
        r = self.post("/customers", {"name": name, "phone": phone, **extra})
        assert r.status_code == 201, r.text
        return r.json()

    def debt(self, customer_id, principal="1000.00", incurred=-10, due=20, **extra) -> dict:
        body = {
            "customer_id": customer_id,
            "description": "Goods on credit",
            "principal": principal,
            "incurred_on": days(incurred),
            "due_date": days(due),
            **extra,
        }
        r = self.post("/debts", body, key=str(uuid.uuid4()))
        assert r.status_code == 201, r.text
        return r.json()

    def pay(self, customer_id, amount, method="cash", key=None, expect=201, **extra) -> dict:
        body = {"customer_id": customer_id, "amount": amount, "method": method, **extra}
        r = self.post("/payments", body, key=key or str(uuid.uuid4()))
        assert r.status_code == expect, r.text
        return r.json()


def register(client: TestClient, email="owner@example.com", business="Duka la Mama") -> Api:
    r = client.post(
        "/api/v1/auth/register",
        json={
            "full_name": "Wanjiru Kamau",
            "email": email,
            "password": PASSWORD,
            "phone": "0712345678",
            "business_name": business,
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    return Api(client, body["access_token"], body["memberships"][0]["business_id"], body["refresh_token"])


def login(client: TestClient, email: str, password: str = PASSWORD, business_id: str | None = None) -> Api:
    r = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    body = r.json()
    return Api(
        client, body["access_token"], business_id or body["memberships"][0]["business_id"], body["refresh_token"]
    )


@pytest.fixture
def owner(client) -> Api:
    return register(client)


@pytest.fixture
def cashier(client, owner) -> Api:
    r = owner.post(
        "/staff",
        {
            "full_name": "Otieno Omondi",
            "email": "cashier@example.com",
            "role": "cashier",
            "temporary_password": "Temporary-Pass-1",
        },
    )
    assert r.status_code == 201, r.text
    return login(client, "cashier@example.com", "Temporary-Pass-1", owner.bid)
