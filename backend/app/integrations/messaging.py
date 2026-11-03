"""SMS and push delivery. Mode is explicit: mock (default), sandbox or production.

The mock providers never contact a network; they record messages in memory so tests
and local development can assert on what *would* have been sent.
"""

import logging
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from app.config import get_settings

log = logging.getLogger("denitrack.messaging")


class DeliveryError(Exception):
    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class SentMessage:
    to: str
    body: str


class SmsProvider(Protocol):
    mode: str

    def send(self, to: str, body: str) -> str:
        """Send and return the provider message id. Raise DeliveryError on failure."""


@dataclass
class MockSms:
    mode: str = "mock"
    outbox: list[SentMessage] = field(default_factory=list)
    fail_next: int = 0  # tests set this to simulate provider outages

    def send(self, to: str, body: str) -> str:
        if self.fail_next > 0:
            self.fail_next -= 1
            raise DeliveryError("Simulated provider outage")
        self.outbox.append(SentMessage(to, body))
        return f"mock-{len(self.outbox)}"


class AfricasTalkingSms:
    """Africa's Talking bulk SMS API (https://developers.africastalking.com)."""

    def __init__(self, mode: str, username: str, api_key: str, sender_id: str):
        self.mode = mode
        self.username = username
        self.api_key = api_key
        self.sender_id = sender_id
        host = "api.sandbox.africastalking.com" if mode == "sandbox" else "api.africastalking.com"
        self.url = f"https://{host}/version1/messaging"

    def send(self, to: str, body: str) -> str:
        data = {"username": self.username, "to": to, "message": body}
        if self.sender_id:
            data["from"] = self.sender_id
        try:
            r = httpx.post(
                self.url,
                data=data,
                headers={"apiKey": self.api_key, "Accept": "application/json"},
                timeout=15,
            )
        except httpx.HTTPError as e:
            raise DeliveryError(f"SMS provider unreachable: {e.__class__.__name__}") from None
        if r.status_code >= 500:
            raise DeliveryError(f"SMS provider error {r.status_code}")
        if r.status_code >= 400:
            raise DeliveryError(f"SMS rejected ({r.status_code})", retryable=False)
        recipients = r.json().get("SMSMessageData", {}).get("Recipients", [])
        if not recipients or recipients[0].get("status") != "Success":
            status = recipients[0].get("status") if recipients else "no recipients"
            raise DeliveryError(f"SMS not accepted: {status}", retryable=False)
        return recipients[0].get("messageId", "")


class PushProvider(Protocol):
    mode: str

    def send(self, token: str, title: str, body: str) -> None: ...


@dataclass
class MockPush:
    mode: str = "mock"
    outbox: list[tuple[str, str, str]] = field(default_factory=list)

    def send(self, token: str, title: str, body: str) -> None:
        self.outbox.append((token, title, body))


_sms: SmsProvider | None = None
_push: PushProvider | None = None


def get_sms() -> SmsProvider:
    global _sms
    if _sms is None:
        s = get_settings()
        if s.sms_mode == "mock":
            _sms = MockSms()
        else:
            if not (s.sms_username and s.sms_api_key):
                raise RuntimeError("SMS mode is not 'mock' but SMS credentials are missing")
            _sms = AfricasTalkingSms(s.sms_mode, s.sms_username, s.sms_api_key, s.sms_sender_id)
    return _sms


def get_push() -> PushProvider:
    global _push
    if _push is None:
        s = get_settings()
        if s.push_mode != "mock":
            # FCM HTTP v1 requires a service-account OAuth flow; see docs/deployment.md.
            raise RuntimeError("Only the mock push provider is implemented in this release")
        _push = MockPush()
    return _push


def set_providers(sms: SmsProvider | None = None, push: PushProvider | None = None) -> None:
    global _sms, _push
    _sms, _push = sms, push


def send_password_reset(user, token: str) -> None:
    body = f"DeniTrack password reset code: {token}\nIt expires in {get_settings().password_reset_minutes} minutes."
    if user.phone:
        try:
            get_sms().send(user.phone, body)
            return
        except DeliveryError:
            log.warning("password reset SMS failed")
    # Without a configured email provider, development builds log that a code was issued (never the code).
    log.info("password reset issued for user %s", user.id)
