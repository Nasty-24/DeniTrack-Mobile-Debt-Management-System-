import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Alert, View } from 'react-native';

import { Badge, METHOD_LABEL } from '../components/finance';
import { applyServerErrors, FormField } from '../components/form';
import { CachedNotice, Screen } from '../components/Screen';
import { Banner, EmptyState, ErrorState, errorMessage, LoadingState } from '../components/states';
import { AppText, Button, Card, ChoiceChips, Divider, ListRow, Row, SectionHeader, SegmentedControl, TextField, ToggleRow } from '../components/ui';
import { encryption } from '../database/localDb';
import { bizPath, useAuditLog, useBizMutation, useBusiness, useNotifications, useReminders, useSettings, useStaff, useTemplates } from '../hooks/queries';
import { useOutbox } from '../hooks/useOutbox';
import { useSession } from '../hooks/useSession';
import type { AppScreenProps } from '../navigation/types';
import { api, getApiUrl } from '../services/api';
import { useTheme } from '../theme/ThemeProvider';
import { colors, space } from '../theme/tokens';
import type { Business, BusinessSettings, PaymentMethod, ReminderTemplate } from '../types/api';
import { formatDateTime } from '../utils/dates';
import { normalizeKenyanPhone } from '../utils/phone';
import { runPhoneTasks, smsAvailable } from '../services/phoneSms';
import { PhoneSmsSettings } from './MpesaScreens';
import { changePasswordSchema, paymentMethods, staffSchema, type StaffForm } from '../validation/schemas';

// --------------------------------------------------------------------------- More menu

export function MoreScreen() {
  const navigation = useNavigation();
  const { isManager, role, business, memberships, selectBusiness } = useSession();
  const notes = useNotifications();
  const unread = notes.data?.data.items.filter((n) => !n.read_at).length ?? 0;
  type MenuRoute = 'Notifications' | 'OverdueDebts' | 'UpcomingPayments' | 'Reports' | 'Reminders' | 'MpesaMessages' | 'Staff' | 'AuditLog' | 'BusinessSetup' | 'Settings';
  const items: { title: string; subtitle: string; to: MenuRoute; show: boolean }[] = [
    { title: 'Notifications', subtitle: unread ? `${unread} unread` : 'Alerts about dues and payments', to: 'Notifications', show: true },
    { title: 'Overdue debts', subtitle: 'Debts past their agreed date', to: 'OverdueDebts', show: true },
    { title: 'Upcoming payments', subtitle: 'Due in the next 14 days', to: 'UpcomingPayments', show: true },
    { title: 'Reports', subtitle: 'Collections, aging, exports', to: 'Reports', show: true },
    { title: 'Reminders', subtitle: 'Schedule, templates and history', to: 'Reminders', show: true },
    { title: 'M-Pesa messages', subtitle: 'Payments read from SMS, and any to match', to: 'MpesaMessages', show: isManager },
    { title: 'Staff', subtitle: 'Who can use this business', to: 'Staff', show: isManager },
    { title: 'Audit log', subtitle: 'Every financial change, who and when', to: 'AuditLog', show: isManager },
    { title: 'Business setup', subtitle: 'Details, payment methods, permissions', to: 'BusinessSetup', show: isManager },
    { title: 'Settings', subtitle: 'Account, security, sync and backup', to: 'Settings', show: true },
  ];
  return (
    <Screen edges={['top']}>
      <AppText variant="title" accessibilityRole="header">{business?.business_name}</AppText>
      <AppText color={colors.inkMuted}>Signed in as {role}</AppText>
      {memberships.length > 1 ? (
        <View style={{ marginTop: space.lg }}>
          <ChoiceChips label="Switch business" value={business?.business_id} onChange={(id) => selectBusiness(id)} options={memberships.map((m) => ({ value: m.business_id, label: m.business_name }))} />
        </View>
      ) : null}
      <Card padded={false} style={{ marginTop: space.lg }}>
        {items.filter((i) => i.show).map((i, idx) => (
          <View key={i.title}>
            {idx > 0 ? <Divider inset={space.lg} /> : null}
            <ListRow title={i.title} subtitle={i.subtitle} onPress={() => navigation.navigate(i.to)} />
          </View>
        ))}
      </Card>
    </Screen>
  );
}

// --------------------------------------------------------------------------- reminders

export function RemindersScreen() {
  const { isManager } = useSession();
  const [tab, setTab] = useState<'history' | 'schedule' | 'templates'>('history');
  return (
    <Screen edges={['bottom']}>
      <SegmentedControl label="Reminder section" value={tab} onChange={setTab} options={[{ value: 'history', label: 'History' }, { value: 'schedule', label: 'Schedule' }, { value: 'templates', label: 'Messages' }]} />
      <View style={{ marginTop: space.lg }}>
        {tab === 'history' ? <ReminderHistory canRetry={isManager} /> : tab === 'schedule' ? <ReminderSchedule canEdit={isManager} /> : <ReminderTemplates canEdit={isManager} />}
      </View>
    </Screen>
  );
}

function ReminderHistory({ canRetry }: { canRetry: boolean }) {
  const { businessId, isManager } = useSession();
  const [status, setStatus] = useState<string>('all');
  const q = useReminders(status === 'all' ? {} : { status });
  const retry = useBizMutation<{ id: string }, unknown>('post', (b) => `/reminders/${b.id}/retry`);
  const run = useBizMutation<object, { planned: number; sent: number; waiting_for_phone: number }>('post', () => '/reminders/run');
  return (
    <>
      <ChoiceChips label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'sent', label: 'Sent' }, { value: 'queued', label: 'Queued' }, { value: 'failed', label: 'Failed' }, { value: 'skipped', label: 'Skipped' }]} />
      {canRetry ? (
        <Button
          title="Check and send due reminders now"
          variant="secondary"
          loading={run.isPending}
          onPress={async () => {
            try {
              const r = await run.mutateAsync({});
              const phone = businessId ? await runPhoneTasks({ businessId, isManager }) : null;
              const fromPhone = phone
                ? ` ${phone.remindersSent} SMS sent from this phone.`
                : r.waiting_for_phone
                  ? ` ${r.waiting_for_phone} SMS waiting for the owner’s phone to send.`
                  : '';
              Alert.alert('Reminders', `${r.planned} planned, ${r.sent} sent.${fromPhone}`);
              void q.refetch();
            } catch (e) {
              Alert.alert('Could not run reminders', errorMessage(e));
            }
          }}
          style={{ marginBottom: space.lg }}
        />
      ) : null}
      {q.isPending ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.data.items.length === 0 ? (
        <EmptyState title="No reminders yet" body="Reminders are created automatically around due dates." />
      ) : (
        <Card padded={false}>
          {q.data.data.items.map((r, i) => (
            <View key={r.id} style={{ padding: space.lg, gap: space.xs }}>
              {i > 0 ? <Divider /> : null}
              <Row style={{ justifyContent: 'space-between' }}>
                <AppText variant="bodyStrong">{r.channel === 'sms' ? 'SMS to customer' : r.channel === 'whatsapp' ? 'WhatsApp to customer' : r.channel === 'in_app' ? 'Staff alert' : r.channel}</AppText>
                <Badge label={r.status} tone={r.status === 'sent' ? 'success' : r.status === 'failed' ? 'danger' : r.status === 'queued' ? 'warning' : 'neutral'} />
              </Row>
              <AppText variant="caption" color={colors.inkMuted}>
                {r.offset_days > 0 ? `${r.offset_days} days before due` : r.offset_days === 0 ? 'On due date' : `${-r.offset_days} days overdue`} · {formatDateTime(r.sent_at ?? r.created_at)}
              </AppText>
              {r.message ? <AppText variant="caption">{r.message}</AppText> : null}
              {r.last_error ? <AppText variant="caption" color={colors.danger}>{r.last_error}</AppText> : null}
              {canRetry && r.status === 'failed' ? <Button title="Retry" compact variant="secondary" onPress={() => retry.mutate({ id: r.id })} style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
          ))}
        </Card>
      )}
    </>
  );
}

function ReminderSchedule({ canEdit }: { canEdit: boolean }) {
  const q = useSettings();
  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <ReminderScheduleForm s={q.data.data} canEdit={canEdit} />;
}

function ReminderScheduleForm({ s, canEdit }: { s: BusinessSettings; canEdit: boolean }) {
  const save = useBizMutation<Partial<BusinessSettings>, BusinessSettings>('patch', () => '/settings');
  const [offsets, setOffsets] = useState(s.reminder_offsets.join(', '));
  const [quiet, setQuiet] = useState({ start: String(s.quiet_hours_start), end: String(s.quiet_hours_end) });
  const [maxWeek, setMaxWeek] = useState(String(s.max_reminders_per_customer_per_week));
  const [error, setError] = useState<string | null>(null);
  const toggleChannel = (c: string) =>
    save.mutate({ reminder_channels: s.reminder_channels.includes(c) ? s.reminder_channels.filter((x) => x !== c) : [...s.reminder_channels, c] });
  const submit = async () => {
    setError(null);
    const parsed = offsets.split(',').map((x) => Number(x.trim())).filter((x) => x.toString() !== 'NaN');
    if (!parsed.length || parsed.some((n) => !Number.isInteger(n) || n < -90 || n > 60)) return setError('Use whole numbers between -90 and 60, separated by commas.');
    try {
      await save.mutateAsync({ reminder_offsets: parsed, quiet_hours_start: Number(quiet.start), quiet_hours_end: Number(quiet.end), max_reminders_per_customer_per_week: Number(maxWeek) });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Card>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <ToggleRow label="Automatic reminders" value={s.reminders_enabled} onChange={(v) => canEdit && save.mutate({ reminders_enabled: v })} />
      <ToggleRow
        label="SMS to customers"
        description={s.sms_sender === 'phone' ? 'Sent as normal SMS from the owner’s phone (Settings → This phone)' : 'Sent through the SMS provider'}
        value={s.reminder_channels.includes('sms')}
        onChange={() => canEdit && toggleChannel('sms')}
      />
      {s.reminder_channels.includes('sms') ? (
        <View style={{ marginVertical: space.sm }}>
          <SegmentedControl
            label="Send SMS from"
            value={s.sms_sender}
            onChange={(v) => canEdit && save.mutate({ sms_sender: v })}
            options={[
              { value: 'phone', label: 'Owner’s phone' },
              { value: 'provider', label: 'SMS provider' },
            ]}
          />
        </View>
      ) : null}
      <ToggleRow label="In-app alerts to staff" value={s.reminder_channels.includes('in_app')} onChange={() => canEdit && toggleChannel('in_app')} />
      <ToggleRow label="Push notifications to staff" value={s.reminder_channels.includes('push')} onChange={() => canEdit && toggleChannel('push')} />
      <View style={{ height: space.lg }} />
      <TextField label="When to remind (days)" value={offsets} onChangeText={setOffsets} editable={canEdit} hint="Positive = before due date, 0 = on the day, negative = days overdue. E.g. 7, 3, 1, 0, -3, -7" />
      <Row gap={space.md}>
        <View style={{ flex: 1 }}><TextField label="Quiet from (hour)" keyboardType="number-pad" value={quiet.start} onChangeText={(start) => setQuiet((q2) => ({ ...q2, start }))} editable={canEdit} /></View>
        <View style={{ flex: 1 }}><TextField label="Quiet until (hour)" keyboardType="number-pad" value={quiet.end} onChangeText={(end) => setQuiet((q2) => ({ ...q2, end }))} editable={canEdit} /></View>
      </Row>
      <TextField label="Most SMS per customer per week" keyboardType="number-pad" value={maxWeek} onChangeText={setMaxWeek} editable={canEdit} />
      {canEdit ? <Button title="Save schedule" onPress={submit} loading={save.isPending} /> : <AppText color={colors.inkMuted}>Only owners and administrators can change reminders.</AppText>}
    </Card>
  );
}

function ReminderTemplates({ canEdit }: { canEdit: boolean }) {
  const q = useTemplates();
  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <>
      <AppText color={colors.inkMuted} style={{ marginBottom: space.md }}>
        Placeholders: {'{customer_name}'}, {'{business_name}'}, {'{amount}'}, {'{due_date}'}, {'{business_phone}'}. Keep messages polite: no threats, and never mention the debt to anyone but the customer.
      </AppText>
      {q.data.data.map((t) => <TemplateEditor key={t.kind} t={t} canEdit={canEdit} />)}
    </>
  );
}

function TemplateEditor({ t, canEdit }: { t: ReminderTemplate; canEdit: boolean }) {
  const [body, setBody] = useState(t.body);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const save = useBizMutation<{ body: string }, ReminderTemplate>('put', () => `/reminder-templates/${t.kind}`);
  const label = { upcoming: 'Before the due date', due_today: 'On the due date', overdue: 'After the due date' }[t.kind];
  return (
    <Card style={{ marginBottom: space.md }}>
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      <TextField label={label} value={body} onChangeText={setBody} multiline editable={canEdit} hint={`${body.length}/480 characters`} />
      {canEdit ? (
        <Button
          title="Save message"
          variant="secondary"
          compact
          loading={save.isPending}
          onPress={async () => {
            try {
              await save.mutateAsync({ body });
              setMsg({ tone: 'success', text: 'Saved.' });
            } catch (e) {
              setMsg({ tone: 'danger', text: errorMessage(e) });
            }
          }}
        />
      ) : null}
    </Card>
  );
}

// --------------------------------------------------------------------------- staff

export function StaffScreen() {
  const { role } = useSession();
  const isOwner = role === 'owner';
  const q = useStaff(true);
  const [adding, setAdding] = useState(false);
  const update = useBizMutation<{ id: string; role?: string; is_active?: boolean }, unknown>('patch', (b) => `/staff/${b.id}`);
  const add = useBizMutation<Record<string, unknown>, unknown>('post', () => '/staff');
  const [formError, setFormError] = useState<string | null>(null);
  const { control, handleSubmit, reset, setError, formState } = useForm<StaffForm>({
    resolver: zodResolver(staffSchema),
    defaultValues: { full_name: '', email: '', phone: '', role: 'cashier', temporary_password: '' },
  });
  const onAdd = handleSubmit(async (v) => {
    setFormError(null);
    try {
      await add.mutateAsync({ ...v, phone: v.phone ? normalizeKenyanPhone(v.phone) : null });
      reset();
      setAdding(false);
      Alert.alert('Staff added', 'Share the temporary password in person. They must change it when they first sign in.');
    } catch (e) {
      setFormError(applyServerErrors(e, setError, ['full_name', 'email', 'phone', 'temporary_password']));
    }
  });

  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <Screen edges={['bottom']}>
      <Card padded={false}>
        {q.data.data.map((s, i) => (
          <View key={s.membership_id} style={{ padding: space.lg, gap: space.sm }}>
            {i > 0 ? <Divider /> : null}
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <AppText variant="bodyStrong">{s.full_name}</AppText>
                <AppText variant="caption" color={colors.inkMuted}>{s.email}</AppText>
              </View>
              <Badge label={s.is_active ? s.role : 'disabled'} tone={s.is_active ? (s.role === 'owner' ? 'success' : 'info') : 'neutral'} />
            </Row>
            {isOwner && s.role !== 'owner' ? (
              <Row gap={space.sm}>
                <Button compact variant="secondary" title={s.role === 'cashier' ? 'Make admin' : 'Make cashier'} onPress={() => update.mutate({ id: s.membership_id, role: s.role === 'cashier' ? 'admin' : 'cashier' })} />
                <Button compact variant={s.is_active ? 'danger' : 'secondary'} title={s.is_active ? 'Disable access' : 'Restore access'} onPress={() => update.mutate({ id: s.membership_id, is_active: !s.is_active })} />
              </Row>
            ) : null}
          </View>
        ))}
      </Card>
      <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.md }}>
        Cashiers record customers, debts and payments. Administrators can also verify, reverse and correct records and see reports. Only the owner manages staff.
      </AppText>
      {isOwner ? (
        adding ? (
          <Card style={{ marginTop: space.lg }}>
            {formError ? <Banner tone="danger">{formError}</Banner> : null}
            <FormField control={control} name="full_name" label="Full name" autoCapitalize="words" />
            <FormField control={control} name="email" label="Email (used to sign in)" keyboardType="email-address" autoCapitalize="none" />
            <FormField control={control} name="phone" label="Phone (optional)" keyboardType="phone-pad" />
            <Controller control={control} name="role" render={({ field }) => <ChoiceChips label="Role" value={field.value} onChange={field.onChange} options={[{ value: 'cashier', label: 'Cashier' }, { value: 'admin', label: 'Administrator' }]} />} />
            <FormField control={control} name="temporary_password" label="Temporary password" secureTextEntry hint="At least 10 characters with letters and numbers" />
            <Button title="Add staff member" onPress={() => void onAdd()} loading={formState.isSubmitting} />
            <Button title="Cancel" variant="ghost" onPress={() => setAdding(false)} />
          </Card>
        ) : (
          <Button title="Add staff member" style={{ marginTop: space.lg }} onPress={() => setAdding(true)} />
        )
      ) : null}
    </Screen>
  );
}

// --------------------------------------------------------------------------- notifications

export function NotificationsScreen() {
  const navigation = useNavigation();
  const { businessId } = useSession();
  const q = useNotifications();
  const readAll = useBizMutation<object, unknown>('post', () => '/notifications/read-all');
  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = q.data.data.items;
  return (
    <Screen edges={['bottom']} refreshing={q.isRefetching} onRefresh={() => q.refetch()}>
      <CachedNotice fromCache={q.data.fromCache} savedAt={q.data.savedAt} />
      {items.some((n) => !n.read_at) ? <Button title="Mark all as read" variant="ghost" onPress={() => readAll.mutate({})} style={{ alignSelf: 'flex-end' }} /> : null}
      {items.length === 0 ? <EmptyState title="You're all caught up" body="Alerts about due dates, failed reminders and payments that need review appear here." /> : (
        <Card padded={false}>
          {items.map((n, i) => (
            <View key={n.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <ListRow
                title={`${n.read_at ? '' : '● '}${n.title}`}
                subtitle={`${n.body} · ${formatDateTime(n.created_at)}`}
                onPress={async () => {
                  if (!n.read_at) await api.post(bizPath(businessId!, `/notifications/${n.id}/read`)).catch(() => undefined);
                  if (n.entity_type === 'debt' && n.entity_id) navigation.navigate('DebtDetail', { debtId: n.entity_id });
                  else if (n.entity_type === 'payment' && n.entity_id) navigation.navigate('PaymentDetail', { paymentId: n.entity_id });
                  else if (n.entity_type === 'mpesa_sms') navigation.navigate('MpesaMessages');
                  void q.refetch();
                }}
              />
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

// --------------------------------------------------------------------------- audit

const ACTION_LABEL: Record<string, string> = {
  'payment.recorded': 'Payment recorded',
  'payment.reversed': 'Payment reversed',
  'payment.verified': 'Payment verified',
  'payment.rejected': 'Payment rejected',
  'debt.created': 'Debt created',
  'debt.updated': 'Debt edited',
  'debt.adjusted': 'Debt adjusted',
  'customer.created': 'Customer added',
  'customer.updated': 'Customer edited',
  'customer.archived': 'Customer archived',
  'settings.updated': 'Settings changed',
  'staff.added': 'Staff added',
  'staff.updated': 'Staff changed',
  'report.exported': 'Report exported',
  'mpesa_sms.assigned': 'M-Pesa payment matched',
  'mpesa_sms.dismissed': 'M-Pesa payment set aside',
  'reminder.manual': 'Reminder sent',
};

export function AuditLogScreen() {
  const [filter, setFilter] = useState<string>('');
  const q = useAuditLog(filter ? { action: filter } : {});
  const staff = useStaff(true);
  const names = new Map((staff.data?.data ?? []).map((s) => [s.user_id, s.full_name]));
  return (
    <Screen edges={['bottom']} refreshing={q.isRefetching} onRefresh={() => q.refetch()}>
      <ChoiceChips label="Show" value={filter} onChange={setFilter} options={[{ value: '', label: 'Everything' }, { value: 'payment', label: 'Payments' }, { value: 'debt', label: 'Debts' }, { value: 'customer', label: 'Customers' }, { value: 'staff', label: 'Staff' }]} />
      {q.isPending ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.data.items.length === 0 ? <EmptyState title="No entries" /> : (
        <Card padded={false}>
          {q.data.data.items.map((a, i) => (
            <View key={a.id} style={{ padding: space.lg, gap: 2 }}>
              {i > 0 ? <Divider /> : null}
              <AppText variant="bodyStrong">{ACTION_LABEL[a.action] ?? a.action}</AppText>
              <AppText variant="caption" color={colors.inkMuted}>
                {formatDateTime(a.created_at)} · {a.actor_user_id ? names.get(a.actor_user_id) ?? 'Staff member' : 'System'}
              </AppText>
              {a.reason ? <AppText variant="caption">Reason: {a.reason}</AppText> : null}
              {a.after && 'amount' in a.after ? <AppText variant="caption" color={colors.inkMuted}>Amount: KSh {String(a.after.amount)}</AppText> : null}
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

// --------------------------------------------------------------------------- business setup

export function BusinessSetupScreen() {
  const { role } = useSession();
  const biz = useBusiness();
  const settings = useSettings();
  const saveSettings = useBizMutation<Partial<BusinessSettings>, BusinessSettings>('patch', () => '/settings');
  if (biz.isPending || settings.isPending) return <LoadingState />;
  if (biz.isError) return <ErrorState error={biz.error} onRetry={() => biz.refetch()} />;
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  const s = settings.data.data;
  const isOwner = role === 'owner';
  const toggleMethod = (m: PaymentMethod) => {
    const next = s.payment_methods.includes(m) ? s.payment_methods.filter((x) => x !== m) : [...s.payment_methods, m];
    if (next.length) saveSettings.mutate({ payment_methods: next });
  };
  return (
    <Screen edges={['bottom']}>
      <BusinessDetailsForm business={biz.data.data} isOwner={isOwner} />
      <SectionHeader title="Payment methods accepted" />
      <Card>
        {paymentMethods.map((m) => (
          <ToggleRow key={m} label={METHOD_LABEL[m]} value={s.payment_methods.includes(m)} onChange={() => toggleMethod(m)} />
        ))}
      </Card>
      <SectionHeader title="Cashier permissions" />
      <Card>
        <ToggleRow label="Cashiers can add customers" value={s.cashier_can_register_customers} onChange={(v) => saveSettings.mutate({ cashier_can_register_customers: v })} />
        <ToggleRow label="Cashiers can view reports" value={s.cashier_can_view_reports} onChange={(v) => saveSettings.mutate({ cashier_can_view_reports: v })} />
      </Card>
    </Screen>
  );
}

function BusinessDetailsForm({ business, isOwner }: { business: Business; isOwner: boolean }) {
  const saveBiz = useBizMutation<Record<string, unknown>, unknown>('patch', () => '');
  const [form, setForm] = useState({ name: business.name, phone: business.phone ?? '', address: business.address ?? '' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  return (
    <>
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      <SectionHeader title="Business details" />
      <Card>
        <TextField label="Business name" value={form.name} onChangeText={(name) => setForm((f) => ({ ...f, name }))} editable={isOwner} />
        <TextField label="Phone (shown on receipts and reminders)" value={form.phone} keyboardType="phone-pad" onChangeText={(phone) => setForm((f) => ({ ...f, phone }))} editable={isOwner} />
        <TextField label="Address" value={form.address} onChangeText={(address) => setForm((f) => ({ ...f, address }))} editable={isOwner} />
        <AppText variant="caption" color={colors.inkMuted} style={{ marginBottom: space.md }}>Currency: KES · Time zone: East Africa Time</AppText>
        {isOwner ? (
          <Button
            title="Save details"
            loading={saveBiz.isPending}
            onPress={async () => {
              setMsg(null);
              const phone = form.phone ? normalizeKenyanPhone(form.phone) : null;
              if (form.phone && !phone) return setMsg({ tone: 'danger', text: 'Enter a valid phone number.' });
              try {
                await saveBiz.mutateAsync({ name: form.name, phone, address: form.address || null });
                setMsg({ tone: 'success', text: 'Business details saved.' });
              } catch (e) {
                setMsg({ tone: 'danger', text: errorMessage(e) });
              }
            }}
          />
        ) : null}
      </Card>
    </>
  );
}

// --------------------------------------------------------------------------- settings

export function SettingsScreen() {
  const navigation = useNavigation();
  const { user, signOut, isManager } = useSession();
  const { preference, setPreference } = useTheme();
  const smsSection = isManager && smsAvailable;
  const { pendingCount, failedCount, lastSyncAt, online, syncNow, syncing } = useOutbox();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<{ status: string; integrations: Record<string, string> }>('/api/v1/health', { auth: false }),
  });
  const unsynced = pendingCount + failedCount;

  const confirmSignOut = (everywhere: boolean) => {
    const proceed = () => void signOut({ everywhere });
    if (unsynced > 0) {
      Alert.alert(
        'Unsynced records',
        `${unsynced} record${unsynced > 1 ? 's are' : ' is'} only saved on this phone. Signing out deletes ${unsynced > 1 ? 'them' : 'it'}. Sync first if you can.`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out and delete', style: 'destructive', onPress: proceed }],
      );
    } else {
      Alert.alert(everywhere ? 'Sign out on all devices?' : 'Sign out?', undefined, [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', onPress: proceed }]);
    }
  };

  return (
    <Screen edges={['bottom']}>
      <SectionHeader title="Account" />
      <Card>
        <AppText variant="bodyStrong">{user?.full_name}</AppText>
        <AppText color={colors.inkMuted}>{user?.email}</AppText>
        <Button title="Change password" variant="secondary" style={{ marginTop: space.lg }} onPress={() => navigation.navigate('ChangePassword')} />
      </Card>

      <SectionHeader title="Appearance" />
      <Card>
        <SegmentedControl
          label="Theme"
          value={preference}
          onChange={setPreference}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
        <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.sm }}>
          {preference === 'system' ? 'Follows your phone’s light or dark setting.' : `Always ${preference}.`}
        </AppText>
      </Card>

      {smsSection ? (
        <>
          <SectionHeader title="This phone" />
          <PhoneSmsSettings />
        </>
      ) : null}

      <SectionHeader title="Sync and backup" />
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText>Connection</AppText>
          <Badge label={online ? 'Online' : 'Offline'} tone={online ? 'success' : 'warning'} />
        </Row>
        <Row style={{ justifyContent: 'space-between', marginTop: space.sm }}>
          <AppText>Waiting to sync</AppText>
          <AppText tabular>{pendingCount}</AppText>
        </Row>
        <Row style={{ justifyContent: 'space-between', marginTop: space.sm }}>
          <AppText>Needs attention</AppText>
          <AppText tabular color={failedCount ? colors.danger : colors.ink}>{failedCount}</AppText>
        </Row>
        <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.sm }}>
          {lastSyncAt ? `Last synced ${formatDateTime(new Date(lastSyncAt).toISOString())}` : 'Not synced in this session yet'}
        </AppText>
        <Row gap={space.md} style={{ marginTop: space.md }}>
          <Button title="Sync now" variant="secondary" compact loading={syncing} onPress={() => void syncNow()} />
          <Button title="View queue" variant="ghost" compact onPress={() => navigation.navigate('SyncQueue')} />
        </Row>
        <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.md }}>
          Your records are stored on the DeniTrack server, which is backed up by your administrator. This phone keeps only a working copy.
        </AppText>
      </Card>

      <SectionHeader title="Security" />
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText>Local data encryption</AppText>
          <Badge label={encryption === 'sqlcipher' ? 'On' : encryption === 'unavailable' ? 'Not available in this build' : 'Unknown'} tone={encryption === 'sqlcipher' ? 'success' : 'warning'} />
        </Row>
        <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.sm }}>
          Sign-in tokens are kept in the phone’s secure keystore. Signing out removes all customer data from this phone.
        </AppText>
        <Button title="Sign out" variant="secondary" style={{ marginTop: space.lg }} onPress={() => confirmSignOut(false)} />
        <Button title="Sign out on all devices" variant="danger" style={{ marginTop: space.sm }} onPress={() => confirmSignOut(true)} />
      </Card>

      <SectionHeader title="Privacy" />
      <Card>
        <AppText variant="caption" color={colors.inkMuted}>
          This business uses DeniTrack to record credit it has given and payments received. It stores customers’ names, phone numbers and optional contact details, kept only as long as needed for these records and any legal retention period. Customers can ask the business to see, correct or delete their information, subject to records the law requires to be kept. Reminders go only to the customer’s own number.
        </AppText>
      </Card>

      <SectionHeader title="About" />
      <Card>
        <AppText variant="caption" color={colors.inkMuted}>Version {Constants.expoConfig?.version ?? '1.0.0'}</AppText>
        <AppText variant="caption" color={colors.inkMuted}>Server: {getApiUrl()}</AppText>
        {health.data ? (
          <AppText variant="caption" color={colors.inkMuted}>
            M-Pesa: {health.data.integrations.mpesa} · SMS: {health.data.integrations.sms} mode
          </AppText>
        ) : null}
      </Card>
    </Screen>
  );
}

export function ChangePasswordScreen({ route, navigation }: AppScreenProps<'ChangePassword'>) {
  const { refreshProfile } = useSession();
  const forced = route.params?.forced;
  const [formError, setFormError] = useState<string | null>(null);
  const { control, handleSubmit, setError, formState } = useForm({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current_password: '', new_password: '', confirm: '' },
  });
  const onSubmit = handleSubmit(async ({ current_password, new_password }) => {
    setFormError(null);
    try {
      await api.post('/api/v1/auth/change-password', { current_password, new_password });
      await refreshProfile();
      if (!forced) navigation.goBack();
    } catch (e) {
      setFormError(applyServerErrors(e, setError, ['current_password', 'new_password']));
    }
  });
  return (
    <Screen edges={forced ? ['top', 'bottom'] : ['bottom']}>
      {forced ? <Banner tone="info">Choose your own password to continue. The temporary one you were given will stop working.</Banner> : null}
      {formError ? <Banner tone="danger">{formError}</Banner> : null}
      <FormField control={control} name="current_password" label={forced ? 'Temporary password' : 'Current password'} secureTextEntry />
      <FormField control={control} name="new_password" label="New password" secureTextEntry hint="At least 10 characters, with letters and numbers" />
      <FormField control={control} name="confirm" label="Confirm new password" secureTextEntry />
      <Button title="Change password" onPress={() => void onSubmit()} loading={formState.isSubmitting} />
      <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.md }}>Other devices will be signed out.</AppText>
    </Screen>
  );
}

export function SyncQueueScreen() {
  const { ops, retry, discard, syncNow, syncing, online } = useOutbox();
  return (
    <Screen edges={['bottom']}>
      <AppText color={colors.inkMuted} style={{ marginBottom: space.lg }}>
        These records were created while offline and are saved only on this phone. They are not on the server and do not appear in reports until synced.
      </AppText>
      <Button title={online ? 'Sync now' : 'Offline – will sync when connected'} disabled={!online} loading={syncing} onPress={() => void syncNow()} />
      {ops.length === 0 ? <EmptyState title="Everything is synced" /> : (
        <Card padded={false} style={{ marginTop: space.lg }}>
          {ops.map((o, i) => (
            <View key={o.id} style={{ padding: space.lg, gap: space.xs }}>
              {i > 0 ? <Divider /> : null}
              <Row style={{ justifyContent: 'space-between' }}>
                <AppText variant="bodyStrong" style={{ flex: 1 }}>{o.summary}</AppText>
                <Badge label={o.status === 'failed' ? 'Needs attention' : 'Waiting'} tone={o.status === 'failed' ? 'danger' : 'warning'} />
              </Row>
              <AppText variant="caption" color={colors.inkMuted}>Saved {formatDateTime(new Date(o.createdAt).toISOString())}{o.attempts ? ` · ${o.attempts} attempt${o.attempts > 1 ? 's' : ''}` : ''}</AppText>
              {o.lastError ? <AppText variant="caption" color={o.status === 'failed' ? colors.danger : colors.inkMuted}>{o.lastError}</AppText> : null}
              {o.status === 'failed' ? (
                <Row gap={space.sm}>
                  <Button compact variant="secondary" title="Try again" onPress={() => void retry(o)} />
                  <Button
                    compact
                    variant="danger"
                    title="Discard"
                    onPress={() => Alert.alert('Discard this record?', 'It was never saved on the server. Re-enter it correctly if needed.', [{ text: 'Keep', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => void discard(o) }])}
                  />
                </Row>
              ) : null}
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}
