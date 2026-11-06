/** The phone's SMS work: reading M-Pesa messages, sending reminder SMS, and the review screen. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { getMeta, setMeta, wipeLocalData } from '../database/localDb';
import { MpesaMessagesScreen } from '../screens/MpesaScreens';
import { api } from '../services/api';
import { ApiError } from '../services/apiClient';
import {
  runPhoneTasks,
  sendDueReminders,
  sendManualReminder,
  setPhoneSmsPrefs,
  syncMpesaInbox,
  type PhoneSmsItem,
} from '../services/phoneSms';
import type { MpesaSms } from '../types/api';

const mockSms = {
  readInbox: jest.fn(),
  sendSms: jest.fn(),
  hasSmsPermission: jest.fn(async (..._args: unknown[]) => true),
  requestSmsPermission: jest.fn(async (..._args: unknown[]) => true),
};
jest.mock('../../modules/denitrack-sms', () => ({
  smsAvailable: true,
  readInbox: (...a: unknown[]) => mockSms.readInbox(...a),
  sendSms: (...a: unknown[]) => mockSms.sendSms(...a),
  hasSmsPermission: (...a: unknown[]) => mockSms.hasSmsPermission(...a),
  requestSmsPermission: (...a: unknown[]) => mockSms.requestSmsPermission(...a),
}));

const mockNav = { navigate: jest.fn() };
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => mockNav,
}));
const mockOutbox = { online: true, ops: [], pendingCount: 0, failedCount: 0, syncing: false, submit: jest.fn() };
jest.mock('../hooks/useOutbox', () => ({ useOutbox: () => mockOutbox }));
jest.mock('../hooks/useSession', () => ({
  useSession: () => ({ businessId: 'biz-1', isManager: true }),
  useBusinessId: () => 'biz-1',
}));

const BASE = '/api/v1/businesses/biz-1';
const RECEIVED = 'TCK1ABC2DE Confirmed.You have received Ksh500.00 from JOHN MWANGI 0722***712 on 24/3/26 at 10:32 AM';

function sms(id: string, date: number, body = RECEIVED, address = 'MPESA') {
  return { id, address, body, date };
}

function item(id: string): PhoneSmsItem {
  return { reminder_id: id, customer_name: 'Achieng', phone: '+254712345670', message: `Reminder ${id}`, whatsapp_url: null };
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await wipeLocalData();
  Object.values(mockSms).forEach((f) => f.mockReset());
  mockSms.hasSmsPermission.mockResolvedValue(true);
  mockSms.requestSmsPermission.mockResolvedValue(true);
  mockNav.navigate.mockReset();
});

describe('Reading M-Pesa messages', () => {
  it('starts from now the first time, so old messages are never recorded', async () => {
    const post = jest.spyOn(api, 'post');
    expect(await syncMpesaInbox('biz-1')).toEqual({ recorded: 0, needsReview: 0 });
    expect(mockSms.readInbox).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(Number(await getMeta('mpesa.lastScan.biz-1'))).toBeGreaterThan(0);
  });

  it('sends only money-received messages and remembers how far it got', async () => {
    await setMeta('mpesa.lastScan.biz-1', '1000');
    mockSms.readInbox.mockResolvedValueOnce([
      sms('1', 2000),
      sms('2', 3000, 'TCK1ABC2DF Confirmed. Ksh200.00 sent to MARY WANJIKU 0711222333'),
      sms('3', 4000, RECEIVED.replace('TCK1ABC2DE', 'TCK1ABC2DG')),
    ]);
    const post = jest.spyOn(api, 'post').mockResolvedValue({
      results: [
        { status: 'applied', detail: null },
        { status: 'needs_review', detail: 'No customer matches' },
      ],
    } as never);

    expect(await syncMpesaInbox('biz-1')).toEqual({ recorded: 1, needsReview: 1 });
    expect(mockSms.readInbox).toHaveBeenCalledWith(['MPESA', 'M-PESA'], 1000, 50);
    const [path, body] = post.mock.calls[0] as [string, { messages: { body: string; received_at: string }[] }];
    expect(path).toBe(`${BASE}/mpesa-sms`);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].received_at).toBe(new Date(2000).toISOString());
    expect(await getMeta('mpesa.lastScan.biz-1')).toBe('4000');
  });

  it('keeps its place when the server cannot be reached', async () => {
    await setMeta('mpesa.lastScan.biz-1', '1000');
    mockSms.readInbox.mockResolvedValueOnce([sms('1', 2000)]);
    jest.spyOn(api, 'post').mockRejectedValue(new ApiError('No connection', 0, 'network_error'));
    await expect(syncMpesaInbox('biz-1')).rejects.toThrow('No connection');
    expect(await getMeta('mpesa.lastScan.biz-1')).toBe('1000');
  });
});

describe('Sending reminder SMS from the phone', () => {
  it('reports each result and never texts the same reminder twice', async () => {
    jest.spyOn(api, 'get').mockResolvedValueOnce([item('r1'), item('r2')] as never).mockResolvedValueOnce([item('r1')] as never);
    const post = jest.spyOn(api, 'post').mockResolvedValue({} as never);
    mockSms.sendSms.mockResolvedValueOnce('sent').mockRejectedValueOnce(new Error('No mobile network. The SMS was not sent.'));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const first = sendDueReminders('biz-1');
    await jest.runAllTimersAsync();
    expect(await first).toBe(1);
    jest.useRealTimers();
    expect(post).toHaveBeenCalledWith(`${BASE}/reminders/r1/phone-result`, { sent: true, error: null });
    expect(post).toHaveBeenCalledWith(`${BASE}/reminders/r2/phone-result`, {
      sent: false,
      error: 'No mobile network. The SMS was not sent.',
    });

    // r1 is offered again (say the server missed the report): confirmed, not re-sent.
    expect(await sendDueReminders('biz-1')).toBe(0);
    expect(mockSms.sendSms).toHaveBeenCalledTimes(2);
  });

  it('does nothing unless switched on for this phone, and only for managers', async () => {
    const get = jest.spyOn(api, 'get');
    expect(await runPhoneTasks({ businessId: 'biz-1', isManager: true })).toBeNull();
    await setPhoneSmsPrefs({ readMpesa: false, sendReminders: true });
    expect(await runPhoneTasks({ businessId: 'biz-1', isManager: false })).toBeNull();
    get.mockResolvedValue([] as never);
    const s = await runPhoneTasks({ businessId: 'biz-1', isManager: true });
    expect(s).toMatchObject({ remindersSent: 0, error: null });
    expect(get).toHaveBeenCalledWith(`${BASE}/reminders/phone-queue`);
  });
});

describe('One-tap reminder', () => {
  it('sends an SMS from the phone and reports it', async () => {
    const post = jest.spyOn(api, 'post').mockResolvedValueOnce(item('m1') as never).mockResolvedValue({} as never);
    mockSms.sendSms.mockResolvedValue('sent');
    const r = await sendManualReminder('biz-1', 'c1', 'sms');
    expect(r.outcome).toBe('sent');
    expect(post).toHaveBeenCalledWith(`${BASE}/reminders/manual`, { customer_id: 'c1', channel: 'sms' });
    expect(mockSms.sendSms).toHaveBeenCalledWith('+254712345670', 'Reminder m1');
    expect(post).toHaveBeenCalledWith(`${BASE}/reminders/m1/phone-result`, { sent: true, error: null });
  });

  it('opens WhatsApp with the message ready', async () => {
    const url = 'https://wa.me/254712345670?text=Reminder';
    jest.spyOn(api, 'post').mockResolvedValueOnce({ ...item('m2'), whatsapp_url: url } as never);
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    expect((await sendManualReminder('biz-1', 'c1', 'whatsapp')).outcome).toBe('opened');
    expect(open).toHaveBeenCalledWith(url);
    expect(mockSms.sendSms).not.toHaveBeenCalled();
  });

  it('falls back to the SMS app when SMS permission is refused', async () => {
    mockSms.hasSmsPermission.mockResolvedValue(false);
    mockSms.requestSmsPermission.mockResolvedValue(false);
    jest.spyOn(api, 'post').mockResolvedValueOnce(item('m3') as never).mockResolvedValue({} as never);
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    expect((await sendManualReminder('biz-1', 'c1', 'sms')).outcome).toBe('opened');
    expect(open).toHaveBeenCalledWith('sms:+254712345670?body=Reminder%20m3');
  });
});

// --------------------------------------------------------------------------- review screen

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

function wrap(ui: ReactNode) {
  // gcTime Infinity: no cache-expiry timers left running, so Jest can exit.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

function message(over: Partial<MpesaSms> = {}): MpesaSms {
  return {
    id: 'm1', transaction_code: 'TCK1ABC2DE', amount: '500.00', payer_name: 'JOHN MWANGI', payer_phone: '0722***712',
    received_at: '2026-11-06T07:32:00Z', status: 'needs_review',
    detail: 'The number matches Mama Njeri, but the M-Pesa name JOHN MWANGI does not.', customer_id: null,
    customer_name: null, suggested_customer_id: 'c9', suggested_customer_name: 'Mama Njeri', payment_id: null,
    created_at: '2026-11-06T07:33:00Z', resolved_at: null, ...over,
  };
}

describe('M-Pesa messages screen', () => {
  it('shows why a payment was not matched and records it for the suggested customer', async () => {
    jest.spyOn(api, 'get').mockResolvedValue({ items: [message()], total: 1, limit: 100, offset: 0 } as never);
    const post = jest.spyOn(api, 'post').mockResolvedValue(message({ status: 'applied' }) as never);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(wrap(<MpesaMessagesScreen />));
    expect(await screen.findByText('JOHN MWANGI · 0722***712')).toBeTruthy();
    expect(screen.getByText(/does not\.$/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Record for Mama Njeri' }));
    const buttons = alert.mock.calls[0][2]!;
    expect(alert.mock.calls[0][0]).toBe('Record KSh 500.00 for Mama Njeri?');
    await buttons.find((b) => b.text === 'Record payment')!.onPress!();
    await waitFor(() => expect(post).toHaveBeenCalledWith(`${BASE}/mpesa-sms/m1/assign`, { customer_id: 'c9' }, undefined));
  });
});
