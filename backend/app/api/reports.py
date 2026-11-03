from datetime import UTC, date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app import reports as rpt
from app.api.deps import Tenant, get_tenant
from app.db import get_db
from app.errors import BusinessRuleError, Forbidden
from app.models import Role
from app.services.common import audit, business_today

router = APIRouter(prefix="/businesses/{business_id}", tags=["reports"])

ReportName = Literal[
    "collections", "credit_issued", "aging", "customer_balances", "settlement", "employee_activity", "exceptions"
]


def reports_access(tenant: Tenant = Depends(get_tenant)) -> Tenant:
    if tenant.role == Role.cashier and not tenant.settings.cashier_can_view_reports:
        raise Forbidden("Reports are available to owners and administrators")
    return tenant


def _range(tenant: Tenant, start: date | None, end: date | None) -> tuple[date, date]:
    today = business_today(tenant.business)
    end = end or today
    start = start or end.replace(day=1)
    if start > end:
        raise BusinessRuleError("Start date must be on or before end date")
    if (end - start).days > 366 * 3:
        raise BusinessRuleError("Date range may not exceed three years")
    return start, end


@router.get("/dashboard")
def dashboard(tenant: Tenant = Depends(get_tenant), db: Session = Depends(get_db)):
    return rpt.dashboard(db, tenant.business, business_today(tenant.business))


def _build(name: str, db: Session, tenant: Tenant, start: date, end: date, group_by: str) -> dict:
    b, today = tenant.business, business_today(tenant.business)
    return {
        "collections": lambda: rpt.collections(db, b, start, end, group_by),
        "credit_issued": lambda: rpt.credit_issued(db, b, start, end),
        "aging": lambda: rpt.aging(db, b, today),
        "customer_balances": lambda: rpt.customer_balances(db, b, today),
        "settlement": lambda: rpt.settlement(db, b, start, end, today),
        "employee_activity": lambda: rpt.employee_activity(db, b, start, end),
        "exceptions": lambda: rpt.exceptions(db, b, start, end, today),
    }[name]()


@router.get("/reports/{name}")
def report(
    name: ReportName,
    start: date | None = None,
    end: date | None = None,
    group_by: Literal["day", "week", "month"] = "day",
    tenant: Tenant = Depends(reports_access),
    db: Session = Depends(get_db),
):
    start, end = _range(tenant, start, end)
    return _build(name, db, tenant, start, end, group_by)


@router.get("/reports/{name}/export")
def export_report(
    name: Literal["collections", "credit_issued", "aging", "customer_balances", "employee_activity"],
    format: Literal["csv", "pdf"] = Query(default="csv"),
    start: date | None = None,
    end: date | None = None,
    tenant: Tenant = Depends(reports_access),
    db: Session = Depends(get_db),
):
    start, end = _range(tenant, start, end)
    data = _build(name, db, tenant, start, end, "day")
    if name == "collections":
        rows = [rpt.payment_row(p) for p in rpt._counted(db, tenant.business, start, end)]
    else:
        rows = data[rpt.EXPORT_TABLES[name][0]]
    columns = rpt.EXPORT_TABLES[name][1]
    filename = f"denitrack-{name}-{start}-{end}.{format}"
    audit(
        db,
        business_id=tenant.business_id,
        actor_id=tenant.user.id,
        action="report.exported",
        entity_type="report",
        entity_id=None,
        after={"report": name, "format": format, "start": start, "end": end},
        ip=tenant.ip,
    )
    db.commit()
    headers = {"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"}
    if format == "csv":
        return Response(rpt.to_csv(rows, columns), media_type="text/csv; charset=utf-8", headers=headers)
    title = f"{tenant.business.name} - {name.replace('_', ' ').title()}"
    subtitle = f"Period {start} to {end}. Generated {datetime.now(UTC):%Y-%m-%d %H:%M} UTC."
    return Response(rpt.to_pdf(title, subtitle, rows, columns), media_type="application/pdf", headers=headers)
