# Phone contacts and learned M-Pesa names: implementation plan

**Goal:** Staff pick a customer from the phone's contacts when recording credit, and M-Pesa payments keep clearing automatically because the app learns each customer's M-Pesa name. Pochi payments wait for one tap.

**Architecture:**
- **Server:** the server stores learned names in a new tenant table, `customer_mpesa_names`. Names are learned in `assign`, and `match_customer` reads them. Two endpoints list and remove learned names.
- **App:** the app reads the phone book with `expo-contacts`, in memory only, through a pure search function. A `ContactResults` section appears in `CustomerPicker`, and on the New customer form. The Record debt form creates the customer first, then the debt, through the existing outbox.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, pytest (backend). Expo SDK 58, React Native, TanStack Query, react-hook-form with zod, and Jest with Testing Library (app).

**Spec:** `docs/design/2026-11-10-contacts-and-mpesa-names.md`

## Global Constraints

- **No commits:** do not commit or push. The owner asks for commits.
- **When the owner does ask for a commit:**
  - author `Nasty-24 <briankibunja3@gmail.com>`;
  - no `Co-Authored-By` lines and no tool attribution of any kind;
  - use `git -c core.longpaths=true`.
- **Auto-clearing:** nothing is applied automatically unless the phone number matches.
- **Pochi payments** (no number) are never applied automatically.
- **The phone book** is never written to storage, the outbox or logs, and never sent to the server.
- **Permissions:** only `READ_CONTACTS` is requested. `android.permission.WRITE_CONTACTS` is in `blockedPermissions`.
- **Exact copy:** text the user sees uses the spec's exact wording where the spec gives it.
- **Backend checks:** `ruff check`, `ruff format --check` and `mypy app` are clean. Python is `/c/Users/User/.venvs/denitrack/Scripts/python`, run from `backend/`.
- **App checks:** `npx tsc --noEmit`, `npx eslint .` and `npx jest` are clean, run from `mobile/`.
- **`mobile/jest.setup.ts`** uses CRLF line endings. Keep them.
- **Demo password:** never print or repeat it. Refer to `DEMO_PASSWORD` in `backend/app/seed.py`.
- **APK builds:** before `expo prebuild`, run `adb kill-server`, then start adb from `C:\` (see "EBUSY" in `docs/deployment.md`).

## Review Focus

1. **Very long names:** a 160-character payer name plus a 160-character customer name must not overflow `mpesa_sms_messages.detail` (`varchar(300)`). The detail is cut to 300 characters. Tested in Task 2 (`test_long_names_fit_the_detail`).
2. **Phone-book numbers in any format:** `0712 345 678`, `+254-712-345-678`, `(0712) 345678` and `254712345678` all find the same contact. A landline (`020 222 3333`) is shown but can't be picked. Tested in Task 4.
3. **A contact saved with only a number:** it is listed under that number as its name, and the name can be edited before use. Tested in Tasks 4 and 5.
4. **An archived customer with the picked number:** the server's "Archived customers cannot receive new credit" message shows in the form banner. No customer or debt is lost or duplicated. Tested in Task 6 (`shows the server message when the existing customer is archived`).
5. **A phone book with thousands of contacts:** the search returns at most 20 matches, and the book is loaded once per form. Tested in Task 4 (`returns at most 20 matches`).

---

### Task 1: Storage for learned M-Pesa names

**Files:**
- Modify: `backend/app/models/__init__.py` (new model after `MpesaSmsMessage`, around line 438; `TENANT_TABLES` at line 530)
- Create: `backend/migrations/versions/0004_customer_mpesa_names.py`
- Modify: `backend/tests/test_postgres_rls.py`

**Interfaces:**
- Produces: the model `CustomerMpesaName` with these columns:
  - `id: uuid`
  - `business_id: uuid` (indexed)
  - `customer_id: uuid`
  - `name: str` (`String(160)`)
  - `source_message_id: uuid | None`
  - `created_by: uuid`
  - `created_at: datetime` (`UTCDateTime`, default `utcnow`)

  `__table_args__` = `UniqueConstraint("business_id", "customer_id", "name")` and `Index("ix_customer_mpesa_names_business_name", "business_id", "name")`. Table name `customer_mpesa_names`.

- [ ] **Step 1: Write the failing PostgreSQL test** `test_learned_mpesa_names_are_isolated(migrated)` in `test_postgres_rls.py`:
  1. With `app.bypass_rls = 'on'`, insert one `customer_mpesa_names` row for business `b`. Use that business's customer, a `users` id from the fixture (`ids["u"]`) and the name `'NJERI WAMBUI'`.
  2. With `app.business_id` set to business `a`, `SELECT count(*) FROM customer_mpesa_names` is `0`.
  3. Set to business `b`, the count is `1`.
- [ ] **Step 2: Run it and confirm it fails:** `DENITRACK_PG_ADMIN_URL=<local admin url> python -m pytest tests/test_postgres_rls.py -k mpesa_names -q`. Expected: an error that the relation does not exist.
- [ ] **Step 3: Add the model and migration.**
  - Add `CustomerMpesaName` with the columns above. Add `"customer_mpesa_names"` to `TENANT_TABLES`.
  - In migration `0004`, `down_revision = "0003"`, copy `0003`'s structure: create the table, indexes, unique constraint and FKs to `businesses`, `customers`, `mpesa_sms_messages` and `users`.
  - On PostgreSQL, enable and force RLS and create the `tenant_isolation` policy with the same `POLICY` string. `downgrade` reverses this.
- [ ] **Step 4: Run the RLS tests on PostgreSQL and the SQLite suite.**
  - Expected: `test_postgres_rls.py` all pass, now 6.
  - `python -m pytest -q` passes, with the same counts as before plus nothing new on SQLite.

### Task 2: Learn names on manual matching, and use them when matching

**Files:**
- Modify: `backend/app/services/mpesa_sms.py`
- Create: `backend/tests/test_mpesa_names.py` (import `received` and `submit` from `tests.test_mpesa_sms`)

**Interfaces:**
- Consumes: `CustomerMpesaName` (Task 1).
- Produces:
  - `LEARNED_SCORE = 100`
  - `learned_names(db: Session, business_id: uuid.UUID) -> dict[uuid.UUID, set[str]]`: customer id to learned names.
  - `match_customer(parsed: ParsedSms, customers: list[Customer], learned: Mapping[uuid.UUID, AbstractSet[str]] | None = None) -> Match`.
  - `learn_name(db: Session, tenant: Tenant, customer: Customer, rec: MpesaSmsMessage) -> str | None`: returns the name it stored, or `None` when the name is `UNKNOWN` or already known.
  - `process_message(..., customers, learned=None)` passes `learned` through `_decide`.

**Test helper:** `teach(owner, customer, party, code)` submits `received(code=code, party=party)` and assigns the needs-matching message to `customer`. Write it as a function in the test file. Use these constants:
- `MAMA` = customer "Mama Njeri", phone `0722000712`
- `PAYER` = `"NJERI WAMBUI"`
- `POCHI` = `received(code="TPOCHI0001", party=PAYER)`, which has no number

- [ ] **Step 1: Write the failing tests:**
  - `test_matching_by_hand_teaches_the_name`:
    1. The first payment from `"NJERI WAMBUI 0722***712"` is `needs_review`.
    2. After assigning it to Mama, `learned_names(db, business_id)[mama_id] == {"NJERI WAMBUI"}`, checked with `SessionLocal`.
    3. The `mpesa_sms.assigned` `AuditLog` row's `after["learned_name"] == "NJERI WAMBUI"`.
    4. A second payment (`code="TCK1ABC2DF"`, same party) has `status == "applied"` and `customer_name == "Mama Njeri"`.
  - `test_a_name_is_learned_once_and_never_unknown`: two assigned payments under the same name leave one row. A payment with `party="0722***712"` (payer name `UNKNOWN`), assigned by hand, adds no row.
  - `test_pochi_payment_waits_with_the_learned_customer_chosen`:
    - after `teach`, submitting `POCHI` gives `status == "needs_review"`;
    - the message has `suggested_customer_name == "Mama Njeri"`;
    - `detail == "No phone number in this payment (for example Pochi la Biashara). NJERI WAMBUI has paid for Mama Njeri before."`;
    - the debt balance is unchanged.
  - `test_unknown_number_with_learned_name_is_suggested_not_applied`: party `"NJERI WAMBUI 0733***999"` gives `needs_review`, Mama suggested, and `detail == "This number isn't saved for any customer. NJERI WAMBUI has paid for Mama Njeri before."`.
  - `test_learned_name_shared_by_two_customers_gives_no_suggestion`: teach the same payer name to Mama and to "Njeri Kamau" (`0711000000`), then submit `POCHI`. `suggested_customer_name is None` and `detail == "2 customers have paid under the M-Pesa name NJERI WAMBUI. Choose the right one."`.
  - `test_archived_customers_learned_names_are_ignored`: teach, archive Mama (`POST /customers/{id}/archive`), submit `POCHI`. There is no suggestion.
  - `test_learned_name_wins_when_a_number_fits_two_customers`:
    - Mama is `0722000712`; "Njeri Kamau" is `0722111712`.
    - The first payment from `"NJERI WAMBUI 0722***712"` ties, so it is `needs_review`; assign it to Mama.
    - The next one is `applied` to Mama.
  - `test_long_names_fit_the_detail`:
    - a customer whose name is `"Mama " + "N" * 150`;
    - teach the payer `"A" * 75 + " " + "B" * 75`, then submit that payer with no number;
    - `len(detail) <= 300` and `status == "needs_review"`.
- [ ] **Step 2: Run them and confirm they fail:** `python -m pytest tests/test_mpesa_names.py -q`. Expected: failures on the suggestion, detail and applied assertions.
- [ ] **Step 3: Implement.**
  - `match_customer`: a learned name scores `LEARNED_SCORE` against a phone-matched customer, otherwise `name_score`. The phone-matched branches keep today's wording.
  - Then, for no number or a number matching no customer, check the active customers whose learned names contain `parsed.payer_name`:
    - exactly one: `Match(None, c, <detail>)`, where the detail starts "No phone number…" when `parsed.payer_phone is None`, otherwise "This number isn't saved…";
    - more than one: `Match(None, None, "<n> customers have paid under the M-Pesa name <NAME>. Choose the right one.")`;
    - none: today's full-name rule.
  - In `_decide`, store `match.reason[:300]`, and cut the "could not be applied" detail the same way it is cut today.
  - `process_batch` loads `learned_names` once and passes them on.
  - `learn_name` adds the row inside `db.begin_nested()` and catches `IntegrityError`, returning `None`.
  - `assign` calls `learn_name` after `_apply`. When a name was learned, add `"learned_name": <name>` to the audit `after`.
- [ ] **Step 4: Run** `python -m pytest tests/test_mpesa_names.py tests/test_mpesa_sms.py -q`. Expected: all pass.

### Task 3: API to list and remove learned names

**Files:**
- Modify: `backend/app/schemas/__init__.py` (new `MpesaNameOut(ORM)`: `id: uuid.UUID`, `name: str`, `created_at: datetime`)
- Modify: `backend/app/api/customers.py`
- Test: `backend/tests/test_mpesa_names.py`

**Interfaces:**
- Consumes: `CustomerMpesaName`, and `teach` from Task 2's tests.
- Produces:
  - `GET /businesses/{bid}/customers/{customer_id}/mpesa-names` returns `list[MpesaNameOut]`, newest first, through `manager_only`.
  - `POST /businesses/{bid}/customers/{customer_id}/mpesa-names/{name_id}/remove` returns the remaining `list[MpesaNameOut]`, through `manager_only`.
  - Removal is audited with `action="customer.mpesa_name_removed"`, `entity_type="customer"`, and `before={"name": <name>}`.

- [ ] **Step 1: Write the failing tests:**
  - `test_owner_sees_and_removes_learned_names`:
    1. After `teach`, `GET .../mpesa-names` returns one item, with `name == "NJERI WAMBUI"`.
    2. `POST .../remove` returns `[]`.
    3. Submitting `POCHI` then gives no suggestion.
    4. An `AuditLog` row with action `customer.mpesa_name_removed` exists (query through `SessionLocal`).
  - `test_removing_twice_returns_404`.
  - `test_cashiers_cannot_see_or_remove_names(owner, cashier)`: both endpoints return 403 for the cashier.
  - `test_other_business_gets_404`: a second business (`register(client, email="other@example.com", business="Other Shop")`) gets 404 for both endpoints, using the first business's customer id and name id.
- [ ] **Step 2: Run them and confirm they fail.** Expected: 404 or 405 on the new routes.
- [ ] **Step 3: Implement the two routes in `customers.py`.** Reuse `_get` for the customer lookup. A name id that doesn't belong to that customer in this business raises `NotFound("M-Pesa name not found")`.
- [ ] **Step 4: Run all backend checks.**
  - `python -m pytest -q`
  - `python -m ruff check app tests`
  - `python -m ruff format --check app tests`
  - `python -m mypy app`

  Expected: all clean.

### Task 4: Reading and searching the phone book

**Files:**
- Modify: `mobile/package.json`, through `npx expo install expo-contacts` (expect `~58.0.10`)
- Modify: `mobile/app.json`:
  - add the plugin `["expo-contacts", {"contactsPermission": "DeniTrack searches your contacts so you can pick a customer quickly."}]`;
  - add `"android.permission.WRITE_CONTACTS"` to `blockedPermissions`.
- Modify: `mobile/jest.setup.ts` (CRLF): mock `expo-contacts` with `jest.fn()` for each of these:
  - `getPermissionsAsync` and `requestPermissionsAsync`, both resolving `{ status: 'granted', granted: true, canAskAgain: true }`;
  - `getContactsAsync`, resolving `{ data: [] }`;
  - plus `Fields: { Name: 'name', PhoneNumbers: 'phoneNumbers' }`.
- Create: `mobile/src/services/contacts.ts`
- Test: `mobile/src/__tests__/contacts.test.ts`

**Interfaces:**
- Produces, from `contacts.ts`:
  ```ts
  export interface PhoneBookNumber { raw: string; e164: string | null } // e164 = normalizeKenyanPhone(raw)
  export interface PhoneBookEntry { id: string; name: string; numbers: PhoneBookNumber[] }
  export type ContactsAccess = 'granted' | 'undetermined' | 'denied';
  export function getContactsAccess(): Promise<ContactsAccess>;
  export function requestContactsAccess(): Promise<ContactsAccess>;
  export function loadPhoneBook(): Promise<PhoneBookEntry[]>;
  export function searchPhoneBook(book: PhoneBookEntry[], query: string, knownPhones: ReadonlySet<string>, limit?: number): PhoneBookEntry[]; // limit defaults to 20
  ```
- Rules:
  - `loadPhoneBook` asks only for `[Fields.Name, Fields.PhoneNumbers]` and drops entries without numbers. A missing or blank name becomes the first number's `raw`.
  - `searchPhoneBook` returns `[]` for a query shorter than 2 characters after trimming. It matches the name (case-insensitive substring), or digits for a query made only of digits, spaces, `+`, `-` and brackets with at least 3 digits.
  - For digit matching, strip a leading `254` or `0` from both the query and each number before the substring test (the same rule as `list_customers` on the server).
  - Leave out any entry with an `e164` in `knownPhones`.

- [ ] **Step 1: Write the failing tests** (book: "Mama Njeri Kibanda" `0712 345 678`, "Office" `020 222 3333`, "Uncle Tom" `+44 7911 123456`, and a nameless entry `0733 000 111`):
  - `finds contacts by name, ignoring case`: `"njeri"` finds Mama Njeri Kibanda.
  - `finds contacts by number in any format`: each of `0712345`, `254712345`, `+254 712 345`, `(0712) 345` and `712-345` finds Mama Njeri Kibanda.
  - `leaves out contacts who are already customers`: with `knownPhones` containing `+254712345678`, `"njeri"` returns `[]`.
  - `marks numbers the app can't use`: Office's number has `e164 === null`, and Uncle Tom's has `e164 === '+447911123456'`.
  - `names a contact saved with only a number by that number`: through `loadPhoneBook` with a mocked `getContactsAsync`, the entry's `name === '0733 000 111'`.
  - `drops contacts without numbers`, and `asks only for names and numbers` (`getContactsAsync` called with `{ fields: ['name', 'phoneNumbers'] }`).
  - `ignores one-letter searches`: `"n"` returns `[]`.
  - `returns at most 20 matches`: a book of 500 entries named `Njeri <i>` returns 20.
  - `maps permission answers`: granted, undetermined and denied map to `'granted'`, `'undetermined'` and `'denied'`.
- [ ] **Step 2: Run them and confirm they fail:** `npx jest src/__tests__/contacts.test.ts`. Expected: module not found.
- [ ] **Step 3: Implement `contacts.ts`** to these interfaces.
- [ ] **Step 4: Run** `npx jest src/__tests__/contacts.test.ts` and `npx tsc --noEmit`. Expected: pass, and no type errors.

### Task 5: "From your phone" in the customer search

**Files:**
- Create: `mobile/src/components/ContactResults.tsx`
- Modify: `mobile/src/components/CustomerPicker.tsx`
- Test: `mobile/src/__tests__/contactResults.test.tsx`

**Interfaces:**
- Consumes: `contacts.ts` (Task 4), `newIdempotencyKey` from `services/api`, and `formatPhone`.
- Produces:
  ```ts
  export interface NewPerson { kind: 'new'; name: string; phone: string; key: string } // phone is e164; key = idempotency key for customer.create
  export function ContactResults(props: { query: string; knownPhones: ReadonlySet<string>; onPick: (p: NewPerson) => void }): JSX.Element | null;
  // CustomerPicker
  export type PickerValue = PickedCustomer | NewPerson;
  props: { value: PickerValue | null; onChange: (c: PickerValue | null) => void; error?: string; owingOnly?: boolean; allowContacts?: boolean /* default false */ }
  ```
- **Copy:**
  - section header "From your phone";
  - button "Search your phone's contacts", with the line "Find people in your contacts and add them as customers.";
  - when access is denied, the line "Contacts are off for DeniTrack." and the button "Open settings" (`Linking.openSettings()`);
  - the confirm step has a `TextField` labelled "Name", one choice per number (labelled with `formatPhone(e164)` or the raw number), "Not a mobile number" beside unusable ones, and the button "Use this person";
  - when the value is a `NewPerson`, the picker card shows the name, `formatPhone(phone)`, and "New customer · added when you save".
- **Behaviour:**
  - `ContactResults` renders nothing when `query.trim().length < 2`.
  - It loads the book once, when access becomes `'granted'`. If `loadPhoneBook` rejects, it shows "Couldn't read your contacts." and the customer list above still works.
  - The first usable number is preselected. "Use this person" is disabled while the name is blank.
  - `CustomerPicker` renders `ContactResults` below the customer list only when `allowContacts`, passing the phones of the customers shown.

- [ ] **Step 1: Write the failing tests:**
  - `offers to search contacts before permission is given`: access `undetermined` shows the button. Pressing it calls `requestPermissionsAsync`, and the results then show "Mama Njeri Kibanda".
  - `explains when contacts are off`: access `denied` shows the line. "Open settings" calls `Linking.openSettings`.
  - `picks a contact and lets the name be edited`:
    1. Select "Mama Njeri Kibanda" and change "Name" to "Mama Njeri".
    2. Press "Use this person".
    3. `onPick` is called with `{ kind: 'new', name: 'Mama Njeri', phone: '+254712345678', key: expect.any(String) }`.
  - `cannot pick a landline`: a contact with `020 222 3333` and `0712 345 678`. The landline choice is disabled with "Not a mobile number", and the mobile number is preselected.
  - `keeps working when contacts can't be read`: `getContactsAsync` rejects. "Couldn't read your contacts." shows, and the customer rows still render.
  - `the customer search shows no contacts unless allowed`: `CustomerPicker` without `allowContacts` never calls `getContactsAsync`, and "From your phone" is absent.
  - `shows a picked contact as a new customer`: `CustomerPicker` with a `NewPerson` value shows "New customer · added when you save".
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** `ContactResults` and the `CustomerPicker` changes.
- [ ] **Step 4: Run** `npx jest` (whole suite: the existing `CustomerPicker` callers must still pass) and `npx tsc --noEmit`.

### Task 6: Record debt for a new contact

**Files:**
- Modify: `mobile/src/screens/DebtScreens.tsx` (`DebtFormScreen`, lines 120–200)
- Test: `mobile/src/__tests__/screens.test.tsx` (`describe('Record debt')`)

**Interfaces:**
- Consumes: `PickerValue` and `NewPerson` (Task 5), `useSettings` (`hooks/queries.ts:71`), and `ApiError(message, status, code, details)`.
- Produces:
  - `const NEW_PERSON_ID = 'new-person'`, the `customer_id` form value while a `NewPerson` is picked;
  - `allowContacts = isManager || settings.cashier_can_register_customers`.
- **Save flow, when a `NewPerson` is picked:**
  1. `submit('customer.create', { name, phone, sms_opt_in: true, allow_duplicate }, 'New customer – <name>', person.key)` gives the customer id: `result.id`, or `localId` when queued.
  2. Then the existing `debt.create` runs with that id.
- **When the customer request returns `possible_duplicate`:**
  - If a detail entry has `phone === person.phone`, use its id. After success, call `Alert.alert('Debt recorded', '<name> is already a customer, so the debt was recorded for them.')`, then navigate as today.
  - Otherwise, show the banner "This may be a customer you already have", with one button per match: "Use <name> (<formatted phone>)". Choosing one sets that customer and clears the banner, and nothing is saved until "Record debt" is pressed again. The banner also has "No, add a new customer", which saves again with `allow_duplicate: true`.

- [ ] **Step 1: Write the failing tests** (route without params; `api.get` mocked to return an empty customer page and settings; contacts mocked to the Task 4 book):
  - `records a debt for a new contact`: after search "njeri", pick, "Use this person", fill and save:
    - `submit.mock.calls[0]` is `['customer.create', { name: 'Mama Njeri Kibanda', phone: '+254712345678', sms_opt_in: true, allow_duplicate: false }, …]`;
    - `calls[1][1].customer_id === 'c-new'`;
    - the screen navigates with `replace('DebtDetail', …)`.
  - `queues the customer and the debt together offline`: the customer resolves `{ queued: true, localId: 'local:k1' }`. The debt body has `customer_id === 'local:k1'`, and the "Saved on this phone" alert appears.
  - `uses the existing customer with the same number`: the customer rejects `possible_duplicate` with `[{ id: 'c7', name: 'Joseph Otieno', phone: '+254712345678' }]`. The debt has `customer_id === 'c7'`, and the alert has the "already a customer" text.
  - `reuses the same customer when saving again`: the customer is created, then the first `debt.create` rejects `ApiError('Check the amount', 422, 'validation_error')`. Pressing "Record debt" again sends `customer.create` with the same idempotency key (`calls[2][3] === calls[0][3]`).
  - `asks when only the name matches`: a duplicate with another phone shows the banner and records no debt. "No, add a new customer" re-submits with `allow_duplicate: true`.
  - `shows the server message when the existing customer is archived`: same-phone duplicate, then `debt.create` rejects `ApiError('Archived customers cannot receive new credit', 422, 'customer_archived')`. The banner shows that text.
  - `cashiers who can't add customers see no contacts`: session role `cashier` with `isManager: false`, and settings `cashier_can_register_customers: false`. "From your phone" is absent after typing "njeri".
- [ ] **Step 2: Run them and confirm they fail:** `npx jest src/__tests__/screens.test.tsx -t "Record debt"`.
- [ ] **Step 3: Implement the flow above in `DebtFormScreen`.**
- [ ] **Step 4: Run** `npx jest` and `npx tsc --noEmit`.

### Task 7: "Pick from contacts" on the New customer form

**Files:**
- Modify: `mobile/src/screens/CustomerScreens.tsx` (`CustomerFormScreen`, lines 135–243)
- Test: `mobile/src/__tests__/screens.test.tsx` (new `describe('Add customer')`)

**Interfaces:**
- Consumes: `ContactResults` (Task 5), and `setValue` from the existing `useForm`.
- **Behaviour:**
  - A secondary compact button "Pick from contacts" shows only when not editing, and only when `isManager || settings.cashier_can_register_customers`.
  - It toggles a `TextField` labelled "Search contacts", with `ContactResults` under it (`knownPhones` = an empty set).
  - `onPick` sets `name`, and sets `phone` to `formatPhone(p.phone)` (both with `shouldValidate: true`), then hides the search.

- [ ] **Step 1: Write the failing tests:**
  - `fills the name and number from a contact`: after "Pick from contacts", type "njeri", pick and "Use this person". The "Full name or business name" field has `'Mama Njeri Kibanda'`, the "Phone number" field has `'0712 345 678'`, and "Search contacts" is gone.
  - `is not offered when editing a customer`.
  - `is not offered to cashiers who can't add customers`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx jest` and `npx tsc --noEmit`.

### Task 8: M-Pesa names on the customer page

**Files:**
- Modify: `mobile/src/types/api.ts` (`export interface MpesaName { id: string; name: string; created_at: string }`)
- Modify: `mobile/src/hooks/queries.ts`
- Modify: `mobile/src/screens/CustomerScreens.tsx` (`CustomerProfileScreen`)
- Test: `mobile/src/__tests__/screens.test.tsx` (new `describe('Customer M-Pesa names')`)

**Interfaces:**
- Consumes: Task 3's endpoints.
- Produces:
  - `useCustomerMpesaNames(id: string, enabled: boolean)`, built like `useCustomer`, with key `['customer', id, 'mpesa-names']`;
  - removal through `useBizMutation<{ nameId: string }, MpesaName[]>('post', (b) => \`/customers/${customerId}/mpesa-names/${b.nameId}/remove\`)`.
- **Copy:**
  - section header "M-Pesa names";
  - the empty list says "Learned when you match one of this customer's M-Pesa payments by hand.";
  - each row has a "Remove" button, which confirms with `Alert.alert('Remove <NAME>?', 'Payments under this name will no longer suggest <customer name>.', [Cancel, Remove (destructive)])`.
  - The section is shown only when `isManager`.
  - If a removal fails (for example a 404 because it was already removed), the list is refetched.

- [ ] **Step 1: Write the failing tests:**
  - `lists learned names and removes one after confirming`: after pressing "Remove" and invoking the alert's Remove callback, `api.post` is called with a path ending `/customers/c1/mpesa-names/n1/remove`.
  - `explains an empty list`.
  - `is hidden from cashiers`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx jest`, `npx tsc --noEmit` and `npx eslint .`.

### Task 9: Recognise Pochi la Biashara messages (blocked until the owner sends a sample)

**Files:**
- Test: `backend/tests/test_mpesa_sms.py` (`class TestParsing`)
- Modify, only if the test fails: `backend/app/services/mpesa_sms.py` (`_RECEIVED`)

- [ ] **Step 1: Add** `test_pochi_la_biashara_message`, using the owner's sample with the balance removed. Assert the code, the amount, `payer_name` as shown, and `payer_phone is None`.
- [ ] **Step 2: Run** `python -m pytest tests/test_mpesa_sms.py -q`.
  - If it passes, stop here.
  - If it fails, add one pattern to `_RECEIVED` for the Pochi wording.
- [ ] **Step 3: Run** `python -m pytest tests/test_mpesa_sms.py -q` again. Expected: the new test passes and `test_ignores_everything_that_is_not_money_received` still passes.

### Task 10: Docs, privacy wording, full checks, and the phone

**Files:**
- Modify: `mobile/src/screens/AdminScreens.tsx` (privacy notice, line 590). Append: "To add a customer quickly, staff can search the phone’s contacts; only the person they pick is saved."
- Modify: `mobile/src/screens/auth/AuthScreens.tsx` (lines 175–178). After "…Only your business’s staff can see them.", add: "If you allow it, the app can search your phone’s contacts to add a customer; only the person you pick is saved."
- Modify: `docs/user-guide.md`, `docs/api-guide.md`, `docs/database-schema.md` (a row for `customer_mpesa_names`), `docs/security.md` (a contacts note in the data-minimisation row, and `DELETE FROM customer_mpesa_names WHERE customer_id = …` in the anonymisation procedure), and `README.md` (feature bullets and test counts).

- [ ] **Step 1: Update the text and docs** listed above.
- [ ] **Step 2: Run the full checks:**
  - backend SQLite `pytest -q`, `ruff check`, `ruff format --check` and `mypy app`;
  - backend on PostgreSQL, with `DENITRACK_DATABASE_URL` and `DENITRACK_PG_ADMIN_URL` set as in the last run;
  - app `tsc`, `eslint` and `jest`.

  Expected: all clean. Put the new counts into `README.md`.
- [ ] **Step 3: Build and install the APK:**
  1. `adb kill-server`, then start adb from `C:\`.
  2. `npx expo prebuild --platform android`, then `./gradlew assembleRelease` in `mobile/android`.
  3. `adb install -r app/build/outputs/apk/release/app-release.apk`.

  Expected: the app starts with no crash in `adb logcat -b crash`.
- [ ] **Step 4: Check on the phone, when the owner says it's free to use:**
  1. The permission prompt appears on the first contacts search.
  2. Record a debt for a new contact.
  3. The customer page shows "M-Pesa names".
  4. After Task 9, a real Pochi payment lands in "needs matching" with the learned customer chosen.
