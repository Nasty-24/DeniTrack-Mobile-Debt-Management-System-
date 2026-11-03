import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { MoneyText, METHOD_LABEL } from '../components/finance';
import { CachedNotice, Screen } from '../components/Screen';
import { Banner, EmptyState, ErrorState, errorMessage, LoadingState } from '../components/states';
import { AppText, Button, Card, ChoiceChips, Divider, ListRow, Row, SectionHeader, TextField } from '../components/ui';
import { bizPath, useReport } from '../hooks/queries';
import { useSession } from '../hooks/useSession';
import { api } from '../services/api';
import { colors, space } from '../theme/tokens';
import type { PaymentMethod } from '../types/api';
import { addDaysISO, formatDate, isValidISODate, todayISO } from '../utils/dates';

type ReportName = 'collections' | 'credit_issued' | 'aging' | 'customer_balances' | 'settlement' | 'employee_activity' | 'exceptions';
type Preset = 'today' | 'week' | 'month' | 'last_month' | 'custom';

const REPORTS: { value: ReportName; label: string; dated: boolean; exportable: boolean }[] = [
  { value: 'collections', label: 'Collections', dated: true, exportable: true },
  { value: 'credit_issued', label: 'Credit issued', dated: true, exportable: true },
  { value: 'aging', label: 'Overdue aging', dated: false, exportable: true },
  { value: 'customer_balances', label: 'Customer balances', dated: false, exportable: true },
  { value: 'settlement', label: 'Settled debts', dated: true, exportable: false },
  { value: 'employee_activity', label: 'Staff activity', dated: true, exportable: true },
  { value: 'exceptions', label: 'Reversals & disputes', dated: true, exportable: false },
];

export function rangeFor(preset: Preset, today: string, custom: { start: string; end: string }): { start: string; end: string } {
  switch (preset) {
    case 'today':
      return { start: today, end: today };
    case 'week': {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
      return { start: addDaysISO(today, -dow), end: today };
    }
    case 'month':
      return { start: `${today.slice(0, 8)}01`, end: today };
    case 'last_month': {
      const firstThis = `${today.slice(0, 8)}01`;
      const lastPrev = addDaysISO(firstThis, -1);
      return { start: `${lastPrev.slice(0, 8)}01`, end: lastPrev };
    }
    default:
      return custom;
  }
}

export function ReportsScreen() {
  const { businessId } = useSession();
  const [report, setReport] = useState<ReportName>('collections');
  const [preset, setPreset] = useState<Preset>('month');
  const [custom, setCustom] = useState({ start: addDaysISO(todayISO(), -30), end: todayISO() });
  const [exporting, setExporting] = useState<string | null>(null);
  const meta = REPORTS.find((r) => r.value === report)!;
  const range = rangeFor(preset, todayISO(), custom);
  const validRange = isValidISODate(range.start) && isValidISODate(range.end) && range.start <= range.end;
  const q = useReport<any>(report, meta.dated ? { ...range, group_by: 'day' } : {}, validRange);

  const doExport = async (format: 'csv' | 'pdf') => {
    setExporting(format);
    try {
      const path = bizPath(businessId!, `/reports/${report}/export`);
      const query = { format, ...(meta.dated ? range : {}) };
      const file = new File(Paths.cache, `denitrack-${report}-${range.start}-${range.end}.${format}`);
      if (file.exists) file.delete();
      file.create();
      if (format === 'csv') file.write(await api.get<string>(path, { query, text: true }));
      else file.write(await api.get<Uint8Array>(path, { query, binary: true }));
      await Sharing.shareAsync(file.uri, { mimeType: format === 'csv' ? 'text/csv' : 'application/pdf', dialogTitle: `${meta.label} report` });
    } catch (e) {
      Alert.alert('Export failed', errorMessage(e));
    } finally {
      setExporting(null);
    }
  };

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => q.refetch()} edges={['bottom']}>
      <ChoiceChips label="Report" value={report} onChange={setReport} options={REPORTS.map((r) => ({ value: r.value, label: r.label }))} />
      {meta.dated ? (
        <>
          <ChoiceChips
            label="Period"
            value={preset}
            onChange={setPreset}
            options={[
              { value: 'today', label: 'Today' },
              { value: 'week', label: 'This week' },
              { value: 'month', label: 'This month' },
              { value: 'last_month', label: 'Last month' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
          {preset === 'custom' ? (
            <Row gap={space.md}>
              <View style={{ flex: 1 }}><TextField label="From" value={custom.start} onChangeText={(start) => setCustom((c) => ({ ...c, start }))} placeholder="YYYY-MM-DD" /></View>
              <View style={{ flex: 1 }}><TextField label="To" value={custom.end} onChangeText={(end) => setCustom((c) => ({ ...c, end }))} placeholder="YYYY-MM-DD" /></View>
            </Row>
          ) : null}
          {validRange ? (
            <AppText variant="caption" color={colors.inkMuted}>{formatDate(range.start)} – {formatDate(range.end)}</AppText>
          ) : (
            <Banner tone="warning">Enter a valid date range (YYYY-MM-DD, start before end).</Banner>
          )}
        </>
      ) : (
        <AppText variant="caption" color={colors.inkMuted}>As of today</AppText>
      )}

      <View style={{ marginTop: space.lg }}>
        {q.isPending ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <>
            <CachedNotice fromCache={q.data.fromCache} savedAt={q.data.savedAt} />
            <ReportBody name={report} data={q.data.data} />
          </>
        )}
      </View>

      {meta.exportable ? (
        <>
          <SectionHeader title="Export" />
          <Row gap={space.md}>
            <Button title="CSV" variant="secondary" style={{ flex: 1 }} loading={exporting === 'csv'} disabled={!validRange} onPress={() => doExport('csv')} />
            <Button title="PDF" variant="secondary" style={{ flex: 1 }} loading={exporting === 'pdf'} disabled={!validRange} onPress={() => doExport('pdf')} />
          </Row>
          <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.sm }}>
            Exports contain customer data. Share them only with people who need them.
          </AppText>
        </>
      ) : null}
    </Screen>
  );
}

function Line({ label, amount, tone }: { label: string; amount: string; tone?: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: space.sm }}>
      <AppText color={colors.inkMuted}>{label}</AppText>
      <MoneyText amount={amount} color={tone} />
    </Row>
  );
}

function ReportBody({ name, data }: { name: ReportName; data: any }) {
  switch (name) {
    case 'collections':
      return (
        <Card>
          <AppText variant="caption" color={colors.inkMuted}>Repayments collected (verified)</AppText>
          <MoneyText amount={data.total_collected} variant="display" color={colors.success} />
          <AppText variant="caption" color={colors.inkMuted}>{data.payment_count} payments · new credit is reported separately</AppText>
          <SectionHeader title="By method" />
          {data.by_method.length === 0 ? <AppText color={colors.inkMuted}>No collections in this period.</AppText> : data.by_method.map((m: any) => <Line key={m.method} label={METHOD_LABEL[m.method as PaymentMethod] ?? m.method} amount={m.amount} />)}
          <SectionHeader title="By day" />
          {data.series.map((s: any) => <Line key={s.period} label={formatDate(s.period.length === 7 ? `${s.period}-01` : s.period)} amount={s.amount} />)}
        </Card>
      );
    case 'credit_issued':
      return (
        <Card>
          <AppText variant="caption" color={colors.inkMuted}>New credit issued</AppText>
          <MoneyText amount={data.total_issued} variant="display" />
          <AppText variant="caption" color={colors.inkMuted}>{data.debt_count} debts recorded</AppText>
          <Divider />
          {data.debts.slice(0, 50).map((d: any) => <ListRow key={d.debt_number} title={d.customer_name} subtitle={`${d.debt_number} · ${formatDate(d.incurred_on)}`} right={<MoneyText amount={d.principal} />} />)}
        </Card>
      );
    case 'aging':
      return (
        <Card>
          <AppText variant="caption" color={colors.inkMuted}>Outstanding by days overdue</AppText>
          <MoneyText amount={data.total} variant="display" />
          <Divider />
          {data.buckets.map((b: any) => (
            <Line key={b.bucket} label={`${b.bucket === 'current' ? 'Not yet due' : `${b.bucket} days`} (${b.count})`} amount={b.amount} tone={b.bucket === 'current' ? colors.ink : colors.danger} />
          ))}
        </Card>
      );
    case 'customer_balances':
      return (
        <Card padded={false}>
          {data.customers.length === 0 ? <EmptyState title="No customers yet" /> : data.customers.map((c: any, i: number) => (
            <View key={c.customer_number}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <ListRow title={c.customer_name} subtitle={`${c.customer_number} · paid ${c.paid}`} right={<MoneyText amount={c.balance} color={c.overdue !== '0.00' ? colors.danger : colors.ink} />} />
            </View>
          ))}
        </Card>
      );
    case 'settlement':
      return (
        <Card>
          <Line label={`Fully settled (${data.fully_settled.length})`} amount={data.fully_settled_total} tone={colors.success} />
          <Line label={`Partly settled, still owing (${data.partially_settled.length})`} amount={data.partially_settled_outstanding} />
          <AppText variant="caption" color={colors.inkMuted}>For debts incurred in the selected period.</AppText>
        </Card>
      );
    case 'employee_activity':
      return (
        <Card padded={false}>
          {data.employees.length === 0 ? <EmptyState title="No activity in this period" /> : data.employees.map((e: any) => (
            <ListRow key={e.user_id} title={e.name} subtitle={`${e.payments_recorded} payments · ${e.debts_created} debts · ${e.reversals} reversals`} right={<MoneyText amount={e.amount_collected} color={colors.success} />} />
          ))}
        </Card>
      );
    case 'exceptions':
      return (
        <Card>
          <Line label={`Reversed payments (${data.reversed_payments.length})`} amount={data.reversed_total} tone={colors.danger} />
          {data.reversed_payments.map((p: any) => <AppText key={p.id} variant="caption" color={colors.inkMuted}>{p.customer_name}: {p.reason}</AppText>)}
          <Line label={`Disputed debts (${data.disputed_debts.length})`} amount={data.disputed_total} tone={colors.warning} />
          <AppText variant="caption" color={colors.inkMuted}>Rejected verifications: {data.rejected_payments.length}</AppText>
        </Card>
      );
  }
}
