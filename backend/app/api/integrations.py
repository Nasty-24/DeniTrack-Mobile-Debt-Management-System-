import hmac

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.errors import NotFound
from app.services.provider_events import process_stk_callback

router = APIRouter(prefix="/integrations", tags=["integrations"])


@router.post("/mpesa/callback/{token}", include_in_schema=False)
async def mpesa_callback(token: str, request: Request, db: Session = Depends(get_db)):
    # Daraja callbacks are unsigned, so: secret URL token + strict parsing + matching a request
    # we created + an independent status query before any money is posted.
    if not hmac.compare_digest(token, get_settings().mpesa_callback_token):
        raise NotFound("Not found")
    try:
        payload = await request.json()
    except ValueError:
        payload = {"_raw": (await request.body())[:2000].decode(errors="replace")}
    if not isinstance(payload, dict):
        payload = {"_raw": str(payload)[:2000]}
    outcome = process_stk_callback(db, payload)
    # Always acknowledge so Daraja stops retrying; the outcome is recorded on our side.
    return {"ResultCode": 0, "ResultDesc": "Accepted", "outcome": outcome}
