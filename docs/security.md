# Security and privacy

## Controls implemented

| Area | Control | Where | Tested |
|---|---|---|---|
| Passwords | Argon2id (argon2-cffi defaults); at least 10 characters | `app/security` | yes |
| Sign-in | Identical response and timing for unknown email vs wrong password; 5 attempts/min per IP+email | `api/auth.py` | yes |
| Sessions | 15-minute JWT access tokens bound to a server-side session; 30-day refresh tokens stored as SHA-256 and rotated on every use; reuse of a rotated refresh token revokes **all** of that user's sessions | `api/auth.py`, `api/deps.py` | yes |
| Revocation | Logout, logout-all, password change and password reset revoke sessions immediately (access tokens are checked against the session row) | `api/auth.py` | yes |
| Account recovery | Single-use, 30-minute reset codes (hashed at rest), sent by SMS; the response never reveals whether an account exists | `api/auth.py` | yes |
| Staff onboarding | Temporary passwords force a change at first sign-in | `api/business.py`, mobile `AppFlow` | yes |
| M-Pesa SMS reading | Off unless an owner/admin switches it on for that phone. The app reads only messages from the sender M-PESA, from the moment it is switched on; ordinary numbers cannot pose as M-Pesa. Only owners/admins may submit them; a payment is recorded only on a phone **and** name match; transaction codes are unique per business; the owner's M-Pesa balance is redacted before storing | `services/mpesa_sms.py`, `modules/denitrack-sms` | yes (parser, matching, duplicates, roles, tenant isolation) |
| Reminder SMS from the phone | Reminders are reserved for one phone at a time and remembered on the phone once sent, so a lost report never causes a second SMS; opt-out, quiet hours and the weekly limit are applied by the server | `services/reminders.py`, mobile `services/phoneSms.ts` | yes |
| Authorisation | Role guards (owner / admin / cashier) on every privileged action | `api/deps.py`, services | yes |
| Tenant isolation | Business id from the URL accepted only with an active membership (404 otherwise); every query filters by `business_id`; PostgreSQL RLS as a second layer | `api/deps.py`, migration `0002` | yes, including RLS under a non-superuser role |
| IDOR | UUID ids; every lookup is `id AND business_id` | services | yes |
| Injection | SQLAlchemy bound parameters only; reminder templates allow a fixed set of placeholders; CSV exports neutralise formula injection; receipt PDF HTML is escaped | throughout | yes |
| Replays / duplicates | Idempotency keys; `client_reference`; unique posted M-Pesa reference; unique provider event key | services | yes |
| Input validation | Pydantic on every request; money must be a decimal with at most 2 places (floats rejected) | `schemas` | yes |
| Errors | Structured `{error:{code,message,details}}`; no stack traces or internals returned | `errors.py` | yes |
| Transport | HTTPS required in production (reverse proxy); Android cleartext only allowed when the build points at an `http://` development server | `app.config.js`, deployment | config |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Cache-Control: no-store` on API responses | `main.py` | yes |
| Secrets | Environment only; production refuses to start with SQLite, or with a default or `.env.example` placeholder JWT secret, callback token or database password | `config.py` | `test_config.py` |
| Logging | Messages containing password/token/API-key keywords are redacted; no request bodies logged | `main.py` | manual |
| Mobile storage | Tokens in Android Keystore / iOS Keychain (`expo-secure-store`, this-device-only); local database encrypted with SQLCipher using a random 256-bit key held in the keystore; all local data wiped on sign-out; `allowBackup=false` | `storage/`, `database/`, `app.json` | partly (logic tested; encryption needs a device build) |
| M-Pesa | Secret callback URL token (constant-time compare) + strict parsing + must match a request we created + amount/phone match + independent STK status query before posting | `services/provider_events.py` | yes (mock provider) |
| Dependencies | `pip-audit` and `npm audit` in CI | `.github/workflows/ci.yml` | `pip-audit`: no known vulnerabilities at time of writing |

## Known gaps and recommendations

- **Rate limiting is in-process.** Use Redis (or the reverse proxy) when running more than one API replica.
- **No MFA** for owners yet. Recommended before onboarding large distributors.
- **Daraja callbacks are not signed by Safaricom.** Restrict the callback path to
  Safaricom's published IP ranges at the reverse proxy, in addition to the controls above.
- **Push notifications** use a mock provider only; FCM credentials and token clean-up are not implemented.
- **Audit logs** are append-only by convention. For tamper evidence, ship them to write-once
  storage, or revoke `UPDATE/DELETE` on `audit_logs` from the application role.
- **Encryption at rest on the server** depends on the host (encrypted disk or managed
  PostgreSQL with storage encryption). It is not configured by this repository.
- The local-database encryption status is shown honestly in Settings. Expo Go does not
  include SQLCipher, so use a development or release build.

## Kenya Data Protection Act, 2019: implementation notes

These notes describe what the software does. They are **not** a compliance certification;
the business operating DeniTrack is the data controller and should take advice and
register with the Office of the Data Protection Commissioner (ODPC) as required.

| Principle / right | How DeniTrack supports it | Business responsibility |
|---|---|---|
| Lawful basis | Records exist to perform a credit-sale contract and keep accounting records. In-app privacy notice shown at sign-up and in Settings | Tell customers what is recorded (e.g. a notice at the till) |
| Data minimisation | Only name and phone are required; email, address and notes are optional; notes guidance limits them to business needs | Do not record unrelated personal details in notes |
| Purpose limitation and confidentiality | Reminders go only to the customer's own number; templates cannot add arbitrary fields; staff see only their business | Train staff not to discuss balances with third parties |
| Marketing / contact preferences | Per-customer SMS opt-out, quiet hours, weekly cap; polite default wording | Honour opt-out requests promptly |
| Access and rectification | Owners/admins can view and correct customer details (audited) | Respond to requests within statutory timelines |
| Erasure | Customers can be archived. Financial transactions are retained because accounting and tax law require it; after the retention period, anonymise customers (procedure below) | Set and document a retention period (commonly 7 years for financial records; confirm with your adviser) |
| Security safeguards | See the table above | Use strong passwords; remove staff access promptly |
| Breach handling | Audit logs, session revocation (logout-all) | Notify the ODPC and affected people as the Act requires |

### Anonymisation procedure (after retention period)

Run in a maintenance window, per business:

```sql
UPDATE customers
SET name = 'Former customer ' || customer_number,
    name_normalized = 'former customer ' || lower(customer_number),
    phone = '+0000000000', email = NULL, address = NULL, notes = NULL, sms_opt_in = false
WHERE business_id = :business_id AND status = 'archived' AND updated_at < now() - interval '7 years';
```

Receipt snapshots also contain customer names and phones. Apply the same treatment with
`jsonb_set` on `receipts.snapshot` for the affected payments.
