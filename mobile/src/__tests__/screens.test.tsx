/** Screen-level tests: forms, payment confirmation, offline queueing, dashboard figures. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { wipeLocalData } from '../database/localDb';
import { DashboardScreen } from '../screens/DashboardScreen';
import { RecordPaymentScreen } from '../screens/PaymentScreens';
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
