import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigation } from '@react-navigation/native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Alert, FlatList, Modal, Share, View } from 'react-native';

import { CustomerPicker, type PickedCustomer } from '../components/CustomerPicker';
import { MoneyText, METHOD_LABEL, VerificationBadge } from '../components/finance';
import { applyServerErrors, FormField } from '../components/form';
import { CachedNotice, Screen } from '../components/Screen';
import { Banner, EmptyState, ErrorState, errorMessage, LoadingState } from '../components/states';
import { AppText, Button, Card, ChoiceChips, Divider, ListRow, Row, SectionHeader, SegmentedControl, TextField } from '../components/ui';
import { bizPath, useBizMutation, useCustomerDebts, usePayment, usePayments, useReceipt, useSettings } from '../hooks/queries';
import { useOutbox } from '../hooks/useOutbox';
import { useSession } from '../hooks/useSession';
import type { AppScreenProps } from '../navigation/types';
import { api, newIdempotencyKey } from '../services/api';
import { expectExternalActivity } from '../services/appLifecycle';
import { colors, space } from '../theme/tokens';
import type { Debt, Payment, PaymentMethod, PaymentRequest, Receipt } from '../types/api';
import { dueLabel, formatDateTime } from '../utils/dates';
import { add, formatKES, fromCents, isPositive, parseAmountInput, subtract, toCents } from '../utils/money';
import { checkNotOverpaying, paymentMethods, paymentSchema, type PaymentForm } from '../validation/schemas';

const allocatable = (d: Debt) => {
  const c = toCents(d.balance) - toCents(d.pending_verification);
  return fromCents(c > 0n ? c : 0n);
};
const isOpen = (d: Debt) => d.status === 'open' || d.status === 'partially_paid' || d.status === 'overdue';

// --------------------------------------------------------------------------- record

export function RecordPaymentScreen({ route, navigation }: AppScreenProps<'RecordPayment'>) {
  const { submit, online } = useOutbox();
  const settings = useSettings();
  const [customer, setCustomer] = useState<PickedCustomer | null>(
    route.params?.customerId ? { id: route.params.customerId, name: '' } : null,
  );
  const debtsQ = useCustomerDebts(customer?.id ?? '', !!customer && !customer.id.startsWith('local:'));
  const [key, setKey] = useState(newIdempotencyKey);
  const [confirming, setConfirming] = useState<PaymentForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [stkOpen, setStkOpen] = useState(false);

  const { control, handleSubmit, setValue, setError, formState } = useForm<PaymentForm>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      customer_id: route.params?.customerId ?? '',
      amount: '',
      method: 'cash',
      external_reference: '',
      notes: '',
      debt_id: route.params?.debtId ?? '',
    },
  });
  const [method, debtId] = useWatch({ control, name: ['method', 'debt_id'] });

  const openDebts = useMemo(
    () => (customer && debtsQ.data ? debtsQ.data.data.filter((d) => isOpen(d) && isPositive(allocatable(d))) : []),
    [customer, debtsQ.data],
  );
  // Opened from a customer or debt screen we only have the id; the name comes with their debts.
  const picked = customer ? { ...customer, name: customer.name || debtsQ.data?.data[0]?.customer_name || 'Selected customer' } : null;

  const payable = debtId
    ? allocatable(openDebts.find((d) => d.id === debtId) ?? ({ balance: '0.00', pending_verification: '0.00' } as Debt))
    : add('0.00', ...openDebts.map(allocatable));
  const enabledMethods = (settings.data?.data.payment_methods ?? [...paymentMethods]) as PaymentMethod[];

  const review = handleSubmit((v) => {
    const over = checkNotOverpaying(v.amount, payable);
    if (over) return setError('amount', { message: over });
    setFormError(null);
    setConfirming(v);
  });

  const confirm = async () => {
    if (!confirming) return;
    const v = confirming;
    const amount = parseAmountInput(v.amount);
    const body: Record<string, unknown> = {
      customer_id: v.customer_id,
      amount,
      method: v.method,
      external_reference: v.external_reference || null,
      notes: v.notes || null,
      paid_at: new Date().toISOString(),
    };
    if (v.debt_id) body.allocations = [{ debt_id: v.debt_id, amount }];
    try {
      const res = await submit<Payment>('payment.create', body, `Payment ${formatKES(amount)} – ${picked?.name ?? ''}`, key);
      setConfirming(null);
      if (res.queued) {
        Alert.alert(
          'Saved on this phone',
          'This payment is waiting to sync. It is NOT yet recorded on the server and no receipt has been issued.',
        );
        navigation.goBack();
      } else if (res.result.receipt_number) {
        navigation.replace('Receipt', { paymentId: res.result.id });
      } else {
        navigation.replace('PaymentDetail', { paymentId: res.result.id });
      }
    } catch (e) {
      setConfirming(null);
      setKey(newIdempotencyKey()); // a rejected request may be corrected and resent as a new one
      setFormError(applyServerErrors(e, setError, ['amount', 'external_reference', 'method']));
    }
  };

  return (
    <Screen edges={['bottom']} footer={customer ? <Button title="Review payment" onPress={() => void review()} /> : undefined}>
      {formError ? <Banner tone="danger">{formError}</Banner> : null}
      <CustomerPicker
        owingOnly
        value={picked}
        error={formState.errors.customer_id?.message}
        onChange={(c) => {
          setCustomer(c);
          setValue('customer_id', c?.id ?? '');
          setValue('debt_id', '');
        }}
      />
      {customer ? (
        debtsQ.isPending ? (
          <LoadingState />
        ) : debtsQ.isError ? (
          <ErrorState error={debtsQ.error} onRetry={() => debtsQ.refetch()} />
        ) : openDebts.length === 0 ? (
          <EmptyState title="Nothing to pay" body="This customer has no outstanding debts that can receive a payment." />
        ) : (
          <>
            <CachedNotice fromCache={debtsQ.data.fromCache} savedAt={debtsQ.data.savedAt} />
            <SectionHeader title="Apply payment to" />
            <Card padded={false}>
              <ListRow
                title="Oldest due first"
                subtitle={`Recommended · ${openDebts.length} open debt${openDebts.length > 1 ? 's' : ''}`}
                right={<AppText color={debtId === '' ? colors.brandText : colors.inkFaint}>{debtId === '' ? 'Selected' : ''}</AppText>}
                onPress={() => setValue('debt_id', '')}
              />
              {openDebts.map((d) => (
                <View key={d.id}>
                  <Divider inset={space.lg} />
                  <ListRow
                    title={`${d.debt_number} · ${d.description}`}
                    subtitle={`${formatKES(allocatable(d))} payable · ${dueLabel(d.next_due_date ?? d.due_date)}`}
                    right={<AppText color={debtId === d.id ? colors.brandText : colors.inkFaint}>{debtId === d.id ? 'Selected' : ''}</AppText>}
                    onPress={() => setValue('debt_id', d.id)}
                    accessibilityLabel={`Apply to ${d.debt_number}${debtId === d.id ? ', selected' : ''}`}
                  />
                </View>
              ))}
            </Card>
            <View style={{ height: space.xl }} />
            <FormField control={control} name="amount" label="Amount received" prefix="KSh" keyboardType="decimal-pad" placeholder="0.00" hint={`Up to ${formatKES(payable)}`} />
            <Button title={`Full amount: ${formatKES(payable)}`} variant="secondary" compact onPress={() => setValue('amount', payable, { shouldValidate: true })} style={{ alignSelf: 'flex-start', marginTop: -space.sm, marginBottom: space.lg }} />
            <Controller
              control={control}
              name="method"
              render={({ field }) => (
                <ChoiceChips label="Payment method" value={field.value} onChange={field.onChange} options={enabledMethods.map((m) => ({ value: m, label: METHOD_LABEL[m] }))} />
              )}
            />
            {method !== 'cash' ? (
              <FormField
                control={control}
                name="external_reference"
                label={method === 'mpesa' ? 'M-Pesa transaction code' : 'Transaction reference'}
                autoCapitalize="characters"
                autoCorrect={false}
                hint={method === 'mpesa' ? 'From the customer\'s confirmation SMS. The payment stays "awaiting verification" until an owner or admin confirms it.' : 'Will be verified before it reduces the balance.'}
              />
            ) : null}
            <FormField control={control} name="notes" label="Notes (optional)" />
            {online && enabledMethods.includes('mpesa') ? (
              <Button title="Request payment by M-Pesa instead" variant="ghost" onPress={() => setStkOpen(true)} />
            ) : null}
          </>
        )
      ) : null}

      <Modal visible={!!confirming} transparent animationType="fade" onRequestClose={() => setConfirming(null)}>
        <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' }}>
          <Card style={{ margin: space.lg }}>
            <AppText variant="title" accessibilityRole="header">Confirm payment</AppText>
            {confirming ? (
              <View style={{ marginTop: space.lg, gap: space.sm }}>
                <Row style={{ justifyContent: 'space-between' }}><AppText color={colors.inkMuted}>Customer</AppText><AppText>{picked?.name}</AppText></Row>
                <Row style={{ justifyContent: 'space-between' }}><AppText color={colors.inkMuted}>Amount</AppText><MoneyText amount={parseAmountInput(confirming.amount)} /></Row>
                <Row style={{ justifyContent: 'space-between' }}><AppText color={colors.inkMuted}>Method</AppText><AppText>{METHOD_LABEL[confirming.method]}</AppText></Row>
                {confirming.external_reference ? <Row style={{ justifyContent: 'space-between' }}><AppText color={colors.inkMuted}>Reference</AppText><AppText>{confirming.external_reference}</AppText></Row> : null}
                <Row style={{ justifyContent: 'space-between' }}><AppText color={colors.inkMuted}>Remaining after</AppText><MoneyText amount={subtract(payable, parseAmountInput(confirming.amount))} /></Row>
                {confirming.method !== 'cash' ? <Banner tone="warning">This payment will be marked “awaiting verification” until it is confirmed.</Banner> : null}
                {!online ? <Banner tone="info">You are offline. The payment will be saved on this phone and sent when you reconnect.</Banner> : null}
              </View>
            ) : null}
            <Button title="Confirm and save" onPress={confirm} loading={formState.isSubmitting} style={{ marginTop: space.lg }} />
            <Button title="Go back" variant="ghost" onPress={() => setConfirming(null)} style={{ marginTop: space.sm }} />
          </Card>
        </View>
      </Modal>
      {stkOpen && customer ? <StkPushSheet debts={openDebts} preselected={debtId} onClose={() => setStkOpen(false)} /> : null}
    </Screen>
  );
}

function StkPushSheet({ debts, preselected, onClose }: { debts: Debt[]; preselected: string; onClose: () => void }) {
  const { businessId } = useSession();
  const [debtId, setDebtId] = useState(preselected || debts[0]?.id || '');
  const [amount, setAmount] = useState('');
  const [request, setRequest] = useState<PaymentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const debt = debts.find((d) => d.id === debtId);

  useEffect(() => {
    if (!request || request.status !== 'pending') return;
    const started = Date.now();
    const t = setInterval(async () => {
      try {
        const r = await api.get<PaymentRequest>(bizPath(businessId!, `/payment-requests/${request.id}`));
        setRequest(r);
        if (r.status !== 'pending' || Date.now() - started > 120_000) clearInterval(t);
      } catch {
        /* keep polling; connectivity may return */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [request, businessId]);

  const send = async () => {
    setError(null);
    const over = debt ? checkNotOverpaying(amount, allocatable(debt)) : 'Choose a debt';
    if (over) return setError(over);
    setBusy(true);
    try {
      setRequest(await api.post<PaymentRequest>(bizPath(businessId!, '/payment-requests/mpesa'), { debt_id: debtId, amount: parseAmountInput(amount) }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen edges={['top', 'bottom']}>
        <AppText variant="title" accessibilityRole="header">Request M-Pesa payment</AppText>
        <AppText color={colors.inkMuted} style={{ marginVertical: space.md }}>
          The customer gets a prompt on their phone to enter their M-Pesa PIN. Nothing is recorded until M-Pesa confirms the payment.
        </AppText>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!request ? (
          <>
            <ChoiceChips label="Debt" value={debtId} onChange={setDebtId} options={debts.map((d) => ({ value: d.id, label: d.debt_number }))} />
            <TextField label="Amount" prefix="KSh" keyboardType="number-pad" value={amount} onChangeText={setAmount} hint={debt ? `Up to ${formatKES(allocatable(debt))}. Whole shillings only.` : undefined} />
            <Button title="Send request" onPress={send} loading={busy} />
          </>
        ) : (
          <Card>
            {request.provider_mode !== 'production' ? (
              <Banner tone="info">{`${request.provider_mode === 'mock' ? 'Test mode: no real money moves' : 'Safaricom sandbox: no real money moves'}.`}</Banner>
            ) : null}
            <AppText variant="heading">
              {request.status === 'pending' ? 'Waiting for the customer to approve…' : request.status === 'succeeded' ? 'Payment received and verified' : request.status === 'needs_review' ? 'Payment received – needs review' : 'Payment not completed'}
            </AppText>
            <AppText color={colors.inkMuted} style={{ marginTop: space.sm }}>
              {formatKES(request.amount)} from {request.phone}
            </AppText>
            {request.failure_reason ? <AppText color={colors.danger} style={{ marginTop: space.sm }}>{request.failure_reason}</AppText> : null}
          </Card>
        )}
        <Button title="Close" variant="ghost" onPress={onClose} style={{ marginTop: space.lg }} />
      </Screen>
    </Modal>
  );
}

// --------------------------------------------------------------------------- history

export function PaymentsTabScreen() {
  const navigation = useNavigation();
  const [filter, setFilter] = useState<'all' | 'pending' | 'reversed'>('all');
  const q = usePayments(filter === 'pending' ? { verification: 'pending', status: 'posted' } : filter === 'reversed' ? { status: 'reversed' } : {});
  return (
    <Screen scroll={false} padded={false} edges={['top']}>
      <View style={{ padding: space.lg, gap: space.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText variant="title" accessibilityRole="header">Payments</AppText>
          <Button title="Record" compact onPress={() => navigation.navigate('RecordPayment')} />
        </Row>
        <SegmentedControl label="Payment filter" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'pending', label: 'To verify' }, { value: 'reversed', label: 'Reversed' }]} />
      </View>
      {q.isPending ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <FlatList
          data={q.data.data.items}
          keyExtractor={(p) => p.id}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ItemSeparatorComponent={() => <Divider inset={space.lg} />}
          ListHeaderComponent={<View style={{ paddingHorizontal: space.lg }}><CachedNotice fromCache={q.data.fromCache} savedAt={q.data.savedAt} /></View>}
          ListEmptyComponent={<EmptyState title={filter === 'pending' ? 'Nothing to verify' : 'No payments here'} />}
          renderItem={({ item: p }) => (
            <ListRow
              title={p.customer_name}
              subtitle={`${METHOD_LABEL[p.method]} · ${formatDateTime(p.paid_at)}${p.recorded_by_name ? ` · ${p.recorded_by_name}` : ''}`}
              onPress={() => navigation.navigate('PaymentDetail', { paymentId: p.id })}
              right={<View style={{ alignItems: 'flex-end', gap: 4 }}><MoneyText amount={p.amount} color={p.status === 'reversed' ? colors.inkFaint : colors.ink} /><VerificationBadge status={p.verification_status} reversed={p.status === 'reversed'} /></View>}
            />
          )}
        />
      )}
    </Screen>
  );
}

export function PaymentDetailScreen({ route, navigation }: AppScreenProps<'PaymentDetail'>) {
  const { paymentId } = route.params;
  const { isManager } = useSession();
  const q = usePayment(paymentId);
  const verify = useBizMutation<{ approve: boolean; note?: string }, Payment>('post', () => `/payments/${paymentId}/verify`);
  const reverse = useBizMutation<{ reason: string }, Payment>('post', () => `/payments/${paymentId}/reverse`);
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data.data;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Screen edges={['bottom']} refreshing={q.isRefetching} onRefresh={() => q.refetch()}>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText variant="caption" color={colors.inkMuted}>{p.receipt_number ?? 'Receipt not issued yet'}</AppText>
          <VerificationBadge status={p.verification_status} reversed={p.status === 'reversed'} />
        </Row>
        <MoneyText amount={p.amount} variant="display" color={p.status === 'reversed' ? colors.inkFaint : colors.ink} />
        <ListRow title={p.customer_name} subtitle="View customer" onPress={() => navigation.navigate('CustomerProfile', { customerId: p.customer_id })} />
        <AppText color={colors.inkMuted}>{METHOD_LABEL[p.method]}{p.external_reference ? ` · ${p.external_reference}` : ''}</AppText>
        <AppText color={colors.inkMuted}>Paid {formatDateTime(p.paid_at)}</AppText>
        {p.recorded_by_name ? <AppText color={colors.inkMuted}>Recorded by {p.recorded_by_name}</AppText> : null}
        {p.notes ? <AppText color={colors.inkMuted}>Note: {p.notes}</AppText> : null}
        {p.status === 'reversed' ? <Banner tone="danger">{`Reversed ${p.reversed_at ? formatDateTime(p.reversed_at) : ''}: ${p.reversal_reason ?? ''}`}</Banner> : null}
      </Card>
      {p.receipt_number ? <Button title="View receipt" style={{ marginTop: space.lg }} onPress={() => navigation.navigate('Receipt', { paymentId })} /> : null}
      {isManager && p.status === 'posted' && p.verification_status === 'pending' ? (
        <>
          <SectionHeader title="Verification" />
          <AppText color={colors.inkMuted} style={{ marginBottom: space.md }}>
            Check your M-Pesa or bank statement for {p.external_reference ?? 'this payment'} before confirming.
          </AppText>
          <Row gap={space.md}>
            <Button title="Confirm received" style={{ flex: 1 }} loading={verify.isPending} onPress={() => run(() => verify.mutateAsync({ approve: true }))} />
            <Button title="Not received" variant="danger" style={{ flex: 1 }} onPress={() => Alert.alert('Reject payment?', 'It will no longer count towards the balance.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Reject', style: 'destructive', onPress: () => run(() => verify.mutateAsync({ approve: false, note: 'Not found on statement' })) }])} />
          </Row>
        </>
      ) : null}
      {isManager && p.status === 'posted' ? (
        <>
          <SectionHeader title="Correction" />
          {reversing ? (
            <Card>
              <TextField label="Reason for reversal" value={reason} onChangeText={setReason} multiline placeholder="e.g. Recorded against the wrong customer" />
              <Button title="Reverse payment" variant="danger" loading={reverse.isPending} onPress={() => (reason.trim().length < 5 ? setError('Give a reason of at least 5 characters.') : run(() => reverse.mutateAsync({ reason })))} />
              <Button title="Keep payment" variant="ghost" onPress={() => setReversing(false)} />
            </Card>
          ) : (
            <Button title="Reverse this payment" variant="secondary" onPress={() => setReversing(true)} />
          )}
          <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.sm }}>
            Payments are never deleted. A reversal restores the balance and is kept in the audit log.
          </AppText>
        </>
      ) : null}
    </Screen>
  );
}

// --------------------------------------------------------------------------- receipt

export function receiptHtml(r: Receipt): string {
  const s = r.snapshot;
  const esc = (v: string | null | undefined) => (v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const rows = s.allocations
    .map((a) => `<tr><td>${esc(a.debt_number)} – ${esc(a.description)}</td><td class="r">${esc(formatKES(a.amount))}</td><td class="r">${esc(formatKES(a.balance_after))}</td></tr>`)
    .join('');
  return `<html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,Roboto,sans-serif;color:#1B1E1C;padding:24px;max-width:480px}
    h1{font-size:18px;margin:0} .muted{color:#5E625E;font-size:12px} table{width:100%;border-collapse:collapse;margin-top:16px;font-size:12px}
    td,th{padding:6px 0;border-bottom:1px solid #E2DED5;text-align:left} .r{text-align:right} .amt{font-size:28px;font-weight:700;margin:16px 0}
    .void{color:#B42318;font-weight:700;border:2px solid #B42318;padding:6px;text-align:center;margin-top:12px}
  </style></head><body>
    <h1>${esc(s.business.name)}</h1><div class="muted">${esc(s.business.address)} ${esc(s.business.phone)}</div>
    <p><strong>Payment receipt ${esc(r.receipt_number)}</strong><br><span class="muted">${esc(formatDateTime(s.paid_at))}</span></p>
    <div>Received from <strong>${esc(s.customer.name)}</strong> (${esc(s.customer.number)})</div>
    <div class="amt">${esc(formatKES(s.amount))}</div>
    <div class="muted">${esc(METHOD_LABEL[s.method])}${s.external_reference ? ` · Ref ${esc(s.external_reference)}` : ''}</div>
    <table><tr><th>Applied to</th><th class="r">Paid</th><th class="r">Balance after</th></tr>${rows}</table>
    ${r.payment_status === 'reversed' ? '<div class="void">THIS PAYMENT HAS BEEN REVERSED</div>' : ''}
    <p class="muted">Recorded by ${esc(s.recorded_by)}. Thank you.</p></body></html>`;
}

export function ReceiptScreen({ route }: AppScreenProps<'Receipt'>) {
  const q = useReceipt(route.params.paymentId);
  const [busy, setBusy] = useState(false);
  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data.data;
  const s = r.snapshot;

  const sharePdf = async () => {
    setBusy(true);
    try {
      const { uri } = await Print.printToFileAsync({ html: receiptHtml(r) });
      expectExternalActivity();
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `Receipt ${r.receipt_number}`, UTI: 'com.adobe.pdf' });
    } catch (e) {
      Alert.alert('Could not create PDF', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['bottom']}>
      <Card>
        <AppText variant="heading">{s.business.name}</AppText>
        {s.business.phone ? <AppText variant="caption" color={colors.inkMuted}>{s.business.phone}</AppText> : null}
        <Divider />
        <AppText variant="label" color={colors.inkMuted} style={{ marginTop: space.lg }}>Payment receipt</AppText>
        <AppText variant="bodyStrong">{r.receipt_number}</AppText>
        <AppText variant="caption" color={colors.inkMuted}>{formatDateTime(s.paid_at)}</AppText>
        <MoneyText amount={s.amount} variant="display" />
        <AppText>Received from {s.customer.name}</AppText>
        <AppText color={colors.inkMuted}>{METHOD_LABEL[s.method]}{s.external_reference ? ` · Ref ${s.external_reference}` : ''}</AppText>
        <SectionHeader title="Applied to" />
        {s.allocations.map((a) => (
          <Row key={a.debt_number} style={{ justifyContent: 'space-between', paddingVertical: space.xs }}>
            <View style={{ flex: 1 }}>
              <AppText>{a.debt_number}</AppText>
              <AppText variant="caption" color={colors.inkMuted}>Balance after: {formatKES(a.balance_after)}</AppText>
            </View>
            <MoneyText amount={a.amount} />
          </Row>
        ))}
        {r.payment_status === 'reversed' ? <Banner tone="danger">This payment has been reversed.</Banner> : null}
        <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.lg }}>Recorded by {s.recorded_by}</AppText>
      </Card>
      <Row gap={space.md} style={{ marginTop: space.lg }}>
        <Button title="Share as text" variant="secondary" style={{ flex: 1 }} onPress={() => { expectExternalActivity(); void Share.share({ message: r.share_text, title: r.receipt_number }); }} />
        <Button title="Share PDF" style={{ flex: 1 }} loading={busy} onPress={sharePdf} />
      </Row>
    </Screen>
  );
}
