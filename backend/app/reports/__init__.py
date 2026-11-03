"""Reports, all derived from the same ledger rules as balances.

"Collected" means posted payments that are verified or need no verification. Payments
awaiting verification and reversed payments are reported separately, never in totals.
"Credit issued" (new debts) is always kept apart from "collections" (repayments).
"""

import csv
import io
import uuid
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Business,
    CustomerStatus,
    Debt,
    DebtFlag,
    Payment,
    PaymentStatus,
    User,
    VerificationStatus,
)
from app.repositories.debts import COUNTED, load_views
from app.services.ledger import ZERO, aging_bucket, quantize


def _bounds(business: Business, start: date, end: date) -> tuple[datetime, datetime]:
    tz = ZoneInfo(business.timezone)
    return (
        datetime.combine(start, time.min, tzinfo=tz),
        datetime.combine(end + timedelta(days=1), time.min, tzinfo=tz),
    )


def _local_date(business: Business, dt: datetime) -> date:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo("UTC"))
    return dt.astimezone(ZoneInfo(business.timezone)).date()


def _payments(db: Session, business: Business, start: date, end: date, *where) -> list[Payment]:
    lo, hi = _bounds(business, start, end)
    return list(
        db.scalars(
            select(Payment)
            .where(Payment.business_id == business.id, Payment.paid_at >= lo, Payment.paid_at < hi, *where)
            .order_by(Payment.paid_at.desc())
        ).unique()
    )


def _counted(db, business, start, end, *where) -> list[Payment]:
    return _payments(
        db,
        business,
        start,
        end,
        Payment.status == PaymentStatus.posted,
        Payment.verification_status.in_(COUNTED),
        *where,
    )


def _sum(items) -> Decimal:
    return quantize(sum((quantize(i) for i in items), ZERO))


def m(d: Decimal) -> str:
    return f"{d:.2f}"


def payment_row(p: Payment) -> dict:
    return {
        "id": str(p.id),
        "customer_id": str(p.customer_id),
        "customer_name": p.customer.name,
        "amount": m(quantize(p.amount)),
        "method": p.method.value,
        "paid_at": p.paid_at.isoformat(),
        "receipt_number": p.receipt_number,
        "verification_status": p.verification_status.value,
        "status": p.status.value,
    }


def dashboard(db: Session, business: Business, today: date) -> dict:
    views = load_views(db, business.id, today, Debt.flag == DebtFlag.none)
    outstanding = [v for v in views if v.figures.balance > 0]
    month_start = today.replace(day=1)
    pending = _payments(
        db,
        business,
        today - timedelta(days=365),
        today,
        Payment.status == PaymentStatus.posted,
        Payment.verification_status == VerificationStatus.pending,
    )
    due_soon = sorted(
        (v for v in outstanding if v.next_due_date and today <= v.next_due_date <= today + timedelta(days=7)),
        key=lambda v: v.next_due_date or today,
    )
    recent_debts = (
        db.scalars(select(Debt).where(Debt.business_id == business.id).order_by(Debt.created_at.desc()).limit(8))
        .unique()
        .all()
    )
    recent_payments = (
        db.scalars(
            select(Payment).where(Payment.business_id == business.id).order_by(Payment.created_at.desc()).limit(8)
        )
        .unique()
        .all()
    )
    return {
        "as_of": today.isoformat(),
        "currency": business.currency,
        "total_outstanding": m(_sum(v.figures.balance for v in outstanding)),
        "total_overdue": m(_sum(v.overdue_amount for v in outstanding)),
        "overdue_debts": sum(1 for v in outstanding if v.overdue_amount > 0),
        "collected_today": m(_sum(p.amount for p in _counted(db, business, today, today))),
        "collected_this_month": m(_sum(p.amount for p in _counted(db, business, month_start, today))),
        "pending_verification": m(_sum(p.amount for p in pending)),
        "pending_verification_count": len(pending),
        "customers_with_balance": len({v.debt.customer_id for v in outstanding}),
        "due_soon": [
            {
                "debt_id": str(v.debt.id),
                "debt_number": v.debt.debt_number,
                "customer_id": str(v.debt.customer_id),
                "customer_name": v.debt.customer.name,
                "due_date": (v.next_due_date or v.debt.due_date).isoformat(),
                "balance": m(v.figures.balance),
            }
            for v in due_soon[:10]
        ],
        "recent_payments": [payment_row(p) for p in recent_payments],
        "recent_debts": [
            {
                "id": str(d.id),
                "debt_number": d.debt_number,
                "customer_id": str(d.customer_id),
                "customer_name": d.customer.name,
                "principal": m(quantize(d.principal)),
                "description": d.description,
                "created_at": d.created_at.isoformat(),
            }
            for d in recent_debts
        ],
    }


def collections(db: Session, business: Business, start: date, end: date, group_by: str = "day") -> dict:
    payments = _counted(db, business, start, end)
    series: dict[str, Decimal] = defaultdict(lambda: ZERO)
    by_method: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for p in payments:
        d = _local_date(business, p.paid_at)
        if group_by == "week":
            key = (d - timedelta(days=d.weekday())).isoformat()
        elif group_by == "month":
            key = d.strftime("%Y-%m")
        else:
            key = d.isoformat()
        series[key] += quantize(p.amount)
        by_method[p.method.value] += quantize(p.amount)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "group_by": group_by,
        "total_collected": m(_sum(p.amount for p in payments)),
        "payment_count": len(payments),
        "series": [{"period": k, "amount": m(v)} for k, v in sorted(series.items())],
        "by_method": [{"method": k, "amount": m(v)} for k, v in sorted(by_method.items())],
    }


def credit_issued(db: Session, business: Business, start: date, end: date) -> dict:
    debts = (
        db.scalars(
            select(Debt)
            .where(
                Debt.business_id == business.id,
                Debt.incurred_on >= start,
                Debt.incurred_on <= end,
                Debt.flag != DebtFlag.cancelled,
            )
            .order_by(Debt.incurred_on)
        )
        .unique()
        .all()
    )
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "debt_count": len(debts),
        "total_issued": m(_sum(d.principal for d in debts)),
        "debts": [
            {
                "debt_number": d.debt_number,
                "customer_name": d.customer.name,
                "incurred_on": d.incurred_on.isoformat(),
                "due_date": d.due_date.isoformat(),
                "principal": m(quantize(d.principal)),
                "description": d.description,
            }
            for d in debts
        ],
    }


def aging(db: Session, business: Business, today: date) -> dict:
    names = ("current", "1-30", "31-60", "61-90", "90+")
    amounts: dict[str, Decimal] = dict.fromkeys(names, ZERO)
    counts: dict[str, int] = dict.fromkeys(names, 0)
    rows = []
    for v in load_views(db, business.id, today, Debt.flag == DebtFlag.none):
        if v.figures.balance <= 0:
            continue
        b = aging_bucket(v.days_overdue)
        amounts[b] += v.figures.balance
        counts[b] += 1
        rows.append(
            {
                "debt_number": v.debt.debt_number,
                "customer_name": v.debt.customer.name,
                "due_date": v.debt.due_date.isoformat(),
                "days_overdue": v.days_overdue,
                "balance": m(v.figures.balance),
                "bucket": b,
            }
        )
    return {
        "as_of": today.isoformat(),
        "buckets": [{"bucket": k, "amount": m(amounts[k]), "count": counts[k]} for k in names],
        "total": m(_sum(amounts.values())),
        "debts": sorted(rows, key=lambda r: -r["days_overdue"]),
    }


def customer_balances(db: Session, business: Business, today: date) -> dict:
    totals: dict[uuid.UUID, dict] = {}
    for v in load_views(db, business.id, today, Debt.flag == DebtFlag.none):
        t = totals.setdefault(
            v.debt.customer_id,
            {"customer": v.debt.customer, "balance": ZERO, "overdue": ZERO, "total_due": ZERO, "paid": ZERO},
        )
        t["balance"] += v.figures.balance
        t["overdue"] += v.overdue_amount
        t["total_due"] += v.figures.total_due
        t["paid"] += v.figures.paid
    rows = sorted(totals.values(), key=lambda t: -t["balance"])
    return {
        "as_of": today.isoformat(),
        "customers": [
            {
                "customer_number": t["customer"].customer_number,
                "customer_name": t["customer"].name,
                "phone": t["customer"].phone,
                "total_billed": m(t["total_due"]),
                "paid": m(t["paid"]),
                "balance": m(t["balance"]),
                "overdue": m(t["overdue"]),
            }
            for t in rows
            if t["balance"] != 0 or t["customer"].status == CustomerStatus.active
        ],
        "total_balance": m(_sum(t["balance"] for t in rows)),
    }


def settlement(db: Session, business: Business, start: date, end: date, today: date) -> dict:
    views = load_views(
        db, business.id, today, Debt.incurred_on >= start, Debt.incurred_on <= end, Debt.flag == DebtFlag.none
    )
    full = [v for v in views if v.status == "paid"]
    partial = [v for v in views if v.figures.paid > 0 and v.figures.balance > 0]

    def row(v):
        return {
            "debt_number": v.debt.debt_number,
            "customer_name": v.debt.customer.name,
            "total_due": m(v.figures.total_due),
            "paid": m(v.figures.paid),
            "balance": m(v.figures.balance),
            "status": v.status,
        }

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "fully_settled": [row(v) for v in full],
        "partially_settled": [row(v) for v in partial],
        "fully_settled_total": m(_sum(v.figures.total_due for v in full)),
        "partially_settled_outstanding": m(_sum(v.figures.balance for v in partial)),
    }


def employee_activity(db: Session, business: Business, start: date, end: date) -> dict:
    stats: dict[uuid.UUID, dict] = defaultdict(
        lambda: {"payments": 0, "collected": ZERO, "debts": 0, "credit": ZERO, "reversals": 0}
    )
    for p in _counted(db, business, start, end):
        stats[p.recorded_by]["payments"] += 1
        stats[p.recorded_by]["collected"] += quantize(p.amount)
    for d in db.scalars(
        select(Debt).where(Debt.business_id == business.id, Debt.incurred_on >= start, Debt.incurred_on <= end)
    ).unique():
        stats[d.created_by]["debts"] += 1
        stats[d.created_by]["credit"] += quantize(d.principal)
    lo, hi = _bounds(business, start, end)
    for p in db.scalars(
        select(Payment).where(Payment.business_id == business.id, Payment.reversed_at >= lo, Payment.reversed_at < hi)
    ).unique():
        if p.reversed_by:
            stats[p.reversed_by]["reversals"] += 1
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(list(stats)))).all()} if stats else {}
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "employees": [
            {
                "user_id": str(uid),
                "name": users[uid].full_name if uid in users else "Unknown",
                "payments_recorded": s["payments"],
                "amount_collected": m(s["collected"]),
                "debts_created": s["debts"],
                "credit_issued": m(s["credit"]),
                "reversals": s["reversals"],
            }
            for uid, s in stats.items()
        ],
    }


def exceptions(db: Session, business: Business, start: date, end: date, today: date) -> dict:
    lo, hi = _bounds(business, start, end)
    reversed_ = (
        db.scalars(
            select(Payment).where(
                Payment.business_id == business.id,
                Payment.status == PaymentStatus.reversed,
                Payment.reversed_at >= lo,
                Payment.reversed_at < hi,
            )
        )
        .unique()
        .all()
    )
    rejected = _payments(db, business, start, end, Payment.verification_status == VerificationStatus.rejected)
    disputed = load_views(db, business.id, today, Debt.flag == DebtFlag.disputed)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "reversed_payments": [payment_row(p) | {"reason": p.reversal_reason} for p in reversed_],
        "reversed_total": m(_sum(p.amount for p in reversed_)),
        "rejected_payments": [payment_row(p) for p in rejected],
        "disputed_debts": [
            {
                "debt_number": v.debt.debt_number,
                "customer_name": v.debt.customer.name,
                "balance": m(v.figures.balance),
                "reason": v.debt.flag_reason,
            }
            for v in disputed
        ],
        "disputed_total": m(_sum(v.figures.balance for v in disputed)),
    }


# --------------------------------------------------------------------------- export

EXPORT_TABLES = {
    "collections": ("payments", ["paid_at", "customer_name", "amount", "method", "receipt_number"]),
    "credit_issued": ("debts", ["debt_number", "customer_name", "incurred_on", "due_date", "principal", "description"]),
    "aging": ("debts", ["debt_number", "customer_name", "due_date", "days_overdue", "balance", "bucket"]),
    "customer_balances": (
        "customers",
        ["customer_number", "customer_name", "phone", "total_billed", "paid", "balance", "overdue"],
    ),
    "employee_activity": (
        "employees",
        ["name", "payments_recorded", "amount_collected", "debts_created", "credit_issued", "reversals"],
    ),
}


def _safe_cell(value) -> str:
    """Neutralise spreadsheet formula injection (=, +, -, @ at the start of a cell)."""
    s = "" if value is None else str(value)
    if s and s[0] in "=+-@\t\r" and not _is_number(s):
        return "'" + s
    return s


def _is_number(s: str) -> bool:
    try:
        Decimal(s)
        return True
    except ArithmeticError:
        return False
    except ValueError:
        return False


def to_csv(rows: list[dict], columns: list[str]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(columns)
    for r in rows:
        w.writerow([_safe_cell(r.get(c)) for c in columns])
    return buf.getvalue()


def to_pdf(title: str, subtitle: str, rows: list[dict], columns: list[str]) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4), title=title)
    styles = getSampleStyleSheet()
    data = [[c.replace("_", " ").title() for c in columns]] + [[str(r.get(c, "") or "") for c in columns] for r in rows]
    table = Table(data, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
                ("FONT", (0, 1), (-1, -1), "Helvetica", 8),
                ("LINEBELOW", (0, 0), (-1, 0), 0.75, colors.HexColor("#1F2A24")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F6F4EF")]),
            ]
        )
    )
    doc.build([Paragraph(title, styles["Title"]), Paragraph(subtitle, styles["Normal"]), Spacer(1, 12), table])
    return buf.getvalue()
