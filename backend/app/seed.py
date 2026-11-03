"""Development seed data. Refuses to run in production.

    python -m app.seed

Creates a demo business with an owner and a cashier, customers, debts in several states
and payments recorded through the real services (so balances are genuinely derived).
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.api.deps import Tenant
from app.config import get_settings
from app.db import SessionLocal, bypass_tenant
from app.models import (
    Business,
    BusinessMembership,
    BusinessSettings,
    Customer,
    ReminderTemplate,
    Role,
    User,
)
from app.schemas import DebtCreate, InstallmentPlanIn, PaymentCreate
from app.security import hash_password
from app.services.common import next_number, normalize_name
from app.services.debts import create_debt
from app.services.payments import record_payment
from app.services.reminders import DEFAULT_TEMPLATES

OWNER_EMAIL = "owner.demo@example.com"
CASHIER_EMAIL = "cashier.demo@example.com"
# Development-only credentials; documented in README. Never use outside local development.
DEMO_PASSWORD = "DemoPass!2026"


def seed() -> None:
    if get_settings().is_production:
        raise SystemExit("Refusing to seed a production database")
    with SessionLocal() as db:
        bypass_tenant(db)  # seeding spans tenants; it runs as a trusted system job
        if db.scalar(select(User.id).where(User.email == OWNER_EMAIL)):
            print("Seed data already present")
            return
        owner = User(
            email=OWNER_EMAIL,
            full_name="Wanjiru Kamau",
            phone="+254712000001",
            password_hash=hash_password(DEMO_PASSWORD),
        )
        cashier = User(
            email=CASHIER_EMAIL,
            full_name="Otieno Omondi",
            phone="+254712000002",
            password_hash=hash_password(DEMO_PASSWORD),
        )
        biz = Business(name="Kamau Hardware & Supplies", phone="+254712000001", address="Kiambu Road, Nairobi")
        db.add_all([owner, cashier, biz])
        db.flush()
        db.add_all(
            [
                BusinessMembership(business_id=biz.id, user_id=owner.id, role=Role.owner),
                BusinessMembership(business_id=biz.id, user_id=cashier.id, role=Role.cashier),
                BusinessSettings(business_id=biz.id),
            ]
        )
        for kind, body in DEFAULT_TEMPLATES.items():
            db.add(ReminderTemplate(business_id=biz.id, kind=kind, body=body))
        db.flush()
        settings = db.get(BusinessSettings, biz.id)
        if settings is None:
            raise SystemExit("Business settings were not created")
        tenant = Tenant(business=biz, user=owner, role=Role.owner, settings=settings, ip=None)

        people = [
            ("Mwangi Building Contractors", "+254722111222"),
            ("Achieng Atieno", "+254733222333"),
            ("Kiprono Kirui", "+254711333444"),
            ("Fatuma Hassan", "+254701444555"),
            ("Njoroge Electricals", "+254720555666"),
        ]
        customers = []
        for name, phone in people:
            n = next_number(db, biz.id, "customer")
            c = Customer(
                business_id=biz.id,
                customer_number=f"C-{n:05d}",
                name=name,
                name_normalized=normalize_name(name),
                phone=phone,
                created_by=owner.id,
            )
            db.add(c)
            customers.append(c)
        db.flush()

        today = date.today()
        specs = [
            (0, "Cement 50 bags, Bamburi", "42500.00", -40, -10, None),
            (0, "Iron sheets, 30 gauge x 20", "18600.00", -5, 9, None),
            (1, "Paint and brushes", "6400.00", -20, -3, None),
            (2, "Plumbing fittings", "12000.00", -15, 3, None),
            (3, "Wheelbarrow", "7800.00", -3, 25, None),
            (
                4,
                "Cables and sockets (installments)",
                "36000.00",
                -45,
                45,
                InstallmentPlanIn(count=3, frequency="monthly", first_due_date=today - timedelta(days=15)),
            ),
        ]
        debts = []
        for idx, desc, amount, incurred, due, plan in specs:
            debts.append(
                create_debt(
                    db,
                    tenant,
                    DebtCreate(
                        customer_id=customers[idx].id,
                        description=desc,
                        principal=Decimal(amount),
                        incurred_on=today + timedelta(days=incurred),
                        due_date=today + timedelta(days=due),
                        installment_plan=plan,
                    ),
                )
            )
        now = datetime.now(UTC)
        record_payment(
            db,
            tenant,
            PaymentCreate(
                customer_id=customers[0].id,
                amount=Decimal("20000.00"),
                method="cash",
                paid_at=now - timedelta(days=8),
                allocations=[{"debt_id": debts[0].id, "amount": "20000.00"}],
            ),
        )
        record_payment(
            db,
            tenant,
            PaymentCreate(
                customer_id=customers[2].id, amount=Decimal("12000.00"), method="cash", paid_at=now - timedelta(hours=3)
            ),
        )
        record_payment(
            db,
            tenant,
            PaymentCreate(
                customer_id=customers[4].id, amount=Decimal("12000.00"), method="cash", paid_at=now - timedelta(days=14)
            ),
        )
        record_payment(
            db,
            tenant,
            PaymentCreate(
                customer_id=customers[1].id,
                amount=Decimal("3000.00"),
                method="mpesa",
                external_reference="SLK4H7R2QX",
                paid_at=now - timedelta(hours=1),
                client_reference=str(uuid.uuid4()),
            ),
        )
        db.commit()
        print(
            f"Seeded business {biz.name}\n  owner:   {OWNER_EMAIL}\n  cashier: {CASHIER_EMAIL}\n"
            f"  password: see app/seed.py (development only)"
        )


if __name__ == "__main__":
    seed()
