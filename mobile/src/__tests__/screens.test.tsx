/** Screen-level tests: forms, payment confirmation, offline queueing, dashboard figures. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Contacts from 'expo-contacts';
import type { ReactNode } from 'react';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { wipeLocalData } from '../database/localDb';
import { CustomerFormScreen, CustomerProfileScreen } from '../screens/CustomerScreens';
import { DashboardScreen } from '../screens/DashboardScreen';
import { DebtFormScreen } from '../screens/DebtScreens';
import { RecordPaymentScreen, receiptHtml } from '../screens/PaymentScreens';
import { SignInScreen } from '../screens/auth/AuthScreens';
import { api } from '../services/api';
import { ApiError } from '../services/apiClient';
import type { DashboardSummary, Debt } from '../types/api';

const mockNav = { navigate: jest.fn(), replace: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() };
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => mockNav,
}));

const mockSession = {
  status: 'signedIn',
  user: { id: 'u1', email: 'owner@example.com', full_name: 'Wanjiru Kamau', phone: null, must_change_password: false },
  memberships: [{ business_id: 'biz-1', business_name: 'Duka la Mama', role: 'owner' }],
  businessId: 'biz-1',
  business: { business_id: 'biz-1', business_name: 'Duka la Mama', role: 'owner' },
  role: 'owner',
  isManager: true,
  signIn: jest.fn(),
};
jest.mock('../hooks/useSession', () => ({
  useSession: () => mockSession,
  useBusinessId: () => 'biz-1',
}));

const mockOutbox = { online: true, ops: [], pendingCount: 0, failedCount: 0, syncing: false, submit: jest.fn() };
jest.mock('../hooks/useOutbox', () => ({ useOutbox: () => mockOutbox }));

// A phone-sized safe area, as the app's SafeAreaProvider would supply on a device.
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

function debt(over: Partial<Debt>): Debt {
  return {
    id: 'd1', debt_number: 'D-000001', customer_id: 'c1', customer_name: 'Achieng Atieno', customer_phone: '+254712345678',
    description: 'Cement 10 bags', currency: 'KES', principal: '1000.00', adjustments_total: '0.00', total_due: '1000.00',
    paid: '200.00', pending_verification: '0.00', balance: '800.00', overdue_amount: '0.00', status: 'partially_paid',
    days_overdue: 0, incurred_on: '2026-10-01', due_date: '2026-11-15', next_due_date: '2026-11-15', terms: null,
    reference: null, flag_reason: null, created_by: 'u1', created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z',
    version: 1, schedule: [], ...over,
  };
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await wipeLocalData(); // start every test with an empty offline cache
  Object.values(mockNav).forEach((f) => f.mockReset());
  mockOutbox.submit.mockReset();
  mockOutbox.online = true;
});

describe('Sign in', () => {
  it('validates before contacting the server', async () => {
    await render(wrap(<SignInScreen navigation={mockNav as never} route={{ key: 'k', name: 'SignIn' } as never} />));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeTruthy();
    expect(screen.getByText('Enter your password')).toBeTruthy();
    expect(mockSession.signIn).not.toHaveBeenCalled();
  });

  it('shows the server error without revealing which field was wrong', async () => {
    mockSession.signIn.mockRejectedValueOnce(new ApiError('Email or password is incorrect', 401, 'invalid_credentials'));
    await render(wrap(<SignInScreen navigation={mockNav as never} route={{ key: 'k', name: 'SignIn' } as never} />));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'owner@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong-password');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email or password is incorrect')).toBeTruthy();
  });
});

describe('Record payment', () => {
  function mockApi(debts: Debt[]) {
    jest.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.endsWith('/settings')) return { payment_methods: ['cash', 'mpesa'] } as never;
      if (path.endsWith('/customers/c1/debts')) return debts as never;
      if (path.endsWith('/customers')) return { items: [], total: 0, limit: 200, offset: 0 } as never;
      throw new Error(`unexpected GET ${path}`);
    });
  }
  const renderScreen = () =>
    render(wrap(<RecordPaymentScreen navigation={mockNav as never} route={{ key: 'k', name: 'RecordPayment', params: { customerId: 'c1' } } as never} />));

  it('blocks overpayment, then confirms and records a valid payment', async () => {
    mockApi([debt({})]);
    mockOutbox.submit.mockResolvedValue({ queued: false, result: { id: 'p1', receipt_number: 'RCT-2026-000001' } });
    await renderScreen();
    expect(await screen.findByText('Achieng Atieno')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Amount received'), '900');
    await fireEvent.press(screen.getByRole('button', { name: 'Review payment' }));
    expect(await screen.findByText('This is more than the customer owes. Overpayments are not accepted.')).toBeTruthy();
    expect(mockOutbox.submit).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText('Amount received'), '300');
    await fireEvent.press(screen.getByRole('button', { name: 'Review payment' }));
    expect(await screen.findByText('Confirm payment')).toBeTruthy();
    expect(screen.getByText('KSh 500.00')).toBeTruthy(); // remaining after
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm and save' }));

    await waitFor(() => expect(mockOutbox.submit).toHaveBeenCalledTimes(1));
    const [kind, body, , key] = mockOutbox.submit.mock.calls[0];
    expect(kind).toBe('payment.create');
    expect(body).toMatchObject({ customer_id: 'c1', amount: '300.00', method: 'cash' });
    expect(typeof key).toBe('string');
    expect(mockNav.replace).toHaveBeenCalledWith('Receipt', { paymentId: 'p1' });
  });

  it('pending M-Pesa verification is not counted as payable headroom', async () => {
    mockApi([debt({ pending_verification: '300.00' })]);
    await renderScreen();
    expect(await screen.findByText('Up to KSh 500.00')).toBeTruthy();
  });

  it('requires the M-Pesa code for M-Pesa payments', async () => {
    mockApi([debt({})]);
    await renderScreen();
    await screen.findByText('Achieng Atieno');
    await fireEvent.press(screen.getByRole('radio', { name: 'M-Pesa' }));
    await fireEvent.changeText(screen.getByLabelText('Amount received'), '100');
    await fireEvent.press(screen.getByRole('button', { name: 'Review payment' }));
    expect(await screen.findByText('Enter the 10-character M-Pesa code from the confirmation SMS')).toBeTruthy();
  });

  it('tells the user a queued offline payment is not yet on the server', async () => {
    mockApi([debt({})]);
    mockOutbox.online = false;
    mockOutbox.submit.mockResolvedValue({ queued: true, localId: 'local:abc' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await renderScreen();
    await screen.findByText('Achieng Atieno');
    await fireEvent.changeText(screen.getByLabelText('Amount received'), '100');
    await fireEvent.press(screen.getByRole('button', { name: 'Review payment' }));
    expect(await screen.findByText(/You are offline/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm and save' }));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).toMatch(/NOT yet recorded on the server/);
    expect(mockNav.replace).not.toHaveBeenCalled();
  });

  it('shows the server reason when a payment is rejected', async () => {
    mockApi([debt({})]);
    mockOutbox.submit.mockRejectedValue(new ApiError('A payment with this transaction reference has already been recorded', 409, 'duplicate_reference'));
    await renderScreen();
    await screen.findByText('Achieng Atieno');
    await fireEvent.changeText(screen.getByLabelText('Amount received'), '100');
    await fireEvent.press(screen.getByRole('button', { name: 'Review payment' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Confirm and save' }));
    expect(await screen.findByText('A payment with this transaction reference has already been recorded')).toBeTruthy();
  });
});

describe('Record debt', () => {
  const route = { key: 'k', name: 'DebtForm', params: { customerId: 'c1', customerName: 'Achieng Atieno' } } as never;

  async function fillAndSave() {
    await fireEvent.changeText(screen.getByLabelText('What was taken on credit'), 'Cement 2 bags');
    await fireEvent.changeText(screen.getByLabelText('Amount'), '2450');
    await fireEvent.press(screen.getByRole('button', { name: 'Record debt' }));
    await waitFor(() => expect(mockOutbox.submit).toHaveBeenCalled());
    return mockOutbox.submit.mock.calls[0][1] as Record<string, unknown>;
  }

  it('texts the customer about the credit by default', async () => {
    mockOutbox.submit.mockResolvedValue({ queued: false, result: debt({ id: 'd9' }) });
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    const sms = screen.getByRole('switch', { name: 'Send SMS to customer' });
    expect(sms.props.accessibilityState.checked).toBe(true);
    expect(await fillAndSave()).toMatchObject({ description: 'Cement 2 bags', principal: '2450.00', notify_customer: true });
    await waitFor(() => expect(mockNav.replace).toHaveBeenCalledWith('DebtDetail', { debtId: 'd9' }));
  });

  it('sends no SMS when switched off', async () => {
    mockOutbox.submit.mockResolvedValue({ queued: false, result: debt({ id: 'd9' }) });
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await fireEvent.press(screen.getByRole('switch', { name: 'Send SMS to customer' }));
    expect(await fillAndSave()).toMatchObject({ notify_customer: false });
  });

  it('takes one item per line, with Enter starting a new line', async () => {
    mockOutbox.submit.mockResolvedValue({ queued: false, result: debt({ id: 'd9' }) });
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    const items = screen.getByLabelText('What was taken on credit');
    expect(items.props.multiline).toBe(true);
    expect(items.props.submitBehavior).toBe('newline');
    await fireEvent.changeText(items, 'Sugar 2kg\nBread\nMilk 1L');
    await fireEvent.changeText(screen.getByLabelText('Amount'), '480');
    await fireEvent.press(screen.getByRole('button', { name: 'Record debt' }));
    await waitFor(() => expect(mockOutbox.submit).toHaveBeenCalled());
    expect(mockOutbox.submit.mock.calls[0][1]).toMatchObject({ description: 'Sugar 2kg\nBread\nMilk 1L' });
  });

  it('explains when the list of items is too long', async () => {
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await fireEvent.changeText(screen.getByLabelText('What was taken on credit'), 'Sugar 2kg\n'.repeat(60));
    await fireEvent.changeText(screen.getByLabelText('Amount'), '480');
    await fireEvent.press(screen.getByRole('button', { name: 'Record debt' }));
    expect(await screen.findByText('Keep the list under 500 characters, or split it into two debts')).toBeTruthy();
    expect(mockOutbox.submit).not.toHaveBeenCalled();
  });

  it('says the SMS waits when the debt is saved offline', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockOutbox.submit.mockResolvedValue({ queued: true, localId: 'local-1' });
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await fillAndSave();
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).toMatch(/SMS to the customer goes once it is recorded/);
  });
});

describe('Debts with several items', () => {
  const ITEMS = 'Sugar 2kg\nBread\nMilk 1L';

  it('shows them on one line when choosing a debt to pay', async () => {
    jest.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.endsWith('/settings')) return { payment_methods: ['cash'] } as never;
      if (path.endsWith('/customers/c1/debts')) return [debt({ description: ITEMS })] as never;
      return { items: [], total: 0, limit: 200, offset: 0 } as never;
    });
    await render(wrap(<RecordPaymentScreen navigation={mockNav as never} route={{ key: 'k', name: 'RecordPayment', params: { customerId: 'c1' } } as never} />));
    expect(await screen.findByText('D-000001 · Sugar 2kg, Bread, Milk 1L')).toBeTruthy();
  });

  it("shows them on one line in the customer's debts", async () => {
    jest.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.endsWith('/debts')) return [debt({ description: ITEMS })] as never;
      if (path.endsWith('/payments') || path.endsWith('/mpesa-names')) return [] as never;
      return {
        id: 'c1', customer_number: 'C-00001', name: 'Achieng Atieno', phone: '+254712345678', email: null, address: null, notes: null,
        status: 'active', sms_opt_in: true, created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', version: 1,
        outstanding_balance: '800.00', overdue_amount: '0.00', pending_verification: '0.00', open_debts: 1,
      } as never;
    });
    await render(wrap(<CustomerProfileScreen navigation={mockNav as never} route={{ key: 'k', name: 'CustomerProfile', params: { customerId: 'c1' } } as never} />));
    expect(await screen.findByText('Sugar 2kg, Bread, Milk 1L')).toBeTruthy();
  });

  it('shows them on one line in recent debts on the dashboard', async () => {
    const summary: DashboardSummary = {
      as_of: '2026-11-12', currency: 'KES', total_outstanding: '480.00', total_overdue: '0.00', overdue_debts: 0,
      collected_today: '0.00', collected_this_month: '0.00', pending_verification: '0.00', pending_verification_count: 0,
      customers_with_balance: 1, due_soon: [], recent_payments: [],
      recent_debts: [{ id: 'd1', debt_number: 'D-000001', customer_id: 'c1', customer_name: 'Achieng Atieno', principal: '480.00', description: ITEMS, created_at: '2026-11-12T08:00:00Z' }],
    };
    jest.spyOn(api, 'get').mockResolvedValue(summary as never);
    await render(wrap(<DashboardScreen />));
    expect(await screen.findByText('D-000001 · Sugar 2kg, Bread, Milk 1L')).toBeTruthy();
  });

  it('shows them on one line on the receipt', () => {
    const html = receiptHtml({
      receipt_number: 'RCT-2026-000001', payment_status: 'verified',
      snapshot: {
        business: { name: 'Duka la Mama', address: null, phone: null }, customer: { name: 'Achieng Atieno', number: 'C-00001' },
        paid_at: '2026-11-12T08:00:00Z', amount: '480.00', method: 'cash', external_reference: null, recorded_by: 'Wanjiru Kamau',
        allocations: [{ debt_number: 'D-000001', description: ITEMS, amount: '480.00', balance_after: '0.00' }],
      },
    } as never);
    expect(html).toContain('D-000001 – Sugar 2kg, Bread, Milk 1L');
  });
});

describe('Record debt for someone from the phone book', () => {
  const route = { key: 'k', name: 'DebtForm', params: undefined } as never;
  const MAMA = { id: '1', fullName: 'Mama Njeri Kibanda', phones: [{ id: 'p1', number: '0712 345 678' }] };
  const EMPTY_PAGE = { items: [], total: 0, limit: 200, offset: 0 };
  const duplicate = (details: unknown) =>
    new ApiError('A customer with the same name or phone number already exists', 409, 'possible_duplicate', details);

  beforeEach(() => {
    (Contacts.Contact.getAllDetails as jest.Mock).mockResolvedValue([MAMA]);
    jest
      .spyOn(api, 'get')
      .mockImplementation(async (path: string) => (path.endsWith('/settings') ? { cashier_can_register_customers: false } : EMPTY_PAGE) as never);
  });

  async function pickMama() {
    await fireEvent.changeText(screen.getByLabelText('Customer'), 'njeri');
    await fireEvent.press(await screen.findByText('Mama Njeri Kibanda', {}, { timeout: 3000 }));
    await fireEvent.press(screen.getByRole('button', { name: 'Use this person' }));
  }

  async function fillAndRecord() {
    await fireEvent.changeText(screen.getByLabelText('What was taken on credit'), 'Sugar 2kg');
    await fireEvent.changeText(screen.getByLabelText('Amount'), '300');
    await fireEvent.press(screen.getByRole('button', { name: 'Record debt' }));
  }

  const calls = () => mockOutbox.submit.mock.calls as [string, Record<string, unknown>, string, string][];

  it('records a debt for a new contact', async () => {
    mockOutbox.submit.mockImplementation(async (kind: string) =>
      kind === 'customer.create' ? { queued: false, result: { id: 'c-new' } } : { queued: false, result: debt({ id: 'd9' }) },
    );
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await pickMama();
    expect(screen.getByText('New customer · added when you save')).toBeTruthy();
    await fillAndRecord();
    await waitFor(() => expect(mockOutbox.submit).toHaveBeenCalledTimes(2));
    const [customer, credit] = calls();
    expect(customer[0]).toBe('customer.create');
    expect(customer[1]).toEqual({ name: 'Mama Njeri Kibanda', phone: '+254712345678', sms_opt_in: true, allow_duplicate: false });
    expect(credit[0]).toBe('debt.create');
    expect(credit[1].customer_id).toBe('c-new');
    await waitFor(() => expect(mockNav.replace).toHaveBeenCalledWith('DebtDetail', { debtId: 'd9' }));
  });

  it('queues the customer and the debt together offline', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockOutbox.submit.mockImplementation(async (kind: string) =>
      kind === 'customer.create' ? { queued: true, localId: 'local:k1' } : { queued: true, localId: 'local:k2' },
    );
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await pickMama();
    await fillAndRecord();
    await waitFor(() => expect(mockOutbox.submit).toHaveBeenCalledTimes(2));
    expect(calls()[1][1].customer_id).toBe('local:k1');
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][0]).toBe('Saved on this phone');
  });

  it('uses the existing customer with the same number', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockOutbox.submit
      .mockRejectedValueOnce(duplicate([{ id: 'c7', name: 'Joseph Otieno', phone: '+254712345678' }]))
      .mockResolvedValueOnce({ queued: false, result: debt({ id: 'd9' }) });
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await pickMama();
    await fillAndRecord();
    await waitFor(() => expect(mockOutbox.submit).toHaveBeenCalledTimes(2));
    expect(calls()[1][1].customer_id).toBe('c7');
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith('Debt recorded', 'Joseph Otieno is already a customer, so the debt was recorded for them.'),
    );
  });

  it('asks when only the name matches', async () => {
    mockOutbox.submit
      .mockRejectedValueOnce(duplicate([{ id: 'c8', name: 'Mama Njeri Kibanda', phone: '+254700000001' }]))
      .mockResolvedValueOnce({ queued: false, result: { id: 'c-new' } })
      .mockResolvedValueOnce({ queued: false, result: debt({ id: 'd9' }) });
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await pickMama();
    await fillAndRecord();
    expect(await screen.findByText('This may be a customer you already have')).toBeTruthy();
    expect(mockOutbox.submit).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'No, add a new customer' }));
    await waitFor(() => expect(mockOutbox.submit).toHaveBeenCalledTimes(3));
    expect(calls()[1][0]).toBe('customer.create');
    expect(calls()[1][1].allow_duplicate).toBe(true);
    expect(calls()[2][1].customer_id).toBe('c-new');
  });

  it('reuses the same customer when saving again', async () => {
    mockOutbox.submit
      .mockResolvedValueOnce({ queued: false, result: { id: 'c-new' } })
      .mockRejectedValueOnce(new ApiError('Check the amount', 422, 'validation_error'))
      .mockResolvedValueOnce({ queued: false, result: debt({ id: 'd9' }) });
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await pickMama();
    await fillAndRecord();
    expect(await screen.findByText('Check the amount')).toBeTruthy();
    expect(screen.queryByText('New customer · added when you save')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Record debt' }));
    await waitFor(() => expect(mockOutbox.submit).toHaveBeenCalledTimes(3));
    expect(calls()[2][0]).toBe('debt.create');
    expect(calls()[2][1].customer_id).toBe('c-new');
  });

  it('retrying after adding a new customer anyway saves only the debt', async () => {
    mockOutbox.submit
      .mockRejectedValueOnce(duplicate([{ id: 'c8', name: 'Mama Njeri Kibanda', phone: '+254700000001' }]))
      .mockResolvedValueOnce({ queued: false, result: { id: 'c-new' } })
      .mockRejectedValueOnce(new ApiError('Check the amount', 422, 'validation_error'))
      .mockResolvedValueOnce({ queued: false, result: debt({ id: 'd9' }) });
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await pickMama();
    await fillAndRecord();
    await fireEvent.press(await screen.findByRole('button', { name: 'No, add a new customer' }));
    expect(await screen.findByText('Check the amount')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Record debt' }));
    await waitFor(() => expect(mockOutbox.submit).toHaveBeenCalledTimes(4));
    expect(calls()[3][0]).toBe('debt.create');
    expect(calls()[3][1].customer_id).toBe('c-new');
  });

  it('shows the server message when the existing customer is archived', async () => {
    mockOutbox.submit
      .mockRejectedValueOnce(duplicate([{ id: 'c7', name: 'Joseph Otieno', phone: '+254712345678' }]))
      .mockRejectedValueOnce(new ApiError('Archived customers cannot receive new credit', 422, 'customer_archived'));
    await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
    await pickMama();
    await fillAndRecord();
    expect(await screen.findByText('Archived customers cannot receive new credit')).toBeTruthy();
    expect(screen.getByText('Joseph Otieno')).toBeTruthy(); // the form now shows who the debt was for
  });

  it("cashiers who can't add customers see no contacts", async () => {
    Object.assign(mockSession, { role: 'cashier', isManager: false });
    try {
      await render(wrap(<DebtFormScreen navigation={mockNav as never} route={route} />));
      await fireEvent.changeText(screen.getByLabelText('Customer'), 'njeri');
      await act(() => new Promise((r) => setTimeout(r, 400)));
      expect(screen.queryByText('From your phone')).toBeNull();
    } finally {
      Object.assign(mockSession, { role: 'owner', isManager: true });
    }
  });
});

describe('Add customer', () => {
  const MAMA = { id: '1', fullName: 'Mama Njeri Kibanda', phones: [{ id: 'p1', number: '0712 345 678' }] };
  const newRoute = { key: 'k', name: 'CustomerForm', params: undefined } as never;

  beforeEach(() => {
    (Contacts.Contact.getAllDetails as jest.Mock).mockResolvedValue([MAMA]);
    jest.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.endsWith('/settings')) return { cashier_can_register_customers: false } as never;
      return {
        id: 'c1', name: 'Achieng Atieno', phone: '+254712345678', email: null, address: null, notes: null,
        sms_opt_in: true, version: 1, status: 'active',
      } as never;
    });
  });

  it('fills the name and number from a contact', async () => {
    await render(wrap(<CustomerFormScreen navigation={mockNav as never} route={newRoute} />));
    await fireEvent.press(screen.getByRole('button', { name: 'Pick from contacts' }));
    await fireEvent.changeText(screen.getByLabelText('Search contacts'), 'njeri');
    await fireEvent.press(await screen.findByText('Mama Njeri Kibanda'));
    await fireEvent.press(screen.getByRole('button', { name: 'Use this person' }));
    expect(screen.getByLabelText('Full name or business name').props.value).toBe('Mama Njeri Kibanda');
    expect(screen.getByLabelText('Phone number').props.value).toBe('0712 345 678');
    expect(screen.queryByLabelText('Search contacts')).toBeNull();
  });

  it('is not offered when editing a customer', async () => {
    const editRoute = { key: 'k', name: 'CustomerForm', params: { customerId: 'c1' } } as never;
    await render(wrap(<CustomerFormScreen navigation={mockNav as never} route={editRoute} />));
    await waitFor(() => expect(screen.getByLabelText('Full name or business name').props.value).toBe('Achieng Atieno'));
    expect(screen.queryByRole('button', { name: 'Pick from contacts' })).toBeNull();
  });

  it("is not offered to cashiers who can't add customers", async () => {
    Object.assign(mockSession, { role: 'cashier', isManager: false });
    try {
      await render(wrap(<CustomerFormScreen navigation={mockNav as never} route={newRoute} />));
      await act(() => new Promise((r) => setTimeout(r, 100)));
      expect(screen.queryByRole('button', { name: 'Pick from contacts' })).toBeNull();
    } finally {
      Object.assign(mockSession, { role: 'owner', isManager: true });
    }
  });
});

describe('Customer M-Pesa names', () => {
  const route = { key: 'k', name: 'CustomerProfile', params: { customerId: 'c1' } } as never;
  const CUSTOMER = {
    id: 'c1', customer_number: 'C-00001', name: 'Mama Mboga', phone: '+254722000712', email: null, address: null, notes: null,
    status: 'active', sms_opt_in: true, created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', version: 1,
    outstanding_balance: '0.00', overdue_amount: '0.00', pending_verification: '0.00', open_debts: 0,
  };
  let names: { id: string; name: string; created_at: string }[] = [];

  beforeEach(() => {
    names = [{ id: 'n1', name: 'NJERI WAMBUI', created_at: '2026-11-01T08:00:00Z' }];
    jest.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.endsWith('/mpesa-names')) return names as never;
      if (path.endsWith('/debts') || path.endsWith('/payments')) return [] as never;
      return CUSTOMER as never;
    });
  });

  it('lists learned names and removes one after confirming', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const post = jest.spyOn(api, 'post').mockResolvedValue([] as never);
    await render(wrap(<CustomerProfileScreen navigation={mockNav as never} route={route} />));
    expect(await screen.findByText('NJERI WAMBUI')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove NJERI WAMBUI' }));
    const [title, message, buttons] = alert.mock.calls[0] as [string, string, { text: string; onPress?: () => void }[]];
    expect(title).toBe('Remove NJERI WAMBUI?');
    expect(message).toBe('Payments under this name will no longer suggest Mama Mboga.');
    await act(async () => buttons.find((b) => b.text === 'Remove')?.onPress?.());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toMatch(/\/customers\/c1\/mpesa-names\/n1\/remove$/);
  });

  it('explains an empty list', async () => {
    names = [];
    await render(wrap(<CustomerProfileScreen navigation={mockNav as never} route={route} />));
    expect(await screen.findByText("Learned when you match one of this customer's M-Pesa payments by hand.")).toBeTruthy();
  });

  it('is hidden from cashiers', async () => {
    Object.assign(mockSession, { role: 'cashier', isManager: false });
    try {
      await render(wrap(<CustomerProfileScreen navigation={mockNav as never} route={route} />));
      expect(await screen.findByText('C-00001', { exact: false })).toBeTruthy();
      expect(screen.queryByText('M-Pesa names')).toBeNull();
      expect((api.get as jest.Mock).mock.calls.some(([p]) => String(p).endsWith('/mpesa-names'))).toBe(false);
    } finally {
      Object.assign(mockSession, { role: 'owner', isManager: true });
    }
  });
});

describe('Dashboard', () => {
  const summary: DashboardSummary = {
    as_of: '2026-10-29', currency: 'KES', total_outstanding: '79300.00', total_overdue: '28900.00', overdue_debts: 2,
    collected_today: '12000.00', collected_this_month: '44000.00', pending_verification: '3000.00',
    pending_verification_count: 1, customers_with_balance: 4,
    due_soon: [{ debt_id: 'd1', debt_number: 'D-000002', customer_id: 'c1', customer_name: 'Mwangi Contractors', due_date: '2026-11-01', balance: '18600.00' }],
    recent_payments: [], recent_debts: [],
  };

  it('renders figures exactly as the server calculated them', async () => {
    jest.spyOn(api, 'get').mockResolvedValue(summary as never);
    await render(wrap(<DashboardScreen />));
    expect(await screen.findByText('KSh 79,300.00')).toBeTruthy();
    expect(screen.getByText('KSh 28,900')).toBeTruthy();
    expect(screen.getByText('KSh 12,000')).toBeTruthy();
    expect(screen.getByText(/1 payment awaiting verification are not yet deducted/)).toBeTruthy();
    expect(screen.getByText('Mwangi Contractors')).toBeTruthy();
    expect(screen.getByText('No payments yet')).toBeTruthy();
  });

  it('shows a retryable error when offline with nothing cached', async () => {
    const get = jest.spyOn(api, 'get').mockRejectedValue(new ApiError('No connection to the server.', 0, 'network_error'));
    await render(wrap(<DashboardScreen />));
    expect(await screen.findByText('You are offline')).toBeTruthy();
    get.mockResolvedValue(summary as never);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('KSh 79,300.00')).toBeTruthy();
  });

  it('marks data served from the offline cache', async () => {
    const get = jest.spyOn(api, 'get').mockResolvedValueOnce(summary as never);
    const first = await render(wrap(<DashboardScreen />));
    await screen.findByText('KSh 79,300.00');
    await first.unmount();
    get.mockRejectedValue(new ApiError('offline', 0, 'network_error'));
    await render(wrap(<DashboardScreen />));
    expect(await screen.findByText(/Saved copy from/)).toBeTruthy();
    expect(screen.getByText('KSh 79,300.00')).toBeTruthy();
  });
});
