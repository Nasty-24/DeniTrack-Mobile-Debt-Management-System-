import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Alert, FlatList, Modal, View } from 'react-native';

import { CustomerPicker, isNewPerson, type PickerValue } from '../components/CustomerPicker';
import { DebtStatusBadge, MoneyText, METHOD_LABEL, ProgressBar, VerificationBadge } from '../components/finance';
import { applyServerErrors, FormField } from '../components/form';
import { CachedNotice, Screen } from '../components/Screen';
import { Banner, EmptyState, ErrorState, errorMessage, LoadingState } from '../components/states';
import { AppText, Button, Card, ChoiceChips, Divider, ListRow, Row, SectionHeader, SegmentedControl, TextField, ToggleRow } from '../components/ui';
import { useBizMutation, useDebt, useDebts, useSettings } from '../hooks/queries';
import { useOutbox } from '../hooks/useOutbox';
import { useSession } from '../hooks/useSession';
import type { AppScreenProps } from '../navigation/types';
import { newIdempotencyKey } from '../services/api';
import { ApiError } from '../services/apiClient';
import { runPhoneTasks } from '../services/phoneSms';
import { colors, space } from '../theme/tokens';
import type { Customer, Debt } from '../types/api';
import { addDaysISO, dueLabel, formatDate, formatDateTime, todayISO } from '../utils/dates';
import { add, formatKES, isPositive, isValidAmountInput, parseAmountInput, toCents } from '../utils/money';
import { formatPhone } from '../utils/phone';
import { debtSchema, type DebtForm } from '../validation/schemas';

// --------------------------------------------------------------------------- list

type ListMode = 'outstanding' | 'overdue' | 'upcoming' | 'paid' | 'all';

export function DebtListView({ initial, title }: { initial: ListMode; title?: string }) {
  const navigation = useNavigation();
  const [mode, setMode] = useState<ListMode>(initial);
  const params =
    mode === 'upcoming'
      ? { status: 'outstanding', due_within_days: 14, sort: 'due_date' }
      : mode === 'overdue'
        ? { status: 'overdue', sort: 'days_overdue' }
        : { status: mode, sort: mode === 'outstanding' ? 'due_date' : 'recent' };
  const q = useDebts(params);
  const today = todayISO();

  return (
    <Screen scroll={false} padded={false} edges={title ? ['top'] : []}>
      <View style={{ padding: space.lg, gap: space.md }}>
        {title ? (
          <Row style={{ justifyContent: 'space-between' }}>
            <AppText variant="title" accessibilityRole="header">{title}</AppText>
            <Button title="New debt" compact onPress={() => navigation.navigate('DebtForm')} />
          </Row>
        ) : null}
        <SegmentedControl
          label="Debt filter"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'outstanding', label: 'Owing' },
            { value: 'overdue', label: 'Overdue' },
            { value: 'upcoming', label: 'Due soon' },
            { value: 'paid', label: 'Paid' },
          ]}
        />
        {q.data ? (
          <AppText variant="caption" color={colors.inkMuted}>
            {q.data.data.total} debt{q.data.data.total === 1 ? '' : 's'} ·{' '}
            {formatKES(add('0.00', ...q.data.data.items.map((d) => d.balance)))} {mode === 'paid' ? 'remaining' : 'outstanding'} in this list
          </AppText>
        ) : null}
      </View>
      {q.isPending ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <FlatList
          data={q.data.data.items}
          keyExtractor={(d) => d.id}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ItemSeparatorComponent={() => <Divider inset={space.lg} />}
          ListHeaderComponent={<View style={{ paddingHorizontal: space.lg }}><CachedNotice fromCache={q.data.fromCache} savedAt={q.data.savedAt} /></View>}
          ListEmptyComponent={
            <EmptyState
              title={{ overdue: 'No overdue debts', upcoming: 'Nothing due in the next 14 days', paid: 'No settled debts yet', outstanding: 'Nobody owes you anything', all: 'No debts' }[mode]}
              body={mode === 'overdue' ? 'Every debt is within its agreed terms.' : undefined}
            />
          }
          renderItem={({ item: d }) => <DebtRow d={d} today={today} onPress={() => navigation.navigate('DebtDetail', { debtId: d.id })} />}
        />
      )}
    </Screen>
  );
}

function DebtRow({ d, today, onPress }: { d: Debt; today: string; onPress: () => void }) {
  const due = d.next_due_date ?? d.due_date;
  const soon = d.status !== 'overdue' && due >= today && due <= addDaysISO(today, 7);
  const subtitle =
    d.status === 'paid' ? `${d.debt_number} · Settled` : d.status === 'overdue' ? `${d.debt_number} · ${d.days_overdue} days overdue` : `${d.debt_number} · ${dueLabel(due, today)}`;
  return (
    <ListRow
      title={d.customer_name}
      subtitle={subtitle}
      onPress={onPress}
      accessibilityLabel={`${d.customer_name}, ${subtitle}, balance ${formatKES(d.balance)}`}
      right={
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <MoneyText amount={d.status === 'overdue' ? d.overdue_amount : d.balance} color={d.status === 'overdue' ? colors.danger : colors.ink} />
          <DebtStatusBadge status={d.status} dueSoon={soon} />
        </View>
      }
    />
  );
}

export const DebtsTabScreen = () => <DebtListView initial="outstanding" title="Debts" />;
export const OverdueDebtsScreen = () => <DebtListView initial="overdue" />;
export const UpcomingPaymentsScreen = () => <DebtListView initial="upcoming" />;

// --------------------------------------------------------------------------- create

/** The form's customer_id while a person from the phone book is picked; the customer is created on save. */
const NEW_PERSON_ID = 'new-person';

interface PossibleDuplicate {
  id: string;
  name: string;
  phone: string;
}

export function DebtFormScreen({ route, navigation }: AppScreenProps<'DebtForm'>) {
  const { submit } = useOutbox();
  const { businessId, isManager } = useSession();
  const settings = useSettings();
  const canAddCustomers = isManager || !!settings.data?.data.cashier_can_register_customers;
  const [customer, setCustomer] = useState<PickerValue | null>(
    route.params?.customerId ? { id: route.params.customerId, name: route.params.customerName ?? 'Selected customer' } : null,
  );
  const [duplicates, setDuplicates] = useState<PossibleDuplicate[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);
  const today = todayISO();
  const { control, handleSubmit, setValue, setError, formState } = useForm<DebtForm>({
    resolver: zodResolver(debtSchema),
    defaultValues: {
      customer_id: route.params?.customerId ?? '',
      description: '',
      principal: '',
      incurred_on: today,
      due_date: addDaysISO(today, 30),
      terms: '',
      reference: '',
      use_installments: false,
      installment_count: '3',
      installment_frequency: 'monthly',
      first_due_date: addDaysISO(today, 30),
      notify_customer: true,
    },
  });
  const [useInstallments, principal, countText, incurredOn] = useWatch({
    control,
    name: ['use_installments', 'principal', 'installment_count', 'incurred_on'],
  });
  const count = Number(countText);
  const preview =
    useInstallments && isValidAmountInput(principal) && Number.isInteger(count) && count >= 2 && count <= 60
      ? `${count} payments of about ${formatKES(fromCentsApprox(toCents(parseAmountInput(principal)), count))}`
      : null;

  /** Saves a person picked from the phone book as a customer. Returns the customer id, or null to stop. */
  const createCustomer = async (allowDuplicate: boolean): Promise<{ id: string; name: string; note: string | null } | null> => {
    if (!isNewPerson(customer)) return null;
    try {
      const res = await submit<Customer>(
        'customer.create',
        { name: customer.name, phone: customer.phone, sms_opt_in: true, allow_duplicate: allowDuplicate },
        `New customer – ${customer.name}`,
        customer.key,
      );
      return { id: res.queued ? res.localId : res.result.id, name: customer.name, note: null };
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'possible_duplicate')) throw e;
      const matches = (e.details ?? []) as PossibleDuplicate[];
      const same = matches.find((d) => d.phone === customer.phone);
      if (!same) {
        setDuplicates(matches);
        return null;
      }
      return { id: same.id, name: same.name, note: `${same.name} is already a customer, so the debt was recorded for them.` };
    }
  };

  const save = async (v: DebtForm, allowDuplicate = false) => {
    setFormError(null);
    setDuplicates(null);
    let customerId = v.customer_id;
    let note: string | null = null;
    if (isNewPerson(customer)) {
      try {
        const created = await createCustomer(allowDuplicate);
        if (!created) return;
        ({ id: customerId, note } = created);
        // From here on the form is for that customer, so saving again sends only the debt.
        setCustomer({ id: created.id, name: created.name });
        setValue('customer_id', created.id, { shouldValidate: true });
      } catch (e) {
        setFormError(applyServerErrors(e, setError, []));
        return;
      }
    }
    const body: Record<string, unknown> = {
      customer_id: customerId,
      description: v.description,
      principal: parseAmountInput(v.principal),
      incurred_on: v.incurred_on,
      due_date: v.use_installments ? v.first_due_date : v.due_date,
      terms: v.terms || null,
      reference: v.reference || null,
      notify_customer: v.notify_customer,
    };
    if (v.use_installments) {
      body.installment_plan = { count: Number(v.installment_count), frequency: v.installment_frequency, first_due_date: v.first_due_date };
    }
    try {
      const res = await submit<Debt>('debt.create', body, `Debt ${formatKES(String(body.principal))} – ${customer?.name ?? ''}`, key);
      if (res.queued) {
        const sms = v.notify_customer ? ' The SMS to the customer goes once it is recorded.' : '';
        Alert.alert('Saved on this phone', `This debt will be recorded when you are back online. It is not on the server yet.${sms}`);
        navigation.goBack();
      } else {
        // If this is the phone that sends SMS, send the credit notice now rather than at the next check.
        if (v.notify_customer && businessId) void runPhoneTasks({ businessId, isManager }).catch(() => undefined);
        if (note) Alert.alert('Debt recorded', note);
        navigation.replace('DebtDetail', { debtId: res.result.id });
      }
    } catch (e) {
      setFormError(applyServerErrors(e, setError, ['description', 'principal', 'incurred_on', 'due_date']));
    }
  };
  const onSubmit = handleSubmit((v) => save(v));

  return (
    <Screen edges={['bottom']} footer={<Button title="Record debt" onPress={() => void onSubmit()} loading={formState.isSubmitting} />}>
      {formError ? <Banner tone="danger">{formError}</Banner> : null}
      {duplicates ? (
        <Banner tone="warning">
          <AppText variant="bodyStrong">This may be a customer you already have</AppText>
          {duplicates.map((d) => (
            <Button
              key={d.id}
              title={`Use ${d.name} (${formatPhone(d.phone)})`}
              variant="ghost"
              compact
              onPress={() => {
                setCustomer({ id: d.id, name: d.name });
                setValue('customer_id', d.id, { shouldValidate: true });
                setDuplicates(null);
              }}
            />
          ))}
          <Button title="No, add a new customer" variant="secondary" compact onPress={() => void handleSubmit((v) => save(v, true))()} />
        </Banner>
      ) : null}
      <CustomerPicker
        value={customer}
        error={formState.errors.customer_id?.message}
        onChange={(c) => {
          setCustomer(c);
          setDuplicates(null);
          setValue('customer_id', c?.id ?? '', { shouldValidate: !!c });
        }}
        onPickNew={
          canAddCustomers
            ? (p) => {
                setCustomer(p);
                setDuplicates(null);
                setValue('customer_id', NEW_PERSON_ID, { shouldValidate: true });
              }
            : undefined
        }
      />
      <FormField
        control={control}
        name="description"
        label="What was taken on credit"
        hint="One item per line. Press Enter for the next item."
        placeholder={'e.g. Cement 20 bags\nSugar 2 kg'}
        multiline
        submitBehavior="newline"
        textAlignVertical="top"
        style={{ minHeight: 88 }}
      />
      <FormField control={control} name="principal" label="Amount" prefix="KSh" keyboardType="decimal-pad" placeholder="0.00" />
      <FormField control={control} name="incurred_on" label="Date of sale" placeholder="YYYY-MM-DD" hint="Cannot be in the future" />
      <Controller
        control={control}
        name="use_installments"
        render={({ field }) => (
          <ToggleRow label="Pay in installments" description="Split the amount into weekly or monthly payments" value={field.value} onChange={field.onChange} />
        )}
      />
      {useInstallments ? (
        <Card style={{ marginVertical: space.md }}>
          <FormField control={control} name="installment_count" label="Number of installments" keyboardType="number-pad" />
          <Controller
            control={control}
            name="installment_frequency"
            render={({ field }) => (
              <ChoiceChips label="Frequency" value={field.value} onChange={field.onChange} options={[{ value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />
            )}
          />
          <FormField control={control} name="first_due_date" label="First installment due" placeholder="YYYY-MM-DD" />
          {preview ? <AppText color={colors.inkMuted}>{preview}. Any remaining cents go on the last installment.</AppText> : null}
        </Card>
      ) : (
        <>
          <FormField control={control} name="due_date" label="Due date" placeholder="YYYY-MM-DD" />
          <Row style={{ flexWrap: 'wrap', marginTop: -space.sm, marginBottom: space.lg }}>
            {[7, 14, 30].map((n) => (
              <Button key={n} title={`+${n} days`} variant="secondary" compact onPress={() => setValue('due_date', addDaysISO(incurredOn || today, n), { shouldValidate: true })} />
            ))}
          </Row>
        </>
      )}
      <FormField control={control} name="terms" label="Agreed terms (optional)" placeholder="e.g. Pay by end of month" />
      <FormField control={control} name="reference" label="Invoice or reference number (optional)" autoCapitalize="characters" />
      <Controller
        control={control}
        name="notify_customer"
        render={({ field }) => (
          <ToggleRow
            label="Send SMS to customer"
            description="Tells them what they took on credit, the amount and when to pay. Not sent to customers who turned off SMS."
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
    </Screen>
  );
}

function fromCentsApprox(cents: bigint, parts: number): string {
  const each = cents / BigInt(parts);
  return `${each / 100n}.${(each % 100n).toString().padStart(2, '0')}`;
}

// --------------------------------------------------------------------------- detail

export function DebtDetailScreen({ route, navigation }: AppScreenProps<'DebtDetail'>) {
  const { debtId } = route.params;
  const { isManager } = useSession();
  const q = useDebt(debtId);
  const [action, setAction] = useState<null | 'adjust' | 'dispute' | 'resolve' | 'cancel'>(null);

  useEffect(() => {
    if (q.data) navigation.setOptions({ title: q.data.data.debt_number });
  }, [q.data, navigation]);

  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data.data;
  const paidFraction = Number(toCents(d.paid)) / Math.max(1, Number(toCents(d.total_due)));
  const canPay = d.status !== 'paid' && d.status !== 'cancelled' && d.status !== 'disputed';

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => q.refetch()} edges={['bottom']}>
      <CachedNotice fromCache={q.data.fromCache} savedAt={q.data.savedAt} />
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText variant="caption" color={colors.inkMuted}>
            {d.debt_number}
          </AppText>
          <DebtStatusBadge status={d.status} />
        </Row>
        <ListRow title={d.customer_name} subtitle="View customer" onPress={() => navigation.navigate('CustomerProfile', { customerId: d.customer_id })} />
        <AppText variant="caption" color={colors.inkMuted}>Balance</AppText>
        <MoneyText amount={d.balance} variant="display" color={d.status === 'overdue' ? colors.danger : colors.ink} />
        <View style={{ marginVertical: space.md }}>
          <ProgressBar fraction={paidFraction} />
          <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.xs }}>
            {formatKES(d.paid)} paid of {formatKES(d.total_due)}
          </AppText>
        </View>
        {isPositive(d.overdue_amount) ? <Banner tone="danger">{`${formatKES(d.overdue_amount)} is overdue (${d.days_overdue} day${d.days_overdue === 1 ? '' : 's'}).`}</Banner> : null}
        {isPositive(d.pending_verification) ? <Banner tone="warning">{`${formatKES(d.pending_verification)} received but not yet verified. It is not deducted until verified.`}</Banner> : null}
        {d.flag_reason && (d.status === 'disputed' || d.status === 'cancelled') ? <Banner tone="info">{`Reason: ${d.flag_reason}`}</Banner> : null}
        <Detail label="Description" value={d.description} />
        <Detail label="Original amount" value={formatKES(d.principal)} />
        {d.adjustments_total !== '0.00' ? <Detail label="Adjustments" value={formatKES(d.adjustments_total)} /> : null}
        <Detail label="Date of sale" value={formatDate(d.incurred_on)} />
        <Detail label={d.schedule.length ? 'Final installment' : 'Due date'} value={formatDate(d.due_date)} />
        {d.terms ? <Detail label="Terms" value={d.terms} /> : null}
        {d.reference ? <Detail label="Reference" value={d.reference} /> : null}
      </Card>

      {canPay ? (
        <Button title="Record payment" style={{ marginTop: space.lg }} onPress={() => navigation.navigate('RecordPayment', { customerId: d.customer_id, debtId: d.id })} />
      ) : null}

      {d.schedule.length ? (
        <>
          <SectionHeader title="Repayment schedule" />
          <Card padded={false}>
            {d.schedule.map((s, i) => (
              <View key={s.number}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <ListRow
                  title={`Installment ${s.number} · ${formatDate(s.due_date)}`}
                  subtitle={s.status === 'paid' ? 'Paid' : s.status === 'overdue' ? 'Overdue' : s.status === 'partially_paid' ? `${formatKES(s.covered)} paid` : 'Not yet due'}
                  right={<MoneyText amount={s.amount} color={s.status === 'paid' ? colors.success : s.status === 'overdue' ? colors.danger : colors.ink} />}
                />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <SectionHeader title="Payments" />
      <Card padded={false}>
        {d.payments.length === 0 ? (
          <EmptyState title="No payments yet" />
        ) : (
          d.payments.map((p, i) => {
            const alloc = p.allocations.find((a) => a.debt_id === d.id);
            return (
              <View key={p.id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <ListRow
                  title={`${METHOD_LABEL[p.method]} · ${formatDateTime(p.paid_at)}`}
                  subtitle={p.receipt_number ?? 'No receipt yet'}
                  onPress={() => navigation.navigate('PaymentDetail', { paymentId: p.id })}
                  right={<View style={{ alignItems: 'flex-end', gap: 4 }}><MoneyText amount={alloc?.amount ?? p.amount} color={p.status === 'reversed' ? colors.inkFaint : colors.success} /><VerificationBadge status={p.verification_status} reversed={p.status === 'reversed'} /></View>}
                />
              </View>
            );
          })
        )}
      </Card>

      {d.adjustments.length ? (
        <>
          <SectionHeader title="Adjustments" />
          <Card padded={false}>
            {d.adjustments.map((a, i) => (
              <View key={a.id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <ListRow title={a.reason} subtitle={formatDateTime(a.created_at)} right={<MoneyText amount={a.amount} />} />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {isManager && d.status !== 'cancelled' ? (
        <>
          <SectionHeader title="Corrections" />
          <View style={{ gap: space.sm }}>
            <Button title="Adjust amount owed" variant="secondary" onPress={() => setAction('adjust')} />
            {d.status === 'disputed' ? (
              <Button title="Resolve dispute" variant="secondary" onPress={() => setAction('resolve')} />
            ) : (
              <Button title="Mark as disputed" variant="secondary" onPress={() => setAction('dispute')} />
            )}
            {d.paid === '0.00' && d.pending_verification === '0.00' ? (
              <Button title="Cancel this debt" variant="danger" onPress={() => setAction('cancel')} />
            ) : null}
          </View>
          <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.sm }}>
            Every correction is recorded in the audit log with your name and reason.
          </AppText>
        </>
      ) : null}
      <DebtActionSheet key={action ?? 'closed'} debtId={d.id} action={action} onClose={() => setAction(null)} />
    </Screen>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: space.xs, alignItems: 'flex-start' }}>
      <AppText color={colors.inkMuted}>{label}</AppText>
      <AppText style={{ flexShrink: 1, textAlign: 'right', marginLeft: space.lg }}>{value}</AppText>
    </Row>
  );
}

function DebtActionSheet({ debtId, action, onClose }: { debtId: string; action: null | 'adjust' | 'dispute' | 'resolve' | 'cancel'; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'reduce' | 'increase'>('reduce');
  const [error, setError] = useState<string | null>(null);
  const adjust = useBizMutation<{ amount: string; reason: string }, Debt>('post', () => `/debts/${debtId}/adjustments`);
  const flag = useBizMutation<{ flag: string; reason: string }, Debt>('post', () => `/debts/${debtId}/flag`);
  if (!action) return null;
  const titles = { adjust: 'Adjust amount owed', dispute: 'Mark as disputed', resolve: 'Resolve dispute', cancel: 'Cancel debt' };
  const run = async () => {
    setError(null);
    if (reason.trim().length < 5) return setError('Give a short reason (at least 5 characters).');
    try {
      if (action === 'adjust') {
        if (!isValidAmountInput(amount)) return setError('Enter an amount like 500 or 500.50.');
        const value = parseAmountInput(amount);
        await adjust.mutateAsync({ amount: direction === 'reduce' ? `-${value}` : value, reason });
      } else {
        await flag.mutateAsync({ flag: action === 'resolve' ? 'none' : action === 'cancel' ? 'cancelled' : 'disputed', reason });
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen edges={['top', 'bottom']}>
        <AppText variant="title" accessibilityRole="header" style={{ marginBottom: space.lg }}>{titles[action]}</AppText>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {action === 'adjust' ? (
          <>
            <SegmentedControl label="Adjustment direction" value={direction} onChange={setDirection} options={[{ value: 'reduce', label: 'Reduce (e.g. returns)' }, { value: 'increase', label: 'Increase' }]} />
            <View style={{ height: space.lg }} />
            <TextField label="Amount" prefix="KSh" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
          </>
        ) : null}
        {action === 'cancel' ? <Banner tone="warning">Cancelling removes this debt from balances. It stays in history and the audit log.</Banner> : null}
        <TextField label="Reason" value={reason} onChangeText={setReason} multiline placeholder="e.g. 2 bags returned unused" />
        <Button title="Confirm" variant={action === 'cancel' ? 'danger' : 'primary'} onPress={run} loading={adjust.isPending || flag.isPending} />
        <Button title="Close" variant="ghost" onPress={onClose} style={{ marginTop: space.sm }} />
      </Screen>
    </Modal>
  );
}
