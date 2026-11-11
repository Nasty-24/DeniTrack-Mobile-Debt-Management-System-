# API guide

Base path `/api/v1`. Interactive OpenAPI docs are at `/docs` (development and staging; disabled in
production). The machine-readable spec is at `/openapi.json`.

## Conventions

- **Auth:** `Authorization: Bearer <access_token>`. Access tokens last 15 minutes; refresh with
  `POST /auth/refresh` (the refresh token rotates every time; reusing an old one ends all sessions).
- **Tenancy:** business-scoped routes are under `/businesses/{business_id}/…`. You get `404` (not `403`)
  for any business you are not an active member of, so ids cannot be probed.
- **Money:** always a JSON **string** with two decimals, e.g. `"1500.00"`. Numbers with a
  fractional part (floats) are rejected with `422`. Currency is KES.
- **Dates:** `YYYY-MM-DD` for business dates (East Africa Time); ISO 8601 UTC for timestamps.
- **Idempotency:** `POST /debts` and `POST /payments` **require** `Idempotency-Key: <uuid>` (8–100 chars).
  Retrying with the same key and body returns the original response with header `Idempotent-Replayed: true`.
  The same key with a different body returns `409 idempotency_key_reused`. `POST /customers` accepts the header optionally.
  Offline clients also send `client_reference` (the same UUID) in the body.
- **Optimistic locking:** `PATCH` on customers and debts must include the `version` you read; a stale version returns `409 version_conflict`.
- **Pagination:** list endpoints take `limit` (max 200) and `offset`, and return `{items, total, limit, offset}`.
- **Errors:** always
  ```json
  {"error": {"code": "overpayment", "message": "Payment exceeds the outstanding balance by KSh 100.00", "details": null}}
  ```
  `401` unauthenticated, `403` role not allowed, `404` not found or not yours, `409` conflict or duplicate,
  `422` validation or business rule, `429` rate limited. Validation errors put
  `[{field, message}]` in `details`.

## Roles

| Action | Owner | Admin | Cashier |
|---|:-:|:-:|:-:|
| View customers, debts, payments, dashboard | ✓ | ✓ | ✓ |
| Add customers | ✓ | ✓ | setting (`cashier_can_register_customers`) |
| Record debts and payments, request M-Pesa | ✓ | ✓ | ✓ |
| Edit customers or debts, adjust, cancel, dispute | ✓ | ✓ | — |
| Verify / reject / reverse payments | ✓ | ✓ | — |
| Reports and exports | ✓ | ✓ | setting (`cashier_can_view_reports`) |
| Settings, templates, run reminders, audit log, list staff | ✓ | ✓ | — |
| Add or change staff, edit business details | ✓ | — | — |

## Endpoints

### Authentication — `/auth`

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | Creates owner + business. Body: `full_name, email, password (≥10), phone?, business_name` |
| POST | `/auth/login` | `{email, password}` → tokens, user, memberships. 5 attempts/min |
| POST | `/auth/refresh` | `{refresh_token}` → new token pair |
| POST | `/auth/logout`, `/auth/logout-all` | Revoke this session / all sessions |
| GET | `/auth/me`, `/auth/memberships` | Profile and businesses |
| POST | `/auth/change-password` | Signs out other devices |
| POST | `/auth/password-reset/request` → `/confirm` | SMS code; always `202` on request |
| POST | `/auth/device-tokens` | Register a push token |

### Business — `/businesses/{bid}`

| Method | Path | Notes |
|---|---|---|
| GET/PATCH | `` | Business details (PATCH: owner) |
| GET/PATCH | `/settings` | Reminder offsets/channels/quiet hours/weekly cap, cashier permissions, payment methods |
| GET/POST | `/staff` | POST: `full_name, email, phone?, role (admin|cashier), temporary_password` |
| PATCH | `/staff/{membership_id}` | `{role?, is_active?}` |
| GET / PUT | `/reminder-templates`, `/reminder-templates/{upcoming|due_today|overdue|credit_notice}` | Placeholders: `{customer_name} {business_name} {amount} {due_date} {business_phone}`; `credit_notice` also `{items} {credit_date}` |
| GET | `/audit-logs` | Filters: `entity_type, entity_id, actor_user_id, action` (prefix), `date_from, date_to` |
| GET / POST | `/notifications`, `/notifications/read-all`, `/notifications/{id}/read` | |

### Customers

| Method | Path | Notes |
|---|---|---|
| GET | `/customers` | `q` (name, phone digits, or customer number), `status=active|archived|all`, `balance=any|outstanding|overdue`, `sort=name|balance|recent`. Items include `outstanding_balance`, `overdue_amount`, `pending_verification`, `open_debts` |
| POST | `/customers` | Phone normalised to E.164. Likely duplicates (same phone or name) → `409 possible_duplicate` with matches in `details`; resend with `allow_duplicate: true` to override |
| GET/PATCH | `/customers/{id}` | PATCH requires `version` |
| POST | `/customers/{id}/archive`, `/restore` | Archived customers keep history but cannot get new debts |
| GET | `/customers/{id}/debts`, `/customers/{id}/payments` | |
| GET | `/customers/check/duplicates?name=&phone=` | Pre-check while typing |
| GET | `/customers/{id}/mpesa-names` | Owner/admin: M-Pesa names learned for this customer (newest first) |
| POST | `/customers/{id}/mpesa-names/{name_id}/remove` | Owner/admin: forget a wrongly learned name; returns the remaining names. Audited |

### Debts

| Method | Path | Notes |
|---|---|---|
| GET | `/debts` | `status=outstanding|open|partially_paid|overdue|paid|cancelled|disputed|all`, `customer_id`, `due_within_days`, `created_by`, `incurred_from/to`, `q`, `sort=due_date|balance|recent|days_overdue` |
| POST | `/debts` | **Idempotency-Key required.** `customer_id, description, principal, incurred_on, due_date, terms?, reference?` plus optionally `installment_plan {count, frequency: weekly|monthly, first_due_date}` or `installments [{due_date, amount}]` (must sum to principal). `notify_customer: true` queues one SMS to the customer (a credit notice: items, amount, dates), sent like reminder SMS but regardless of quiet hours and the weekly limit; reminder history shows it with `purpose: "credit_notice"` |
| GET | `/debts/{id}` | Includes `schedule` (per-installment status), `adjustments`, `payments` |
| PATCH | `/debts/{id}` | `version` + `description/due_date/terms/reference`. Principal cannot be edited; use adjustments |
| POST | `/debts/{id}/adjustments` | `{amount: "-200.00", reason}`; cannot take `total_due` below what has been paid |
| POST | `/debts/{id}/flag` | `{flag: cancelled|disputed|none, reason}`; cancellation only allowed with no payments |

Every debt response includes the derived `total_due, paid, pending_verification, balance, overdue_amount, status, days_overdue, next_due_date`.

### Payments and receipts

| Method | Path | Notes |
|---|---|---|
| GET | `/payments` | `customer_id, method, verification, status=posted|reversed|all, recorded_by, date_from, date_to` |
| POST | `/payments` | **Idempotency-Key required.** `customer_id, amount, method, paid_at?, external_reference?, notes?, allocations?[{debt_id, amount}], client_reference?`. Without `allocations`, the earliest-due debt is paid first. Overpayment → `422 overpayment`. M-Pesa needs a 10-character code; a posted duplicate reference → `409 duplicate_reference`. Cash is counted immediately; other methods are `pending` until verified |
| POST | `/payments/{id}/verify` | `{approve: bool, note?}`; approving issues the receipt |
| POST | `/payments/{id}/reverse` | `{reason}`; restores the balance and keeps the record |
| GET | `/payments/{id}/receipt`, `/receipts/{number}` | Immutable snapshot plus `share_text`; shows `payment_status` (reversed receipts are marked) |
| POST | `/payment-requests/mpesa` | `{debt_id, amount, phone?}`: sends an STK Push. Creates a *request* only |
| GET | `/payment-requests/{id}` | Poll `status`: `pending → succeeded | failed | needs_review` |
| POST | `/integrations/mpesa/callback/{token}` | Daraja callback (not in public docs); always acknowledged |

### Reminders, reports, sync, health

| Method | Path | Notes |
|---|---|---|
| GET | `/reminders` | History; filters `status, channel, customer_id, debt_id` |
| POST | `/reminders/run` | Plan and send due reminders now |
| POST | `/reminders/{id}/retry` | Re-queue a failed reminder (balance re-checked before sending) |
| GET | `/reminders/phone-queue` | Owner/admin phone: due reminder SMS to send from its SIM, each reserved for 15 minutes (quiet hours, opt-out, weekly limit applied) |
| POST | `/reminders/{id}/phone-result` | `{sent, error}`: the phone reports the outcome; safe to repeat |
| POST | `/reminders/manual` | `{customer_id, channel: sms|whatsapp}`: a reminder to send now, with the message, phone and (WhatsApp) a `wa.me` link |
| POST | `/mpesa-sms` | Owner/admin phone: up to 100 M-Pesa SMS `{sender, body, received_at}`; each is applied, confirms a typed-in code, or waits for review |
| GET | `/mpesa-sms` | M-Pesa messages and outcomes; filter `status` (`needs_review`, `applied`, ...) |
| POST | `/mpesa-sms/{id}/assign`, `/mpesa-sms/{id}/dismiss` | Record an unmatched payment for a chosen customer (this also learns the payer's M-Pesa name for that customer), or mark it as not a debt payment |
| GET | `/dashboard` | Totals, due in 7 days, recent payments and debts |
| GET | `/reports/{name}` | `collections` (`group_by=day|week|month`), `credit_issued`, `aging`, `customer_balances`, `settlement`, `employee_activity`, `exceptions`. `start`, `end` (defaults: month to date; max 3 years) |
| GET | `/reports/{name}/export?format=csv|pdf` | Collections, credit issued, aging, customer balances, employee activity. Exports are audited |
| GET | `/sync/changes?since=` | Customers changed since, plus all outstanding or changed debts, plus `server_time` for the next call |
| GET | `/health` | Database status and integration modes (`mock` / `sandbox` / `production`) |

### How M-Pesa messages are matched

A payment is applied automatically **only when the phone number matches**. A learned M-Pesa name
(see `/mpesa-sms/{id}/assign`) counts as the customer's name.

| Message | Result |
|---|---|
| Number matches one customer, and their name or a learned M-Pesa name matches | `applied` (a learned name beats a partial name when the number fits several customers) |
| Number matches, names don't | `needs_review`, that customer suggested when only one has the number |
| No number (e.g. Pochi la Biashara) or a number no customer has, and exactly one active customer has that learned name | `needs_review` with that customer suggested; never applied automatically |
| As above, two or more customers have that learned name | `needs_review`, no suggestion |
| As above, no learned name | `needs_review`; a customer whose full name matches is suggested |

## Example: recording a payment

```http
POST /api/v1/businesses/6b1…/payments
Authorization: Bearer eyJ…
Idempotency-Key: 3f0c2a8e-5b8a-4b44-9c55-1d2f7e9a0b11
Content-Type: application/json

{"customer_id": "a71…", "amount": "2500.00", "method": "mpesa", "external_reference": "SLK4H7R2QX"}
```

```json
{
  "id": "…", "amount": "2500.00", "method": "mpesa", "verification_status": "pending",
  "status": "posted", "receipt_number": null,
  "allocations": [{"debt_id": "d2…", "amount": "2500.00"}]
}
```

An owner then calls `POST /payments/{id}/verify {"approve": true}`. The payment then counts toward the balance and receives `RCT-2026-000124`.
