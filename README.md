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
- Overpayments are refused. Posted payments are never edited or deleted (corrections are audited
  reversals and adjustments). Receipt numbers are gapless per business and year.
- Debt and payment creation require an `Idempotency-Key`; retries and offline replays never double-post.

## Integration modes

| Integration | Default | Available | Status |
|---|---|---|---|
| M-Pesa (Daraja STK Push) | `mock` | `sandbox`, `production` | Daraja client implemented but **not tested against Safaricom** (no credentials). Mock provider fully tested |
| SMS (Africa's Talking) | `mock` | `sandbox`, `production` | Client implemented but **not tested against the live API**. Mock provider fully tested |
| Push (FCM) | `mock` | — | Mock only; FCM not implemented |
| WhatsApp Business | — | — | Not implemented; reminders on this channel are recorded as failed with a clear reason |

The current modes are reported by `GET /api/v1/health` and shown in the app under Settings → About.

## Verification results

Run on Windows 11, 29–31 Oct 2026.

| Check | Result |
|---|---|
| Backend tests, SQLite (`pytest`) | **121 passed** (+5 PostgreSQL-only tests skipped) |
| Backend tests, PostgreSQL (same suite) | **121 passed** |
| Migrations and row-level security on PostgreSQL (`tests/test_postgres_rls.py`): upgrade → downgrade → upgrade → `alembic check`, cross-tenant reads/writes blocked for a non-superuser role, full API + worker smoke under RLS | **5 passed** |
| Backend coverage | 88% of `app/` |
| `ruff check` + `ruff format --check`, `mypy app` | clean |
| `pip-audit -r requirements.txt` | no known vulnerabilities |
| Backup → restore drill (`scripts/backup_restore_check.py`, pg_dump/pg_restore) | ledger totals identical for all 5 businesses; 15 RLS policies restored |
| Live server smoke (uvicorn + seeded data) | health OK; dashboard totals hand-checked against the seed (outstanding 79,300.00, overdue 28,900.00, collected today 12,000.00, month 44,000.00, pending 3,000.00); PDF export 200 |
| Mobile `tsc --noEmit` (strict) | clean |
| Mobile `eslint` (eslint-config-expo, incl. React Compiler rules) | clean |
| Mobile tests (`jest`) | **134 passed** (money, phone, dates, validation, offline sync engine, API client refresh, server-address checks, light/dark palette contrast (WCAG AA), splash-on-reopen rules, components and accessibility, sign-in, record-payment flow incl. overpayment, M-Pesa and offline queueing, dashboard incl. offline cache) |
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

Unused permissions that Expo adds by default (draw over other apps, legacy external storage) are
blocked in `app.json`. The APK requests internet and network-state access, vibration, and biometrics
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
| 14 | Core workflows tested | Done: 121 backend + 5 PostgreSQL + 134 mobile tests |
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
- No customer self-service portal (the architecture allows adding one), no WhatsApp channel, no FCM push.
- No customer credit balances: overpayments are refused, and over-collected M-Pesa money is flagged for manual refund.
- Login rate limiting is per-process; use Redis behind multiple API replicas.
- No MFA for owners yet.
- Balances are computed per request, which is fine for thousands of debts per business. See the scaling notes in architecture.md.
- Analytics forecasting (optional in the brief) is not implemented.
- Data-protection notes describe what the software does; they are not a legal compliance assessment.
