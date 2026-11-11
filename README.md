# DeniTrack

**Every debt accounted for. Every payment tracked.**

DeniTrack is a mobile debt-management system for Kenyan shops, hardware stores, wholesalers
and distributors that sell on credit. It records credit sales, full and partial repayments
(cash, M-Pesa, bank), installment plans, receipts, polite automated reminders and reports,
and works through unreliable connectivity.

| | |
|---|---|
| `backend/` | Python 3.12 · FastAPI · Pydantic 2 · SQLAlchemy 2 · Alembic · PostgreSQL (row-level security) · APScheduler worker |
| `mobile/` | React Native 0.88 (Expo SDK 58) · TypeScript strict · React Navigation 7 · TanStack Query 5 · React Hook Form + Zod · SQLCipher SQLite · SecureStore |
| `docs/` | [Architecture](docs/architecture.md) · [Database schema and ER diagram](docs/database-schema.md) · [API guide](docs/api-guide.md) · [Security and privacy](docs/security.md) · [Deployment and operations](docs/deployment.md) · [User guide](docs/user-guide.md) |

## Quick start

```bash
# Backend
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/alembic upgrade head && .venv/bin/python -m app.seed
.venv/bin/uvicorn app.main:app --reload --port 8000

# Mobile (separate terminal; Android emulator or USB device)
cd mobile
npm ci && cp .env.example .env
npx expo run:android
```

Sign in with the seeded owner `owner.demo@example.com` (password: `DEMO_PASSWORD` in
`backend/app/seed.py`, for development only). Full instructions, Docker, production, backups and
Android release signing are in [docs/deployment.md](docs/deployment.md).

## How money is handled

- Amounts are decimal strings on the wire, `NUMERIC(14,2)` in the database, `Decimal` in Python and
  integer cents (`BigInt`) in TypeScript. Floats are rejected.
- `balance = principal + adjustments − verified payments`, derived from the ledger on every read.
  Status (open, partly paid, overdue, paid, disputed, cancelled) follows from the balance, the due date and
  installment dates, so a paid debt can never show as overdue.
- Typed-in M-Pesa codes and bank transfers stay **awaiting verification** until an owner or admin
  confirms them; STK Push payments are confirmed via the provider callback plus an independent status query.
- M-Pesa payments can also be **read from the owner's phone**: the Android app reads M-Pesa
  "you have received" SMS (sender M-PESA only) and the server records a payment only when the
  payer matches one customer by phone number **and** name, including Safaricom's masked numbers
  (e.g. 0722***712). Anything else waits under More → M-Pesa messages for an owner to match. The
  SMS also confirms a code a cashier typed in, and a transaction code is never applied twice.
- Customers added from the phone's contacts often have nicknames, while M-Pesa shows the name on
  their ID. When an owner matches a payment by hand, that M-Pesa name is learned for the customer,
  so their next payment from the same number clears on its own. Pochi la Biashara payments show no
  number and are never applied automatically: the learned customer is pre-selected for one tap
  (once the Pochi message wording is confirmed against a real message; see Known limitations).
- When credit is recorded, the customer can get an SMS (on by default) naming what they took, the
  amount and the due date. It is sent like reminder SMS, but straight away and outside the weekly limit.
- Overpayments are refused. Posted payments are never edited or deleted (corrections are audited
  reversals and adjustments). Receipt numbers are gapless per business and year.
- Debt and payment creation require an `Idempotency-Key`; retries and offline replays never double-post.

## Integration modes

| Integration | Default | Available | Status |
|---|---|---|---|
| M-Pesa (Daraja STK Push) | `mock` | `sandbox`, `production` | Daraja client implemented but **not tested against Safaricom** (no credentials). Mock provider fully tested |
| Reminder SMS | from the owner's phone | Africa's Talking (`mock`, `sandbox`, `production`) | Phone sending (Android, SEND_SMS) is covered by tests but **not yet tried on a real phone**. The Africa's Talking client is implemented but not tested against the live API |
| M-Pesa SMS reading | off (switched on per phone) | — | Parser tested on known formats, including the 2026 masked numbers; **not yet tried on real M-Pesa messages** |
| Push (FCM) | `mock` | — | Mock only; FCM not implemented |
| WhatsApp | one-tap from a customer's profile | — | Opens WhatsApp with the reminder ready; the person taps send. Automatic WhatsApp (Business API) is not implemented |

The current modes are reported by `GET /api/v1/health` and shown in the app under Settings → About.

## Verification results

Run on Windows 11, 29 Oct – 10 Nov 2026.

| Check | Result |
|---|---|
| Backend tests, SQLite (`pytest`) | **202 passed** (+9 PostgreSQL-only tests skipped) |
| Backend tests, PostgreSQL (same suite) | **200 passed** |
| Migrations and row-level security on PostgreSQL (`tests/test_postgres_rls.py`): upgrade → downgrade → upgrade → `alembic check`, cross-tenant reads/writes blocked for a non-superuser role, full API + worker smoke under RLS | **6 passed** |
| Backend coverage | 88% of `app/` |
| `ruff check` + `ruff format --check`, `mypy app` | clean |
| `pip-audit -r requirements.txt` | no known vulnerabilities |
| Backup → restore drill (`scripts/backup_restore_check.py`, pg_dump/pg_restore) | ledger totals identical for all 5 businesses; 15 RLS policies restored |
| Live server smoke (uvicorn + seeded data) | health OK; dashboard totals hand-checked against the seed (outstanding 79,300.00, overdue 28,900.00, collected today 12,000.00, month 44,000.00, pending 3,000.00); PDF export 200 |
| Mobile `tsc --noEmit` (strict) | clean |
| Mobile `eslint` (eslint-config-expo, incl. React Compiler rules) | clean |
| Mobile tests (`jest`) | **181 passed** (money, phone, dates, validation, offline sync engine, API client refresh, server-address checks, light/dark palette contrast (WCAG AA), splash-on-reopen rules, M-Pesa SMS reading, reminder SMS from the phone, one-tap SMS/WhatsApp reminders, M-Pesa matching screen, credit-notice SMS on the debt form, password show/hide, phone-book search and "From your phone" (permissions, landlines, unreadable contacts), recording a debt for a new contact online and offline with duplicate checks, Pick from contacts, learned M-Pesa names on the customer page, components and accessibility, sign-in, record-payment flow incl. overpayment, M-Pesa and offline queueing, dashboard incl. offline cache) |
| `expo install --check` | dependencies up to date |
| Android release APK (`gradlew assembleRelease`) | **built** on Windows (29.5 min): `ke.denitrack.app` 1.0.0, Android 7.0+ (API 24), target API 36, arm64-v8a + x86_64, JS bundle embedded, SQLCipher compiled in; signed with the debug key (test build) |

PostgreSQL checks used a local PostgreSQL 16 started via the `pgserver` Python package; CI uses the
`postgres:17-alpine` service ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

### Android build

A test APK is in [`builds/denitrack-1.0.0-test.apk`](builds/) (56.3 MB, SHA-256
`D05FF43EEE30064C06B208831979AD10FA5BF972EEFD5D376991CFC5CC8626BD`; `*.apk` is git-ignored).
It is signed with the Android **debug** key, so it is fine for testing but not for the Play Store
(see "Release signing" in [deployment.md](docs/deployment.md)). Its default server is
`http://10.0.2.2:8000` (an emulator talking to this PC). On a phone, tap **Change server** on the
sign-in screen and enter this PC's LAN address, e.g. `192.168.100.3:8000`, with the backend started
using `--host 0.0.0.0`.

Getting it to build on Windows needed three things, all now documented and automated where possible:
long paths enabled, CMake 4.1.2 from the Android SDK (its ninja 1.12.1 handles long paths;
the default CMake's ninja 1.10.2 does not), and a short real build folder. The config plugin
[`plugins/withWindowsLongPathBuild.js`](mobile/plugins/withWindowsLongPathBuild.js) applies the
CMake switch only on Windows hosts, so Linux/macOS/CI builds are unchanged. The final APK was built
with no manual edits to the generated `android/` project.

Unused permissions that Expo adds by default (draw over other apps, legacy external storage, and
changing contacts) are blocked in `app.json`. Reading contacts is asked for the first time staff
search the phone book for a customer. The APK requests internet and network-state access, vibration, and biometrics
(from the secure-storage module).

## Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Owner signs in securely | Done: Argon2id, rotating refresh tokens, revocable sessions, rate limiting |
| 2 | Register customers | Done: E.164 normalisation, duplicate detection, archive |
| 3 | Record debts | Done: single-payment and installment plans |
| 4 | Full and partial payments | Done |
| 5 | Correct balances | Done: derived from ledger; covered by unit and integration tests |
| 6 | Accurate overdue | Done: including installment-level overdue; business time zone |
| 7 | Receipts generated and retrieved | Done: immutable snapshots, share as text or PDF |
| 8 | Dashboard matches records | Done: tested against the ledger and hand-checked on seed data |
| 9 | Reminders without duplicates | Done: unique keys; quiet hours, caps, opt-out, retries |
| 10 | Reports filtered and exported | Done: CSV and PDF, date presets and custom ranges |
| 11 | Unauthorised users blocked | Done: role tests |
| 12 | Businesses isolated | Done: application checks plus PostgreSQL RLS, both tested |
| 13 | Financial changes auditable | Done: audit log with before/after and reason |
| 14 | Core workflows tested | Done: 202 backend + 9 PostgreSQL + 181 mobile tests |
| 15 | Mobile app buildable from docs | Done on Windows (release APK built from the documented steps). The Linux CI Android job has not been run yet |
| 16 | Mock / sandbox / production modes distinct | Done: explicit config, shown in `/health` and the app |
| 17 | Limitations documented | Done: below and in [security.md](docs/security.md) |

## Known limitations and risks

- **The app has not been run on a device or emulator yet.** The APK builds and the code compiles, lints
  and passes tests, but the emulator on the development PC cannot start (no hardware acceleration), so
  no one has used it end to end on a phone. Do a manual pass (sign up, add customer, debt, payment,
  receipt share, offline queue, reminder) before giving it to a business.
- **M-Pesa Daraja and Africa's Talking clients are untested against the real services.** Test them in
  sandbox mode before any production use (steps in deployment.md).
- **Pochi la Biashara messages are not confirmed yet.** The reader expects the usual "You have received
  Ksh… from NAME…" wording; a real Pochi message is needed to confirm it, or Pochi payments may be skipped.
- **SMS features have not been tried on a real phone with real M-Pesa messages yet.** Safaricom changes
  its wording from time to time; check the first payments under More → M-Pesa messages.
- **Google Play restricts the SMS permissions** (READ_SMS, SEND_SMS). They work in an APK you install
  yourself; a Play Store release needs Google's approval for them, or a build without these features.
- No customer self-service portal (the architecture allows adding one), no automatic WhatsApp (one-tap only), no FCM push.
- No customer credit balances: overpayments are refused, and over-collected M-Pesa money is flagged for manual refund.
- Login rate limiting is per-process; use Redis behind multiple API replicas.
- No MFA for owners yet.
- Balances are computed per request, which is fine for thousands of debts per business. See the scaling notes in architecture.md.
- Analytics forecasting (optional in the brief) is not implemented.
- Data-protection notes describe what the software does; they are not a legal compliance assessment.
