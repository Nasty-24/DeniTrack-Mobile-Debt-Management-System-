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
| Add a customer | **Customers → Add**. If DeniTrack thinks they already exist, it shows the match first |
| Record goods given on credit | **Home → New debt**, or from the customer's profile. Turn on *Pay in installments* for weekly or monthly plans |
| Record money received | **Record payment**. Choose the customer, check the amount, choose *Oldest due first* or a specific debt, pick the method, then **Review payment → Confirm and save** |
| Give a receipt | After saving a payment, tap **Share as text** (SMS or WhatsApp) or **Share PDF** |
| Ask a customer to pay by M-Pesa | In **Record payment**, tap **Request payment by M-Pesa instead**. The customer gets a PIN prompt; the payment is recorded only when M-Pesa confirms it |
| Follow up overdue accounts | **Debts → Overdue**, or **More → Overdue debts** |
| See what is coming due | **Debts → Due soon**, or **More → Upcoming payments** |

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

## Reminders

**More → Reminders → Schedule** controls when customers get a polite SMS: by default 7, 3 and 1
day(s) before the due date, on the day, and 3 and 7 days after. Reminders:

- are never sent during quiet hours (default 8 pm–8 am; they wait until morning);
- never exceed your weekly limit per customer (default 3);
- skip customers who asked not to be contacted (turn off *Send SMS reminders* on their profile);
- always use the current balance, and are cancelled automatically if the customer has paid.

Edit the wording under **Messages**. Keep it friendly. Never threaten or shame, and remember reminders go only to the customer.

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
