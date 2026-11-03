"""Pure, database-free financial rules. Everything here uses Decimal; floats are rejected.

Definitions (also documented in docs/architecture.md):

* total_due   = principal + sum(posted adjustments)
* paid        = sum(allocations of POSTED payments whose verification is verified/not_required)
* pending     = sum(allocations of POSTED payments still awaiting verification)
* balance     = total_due - paid                  (what the customer owes on verified records)
* allocatable = balance - pending                 (headroom for new payments; prevents overpayment)
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CENT = Decimal("0.01")
ZERO = Decimal("0.00")


class MoneyError(ValueError):
    pass


def money(value: Decimal | int | str) -> Decimal:
    """Normalise to 2dp. Floats are refused to avoid binary rounding errors."""
    if isinstance(value, float):
        raise MoneyError("Floating-point values are not accepted for money")
    try:
        d = Decimal(str(value)) if not isinstance(value, Decimal) else value
    except InvalidOperation as exc:
        raise MoneyError(f"Invalid amount: {value!r}") from exc
    if not d.is_finite():
        raise MoneyError("Amount must be finite")
    if d != d.quantize(CENT, rounding=ROUND_HALF_UP):
        raise MoneyError("Amounts may have at most 2 decimal places")
    return d.quantize(CENT)


def quantize(value: Decimal | int | None) -> Decimal:
    """For aggregates coming back from the database (never for user input)."""
    if value is None:
        return ZERO
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class DebtFigures:
    principal: Decimal
    adjustments: Decimal = ZERO
    paid: Decimal = ZERO
    pending: Decimal = ZERO

    @property
    def total_due(self) -> Decimal:
        return self.principal + self.adjustments

    @property
    def balance(self) -> Decimal:
        return self.total_due - self.paid

    @property
    def allocatable(self) -> Decimal:
        return max(ZERO, self.balance - self.pending)


@dataclass(frozen=True)
class Installment:
    number: int
    due_date: date
    amount: Decimal


def amount_overdue(
    figures: DebtFigures, due_date: date, today: date, schedule: list[Installment] | None = None
) -> Decimal:
    """Portion of the balance whose agreed date has passed (strictly before today)."""
    if figures.balance <= 0:
        return ZERO
    if today > due_date:
        return figures.balance
    if schedule:
        required = sum((i.amount for i in schedule if i.due_date < today), ZERO)
        return min(figures.balance, max(ZERO, required - figures.paid))
    return ZERO


def derive_status(
    flag: str,
    figures: DebtFigures,
    due_date: date,
    today: date,
    schedule: list[Installment] | None = None,
) -> str:
    """Single source of truth for debt status. Paid always wins over overdue."""
    if flag == "cancelled":
        return "cancelled"
    if flag == "disputed":
        return "disputed"
    if figures.balance <= 0:
        return "paid"
    if amount_overdue(figures, due_date, today, schedule) > 0:
        return "overdue"
    if figures.paid > 0:
        return "partially_paid"
    return "open"


def next_installment_due(schedule: list[Installment], paid: Decimal) -> tuple[Installment, Decimal] | None:
    """First installment not yet fully covered by verified payments, and what remains on it."""
    cumulative = ZERO
    for inst in schedule:
        cumulative += inst.amount
        if cumulative > paid:
            return inst, min(inst.amount, cumulative - paid)
    return None


def split_evenly(total: Decimal, parts: int) -> list[Decimal]:
    """Split into `parts` amounts that sum exactly to total; leftover cents go to the last part."""
    if parts < 1:
        raise MoneyError("At least one installment is required")
    total = money(total)
    cents = int(total * 100)
    base, remainder = divmod(cents, parts)
    amounts = [Decimal(base) / 100 for _ in range(parts)]
    amounts[-1] += Decimal(remainder) / 100
    if any(a <= 0 for a in amounts):
        raise MoneyError("Too many installments for this amount")
    return [a.quantize(CENT) for a in amounts]


def add_months(d: date, months: int) -> date:
    month_index = d.month - 1 + months
    year, month = d.year + month_index // 12, month_index % 12 + 1
    # Clamp to month end (e.g. 31 Jan + 1 month -> 28/29 Feb)
    for day in (d.day, 30, 29, 28):
        try:
            return date(year, month, min(d.day, day))
        except ValueError:
            continue
    raise AssertionError("unreachable")


def build_schedule(total: Decimal, count: int, first_due: date, frequency: str = "monthly") -> list[Installment]:
    amounts = split_evenly(total, count)
    out = []
    for i, amt in enumerate(amounts):
        if frequency == "monthly":
            due = add_months(first_due, i)
        elif frequency == "weekly":
            due = first_due + timedelta(weeks=i)
        else:
            raise MoneyError(f"Unknown frequency {frequency!r}")
        out.append(Installment(i + 1, due, amt))
    return out


def validate_schedule(principal: Decimal, schedule: list[Installment]) -> None:
    if not schedule:
        return
    if sum((i.amount for i in schedule), ZERO) != principal:
        raise MoneyError("Installments must add up exactly to the debt amount")
    dates = [i.due_date for i in schedule]
    if dates != sorted(dates) or len(set(dates)) != len(dates):
        raise MoneyError("Installment dates must be strictly increasing")


@dataclass(frozen=True)
class OpenDebt:
    debt_id: uuid.UUID
    due_date: date
    incurred_on: date
    allocatable: Decimal


class OverpaymentError(MoneyError):
    pass


def allocate_oldest_first(amount: Decimal, debts: list[OpenDebt]) -> list[tuple[uuid.UUID, Decimal]]:
    """Documented default rule: settle the debt with the earliest due date first
    (ties broken by date incurred). Overpayment is refused rather than silently held."""
    amount = money(amount)
    if amount <= 0:
        raise MoneyError("Payment amount must be positive")
    remaining = amount
    allocations: list[tuple[uuid.UUID, Decimal]] = []
    for d in sorted(debts, key=lambda d: (d.due_date, d.incurred_on, str(d.debt_id))):
        if remaining <= 0:
            break
        if d.allocatable <= 0:
            continue
        take = min(remaining, d.allocatable)
        allocations.append((d.debt_id, take))
        remaining -= take
    if remaining > 0:
        raise OverpaymentError(f"Payment exceeds the outstanding balance by KSh {remaining:,.2f}")
    return allocations


def check_explicit_allocations(
    amount: Decimal,
    requested: list[tuple[uuid.UUID, Decimal]],
    allocatable: dict[uuid.UUID, Decimal],
) -> None:
    if sum((a for _, a in requested), ZERO) != amount:
        raise MoneyError("Allocations must add up exactly to the payment amount")
    seen = set()
    for debt_id, amt in requested:
        if debt_id in seen:
            raise MoneyError("A debt may appear only once in an allocation")
        seen.add(debt_id)
        if amt <= 0:
            raise MoneyError("Allocation amounts must be positive")
        if debt_id not in allocatable:
            raise MoneyError("Allocation refers to a debt that cannot receive payments")
        if amt > allocatable[debt_id]:
            raise OverpaymentError(
                f"Allocation of KSh {amt:,.2f} exceeds the remaining balance of KSh {allocatable[debt_id]:,.2f}"
            )


def aging_bucket(days_overdue: int) -> str:
    if days_overdue <= 0:
        return "current"
    if days_overdue <= 30:
        return "1-30"
    if days_overdue <= 60:
        return "31-60"
    if days_overdue <= 90:
        return "61-90"
    return "90+"
