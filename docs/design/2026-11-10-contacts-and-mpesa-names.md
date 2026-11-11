# Phone contacts and learned M-Pesa names

Status: agreed with the owner on 10 Nov 2026, waiting for review of this document.

## Why

Recording credit should be quick. Instead of typing a new customer's name and number, staff
search the phone's contacts and pick the person.

That creates a problem for automatic clearing of debts from M-Pesa messages:

- A payment clears automatically today only when the payer's number **and** name match one
  customer (`backend/app/services/mpesa_sms.py`, `match_customer`).
- Phone-book names are often nicknames ("Mama Njeri Kibanda"), while M-Pesa shows the name on
  the payer's ID ("NJERI WAMBUI"). Customers added from contacts would fail the name check even
  when the number matches, so their payments would wait for review.
- Pochi la Biashara messages show the payer's name but no number, so they cannot be matched on
  the number at all. Today they always wait in "needs matching".

## Decisions

| Question | Decision |
|---|---|
| Where can contacts be searched? | In the customer search on the **Record debt** form, and through a **Pick from contacts** button on the **New customer** form |
| How are contacts searched? | Inside DeniTrack, not through Android's contact picker, so contacts and customers appear in one list |
| What leaves the phone? | Only the contact that is picked, saved as a customer. The phone book itself is never stored or uploaded |
| How do Send Money payments from contact-added customers keep clearing? | The app learns each customer's M-Pesa name when a payment is matched by hand |
| Do Pochi payments (no number) clear on their own? | **No.** They wait in "needs matching". When the learned name points to exactly one customer, that customer is already chosen, so confirming takes one tap |

## Part 1: searching phone contacts (app)

### Behaviour

- **Record debt form.** The customer search lists matching customers first, as now, then a
  **From your phone** section with matching contacts.
  - A contact matches when the query appears in its name or, ignoring spaces and the
    `0` / `254` / `+254` prefix, in one of its numbers.
  - Contacts whose number already belongs to a customer in the search results are left out of
    **From your phone**.
  - Picking a contact opens a short confirm step:
    - the name, prefilled and editable (for example to remove an emoji);
    - the number, chosen from a list when the contact has several. A number the app can't use
      (`normalizeKenyanPhone` returns null, for example a landline) is shown but cannot be
      picked, with "Not a mobile number" beside it. Numbers in international format are
      accepted, as the New customer form accepts them today, and the server validates them;
    - **Use this person**.
  - The picked person then shows as the debt's customer with the caption "New customer · added
    when you save".
  - **Save, online:** `POST /customers`, then `POST /debts`.
    - If the customer request replies `possible_duplicate` and one of the matches has the same
      number, the debt is recorded for that customer instead. The confirmation then says
      "<name> is already a customer, so the debt was recorded for them."
    - If the matches only share the name, the form shows the same choice the New customer form
      offers today: use an existing customer, or add a new one anyway.
    - The customer request has its own idempotency key, made when the person is picked. If the
      debt fails after the customer was created, saving again reuses that customer.
  - **Save, offline:** a `customer.create` and a `debt.create` are queued in the outbox. The
    debt refers to the customer's local id, which the outbox already supports
    (`LOCAL_PREFIX`, `setMapping`). If the customer can't be created when it syncs, both show
    as failed in the existing sync-issues view, as they do today for customers added offline.
- **New customer form.** A **Pick from contacts** button opens the same contact search under
  the button. Picking a person fills in the name and phone fields and closes the search.
  Nothing is saved until the form is saved.
- **Permission.** The first time contacts would be searched, **From your phone** shows a
  **Search your phone's contacts** button with one line of explanation. Tapping it asks Android
  for permission.
  - Granted: results appear.
  - Refused: a line says contacts are off, with an **Open settings** button
    (`Linking.openSettings`). Everything else works as now.
- **Cashiers.** When the business does not let cashiers register customers
  (`cashier_can_register_customers` is off), cashiers do not see **From your phone** or
  **Pick from contacts**.

### Privacy

- The phone book is read on the phone into memory only while a form that uses it is open. It is
  never written to storage, the outbox or logs, and never sent to the server.
- Only the picked person's name and chosen number are saved, as an ordinary customer.
- Only `READ_CONTACTS` is requested. `android.permission.WRITE_CONTACTS`, which the module's
  config plugin adds by default, goes in `blockedPermissions` in `mobile/app.json`.
- One sentence is added to the in-app privacy notice, in Settings and at sign-up.
- `docs/security.md` gets a data-minimisation note about contacts.

### Components

| Unit | Purpose | Notes |
|---|---|---|
| `expo-contacts` `~58.0.10` | Read the phone book | New native module. Needs a new APK |
| `mobile/src/services/contacts.ts` | Permission state, load the phone book once per form (name and numbers only), and a **pure** `searchPhoneBook(book, query, knownPhones)` | The search is pure so it can be unit tested without a phone |
| `mobile/src/components/ContactResults.tsx` | The **From your phone** section: permission states, the result list, and the confirm step | Used by `CustomerPicker` and the New customer modal |
| `CustomerPicker` | Gains `allowContacts`, and can return a new person `{ kind: 'new', name, phone }` as well as an existing customer | Existing callers are unchanged (`allowContacts` defaults to false) |
| `DebtFormScreen` | Creates the customer before the debt, online or offline as described above | |
| `CustomerFormScreen` | **Pick from contacts** button | |

There are no server changes in Part 1.

## Part 2: learned M-Pesa names (server and app)

### Data

New table `customer_mpesa_names`, migration `0004`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `business_id` | uuid | FK `businesses`, indexed |
| `customer_id` | uuid | FK `customers` |
| `name` | varchar(160) | upper case, single spaces, as stored in `mpesa_sms_messages.payer_name` |
| `source_message_id` | uuid, nullable | FK `mpesa_sms_messages`: the payment it was learned from |
| `created_by` | uuid | FK `users` |
| `created_at` | timestamp (UTC) | |

- Unique `(business_id, customer_id, name)`. Index `(business_id, name)`.
- Row-level security as in migration `0003`: enable, force, and the same `tenant_isolation`
  policy. The table is added to `TENANT_TABLES` in `app/models`.
- The anonymisation procedure in `docs/security.md` also deletes a customer's learned names,
  because they are personal data.

### Learning

- In `assign` (`POST /mpesa-sms/{id}/assign`), after the payment is recorded, the message's
  `payer_name` is added to that customer's learned names. This also covers the existing
  one-tap **Record for <name>** button, which calls the same endpoint.
- Nothing is learned when the name is `UNKNOWN`, or when the customer already has that name.
- The `mpesa_sms.assigned` audit entry records whether a name was learned
  (`"learned_name": "<NAME>"` or absent).

### Matching

`match_customer` receives the learned names for the active customers (one query per batch in
`process_batch`). A learned name **matches** when it equals the message's payer name exactly.

| Message | Result |
|---|---|
| Number shown, number matches, and either `name_score > 0` against the customer's name **or** a learned name matches | **Applied automatically**, as now. A learned-name match beats a partial name match when the number fits several customers |
| Number shown, number matches, names don't | As now: needs matching, with that customer suggested when only one customer has the number. Matching it by hand teaches the name, so the next payment clears on its own |
| No number (for example Pochi), **or** a number no customer has (for example a customer paying from someone else's phone), and exactly one active customer has that learned name | **Needs matching**, with that customer suggested. **Never applied automatically.** The detail reads "No phone number in this payment (for example Pochi la Biashara). <NAME> has paid for <customer> before." or "This number isn't saved for any customer. <NAME> has paid for <customer> before." |
| As above, but two or more customers have that learned name | Needs matching, no suggestion. The detail reads "<n> customers have paid under the M-Pesa name <NAME>. Choose the right one." |
| As above, and no customer has that learned name | As now: a full-name match suggests a customer, otherwise no suggestion |

Rule kept from today: **nothing is applied automatically unless the phone number matches.**

### API

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /customers/{id}/mpesa-names` | owner, manager (`manager_only`) | List learned names, newest first |
| `POST /customers/{id}/mpesa-names/{name_id}/remove` | owner, manager | Remove a wrongly learned name and return the remaining list. Audited as `customer.mpesa_name_removed`. A POST action, like archive and restore, because the app's API client has no DELETE |

Another business's customer or name returns 404.

Match details are cut to 300 characters before they are stored, because
`mpesa_sms_messages.detail` is `varchar(300)` and the payer and customer names can each be up
to 160 characters.

### App

- **Customer page (managers only):** an **M-Pesa names** section lists learned names, with
  **Remove** and a confirm step. When the list is empty it says "Learned when you match one of
  this customer's M-Pesa payments by hand."
- **Needs matching:** no change needed. The server's suggestion and detail text drive the
  existing **Record for <name>** button.

## Part 3: recognising Pochi messages (input needed)

The parser (`parse_mpesa_sms`) accepts "...received Ksh<amount> from <party> on <date>..." and
"Ksh<amount> received from <party>...". A Pochi payment message whose wording differs is
ignored entirely and never reaches "needs matching".

- **Needed from the owner:** one real Pochi payment message, with the balance removed. The name
  and code letters may be changed.
- If its wording already parses, add it as a parsing test (name, amount, code, no phone).
- If it doesn't, add a pattern for it, plus that test. A reversal or outgoing-payment message
  must still be ignored.

## Error handling

- **Contacts unavailable** (permission refused, no contacts, or the module failing to load):
  **From your phone** shows a short message, and searching customers works as before.
- **A contact with no usable number** is shown but cannot be picked, with the reason.
- **Learning a name that is already learned** does nothing. A unique-constraint race is caught
  and ignored, so the payment is still recorded.
- **Removing a name that is already gone** returns 404 and the app refreshes the list.

## Testing

- **Backend** (`backend/tests/test_mpesa_names.py`):
  - a name is learned on assign, once only, and not for `UNKNOWN`;
  - a number match plus a learned name clears automatically for a nickname customer;
  - no number plus a learned name gives needs matching with that customer suggested, and the
    payment is not applied;
  - a learned name shared by two customers gives no suggestion;
  - archived customers' names are ignored;
  - removing a name stops the suggestion;
  - cashiers get 403 and other businesses get 404;
  - the Pochi parsing test.
- **PostgreSQL row-level security:** `customer_mpesa_names` is covered in
  `test_postgres_rls.py`.
- **App:**
  - `searchPhoneBook` by name and by number in each format, leaving out existing customers'
    numbers and flagging non-Kenyan numbers;
  - `ContactResults` permission states;
  - Record debt with a new contact, online (customer, then debt) and offline (both queued);
  - an existing number reusing the customer;
  - Pick from contacts filling the New customer form;
  - the M-Pesa names section;
  - `expo-contacts` mocked in `jest.setup.ts`.
- **On the phone:** the permission prompt, recording a debt for a new contact, and a real Pochi
  payment arriving in "needs matching" with the learned customer chosen.

## Docs to update

- `docs/user-guide.md`: contacts search, M-Pesa names, how Pochi payments are handled.
- `docs/api-guide.md`: the new endpoints and the matching table.
- `docs/database-schema.md`: the new table.
- `docs/security.md`: contacts data handling, and the anonymisation step.
- `README.md`: the feature list and test counts.

## Out of scope

- Importing the whole phone book as customers.
- Clearing Pochi payments automatically.
- Syncing contact edits back to customers, or customer edits to contacts.
- M-PESA Jumbe staff alerts (initials and the last two digits instead of the name). The app
  reads M-Pesa messages on the owner's phone, not on staff phones.
