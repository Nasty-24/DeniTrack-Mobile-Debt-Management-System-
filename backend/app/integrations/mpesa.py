"""M-Pesa (Safaricom Daraja) STK Push integration.

Nothing here marks a payment as successful on its own. A payment is created only after:
 1. a callback arrives on the secret callback URL,
 2. it matches a pending request we created (CheckoutRequestID),
 3. ResultCode == 0 and the amount and phone match the request, and
 4. an independent STK Push Query to the provider confirms the result.
"""

import base64
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Protocol
from zoneinfo import ZoneInfo

import httpx

from app.config import get_settings


class ProviderError(Exception):
    pass


@dataclass
class StkPushResult:
    checkout_request_id: str
    merchant_request_id: str


@dataclass
class QueryResult:
    result_code: int | None  # None = still processing
    description: str


class MpesaProvider(Protocol):
    name: str
    mode: str

    def stk_push(self, phone: str, amount: Decimal, account_ref: str, description: str) -> StkPushResult: ...

    def query(self, checkout_request_id: str) -> QueryResult: ...


@dataclass
class MockMpesa:
    """Deterministic provider for tests and demos. `complete()` builds the callback the
    real Daraja service would POST, so the full verification path is exercised."""

    name: str = "mpesa"
    mode: str = "mock"
    requests: dict[str, dict] = field(default_factory=dict)
    outcomes: dict[str, int] = field(default_factory=dict)

    def stk_push(self, phone, amount, account_ref, description) -> StkPushResult:
        cid = f"ws_CO_{uuid.uuid4().hex[:20]}"
        self.requests[cid] = {"phone": phone, "amount": amount, "account_ref": account_ref}
        return StkPushResult(cid, f"mr_{uuid.uuid4().hex[:12]}")

    def query(self, checkout_request_id: str) -> QueryResult:
        if checkout_request_id not in self.outcomes:
            return QueryResult(None, "The transaction is being processed")
        code = self.outcomes[checkout_request_id]
        return QueryResult(code, "Success" if code == 0 else "Failed")

    def complete(
        self,
        checkout_request_id: str,
        result_code: int = 0,
        receipt: str | None = None,
        amount: Decimal | None = None,
        phone: str | None = None,
    ) -> dict:
        req = self.requests[checkout_request_id]
        self.outcomes[checkout_request_id] = result_code
        cb = {
            "Body": {
                "stkCallback": {
                    "MerchantRequestID": "mock",
                    "CheckoutRequestID": checkout_request_id,
                    "ResultCode": result_code,
                    "ResultDesc": "The service request is processed successfully."
                    if result_code == 0
                    else "Request cancelled by user",
                }
            }
        }
        if result_code == 0:
            cb["Body"]["stkCallback"]["CallbackMetadata"] = {
                "Item": [
                    {"Name": "Amount", "Value": float(amount if amount is not None else req["amount"])},
                    {"Name": "MpesaReceiptNumber", "Value": receipt or uuid.uuid4().hex[:10].upper()},
                    {"Name": "TransactionDate", "Value": int(datetime.now().strftime("%Y%m%d%H%M%S"))},
                    {"Name": "PhoneNumber", "Value": int((phone or req["phone"]).lstrip("+"))},
                ]
            }
        return cb


class DarajaMpesa:
    """Safaricom Daraja API (sandbox or production) – Lipa Na M-Pesa Online."""

    name = "mpesa"

    def __init__(self, mode: str):
        s = get_settings()
        missing = [
            k
            for k in (
                "mpesa_consumer_key",
                "mpesa_consumer_secret",
                "mpesa_shortcode",
                "mpesa_passkey",
                "mpesa_callback_base_url",
            )
            if not getattr(s, k)
        ]
        if missing:
            raise RuntimeError(f"M-Pesa {mode} mode needs: {', '.join(m.upper() for m in missing)}")
        self.mode = mode
        self.s = s
        self.base = "https://sandbox.safaricom.co.ke" if mode == "sandbox" else "https://api.safaricom.co.ke"

    def _token(self) -> str:
        r = httpx.get(
            f"{self.base}/oauth/v1/generate?grant_type=client_credentials",
            auth=(self.s.mpesa_consumer_key, self.s.mpesa_consumer_secret),
            timeout=15,
        )
        if r.status_code != 200:
            raise ProviderError(f"Daraja auth failed ({r.status_code})")
        return r.json()["access_token"]

    def _callback_url(self) -> str:
        base = self.s.mpesa_callback_base_url.rstrip("/")
        return f"{base}/api/v1/integrations/mpesa/callback/{self.s.mpesa_callback_token}"

    def _password(self) -> tuple[str, str]:
        ts = datetime.now(ZoneInfo("Africa/Nairobi")).strftime("%Y%m%d%H%M%S")
        raw = f"{self.s.mpesa_shortcode}{self.s.mpesa_passkey}{ts}".encode()
        return base64.b64encode(raw).decode(), ts

    def stk_push(self, phone, amount, account_ref, description) -> StkPushResult:
        if amount != amount.to_integral_value():
            raise ProviderError("M-Pesa STK Push supports whole shilling amounts only")
        password, ts = self._password()
        body = {
            "BusinessShortCode": self.s.mpesa_shortcode,
            "Password": password,
            "Timestamp": ts,
            "TransactionType": "CustomerPayBillOnline",
            "Amount": int(amount),
            "PartyA": phone.lstrip("+"),
            "PartyB": self.s.mpesa_shortcode,
            "PhoneNumber": phone.lstrip("+"),
            "CallBackURL": self._callback_url(),
            "AccountReference": account_ref[:12],
            "TransactionDesc": description[:13],
        }
        r = httpx.post(
            f"{self.base}/mpesa/stkpush/v1/processrequest",
            json=body,
            headers={"Authorization": f"Bearer {self._token()}"},
            timeout=20,
        )
        data = r.json() if r.content else {}
        if r.status_code != 200 or data.get("ResponseCode") != "0":
            raise ProviderError(data.get("errorMessage") or data.get("ResponseDescription") or "STK Push failed")
        return StkPushResult(data["CheckoutRequestID"], data["MerchantRequestID"])

    def query(self, checkout_request_id: str) -> QueryResult:
        password, ts = self._password()
        r = httpx.post(
            f"{self.base}/mpesa/stkpushquery/v1/query",
            json={
                "BusinessShortCode": self.s.mpesa_shortcode,
                "Password": password,
                "Timestamp": ts,
                "CheckoutRequestID": checkout_request_id,
            },
            headers={"Authorization": f"Bearer {self._token()}"},
            timeout=20,
        )
        data = r.json() if r.content else {}
        if "ResultCode" not in data:
            return QueryResult(None, data.get("errorMessage", "Pending"))
        return QueryResult(int(data["ResultCode"]), data.get("ResultDesc", ""))


_provider: MpesaProvider | None = None


def get_mpesa() -> MpesaProvider:
    global _provider
    if _provider is None:
        mode = get_settings().mpesa_mode
        _provider = MockMpesa() if mode == "mock" else DarajaMpesa(mode)
    return _provider


def set_mpesa(provider: MpesaProvider | None) -> None:
    global _provider
    _provider = provider


@dataclass
class ParsedCallback:
    checkout_request_id: str
    result_code: int
    result_desc: str
    amount: Decimal | None
    receipt: str | None
    phone: str | None


def parse_callback(payload: dict) -> ParsedCallback:
    """Strict parsing; raises ValueError on anything malformed."""
    try:
        cb = payload["Body"]["stkCallback"]
        cid = str(cb["CheckoutRequestID"])
        code = int(cb["ResultCode"])
        desc = str(cb.get("ResultDesc", ""))[:200]
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError("Malformed STK callback") from e
    if not cid or len(cid) > 100:
        raise ValueError("Malformed CheckoutRequestID")
    amount = receipt = phone = None
    if code == 0:
        items = {
            i.get("Name"): i.get("Value") for i in cb.get("CallbackMetadata", {}).get("Item", []) if isinstance(i, dict)
        }
        try:
            amount = Decimal(str(items["Amount"])).quantize(Decimal("0.01"))
            receipt = str(items["MpesaReceiptNumber"]).upper()
            phone = "+" + str(items["PhoneNumber"]).lstrip("+")
        except (KeyError, ArithmeticError) as e:
            raise ValueError("Successful callback missing metadata") from e
    return ParsedCallback(cid, code, desc, amount, receipt, phone)
