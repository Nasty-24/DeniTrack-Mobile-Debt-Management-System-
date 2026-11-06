import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Alert, FlatList, Linking, View } from 'react-native';

import { Badge, DebtStatusBadge, MoneyText, METHOD_LABEL, VerificationBadge } from '../components/finance';
import { applyServerErrors, FormField } from '../components/form';
import { CachedNotice, Screen } from '../components/Screen';
import { Banner, EmptyState, ErrorState, LoadingState } from '../components/states';
import { AppText, Button, Card, Divider, ListRow, Row, SectionHeader, SegmentedControl, TextField, ToggleRow } from '../components/ui';
import { bizPath, useBizMutation, useCustomer, useCustomerDebts, useCustomerPayments, useCustomers } from '../hooks/queries';
import { useOutbox } from '../hooks/useOutbox';
import { useSession } from '../hooks/useSession';
import type { AppScreenProps } from '../navigation/types';
import { api, newIdempotencyKey } from '../services/api';
import { ApiError } from '../services/apiClient';
import { expectExternalActivity } from '../services/appLifecycle';
import { LOCAL_PREFIX } from '../services/outbox';
import { SendReminderButton } from './MpesaScreens';
import { colors, space } from '../theme/tokens';
import type { Customer } from '../types/api';
import { dueLabel, formatDate, formatDateTime } from '../utils/dates';
import { formatKES, isPositive, isZero } from '../utils/money';
import { formatPhone, normalizeKenyanPhone } from '../utils/phone';
import { customerSchema, type CustomerForm } from '../validation/schemas';

type Filter = 'all' | 'outstanding' | 'overdue';

export function CustomerListScreen() {
  const navigation = useNavigation();
  const { ops } = useOutbox();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  const q = useCustomers({ q: debounced || undefined, balance: filter === 'all' ? 'any' : filter, sort: filter === 'all' ? 'name' : 'balance' });
  const queuedCustomers = ops.filter((o) => o.kind === 'customer.create');

  return (
    <Screen scroll={false} padded={false} edges={['top']}>
      <View style={{ padding: space.lg, paddingBottom: space.sm, gap: space.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText variant="title" accessibilityRole="header">
            Customers
          </AppText>
          <Button title="Add" compact onPress={() => navigation.navigate('CustomerForm')} />
        </Row>
        <TextField
          label="Search"
          placeholder="Name, phone number or customer ID"
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          returnKeyType="search"
        />
        <SegmentedControl
          label="Filter customers"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'outstanding', label: 'Owing' },
            { value: 'overdue', label: 'Overdue' },
          ]}
        />
      </View>
      {queuedCustomers.length > 0 ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <Banner tone="warning">
            {`${queuedCustomers.length} new customer${queuedCustomers.length > 1 ? 's' : ''} waiting to sync: ${queuedCustomers.map((o) => String(o.payload.name)).join(', ')}`}
          </Banner>
        </View>
      ) : null}
      {q.isPending ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <FlatList
          data={q.data.data.items}
          keyExtractor={(c) => c.id}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ItemSeparatorComponent={() => <Divider inset={space.lg} />}
          ListHeaderComponent={<View style={{ paddingHorizontal: space.lg }}><CachedNotice fromCache={q.data.fromCache} savedAt={q.data.savedAt} /></View>}
          ListEmptyComponent={
            debounced ? (
              <EmptyState title="No matching customers" body={`Nothing matches "${debounced}".`} />
            ) : (
              <EmptyState
                title={filter === 'all' ? 'No customers yet' : 'Nobody in this list'}
                body={filter === 'all' ? 'Add the people and businesses you sell to on credit.' : undefined}
                action={filter === 'all' ? <Button title="Add customer" onPress={() => navigation.navigate('CustomerForm')} /> : undefined}
              />
            )
          }
          renderItem={({ item: c }) => <CustomerRow c={c} onPress={() => navigation.navigate('CustomerProfile', { customerId: c.id })} />}
        />
      )}
    </Screen>
  );
}

function CustomerRow({ c, onPress }: { c: Customer; onPress: () => void }) {
  const owes = isPositive(c.outstanding_balance);
  return (
    <ListRow
      title={c.name}
      subtitle={`${c.customer_number} · ${formatPhone(c.phone)}${c.status === 'archived' ? ' · Archived' : ''}`}
      onPress={onPress}
      right={
        owes ? (
          <View style={{ alignItems: 'flex-end', gap: 2 }}>
            <MoneyText amount={c.outstanding_balance} color={isPositive(c.overdue_amount) ? colors.danger : colors.ink} />
            {isPositive(c.overdue_amount) ? (
              <AppText variant="caption" color={colors.danger}>
                Overdue
              </AppText>
            ) : null}
          </View>
        ) : (
          <AppText variant="caption" color={colors.inkMuted}>
            Nothing owed
          </AppText>
        )
      }
    />
  );
}

export function CustomerFormScreen({ route, navigation }: AppScreenProps<'CustomerForm'>) {
  const editingId = route.params?.customerId;
  const existing = useCustomer(editingId ?? '', !!editingId);
  const { submit } = useOutbox();
  const { businessId } = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<{ id: string; name: string; phone: string }[] | null>(null);
  const [key] = useState(newIdempotencyKey);
  const { control, handleSubmit, setError, reset, formState, getValues } = useForm<CustomerForm>({
    resolver: zodResolver(customerSchema),
    defaultValues: { name: '', phone: '', email: '', address: '', notes: '', sms_opt_in: true },
  });

  useEffect(() => {
    navigation.setOptions({ title: editingId ? 'Edit customer' : 'Add customer' });
    const c = existing.data?.data;
    if (editingId && c) {
      reset({ name: c.name, phone: formatPhone(c.phone), email: c.email ?? '', address: c.address ?? '', notes: c.notes ?? '', sms_opt_in: c.sms_opt_in });
    }
  }, [editingId, existing.data, navigation, reset]);

  const save = async (v: CustomerForm, allowDuplicate = false) => {
    setFormError(null);
    const body = {
      name: v.name,
      phone: normalizeKenyanPhone(v.phone),
      email: v.email || null,
      address: v.address || null,
      notes: v.notes || null,
      sms_opt_in: v.sms_opt_in,
    };
    try {
      if (editingId) {
        await api.patch(bizPath(businessId!, `/customers/${editingId}`), { ...body, version: existing.data?.data.version });
        navigation.goBack();
        return;
      }
      const res = await submit<Customer>('customer.create', { ...body, allow_duplicate: allowDuplicate }, `New customer – ${v.name}`, key);
      if (res.queued) {
        Alert.alert('Saved on this phone', `${v.name} will be added when you are back online.`);
        navigation.goBack();
      } else {
        navigation.replace('CustomerProfile', { customerId: res.result.id });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'possible_duplicate') {
        setDuplicates(e.details as { id: string; name: string; phone: string }[]);
        return;
      }
      if (e instanceof ApiError && e.code === 'version_conflict') {
        setFormError('Someone else changed this customer. Your edits were not saved; reopen the customer and try again.');
        return;
      }
      setFormError(applyServerErrors(e, setError, ['name', 'phone', 'email', 'address', 'notes']));
    }
  };

  if (editingId && existing.isPending) return <LoadingState />;
  return (
    <Screen
      edges={['bottom']}
      footer={<Button title={editingId ? 'Save changes' : 'Save customer'} onPress={() => void handleSubmit((v) => save(v))()} loading={formState.isSubmitting} />}
    >
      {formError ? <Banner tone="danger">{formError}</Banner> : null}
      {duplicates ? (
        <Banner tone="warning">
          <AppText variant="bodyStrong">This may be a customer you already have</AppText>
          {duplicates.map((d) => (
            <Button
              key={d.id}
              title={`Open ${d.name} (${formatPhone(d.phone)})`}
              variant="ghost"
              compact
              onPress={() => navigation.replace('CustomerProfile', { customerId: d.id })}
            />
          ))}
          <Button title="No, create a new customer" variant="secondary" compact onPress={() => save(getValues(), true)} />
        </Banner>
      ) : null}
      <FormField control={control} name="name" label="Full name or business name" autoCapitalize="words" />
      <FormField control={control} name="phone" label="Phone number" keyboardType="phone-pad" placeholder="0712 345 678" />
      <FormField control={control} name="email" label="Email (optional)" keyboardType="email-address" autoCapitalize="none" />
      <FormField control={control} name="address" label="Business or billing address (optional)" />
      <FormField control={control} name="notes" label="Notes (optional)" multiline hint="Only notes needed for the business relationship, e.g. preferred payment day." />
      <Controller
        control={control}
        name="sms_opt_in"
        render={({ field }) => (
          <ToggleRow
            label="Send SMS reminders"
            description="Polite reminders before and after due dates. Turn off if the customer asks not to be contacted."
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
    </Screen>
  );
}

export function CustomerProfileScreen({ route, navigation }: AppScreenProps<'CustomerProfile'>) {
  const { customerId } = route.params;
  const { isManager } = useSession();
  const c = useCustomer(customerId);
  const debts = useCustomerDebts(customerId);
  const payments = useCustomerPayments(customerId);
  const [tab, setTab] = useState<'debts' | 'payments'>('debts');
  const archive = useBizMutation<object, Customer>('post', () => `/customers/${customerId}/archive`);
  const restore = useBizMutation<object, Customer>('post', () => `/customers/${customerId}/restore`);

  useEffect(() => {
    if (c.data) navigation.setOptions({ title: c.data.data.name });
  }, [c.data, navigation]);

  if (customerId.startsWith(LOCAL_PREFIX)) {
    return <EmptyState title="Waiting to sync" body="This customer was added offline and will appear once it is saved." />;
  }
  if (c.isPending) return <LoadingState />;
  if (c.isError) return <ErrorState error={c.error} onRetry={() => c.refetch()} />;
  const cust = c.data.data;
  const archived = cust.status === 'archived';

  return (
    <Screen refreshing={c.isRefetching} onRefresh={() => { c.refetch(); debts.refetch(); payments.refetch(); }} edges={['bottom']}>
      <CachedNotice fromCache={c.data.fromCache} savedAt={c.data.savedAt} />
      <Card>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <AppText variant="caption" color={colors.inkMuted}>
              {cust.customer_number}
            </AppText>
            <AppText variant="heading">{cust.name}</AppText>
          </View>
          {archived ? <Badge label="Archived" tone="neutral" /> : null}
        </Row>
        <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.lg }}>
          Outstanding balance
        </AppText>
        <MoneyText amount={cust.outstanding_balance} variant="display" color={isPositive(cust.overdue_amount) ? colors.danger : colors.ink} />
        {isPositive(cust.overdue_amount) ? (
          <AppText color={colors.danger}>Of which overdue: {formatKES(cust.overdue_amount)}</AppText>
        ) : null}
        {isPositive(cust.pending_verification) ? (
          <AppText variant="caption" color={colors.warning}>
            {formatKES(cust.pending_verification)} received but awaiting verification
          </AppText>
        ) : null}
        <Divider />
        <View style={{ marginTop: space.md, gap: space.xs }}>
          <Button title={`Call ${formatPhone(cust.phone)}`} variant="ghost" compact onPress={() => { expectExternalActivity(); void Linking.openURL(`tel:${cust.phone}`); }} style={{ alignSelf: 'flex-start' }} />
          {cust.email ? <AppText color={colors.inkMuted}>{cust.email}</AppText> : null}
          {cust.address ? <AppText color={colors.inkMuted}>{cust.address}</AppText> : null}
          {cust.notes ? <AppText color={colors.inkMuted}>Note: {cust.notes}</AppText> : null}
          {!cust.sms_opt_in ? <AppText variant="caption" color={colors.inkMuted}>SMS reminders are off for this customer</AppText> : null}
        </View>
      </Card>

      {!archived ? (
        <Row style={{ marginTop: space.lg }} gap={space.md}>
          <Button title="Record payment" style={{ flex: 1 }} disabled={isZero(cust.outstanding_balance)} onPress={() => navigation.navigate('RecordPayment', { customerId })} />
          <Button title="New debt" variant="secondary" style={{ flex: 1 }} onPress={() => navigation.navigate('DebtForm', { customerId, customerName: cust.name })} />
        </Row>
      ) : null}
      {!archived && cust.sms_opt_in && isPositive(cust.outstanding_balance) ? (
        <Row style={{ marginTop: space.md }}>
          <SendReminderButton customerId={customerId} name={cust.name} />
        </Row>
      ) : null}

      <View style={{ marginTop: space.xl }}>
        <SegmentedControl
          label="Customer history"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'debts', label: `Debts${debts.data ? ` (${debts.data.data.length})` : ''}` },
            { value: 'payments', label: `Payments${payments.data ? ` (${payments.data.data.length})` : ''}` },
          ]}
        />
      </View>
      <Card padded={false} style={{ marginTop: space.md }}>
        {tab === 'debts' ? (
          debts.isPending ? <LoadingState /> : debts.isError ? <ErrorState error={debts.error} onRetry={() => debts.refetch()} /> :
          debts.data.data.length === 0 ? <EmptyState title="No debts recorded" /> :
          debts.data.data.map((d, i) => (
            <View key={d.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <ListRow
                title={d.description}
                subtitle={`${d.debt_number} · ${d.status === 'paid' ? 'Settled' : dueLabel(d.next_due_date ?? d.due_date)}`}
                onPress={() => navigation.navigate('DebtDetail', { debtId: d.id })}
                right={<View style={{ alignItems: 'flex-end', gap: 4 }}><MoneyText amount={d.balance} /><DebtStatusBadge status={d.status} /></View>}
              />
            </View>
          ))
        ) : payments.isPending ? <LoadingState /> : payments.isError ? <ErrorState error={payments.error} onRetry={() => payments.refetch()} /> :
          payments.data.data.length === 0 ? <EmptyState title="No payments yet" /> :
          payments.data.data.map((p, i) => (
            <View key={p.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <ListRow
                title={`${METHOD_LABEL[p.method]}${p.receipt_number ? ` · ${p.receipt_number}` : ''}`}
                subtitle={formatDateTime(p.paid_at)}
                onPress={() => navigation.navigate('PaymentDetail', { paymentId: p.id })}
                right={<View style={{ alignItems: 'flex-end', gap: 4 }}><MoneyText amount={p.amount} color={p.status === 'reversed' ? colors.inkFaint : colors.success} /><VerificationBadge status={p.verification_status} reversed={p.status === 'reversed'} /></View>}
              />
            </View>
          ))}
      </Card>

      {isManager ? (
        <>
          <SectionHeader title="Manage" />
          <Button title="Edit details" variant="secondary" onPress={() => navigation.navigate('CustomerForm', { customerId })} />
          <Button
            title={archived ? 'Restore customer' : 'Archive customer'}
            variant="ghost"
            loading={archive.isPending || restore.isPending}
            style={{ marginTop: space.sm }}
            onPress={() =>
              archived
                ? restore.mutate({})
                : Alert.alert('Archive customer?', 'Their history is kept, but no new credit can be recorded for them.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Archive', style: 'destructive', onPress: () => archive.mutate({}) },
                  ])
            }
          />
          <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.sm }}>
            Customer since {formatDate(cust.created_at)}
          </AppText>
        </>
      ) : null}
    </Screen>
  );
}
