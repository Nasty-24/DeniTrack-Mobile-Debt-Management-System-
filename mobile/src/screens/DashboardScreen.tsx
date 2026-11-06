import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';

import { MoneyText, StatTile, VerificationBadge } from '../components/finance';
import { CachedNotice, Screen } from '../components/Screen';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { AppText, Button, Card, Divider, ListRow, Row, SectionHeader } from '../components/ui';
import { useDashboard } from '../hooks/queries';
import { useSession } from '../hooks/useSession';
import { colors, radius, space } from '../theme/tokens';
import { dueLabel, formatDate, formatDateTime } from '../utils/dates';
import { isZero } from '../utils/money';

export function DashboardScreen() {
  const navigation = useNavigation();
  const { business, user } = useSession();
  const q = useDashboard();

  if (q.isPending) return <LoadingState label="Loading your figures…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { data: d, fromCache, savedAt } = q.data;
  const firstName = user?.full_name.split(' ')[0] ?? '';

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => q.refetch()} edges={['top']}>
      <View style={styles.header}>
        <AppText variant="caption" color={colors.inkMuted}>
          {business?.business_name}
        </AppText>
        <AppText variant="title" accessibilityRole="header">
          Habari, {firstName}
        </AppText>
      </View>
      <CachedNotice fromCache={fromCache} savedAt={savedAt} />

      {/* The app icon's gradient: deep blue to brighter blue (both readable with white text). */}
      <LinearGradient
        colors={[colors.heroStart, colors.heroEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <AppText variant="caption" color={colors.onBrand}>
          Total outstanding
        </AppText>
        <MoneyText amount={d.total_outstanding} variant="display" color={colors.onBrand} />
        <AppText variant="caption" color={colors.onBrand} style={{ marginTop: space.xs }}>
          {d.customers_with_balance} customer{d.customers_with_balance === 1 ? '' : 's'} owe you · as of {formatDate(d.as_of)}
        </AppText>
        {!isZero(d.pending_verification) ? (
          <AppText variant="caption" color={colors.onBrand} style={[styles.heroNote, { borderTopColor: colors.onBrand }]}>
            {d.pending_verification_count} payment{d.pending_verification_count === 1 ? '' : 's'} awaiting verification are not yet deducted
          </AppText>
        ) : null}
      </LinearGradient>

      <View style={styles.tiles}>
        <StatTile
          label="Overdue"
          amount={d.total_overdue}
          tone={isZero(d.total_overdue) ? 'neutral' : 'danger'}
          footnote={`${d.overdue_debts} debt${d.overdue_debts === 1 ? '' : 's'}`}
        />
        <StatTile label="Collected today" amount={d.collected_today} tone="success" />
      </View>
      <View style={styles.tiles}>
        <StatTile label="Collected this month" amount={d.collected_this_month} />
        <StatTile label="Awaiting verification" amount={d.pending_verification} tone={isZero(d.pending_verification) ? 'neutral' : 'warning'} />
      </View>

      <View style={styles.actions}>
        <Button title="Record payment" onPress={() => navigation.navigate('RecordPayment')} style={{ flex: 1 }} />
        <Button title="New debt" variant="secondary" onPress={() => navigation.navigate('DebtForm')} style={{ flex: 1 }} />
      </View>
      <Button title="Add customer" variant="ghost" onPress={() => navigation.navigate('CustomerForm')} />

      <SectionHeader
        title="Due in the next 7 days"
        action={<Button title="All" variant="ghost" compact onPress={() => navigation.navigate('UpcomingPayments')} />}
      />
      <Card padded={false}>
        {d.due_soon.length === 0 ? (
          <EmptyState title="Nothing due this week" />
        ) : (
          d.due_soon.map((x, i) => (
            <View key={x.debt_id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <ListRow
                title={x.customer_name}
                subtitle={`${x.debt_number} · ${dueLabel(x.due_date, d.as_of)}`}
                right={<MoneyText amount={x.balance} color={colors.warning} />}
                onPress={() => navigation.navigate('DebtDetail', { debtId: x.debt_id })}
              />
            </View>
          ))
        )}
      </Card>
      {!isZero(d.total_overdue) ? (
        <Button title="Review overdue debts" variant="danger" onPress={() => navigation.navigate('OverdueDebts')} style={{ marginTop: space.md }} />
      ) : null}

      <SectionHeader title="Recent payments" />
      <Card padded={false}>
        {d.recent_payments.length === 0 ? (
          <EmptyState title="No payments yet" body="Payments you record will appear here." />
        ) : (
          d.recent_payments.map((p, i) => (
            <View key={p.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <ListRow
                title={p.customer_name}
                subtitle={formatDateTime(p.paid_at)}
                right={
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <MoneyText amount={p.amount} color={p.status === 'reversed' ? colors.inkFaint : colors.success} />
                    {p.status === 'reversed' || p.verification_status === 'pending' ? (
                      <VerificationBadge status={p.verification_status} reversed={p.status === 'reversed'} />
                    ) : null}
                  </View>
                }
                onPress={() => navigation.navigate('PaymentDetail', { paymentId: p.id })}
              />
            </View>
          ))
        )}
      </Card>

      <SectionHeader title="Recent credit" />
      <Card padded={false}>
        {d.recent_debts.length === 0 ? (
          <EmptyState title="No debts recorded" />
        ) : (
          d.recent_debts.map((x, i) => (
            <View key={x.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <ListRow
                title={x.customer_name}
                subtitle={`${x.debt_number} · ${x.description}`}
                right={<MoneyText amount={x.principal} />}
                onPress={() => navigation.navigate('DebtDetail', { debtId: x.id })}
              />
            </View>
          ))
        )}
      </Card>
      <Row style={{ justifyContent: 'center', marginTop: space.xl }}>
        <AppText variant="caption" color={colors.inkFaint}>
          All figures are calculated from recorded transactions.
        </AppText>
      </Row>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: space.sm },
  hero: { marginTop: space.lg, borderRadius: radius.lg, padding: space.lg },
  heroNote: { marginTop: space.sm, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  tiles: { flexDirection: 'row', gap: space.md, marginTop: space.md },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.xl },
});
