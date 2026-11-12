# DeniTrack user guide

*Every debt accounted for. Every payment tracked.*

## Getting started (owner)

1. Open the app and tap **Set up my business**. If someone set up a DeniTrack server for you,
   first tap **Change server** at the bottom of that screen and enter the address they gave you
   (the app checks it before saving). Enter your business name, your name, phone,
   email and a password (at least 10 characters with letters and numbers).
2. Go to **More → Business setup** to add your phone and address (they appear on receipts),
   choose which payment methods you accept, and decide whether cashiers may add customers or view reports.
3. Go to **More → Staff → Add staff member** for each cashier. Give them the temporary password
   in person; they will be asked to choose their own the first time they sign in.

## Daily work

| I want to… | Go to |
|---|---|
| See what is owed, what is overdue and today's collections | **Home** |
| Find a customer | **Customers**: search by name, phone (e.g. `0712…`) or customer ID (`C-00012`) |
| Add a customer | **Customers → Add**. Tap **Pick from contacts** to fill in the name and number from your phone's contacts. If DeniTrack thinks they already exist, it shows the match first |
| Record goods given on credit | **Home → New debt**, or from the customer's profile. Search for the customer: people in your phone's contacts who aren't customers yet appear under *From your phone*, and picking one adds them as a customer when you save. Under *What was taken on credit*, put one item per line (press Enter for the next item); lists, receipts and the SMS show them as "Sugar 2kg, Bread, Milk 1L". Turn on *Pay in installments* for weekly or monthly plans. *Send SMS to customer* (on by default) texts them what they took, the amount and when to pay |
| Record money received | **Record payment**. Choose the customer, check the amount, choose *Oldest due first* or a specific debt, pick the method, then **Review payment → Confirm and save** |
| Give a receipt | After saving a payment, tap **Share as text** (SMS or WhatsApp) or **Share PDF** |
| Ask a customer to pay by M-Pesa | In **Record payment**, tap **Request payment by M-Pesa instead**. The customer gets a PIN prompt; the payment is recorded only when M-Pesa confirms it |
| Follow up overdue accounts | **Debts → Overdue**, or **More → Overdue debts** |
| See what is coming due | **Debts → Due soon**, or **More → Upcoming payments** |

### Customers from your phone's contacts

The first time you search contacts, Android asks whether DeniTrack may read them. The phone book
stays on the phone: DeniTrack saves only the person you pick, as a customer, and you can tidy their
name before saving. When you're online and the number already belongs to a customer, the debt goes
to that customer instead of creating a second one. Offline, DeniTrack can't check: if the number
turns out to belong to a customer, the new customer and the debt turn the sync bar red (see
*Working without internet*). Cashiers see contacts only when the business lets cashiers add
customers. If you said no, **Open settings** lets you change your mind.

### What the colours mean

- **Green**: paid, received, verified.
- **Amber**: due within a week, or a payment waiting for verification.
- **Red**: overdue, reversed, or needs attention.

### M-Pesa and bank payments need verification

When a cashier types an M-Pesa code or bank reference, the payment shows **Awaiting verification**
and does **not** reduce the balance yet. An owner or admin checks the M-Pesa statement or bank
account, then opens the payment and taps **Confirm received**. This prevents mistakes and fraudulent
codes. Cash recorded in person counts immediately. M-Pesa requests sent from the app (STK Push)
are confirmed automatically by Safaricom.

### Mistakes and corrections

Nothing financial is ever deleted:

- **Wrong payment?** Open it and tap **Reverse this payment** (owner or admin), giving a reason. The balance is restored and the receipt is marked reversed. Then record the correct payment.
- **Goods returned or a discount agreed?** Open the debt and tap **Adjust amount owed**.
- **Customer disputes a debt?** **Mark as disputed**: it stops counting as overdue and stops reminders until you resolve it.
- **Entered a debt twice?** **Cancel this debt** (only possible before any payment).

Every correction appears in **More → Audit log** with who did it, when, and why.

## M-Pesa payments recorded automatically

On the phone that receives your business's M-Pesa messages, an owner or administrator turns on
**More → Settings → This phone → Record M-Pesa payments automatically** and allows SMS access.

- DeniTrack reads only messages from **M-PESA**, starting from the moment you turn it on.
- When a message says you received money, the payment is recorded and the debt reduced **only if the
  payer's phone number and name both match one customer**. Safaricom now hides part of the number
  (e.g. 0722\*\*\*712); DeniTrack matches the digits that are shown together with the name.
- **M-Pesa names.** Customers added from contacts often have nicknames ("Mama Njeri"), while M-Pesa
  shows the name on their ID ("NJERI WAMBUI"). When you match one of their payments by hand,
  DeniTrack remembers that name, so their next payment from the same number is recorded
  automatically. Owners and admins see these names on the customer's page and can remove a wrong one.
- **Pochi la Biashara** messages show the payer's name but no phone number, so they are never
  recorded automatically. If that name has paid for one customer before, the customer is already
  chosen under **Needs matching**: one tap on **Record for …** records it. DeniTrack has not yet been
  checked against a real Pochi message, so until it is, Pochi payments may not appear at all: record
  them by hand.
- If a cashier already typed that M-Pesa code, the message confirms their payment instead.
- Anything it cannot match safely (a different name, someone paying for a customer, more than is owed)
  waits under **More → M-Pesa messages → Needs matching**. Tap **Record for …** or **Choose customer**,
  or **Not a debt payment** for things like a cash sale paid by M-Pesa.
- It runs when the app opens, every minute while it is open, and about every 15 minutes in the background.
  The phone needs a connection to your DeniTrack server.

Keep customers' phone numbers correct: the number is what DeniTrack matches first.

## Reminders

**More → Reminders → Schedule** controls when customers get a polite SMS: by default 7, 3 and 1
day(s) before the due date, on the day, and 3 and 7 days after. Reminders:

- are never sent during quiet hours (default 8 pm–8 am; they wait until morning);
- never exceed your weekly limit per customer (default 3);
- skip customers who asked not to be contacted (turn off *Send SMS reminders* on their profile);
- always use the current balance, and are cancelled automatically if the customer has paid.

Reminder SMS are sent **from the owner's phone** as normal text messages (SMS charges apply), so no SMS
provider account is needed. Turn on **Settings → This phone → Send reminder SMS from this phone** on one
phone. If you later get an SMS provider, choose it under **Schedule → Send SMS from**.

**Remind one customer now:** open their profile and tap **Send reminder**, then **SMS** (sent from your
phone) or **WhatsApp** (opens WhatsApp with the message ready; you tap send). The message uses your
wording and their current balance, and counts towards the weekly limit.

**SMS when credit is recorded:** with *Send SMS to customer* on, the customer gets a message such as
"Hello Achieng, Duka la Mama has recorded Cement 2 bags taken on credit on 07 Nov 2026, worth KSh
2,450.00. Please pay by 21 Nov 2026." It is a receipt, not a reminder, so it goes straight away even
in quiet hours and does not count towards the weekly limit. It goes out like reminder SMS: at once if
the debt was recorded on the phone that sends SMS, otherwise from that phone at its next check (within
a minute while the app is open). Customers who turned off SMS do not get it.

Edit the wording under **Messages** (*When credit is recorded* is the notice; it can also use
`{items}` and `{credit_date}`). Keep it friendly. Never threaten or shame, and remember reminders go only to the customer.

## Reports

**More → Reports**: choose a report and a period (today, this week, this month, last month or custom).

- **Collections**: repayments received and verified, by day and by method.
- **Credit issued**: new debts recorded. This is not money received.
- **Overdue aging**: what is owed, grouped by days overdue.
- **Customer balances**, **Settled debts**, **Staff activity**, **Reversals & disputes**.

Tap **CSV** or **PDF** to export and share. Exports contain customer data, so share them carefully.

## Working without internet

You can keep adding customers, debts and payments when the connection drops. A yellow bar shows
**Offline · N records waiting to sync**. They are saved on the phone and sent automatically when you reconnect.

- Records waiting to sync are **not yet on the server**. They do not appear in reports, and no receipt is issued until they sync.
- If the server refuses one (for example, someone else already recorded that payment), the bar turns red. Tap it to see why, then **Try again** or **Discard**.
- Verifying, reversing, adjustments, reports and M-Pesa requests need a connection.
- Do not sign out with records waiting to sync: signing out removes them from the phone.

## Light and dark mode

**More → Settings → Appearance**: *System* follows your phone's light/dark setting, or choose
*Light* or *Dark* to keep one look. The choice stays on the phone, even after signing out.

## Security tips

- Each staff member should have their own login; never share passwords.
- If a phone is lost, sign in on another device and use **Settings → Sign out on all devices**,
  and the owner can **Disable access** for that staff member.
- Remove staff access as soon as someone leaves.
