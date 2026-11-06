import { useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Linking, View } from 'react-native';

import { CustomerPicker, type PickedCustomer } from '../components/CustomerPicker';
import { Badge, MoneyText } from '../components/finance';
import { Screen } from '../components/Screen';
import { Banner, EmptyState, ErrorState, errorMessage, LoadingState } from '../components/states';
import { AppText, Button, Card, Row, SegmentedControl, ToggleRow } from '../components/ui';
import { useBizMutation, useMpesaMessages, useSettings } from '../hooks/queries';
import { useSession } from '../hooks/useSession';
import { expectExternalActivity } from '../services/appLifecycle';
import { updateBackgroundTask } from '../services/backgroundSync';
import {
  askSmsPermission,
  getPhoneSmsPrefs,
  lastPhoneRun,
  runPhoneTasks,
  sendManualReminder,
  setPhoneSmsPrefs,
  smsAvailable,
  startMpesaReadingFromNow,
  type ManualChannel,
  type PhoneRunSummary,
  type PhoneSmsPrefs,
} from '../services/phoneSms';
import { colors, space } from '../theme/tokens';
import type { MpesaSms, MpesaSmsStatus } from '../types/api';
import { formatDateTime } from '../utils/dates';
import { formatKES } from '../utils/money';

// --------------------------------------------------------------------------- M-Pesa messages

const STATUS_LABEL: Record<MpesaSmsStatus, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  applied: { label: 'Recorded', tone: 'success' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  already_recorded: { label: 'Already recorded', tone: 'neutral' },
  needs_review: { label: 'Needs matching', tone: 'warning' },
  dismissed: { label: 'Not a debt payment', tone: 'neutral' },
};

export function MpesaMessagesScreen() {
  const [tab, setTab] = useState<'review' | 'handled'>('review');
  const q = useMpesaMessages(tab === 'review' ? 'needs_review' : undefined);
  const items = (q.data?.data.items ?? []).filter((m) => tab === 'review' || m.status !== 'needs_review');
  return (
    <Screen edges={['bottom']} refreshing={q.isRefetching} onRefresh={() => q.refetch()}>
      <SegmentedControl
        label="M-Pesa messages"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'review', label: 'Needs matching' },
          { value: 'handled', label: 'Handled' },
        ]}
      />
      <View style={{ marginTop: space.lg, gap: space.md }}>
        {q.isPending ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title={tab === 'review' ? 'Nothing to match' : 'No M-Pesa payments yet'}
            body={
              tab === 'review'
                ? 'M-Pesa payments that could not be matched to one customer by phone number and name appear here.'
                : 'Turn on “Record M-Pesa payments automatically” in Settings, on the phone that receives your M-Pesa messages.'
            }
          />
        ) : (
          items.map((m) => <MpesaCard key={m.id} m={m} />)
        )}
      </View>
    </Screen>
  );
}

function MpesaCard({ m }: { m: MpesaSms }) {
  const navigation = useNavigation();
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<PickedCustomer | null>(null);
  const assign = useBizMutation<{ customer_id: string }, MpesaSms>('post', () => `/mpesa-sms/${m.id}/assign`);
  const dismiss = useBizMutation<{ reason?: string }, MpesaSms>('post', () => `/mpesa-sms/${m.id}/dismiss`);
  const status = STATUS_LABEL[m.status];

  const record = (customerId: string, name: string) =>
    Alert.alert(`Record ${formatKES(m.amount)} for ${name}?`, 'It goes to their oldest debt first and a receipt is issued.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Record payment',
        onPress: async () => {
          try {
            await assign.mutateAsync({ customer_id: customerId });
          } catch (e) {
            Alert.alert('Could not record it', errorMessage(e));
          }
        },
      },
    ]);

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <MoneyText amount={m.amount} variant="heading" />
          <AppText>
            {m.payer_name}
            {m.payer_phone ? ` · ${m.payer_phone}` : ''}
          </AppText>
          <AppText variant="caption" color={colors.inkMuted}>
            {m.transaction_code} · {formatDateTime(m.received_at)}
          </AppText>
        </View>
        <Badge label={status.label} tone={status.tone} />
      </Row>
      {m.customer_name && m.status !== 'needs_review' ? (
        <AppText style={{ marginTop: space.sm }}>For {m.customer_name}</AppText>
      ) : null}
      {m.detail ? (
        <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.xs }}>
          {m.detail}
        </AppText>
      ) : null}

      {m.status === 'needs_review' ? (
        <View style={{ marginTop: space.md, gap: space.sm }}>
          {m.suggested_customer_id && m.suggested_customer_name ? (
            <Button
              title={`Record for ${m.suggested_customer_name}`}
              loading={assign.isPending}
              onPress={() => record(m.suggested_customer_id!, m.suggested_customer_name!)}
            />
          ) : null}
          {choosing ? (
            <>
              <CustomerPicker value={picked} onChange={setPicked} owingOnly />
              <Button title="Record for this customer" disabled={!picked} loading={assign.isPending} onPress={() => picked && record(picked.id, picked.name)} />
            </>
          ) : (
            <Button title="Choose customer" variant="secondary" onPress={() => setChoosing(true)} />
          )}
          <Button
            title="Not a debt payment"
            variant="ghost"
            loading={dismiss.isPending}
            onPress={() =>
              Alert.alert('Not a debt payment?', 'For example a cash sale paid by M-Pesa. It will not change any balance.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Mark as not a debt payment', onPress: () => dismiss.mutate({}) },
              ])
            }
          />
        </View>
      ) : m.payment_id ? (
        <Button
          title="View payment"
          variant="ghost"
          compact
          style={{ alignSelf: 'flex-start', marginTop: space.sm }}
          onPress={() => navigation.navigate('PaymentDetail', { paymentId: m.payment_id! })}
        />
      ) : null}
    </Card>
  );
}

// --------------------------------------------------------------------------- Settings → This phone

function permissionDenied() {
  Alert.alert('SMS permission needed', 'Allow SMS for DeniTrack in the phone’s app settings, then turn this on again.', [
    { text: 'Not now', style: 'cancel' },
    {
      text: 'Open settings',
      onPress: () => {
        expectExternalActivity();
        void Linking.openSettings();
      },
    },
  ]);
}

function lastRunText(last: PhoneRunSummary): string {
  const when = formatDateTime(new Date(last.at).toISOString());
  if (last.error) return `Last checked ${when}. Problem: ${last.error}`;
  return `Last checked ${when}: ${last.recorded} payment${last.recorded === 1 ? '' : 's'} recorded, ${last.needsReview} to match, ${last.remindersSent} reminder${last.remindersSent === 1 ? '' : 's'} sent.`;
}

/** Shown in Settings to owners and administrators on Android phones. */
export function PhoneSmsSettings() {
  const navigation = useNavigation();
  const qc = useQueryClient();
  const { businessId, isManager } = useSession();
  const settings = useSettings();
  const [prefs, setPrefs] = useState<PhoneSmsPrefs | null>(null);
  const [last, setLast] = useState<PhoneRunSummary | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([getPhoneSmsPrefs(), lastPhoneRun()]).then(([p, l]) => {
      if (alive) {
        setPrefs(p);
        setLast(l);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!smsAvailable || !isManager || !businessId || !prefs) return null;

  const save = async (next: PhoneSmsPrefs) => {
    await setPhoneSmsPrefs(next);
    setPrefs(next);
    await updateBackgroundTask().catch(() => undefined);
  };

  const checkNow = async () => {
    setBusy(true);
    try {
      const s = await runPhoneTasks({ businessId, isManager });
      if (s) {
        setLast(s);
        await qc.invalidateQueries({ queryKey: [businessId] });
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleMpesa = (on: boolean) => {
    if (!on) return void save({ ...prefs, readMpesa: false });
    Alert.alert(
      'Record M-Pesa payments automatically?',
      'DeniTrack will read the M-Pesa messages on this phone (only messages from M-PESA) and record each payment that matches a customer by phone number and name. Payments it cannot match wait under M-Pesa messages for you. Messages already on the phone are not recorded.\n\nTurn this on only on the phone that receives your business’s M-Pesa messages.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn on',
          onPress: async () => {
            if (!(await askSmsPermission('read'))) return permissionDenied();
            await startMpesaReadingFromNow(businessId);
            await save({ ...prefs, readMpesa: true });
          },
        },
      ],
    );
  };

  const toggleSend = (on: boolean) => {
    if (!on) return void save({ ...prefs, sendReminders: false });
    Alert.alert(
      'Send reminder SMS from this phone?',
      'Due reminders will be sent as normal SMS from this phone’s SIM, using its airtime or SMS bundle. Quiet hours and the weekly limit still apply. Turn this on for one phone only.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn on',
          onPress: async () => {
            if (!(await askSmsPermission('send'))) return permissionDenied();
            await save({ ...prefs, sendReminders: true });
            void checkNow();
          },
        },
      ],
    );
  };

  const viaProvider = settings.data?.data.sms_sender === 'provider';

  return (
    <Card>
      <ToggleRow
        label="Record M-Pesa payments automatically"
        description="Reads M-Pesa messages on this phone and clears debts for customers whose phone number and name match."
        value={prefs.readMpesa}
        onChange={toggleMpesa}
      />
      <ToggleRow
        label="Send reminder SMS from this phone"
        description="Customers get reminders as normal SMS from this phone’s number. SMS charges apply."
        value={prefs.sendReminders}
        onChange={toggleSend}
      />
      {prefs.sendReminders && viaProvider ? (
        <Banner tone="warning">Reminders are set to go through an SMS provider. Change “Send SMS from” in Reminders → Schedule.</Banner>
      ) : null}
      {last ? (
        <AppText variant="caption" color={last.error ? colors.danger : colors.inkMuted} style={{ marginTop: space.sm }}>
          {lastRunText(last)}
        </AppText>
      ) : null}
      <Row gap={space.md} style={{ marginTop: space.md }}>
        <Button title="Check now" variant="secondary" compact loading={busy} disabled={!prefs.readMpesa && !prefs.sendReminders} onPress={() => void checkNow()} />
        <Button title="M-Pesa messages" variant="ghost" compact onPress={() => navigation.navigate('MpesaMessages')} />
      </Row>
      <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.md }}>
        This runs when DeniTrack opens and about every 15 minutes in the background. The phone needs a connection to your DeniTrack server.
      </AppText>
    </Card>
  );
}

// --------------------------------------------------------------------------- one-tap reminder

/** On a customer's profile: remind them now by SMS or WhatsApp. */
export function SendReminderButton({ customerId, name }: { customerId: string; name: string }) {
  const qc = useQueryClient();
  const { businessId } = useSession();
  const [busy, setBusy] = useState(false);

  const send = async (channel: ManualChannel) => {
    if (!businessId) return;
    setBusy(true);
    try {
      const r = await sendManualReminder(businessId, customerId, channel);
      await qc.invalidateQueries({ queryKey: [businessId, 'reminders'] });
      if (r.outcome === 'sent') Alert.alert('Reminder sent', `SMS sent to ${name}:\n\n${r.item.message}`);
    } catch (e) {
      Alert.alert('Reminder not sent', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      title="Send reminder"
      variant="secondary"
      loading={busy}
      style={{ flex: 1 }}
      onPress={() =>
        Alert.alert(`Remind ${name}`, 'The message uses your reminder wording and their current balance.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'WhatsApp', onPress: () => void send('whatsapp') },
          { text: smsAvailable ? 'SMS' : 'SMS app', onPress: () => void send('sms') },
        ])
      }
    />
  );
}
