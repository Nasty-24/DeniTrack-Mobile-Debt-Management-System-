"""Unit tests for the pure financial rules."""

import uuid
from datetime import date
from decimal import Decimal as D

import pytest

from app.services.ledger import (
    DebtFigures,
    Installment,
    MoneyError,
    OpenDebt,
    OverpaymentError,
    add_months,
    aging_bucket,
    allocate_oldest_first,
    amount_overdue,
    build_schedule,
    check_explicit_allocations,
    derive_status,
    money,
    next_installment_due,
    split_evenly,
    validate_schedule,
)

TODAY = date(2026, 6, 15)


class TestMoney:
    def test_accepts_strings_ints_and_decimals(self):
        assert money("1500") == D("1500.00")
        assert money(42) == D("42.00")
        assert money(D("0.1")) == D("0.10")

    def test_rejects_float(self):
        with pytest.raises(MoneyError):
            money(0.1)

    def test_rejects_sub_cent_precision(self):
        with pytest.raises(MoneyError):
            money("10.005")

    @pytest.mark.parametrize("bad", ["abc", "NaN", "Infinity", ""])
    def test_rejects_garbage(self, bad):
        with pytest.raises(MoneyError):
            money(bad)

    def test_decimal_sum_is_exact_where_float_is_not(self):
        assert money("0.10") + money("0.20") == money("0.30")


class TestBalancesAndStatus:
    def test_balance_formula(self):
        f = DebtFigures(principal=D("1000.00"), adjustments=D("-100.00"), paid=D("300.00"), pending=D("50.00"))
        assert f.total_due == D("900.00")
        assert f.balance == D("600.00")
        assert f.allocatable == D("550.00")

    def test_open_partial_paid(self):
        due = date(2026, 7, 1)
        assert derive_status("none", DebtFigures(D("100")), due, TODAY) == "open"
        assert derive_status("none", DebtFigures(D("100"), paid=D("40")), due, TODAY) == "partially_paid"
        assert derive_status("none", DebtFigures(D("100"), paid=D("100")), due, TODAY) == "paid"

    def test_fully_paid_debt_is_never_overdue(self):
        past_due = date(2026, 1, 1)
        f = DebtFigures(D("100"), paid=D("100"))
        assert derive_status("none", f, past_due, TODAY) == "paid"
        assert amount_overdue(f, past_due, TODAY) == 0

    def test_overdue_after_due_date_only(self):
        f = DebtFigures(D("100"), paid=D("30"))
        assert derive_status("none", f, TODAY, TODAY) == "partially_paid"  # due today is not overdue
        assert derive_status("none", f, date(2026, 6, 14), TODAY) == "overdue"
        assert amount_overdue(f, date(2026, 6, 14), TODAY) == D("70")

    def test_pending_payments_do_not_reduce_balance(self):
        f = DebtFigures(D("100"), pending=D("100"))
        assert f.balance == D("100")
        assert f.allocatable == 0
        assert derive_status("none", f, date(2026, 6, 1), TODAY) == "overdue"

    def test_flags_take_precedence(self):
        f = DebtFigures(D("100"))
        assert derive_status("cancelled", f, date(2026, 1, 1), TODAY) == "cancelled"
        assert derive_status("disputed", f, date(2026, 1, 1), TODAY) == "disputed"


class TestInstallments:
    def test_split_evenly_sums_exactly(self):
        parts = split_evenly(D("1000.00"), 3)
        assert parts == [D("333.33"), D("333.33"), D("333.34")]
        assert sum(parts) == D("1000.00")

    def test_split_too_small(self):
        with pytest.raises(MoneyError):
            split_evenly(D("0.02"), 3)

    def test_month_end_clamping(self):
        assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
        assert add_months(date(2028, 1, 31), 1) == date(2028, 2, 29)
        assert add_months(date(2026, 11, 30), 3) == date(2027, 2, 28)

    def test_build_schedule_monthly_and_weekly(self):
        s = build_schedule(D("900.00"), 3, date(2026, 1, 31))
        assert [i.due_date for i in s] == [date(2026, 1, 31), date(2026, 2, 28), date(2026, 3, 31)]
        w = build_schedule(D("100.00"), 2, date(2026, 1, 1), "weekly")
        assert w[1].due_date == date(2026, 1, 8)

    def test_validate_schedule(self):
        good = [Installment(1, date(2026, 1, 1), D("50")), Installment(2, date(2026, 2, 1), D("50"))]
        validate_schedule(D("100"), good)
        with pytest.raises(MoneyError):
            validate_schedule(D("101"), good)
        with pytest.raises(MoneyError):
            validate_schedule(D("100"), list(reversed(good)))

    def test_installment_overdue_before_final_due_date(self):
        sched = [Installment(1, date(2026, 6, 1), D("100")), Installment(2, date(2026, 7, 1), D("100"))]
        final = date(2026, 7, 1)
        assert derive_status("none", DebtFigures(D("200")), final, TODAY, sched) == "overdue"
        assert amount_overdue(DebtFigures(D("200")), final, TODAY, sched) == D("100")
        # First installment covered -> no longer overdue, just partially paid
        f = DebtFigures(D("200"), paid=D("100"))
        assert derive_status("none", f, final, TODAY, sched) == "partially_paid"

    def test_next_installment_due(self):
        sched = [Installment(1, date(2026, 6, 1), D("100")), Installment(2, date(2026, 7, 1), D("100"))]
        inst, remaining = next_installment_due(sched, D("130"))
        assert inst.number == 2 and remaining == D("70")
        assert next_installment_due(sched, D("200")) is None


class TestAllocation:
    def _debts(self):
        a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        return (
            a,
            b,
            c,
            [
                OpenDebt(b, date(2026, 7, 1), date(2026, 5, 1), D("300")),
                OpenDebt(a, date(2026, 6, 1), date(2026, 5, 1), D("200")),
                OpenDebt(c, date(2026, 8, 1), date(2026, 5, 1), D("0")),
            ],
        )

    def test_oldest_due_first(self):
        a, b, _, debts = self._debts()
        assert allocate_oldest_first(D("250"), debts) == [(a, D("200")), (b, D("50"))]

    def test_overpayment_refused(self):
        *_, debts = self._debts()
        with pytest.raises(OverpaymentError):
            allocate_oldest_first(D("500.01"), debts)

    def test_exact_settlement_allowed(self):
        a, b, _, debts = self._debts()
        assert allocate_oldest_first(D("500"), debts) == [(a, D("200")), (b, D("300"))]

    def test_non_positive_refused(self):
        *_, debts = self._debts()
        with pytest.raises(MoneyError):
            allocate_oldest_first(D("0"), debts)

    def test_explicit_allocations(self):
        a, b, *_ = self._debts()
        cap = {a: D("200"), b: D("300")}
        check_explicit_allocations(D("250"), [(a, D("100")), (b, D("150"))], cap)
        with pytest.raises(MoneyError):  # does not add up
            check_explicit_allocations(D("250"), [(a, D("100"))], cap)
        with pytest.raises(OverpaymentError):
            check_explicit_allocations(D("250"), [(a, D("250"))], cap)
        with pytest.raises(MoneyError):  # duplicate debt
            check_explicit_allocations(D("200"), [(a, D("100")), (a, D("100"))], cap)
        with pytest.raises(MoneyError):  # unknown debt
            check_explicit_allocations(D("10"), [(uuid.uuid4(), D("10"))], cap)


@pytest.mark.parametrize(
    "days,bucket", [(0, "current"), (1, "1-30"), (30, "1-30"), (31, "31-60"), (61, "61-90"), (91, "90+")]
)
def test_aging_buckets(days, bucket):
    assert aging_bucket(days) == bucket
