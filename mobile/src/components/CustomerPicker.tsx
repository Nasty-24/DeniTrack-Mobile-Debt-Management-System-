import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { useCustomers } from '../hooks/queries';
import { useOutbox } from '../hooks/useOutbox';
import { LOCAL_PREFIX } from '../services/outbox';
import { colors, space } from '../theme/tokens';
import { formatKES, isPositive } from '../utils/money';
import { formatPhone } from '../utils/phone';
import { ContactResults, type NewPerson } from './ContactResults';
import { LoadingState } from './states';
import { AppText, Button, Card, Divider, ListRow, TextField } from './ui';

export interface PickedCustomer {
  id: string;
  name: string;
}

export type PickerValue = PickedCustomer | NewPerson;

export function isNewPerson(v: PickerValue | null): v is NewPerson {
  return v !== null && 'kind' in v && v.kind === 'new';
}

/**
 * Search-and-select for forms. Includes customers created offline that are waiting to sync.
 * With `onPickNew`, people from the phone's contacts are listed too ("From your phone").
 */
export function CustomerPicker({
  value,
  onChange,
  onPickNew,
  error,
  owingOnly = false,
}: {
  value: PickerValue | null;
  onChange: (c: PickedCustomer | null) => void;
  onPickNew?: (p: NewPerson) => void;
  error?: string;
  owingOnly?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const { ops } = useOutbox();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  const q = useCustomers({ q: debounced || undefined, balance: owingOnly ? 'outstanding' : 'any', status: 'active', sort: owingOnly ? 'balance' : 'name' });
  const items = useMemo(() => q.data?.data.items ?? [], [q.data]);
  const knownPhones = useMemo(() => new Set(items.map((c) => c.phone)), [items]);

  if (isNewPerson(value)) {
    return (
      <Card style={{ marginBottom: space.lg }}>
        <AppText variant="caption" color={colors.inkMuted}>
          Customer
        </AppText>
        <AppText variant="heading">{value.name}</AppText>
        <AppText color={colors.inkMuted}>{formatPhone(value.phone)}</AppText>
        <AppText variant="caption" color={colors.warning}>
          New customer · added when you save
        </AppText>
        <Button title="Change customer" variant="ghost" compact onPress={() => onChange(null)} style={{ alignSelf: 'flex-start', marginTop: space.xs }} />
      </Card>
    );
  }

  if (value) {
    return (
      <Card style={{ marginBottom: space.lg }}>
        <AppText variant="caption" color={colors.inkMuted}>
          Customer
        </AppText>
        <AppText variant="heading">{value.name}</AppText>
        {value.id.startsWith(LOCAL_PREFIX) ? (
          <AppText variant="caption" color={colors.warning}>
            Added offline · waiting to sync
          </AppText>
        ) : null}
        <Button title="Change customer" variant="ghost" compact onPress={() => onChange(null)} style={{ alignSelf: 'flex-start', marginTop: space.xs }} />
      </Card>
    );
  }

  const queued = owingOnly
    ? []
    : ops
        .filter((o) => o.kind === 'customer.create' && o.status === 'pending')
        .map((o) => ({ id: `${LOCAL_PREFIX}${o.id}`, name: String(o.payload.name) }));

  return (
    <View style={{ marginBottom: space.lg }}>
      <TextField label="Customer" placeholder="Search by name, phone or ID" value={query} onChangeText={setQuery} error={error} autoCorrect={false} />
      <Card padded={false}>
        {q.isPending ? <LoadingState /> : null}
        {queued.map((c) => (
          <ListRow key={c.id} title={c.name} subtitle="Added offline · waiting to sync" onPress={() => onChange(c)} />
        ))}
        {items.slice(0, 8).map((c, i) => (
          <View key={c.id}>
            {i > 0 || queued.length ? <Divider inset={space.lg} /> : null}
            <ListRow
              title={c.name}
              subtitle={`${c.customer_number} · ${formatPhone(c.phone)}`}
              right={isPositive(c.outstanding_balance) ? <AppText variant="caption" tabular>{formatKES(c.outstanding_balance)}</AppText> : undefined}
              onPress={() => onChange({ id: c.id, name: c.name })}
            />
          </View>
        ))}
        {!q.isPending && items.length === 0 && queued.length === 0 ? (
          <View style={{ padding: space.lg }}>
            <AppText color={colors.inkMuted}>{owingOnly ? 'No customers with an outstanding balance match.' : 'No customers match.'}</AppText>
          </View>
        ) : null}
      </Card>
      {onPickNew ? <ContactResults query={debounced} knownPhones={knownPhones} onPick={onPickNew} /> : null}
    </View>
  );
}
