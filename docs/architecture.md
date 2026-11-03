# Architecture

```
┌────────────────────────────┐        HTTPS / JSON        ┌───────────────────────────────┐
│ Mobile app (Expo / RN)     │ ─────────────────────────▶ │ FastAPI  /api/v1              │
│  screens → hooks → api     │   Bearer JWT (15 min)      │  routers → services → repos   │
│  TanStack Query cache      │   Idempotency-Key          │  Pydantic validation          │
│  SQLCipher SQLite:         │                            │  SQLAlchemy 2 + Alembic       │
│   outbox, read cache       │ ◀─── /sync/changes ─────── │                               │
│  SecureStore: tokens, key  │                            └──────────────┬────────────────┘
└────────────────────────────┘                                           │ RLS-scoped tx
                                                          ┌──────────────▼────────────────┐
  Safaricom Daraja ── STK callback ──▶ /integrations/...  │ PostgreSQL (row-level security)│
  Africa's Talking ◀── SMS ─────────── worker (APScheduler)└───────────────────────────────┘
```

## Backend (`backend/app`)

| Layer | Location | Responsibility |
|---|---|---|
| Routers | `api/*.py` | HTTP, auth dependencies, pagination, idempotent responses |
| Tenancy and auth | `api/deps.py`, `security/` | JWT and session validation, membership check, role guards, RLS scope |
| Services | `services/*.py` | Business rules: debts, payments, receipts, reminders, provider callbacks |
| Pure rules | `services/ledger.py` | Decimal money, balances, status, installments, allocation (no database) |
| Repositories | `repositories/debts.py` | Ledger aggregation queries |
| Reports | `reports/` | Dashboard, collections, aging, exports (CSV and PDF) |
| Integrations | `integrations/` | SMS (mock / Africa's Talking), push (mock), M-Pesa (mock / Daraja) |
| Workers | `workers/scheduler.py` | Reminder planning and dispatch every 15 minutes |

### Key decisions

1. **Balances are derived, never stored.** See `database-schema.md`. Every figure
   (dashboard, reports, receipts, reminders) goes through the same `DebtFigures` rules.
2. **Unverified money does not reduce a balance.** Cash recorded in person is
   `not_required`. M-Pesa codes typed by staff, bank transfers and card payments are
   `pending` until an owner or admin verifies them. Pending amounts *do* reduce the
   `allocatable` headroom, so a debt cannot be overpaid while verification is outstanding.
   This trades "the balance changes immediately" for "the balance is never wrong"; the UI
   shows pending amounts alongside the balance.
3. **Overpayment is refused.** There is no customer credit balance in v1. Money that
   arrives through M-Pesa for an already-settled debt is never dropped: its request is
   marked `needs_review` and the owner is alerted to refund it or apply it manually.
4. **Default allocation rule:** the earliest due debt first (installment debts use their
   next unpaid installment date), ties broken by date incurred. Staff can instead apply
   a payment to one specific debt. Allocations are stored, so history is reproducible.
5. **Corrections are append-only.** Debt amounts change only via signed adjustments with
   a reason. Payments are reversed, never edited or deleted. Both are audited.
6. **Idempotency everywhere money moves.** `POST /debts` and `POST /payments` require an
   `Idempotency-Key`. The stored response is replayed on retry, and a different body with the
   same key is rejected with 409. `client_reference` gives a second, independent dedupe
   for offline replays.
7. **Numbering** uses a per-business counter row incremented with `UPDATE … RETURNING`
   (row lock in PostgreSQL), so receipt numbers (`RCT-2026-000123`) are gapless and unique.
8. **Concurrency.** Recording a payment locks the customer's debt rows (`FOR UPDATE OF debts`),
   so two cashiers cannot both pass the balance check. Debt and customer edits use a
   `version` column (optimistic locking), so a stale edit gets 409, not a silent overwrite.
9. **Time.** Stored in UTC. "Today", overdue, due-soon and report periods are evaluated
   in the business time zone (East Africa Time).

## Mobile (`mobile/src`)

| Folder | Contents |
|---|---|
| `theme/` | Design tokens (light and dark palettes, spacing, type scale), `ThemeProvider` (System / Light / Dark, remembered on the device) |
| `components/` | Design-system primitives, finance components (money, badges, tiles), states, form bindings |
| `screens/` | 20 screens (see the user guide) |
| `navigation/` | Auth stack → (forced password change) → tabs plus detail stack |
| `hooks/` | Session, offline outbox, TanStack Query data hooks with offline fallback |
| `services/` | API client (refresh single-flight, structured errors), outbox sync engine |
| `database/` | SQLCipher-encrypted SQLite: outbox, id map, read cache |
| `storage/` | SecureStore: tokens and database key |
| `validation/` | Zod schemas mirroring server rules |
| `utils/` | BigInt-cents money maths, Kenyan phone normalisation, EAT dates |

## Offline support

| Works offline | Requires a connection |
|---|---|
| Viewing the last-synced copy of any screen you opened, clearly labelled with its age | Payment verification and reversal |
| Adding a customer | Debt adjustments, cancellation and disputes |
| Recording a debt (including for a customer added offline) | M-Pesa STK Push requests |
| Recording a cash or M-Pesa-code payment | Staff, settings and template changes |
| | Reports and exports, sign-in, password changes |

How the outbox works (`services/outbox.ts`):

1. An offline-capable form generates one UUID per submission. If online, it is sent as the
   `Idempotency-Key`. If the request fails for network reasons, the same UUID becomes the
   outbox entry id. So if the first attempt actually reached the server, the replay is
   de-duplicated rather than creating a second record.
2. The queue replays in creation order when connectivity returns, when the app comes to the
   foreground, and every 60 seconds. Network or 5xx errors keep the entry with exponential
   backoff (5 s up to a 15 min cap).
3. If the server rejects an entry (overpayment because someone else recorded a payment
   meanwhile, validation failure, or permission), the entry is marked **failed** with the
   server's reason. It is never silently discarded. The user can retry or explicitly discard it.
4. Customers created offline get a `local:<uuid>` id. Queued debts that reference it are
   rewritten to the server id once the customer is created. If the customer is rejected,
   its dependants are marked failed with an explanation.
5. Queued items appear only in the sync bar and sync queue, never in payment history or
   balances, so a queued payment is never shown as server-confirmed.
6. Signing out wipes local data. If unsynced entries exist, the user must explicitly confirm losing them.

Conflict policy: the server is authoritative for all financial state. Creates are
idempotent. Edits (customers, debts) use `version` checks and fail with a clear message
rather than overwrite. A queued payment that would now overpay is rejected for review, not trimmed.

## Scaling notes

- Balance aggregation is per request. For businesses with tens of thousands of open
  debts, add a materialised per-debt summary refreshed in the same transaction as each
  ledger write, and keep the derivation as a reconciliation check.
- The login rate limiter is in-process. Behind multiple API replicas, back it with Redis.
- The reminder worker is safe to run on several machines (unique keys plus `SKIP LOCKED`).
