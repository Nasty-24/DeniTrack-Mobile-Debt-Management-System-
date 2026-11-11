# Deployment and operations

## 1. Local development

### Backend (Python 3.12)

```bash
cd backend
python -m venv .venv            # on Windows with a very long project path, create it somewhere short instead
.venv/bin/pip install -r requirements-dev.txt     # Windows: .venv\Scripts\pip
.venv/bin/alembic upgrade head                    # SQLite dev DB by default (denitrack-dev.db)
.venv/bin/python -m app.seed                      # demo business, owner and cashier
.venv/bin/uvicorn app.main:app --reload --port 8000
```

- API docs: http://localhost:8000/docs (disabled in production).
- Demo accounts (development only, created by `app/seed.py`): `owner.demo@example.com`
  and `cashier.demo@example.com`; the password is `DEMO_PASSWORD` in `app/seed.py`.
- The reminder worker: `python -m app.workers.scheduler` (or `--once` for a single pass).

> **Windows note.** If the project lives under a very long path, compiled Python packages
> (argon2) can fail to load with "The filename or extension is too long". Create the
> virtualenv at a short path, e.g. `C:\venvs\denitrack`.

### Tests

```bash
cd backend
pytest -q                                  # SQLite, about 1 minute
DENITRACK_DATABASE_URL=postgresql+psycopg://postgres@localhost/dt_test pytest -q
DENITRACK_PG_ADMIN_URL=postgresql+psycopg://postgres@localhost/dt_migrate pytest tests/test_postgres_rls.py
ruff check app tests migrations && mypy app && pip-audit -r requirements.txt
```

The RLS test drops and rebuilds the `public` schema of the database it is given, so use a scratch database.

### Mobile (Node 22.13+ or 24+)

```bash
cd mobile
npm ci
cp .env.example .env              # set EXPO_PUBLIC_API_URL
npx tsc --noEmit && npx eslint . && npx jest
npx expo run:android              # development build on an emulator or USB device
```

`10.0.2.2` reaches the host machine from the Android emulator; on a physical phone use
your computer's LAN IP. Expo Go cannot be used, because SQLCipher and other native
modules need a development build.

## 2. Production backend

1. Provision a Linux host or managed container service, and PostgreSQL 15+ (managed is
   preferable: automated backups, storage encryption, point-in-time recovery).
2. `cp .env.example .env` and set **every** secret (generate with
   `python -c "import secrets; print(secrets.token_urlsafe(48))"`). The API refuses to
   start in production with default secrets or SQLite.
3. Start the database and run migrations as the schema owner, then start the API and
   worker as the restricted `denitrack_app` role:
   ```bash
   docker compose up -d db
   docker compose run --rm migrate
   docker compose up -d api worker
   ```
   With managed PostgreSQL, run `backend/scripts/create_app_role.sh`'s SQL once as the owner,
   then point `migrate` at the owner role and `api`/`worker` at `denitrack_app`.
4. Put a TLS-terminating reverse proxy (Caddy, nginx, or a cloud load balancer) in front of
   `127.0.0.1:8000`. Enforce HTTPS and HSTS, and limit request size (1 MB is ample).
5. Health check: `GET /api/v1/health` returns database status and integration modes
   (`mock` / `sandbox` / `production`). `GET /health` is a plain readiness check for platforms
   that probe a fixed path: `{"status": "ok"}`, or `503` while the database is unreachable.

The API refuses to start in production while `DENITRACK_JWT_SECRET`, `DENITRACK_MPESA_CALLBACK_TOKEN` or
the database password still has a default or `change-me` value from `.env.example`.

### On an app platform (e.g. PrimeCloud)

Platforms that build from GitHub and run managed PostgreSQL need one app and one database. The
reminder worker is only needed when reminders go through an SMS provider. With reminders sent from the
owner's phone (the default), the phone's own check plans them.

| Setting | Value |
|---|---|
| Source | this repository, branch `main` |
| Root directory / Dockerfile | `backend` / `backend/Dockerfile` (the Dockerfile's `COPY` paths are relative to `backend/`) |
| Port | `8000` |
| Health check path | `/health` (or `/api/v1/health` where the platform lets you choose) |
| Pre-deploy command | `python -m alembic upgrade head` |
| Start command | empty (the Dockerfile's command, with proxy headers on) |
| Database binding | env var name `DENITRACK_DATABASE_URL` |
| Environment | `DENITRACK_ENVIRONMENT=production`; `DENITRACK_JWT_SECRET` and `DENITRACK_MPESA_CALLBACK_TOKEN` as secrets |

On PrimeCloud the database binding is injected as `DATABASE_URL`, and the console has no
pre-deploy field, so set the app's **Run command** to copy the URL, migrate, then start:

```bash
if [ -z "$DENITRACK_DATABASE_URL" ] && [ -n "$DATABASE_URL" ]; then export DENITRACK_DATABASE_URL="$DATABASE_URL"; fi; python -m alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips "*"
```

PrimeCloud's deploy check probes `/health`. Settings typed into the new-application form may not be
kept; check them afterwards under the app's **Configuration** tab. PrimeCloud's database user is a
superuser, so also set `DENITRACK_DB_ROLE=denitrack_app` (see below).

Platforms usually provide a plain `postgresql://…` URL, sometimes with pool options such as
`connection_limit`. The API accepts it as given: it selects the psycopg driver and drops options libpq
does not understand.

On a platform with one database user, migrations and the API share that user. Row-level security still
applies to it (the tables use `FORCE ROW LEVEL SECURITY`) unless the user is a superuser or has
`BYPASSRLS`. Check in the platform's database shell; both values should be `f`:
`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;`
If the user is a superuser, migration `0005` (run as that user) creates the no-login role
`denitrack_app`, which cannot bypass row-level security. Set `DENITRACK_DB_ROLE=denitrack_app` on the
API (and worker) after that migration has run, and every connection switches to it, so RLS applies.
Migrations still run as the platform user, which owns the tables.
If the worker is needed, add a second app from the same source with start command
`python -m app.workers.scheduler` and no pre-deploy command.

#### Connecting the app to the hosted server

1. Take the app's HTTPS address from the platform: its default address, or your custom domain once
   its certificate is issued. `https://<address>/api/v1/health` must answer with `"status": "ok"`.
2. On each phone, on the sign-in screen, tap **Change server**, enter `https://<address>` and tap
   **Check and save**. The phone keeps that address.
3. For phones you hand out, build the APK with the address built in, so nobody has to type it:
   `EXPO_PUBLIC_API_URL=https://<address> npx expo prebuild --platform android`, then
   `./gradlew assembleRelease` (see "Android builds" below). A build with an `https://` default refuses
   plain-`http` servers.
4. Data on a test server does not move with the app. Create the business on the hosted server (sign
   up again there), or restore a database dump into the platform's database if it allows that.
5. The phone keeps its **This phone** switches (sending SMS, reading M-Pesa). For the new business,
   M-Pesa reading starts from the first time it runs there, so earlier messages are not read again.

### Enabling real integrations

**SMS from the owner's phone (default).** Nothing to configure on the server. Reminder SMS wait for the
owner's phone, which collects them (`GET /reminders/phone-queue`), sends them from its SIM and reports
back. Turn it on in the app under Settings → This phone. The same section turns on reading M-Pesa
messages. Both need the Android app (permissions READ_SMS and SEND_SMS, declared by
`mobile/modules/denitrack-sms`). Google Play only allows these permissions after a policy review, so
distribute the APK directly or apply for the exception before a Play Store release.

**SMS (Africa's Talking), optional.** Choose "SMS provider" under Reminders → Schedule → Send SMS from. Create an account, register a sender ID, then set
`DENITRACK_SMS_MODE=sandbox` (test) or `production`, plus `DENITRACK_SMS_USERNAME`,
`DENITRACK_SMS_API_KEY` and `DENITRACK_SMS_SENDER_ID`. Send a reminder from the Reminders
screen ("Check and send due reminders now") and confirm delivery in the Africa's Talking dashboard.

**M-Pesa (Safaricom Daraja).** Not live in this repository; the mock provider is used unless configured.
1. Create an app at https://developer.safaricom.co.ke and use the sandbox shortcode and passkey.
2. Set `DENITRACK_MPESA_MODE=sandbox`, the consumer key and secret, shortcode, passkey, a
   public HTTPS `DENITRACK_MPESA_CALLBACK_BASE_URL`, and a long random `DENITRACK_MPESA_CALLBACK_TOKEN`.
3. At the proxy, allow `/api/v1/integrations/mpesa/callback/*` only from Safaricom's published IP ranges.
4. Test an STK Push from a debt in the app with a sandbox test number. Confirm the request moves
   to `succeeded` and exactly one verified payment and receipt appear.
5. For production, complete Safaricom's go-live process for your paybill or till, and switch the mode.
   Daraja STK Push supports whole-shilling amounts only, so the app enforces that.

**Push notifications (FCM).** Only the mock provider exists. Implementing FCM HTTP v1 needs a
Firebase project, a service account (kept server-side), `google-services.json` in the app
build (never committed), and an implementation of `PushProvider` in `app/integrations/messaging.py`.

## 3. Backups and restore

Back up the database at least daily, and keep copies off-site and encrypted.

```bash
# Backup (custom format, compressed)
docker compose exec -T db pg_dump -U denitrack_owner -d denitrack -Fc > backups/denitrack-$(date +%F).dump

# Restore into a fresh database (never over the live one)
docker compose exec -T db createdb -U denitrack_owner denitrack_restore
docker compose exec -T db pg_restore -U denitrack_owner -d denitrack_restore --no-owner < backups/denitrack-YYYY-MM-DD.dump
```

**Test the restore monthly.** Restore into a scratch database, point a staging API at it,
and compare `GET /dashboard` totals for two or three businesses with production. The repository's
`backend/scripts/backup_restore_check.py` automates the dump → restore → compare-ledger-totals cycle;
see "Verification results" in the README for the last run.

Row-level-security policies are part of the dump. Restore as the owner role, and keep
the application on `denitrack_app`.

## 4. Logging, monitoring and recovery

- Logs go to stdout in `time level logger message` format. Ship them to your log platform.
  Messages mentioning passwords or tokens are redacted.
- Alert on: `/health` not `ok`; 5xx rate; worker log lines `reminder run failed`; growth of
  `reminder_history` rows with `status='failed'`; `payment_requests` with `status='needs_review'`.
- Error monitoring: add Sentry (or similar) to `create_app()` and to the mobile app; strip
  request bodies and PII in `before_send`.
- Recovery playbook:
  - *API down:* the mobile app keeps working offline for supported actions and syncs after recovery.
  - *Bad deploy:* roll back the image. Migrations are additive; `alembic downgrade -1` is
    available but take a backup first.
  - *Suspected account compromise:* owner uses "Sign out on all devices"; an admin can
    revoke all sessions with `UPDATE user_sessions SET revoked_at = now() WHERE user_id = …`.
  - *Wrong payment recorded:* reverse it in the app (with a reason) and record the correct one.

## 5. Android builds

Requirements: JDK 17 (Android Studio's bundled JBR works), Android SDK with the platform
and build-tools versions that `expo prebuild` requests, Node 22.13+.

```bash
cd mobile
npm ci
EXPO_PUBLIC_API_URL=https://api.example.co.ke npx expo prebuild --platform android
cd android
./gradlew assembleRelease        # APK:  app/build/outputs/apk/release/
./gradlew bundleRelease          # AAB for Google Play: app/build/outputs/bundle/release/
```

Release builds are shrunk by R8. `app.json` adds one keep rule through `expo-build-properties`:
`-keep class * extends androidx.room.RoomDatabase { <init>(); }`. WorkManager (used by
`expo-background-task`) creates its database through that constructor. Room 2.6.1's own rule keeps the
class but not the constructor, so without this line the release app crashes on launch with
`NoSuchMethodException: androidx.work.impl.WorkDatabase_Impl.<init>`. Debug builds are not shrunk and do
not show the problem. The line can go once the build resolves Room 2.7 or later.

### Splash screen

The splash shows the app icon. `mobile/assets/splash-icon.png` is built from
`mobile/assets/icon.png` by `python mobile/scripts/make_splash.py` (needs Pillow). Re-run it
whenever the icon changes, so the splash always matches the app icon. The native splash (light and dark backgrounds) is configured under
`expo-splash-screen` in `app.json`. The in-app launch screen (`src/components/BrandSplash.tsx`)
continues it while the session is restored, and is shown again whenever the app is reopened after
being left (Home, app switcher, screen lock), but not when the app itself opened the share sheet,
PDF viewer or dialer (`src/services/appLifecycle.ts`).

### Building on Windows

React Native's C++ build nests absolute source paths inside its build folders, so paths
go past Windows' 260-character limit. Three things are needed (all verified on the
development machine):

1. **Enable long paths** (administrator, once): set
   `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` to `1`.
2. **Install CMake 4.1.2** in the Android SDK: Android Studio → SDK Manager → SDK Tools →
   *Show Package Details* → CMake 4.1.2, or `android sdk install cmake/4.1.2` with the SDK's
   new Android CLI. Its bundled ninja 1.12.1 understands long paths; the default CMake 3.22.1
   (and 3.30.5) ship ninja 1.10.2, which does not.
3. **Build from a short real folder**, e.g. a copy of `mobile/` (without `node_modules` and
   `android/`) in `C:\dt\mobile`, then `npm ci` there. Exclude only the *top-level* `android/`:
   `mobile/modules/denitrack-sms/android/` is source code (robocopy's `/XD android` would skip it too,
   so pass full paths to `/XD`).

Don't start adb (or leave a shell) inside `android/`. `expo prebuild` deletes and recreates that folder,
and Windows refuses ("EBUSY: resource busy or locked") while any running program, such as an adb server
started from there, has it as its current folder. Run `adb kill-server`, then start adb again from
another folder.

The config plugin `mobile/plugins/withWindowsLongPathBuild.js` (registered in `app.json`)
then makes every native module use CMake 4.1.2 with `CMAKE_POLICY_VERSION_MINIMUM=3.5`
when the build host is Windows. Linux and macOS builds, including CI, are unchanged.

Things that do **not** work: a `subst` drive letter or directory junction (Node resolves the
real path while Gradle uses the mapped one, and codegen fails with "this and base files have
different roots"); and long paths with the default CMake (ninja 1.10.2 still fails).

The first build downloads Gradle, the Android Gradle plugin, the NDK, CMake and Maven
dependencies. On the development machine, the first attempt ran 54 minutes before reaching
compilation, and a full release build with a warm cache took about 32 minutes. Later builds
reuse the Gradle cache in `~/.gradle`.

### Trying a test build on a phone

The test APK defaults to `http://10.0.2.2:8000` (the emulator's address for the host PC). On a
physical phone on the same Wi-Fi:

1. Start the backend listening on the network: `uvicorn app.main:app --host 0.0.0.0 --port 8000`
   (allow it through Windows Firewall for *private* networks only).
2. Install the APK (`adb install app-release.apk`, or copy it to the phone and allow installs from that source).
3. On the sign-in screen tap **Change server**, enter `<PC-LAN-IP>:8000`, and tap **Check and save**.
   The app checks `/api/v1/health` before saving.

Plain-`http` addresses only work in test builds whose default URL is `http://`. A release
build pointed at `https://…` does not allow cleartext traffic.

### Release signing

1. Generate an upload key **once** and store it in a password manager or secret store, never in git:
   ```bash
   keytool -genkeypair -v -keystore denitrack-upload.jks -alias denitrack -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Provide it to Gradle through `~/.gradle/gradle.properties` (outside the repo):
   ```
   DENITRACK_UPLOAD_STORE_FILE=/secure/path/denitrack-upload.jks
   DENITRACK_UPLOAD_KEY_ALIAS=denitrack
   DENITRACK_UPLOAD_STORE_PASSWORD=…
   DENITRACK_UPLOAD_KEY_PASSWORD=…
   ```
   and add a `signingConfigs.release` block referencing those properties (via a config plugin,
   since `android/` is generated). Alternatively use EAS Build with managed credentials.
3. Enrol in Play App Signing, so Google holds the app signing key and a lost upload key can be reset.
4. Bump `version` and `android.versionCode` in `app.json` for every release.
