import { fireEvent, render, screen } from '@testing-library/react-native';

import { DebtStatusBadge, MoneyText, VerificationBadge } from '../components/finance';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { Button, SegmentedControl, TextField } from '../components/ui';
import { ApiError } from '../services/apiClient';

describe('shared states', () => {
  it('announces loading', async () => {
    await render(<LoadingState label="Loading your figures…" />);
    expect(screen.getByLabelText('Loading your figures…')).toBeTruthy();
  });

  it('shows an empty state with an action', async () => {
    const onPress = jest.fn();
    await render(<EmptyState title="No customers yet" body="Add the people you sell to on credit." action={<Button title="Add customer" onPress={onPress} />} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Add customer' }));
    expect(onPress).toHaveBeenCalled();
  });

  it('distinguishes offline from other errors and offers retry', async () => {
    const retry = jest.fn();
    await render(<ErrorState error={new ApiError('No connection to the server.', 0, 'network_error')} onRetry={retry} />);
    expect(screen.getByText('You are offline')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows the server message for other errors', async () => {
    await render(<ErrorState error={new ApiError('Business not found', 404, 'not_found')} />);
    expect(screen.getByText('Could not load this')).toBeTruthy();
    expect(screen.getByText('Business not found')).toBeTruthy();
  });
});

describe('accessibility', () => {
  it('buttons expose role, label and busy/disabled state', async () => {
    const onPress = jest.fn();
    await render(<Button title="Save" onPress={onPress} loading />);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    await fireEvent.press(btn);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('text fields are labelled and expose their error', async () => {
    await render(<TextField label="Phone number" value="" error="Enter a valid phone number" />);
    const input = screen.getByLabelText('Phone number');
    expect(input.props.accessibilityHint).toBe('Enter a valid phone number');
    expect(screen.getByText('Enter a valid phone number')).toBeTruthy();
  });

  it('money is read out in words', async () => {
    await render(<MoneyText amount="1500.50" />);
    expect(screen.getByText('KSh 1,500.50')).toBeTruthy();
    expect(screen.getByLabelText('1,500 shillings and 50 cents')).toBeTruthy();
  });

  it('segmented control reports the selected option', async () => {
    const onChange = jest.fn();
    await render(<SegmentedControl label="Filter" value="all" onChange={onChange} options={[{ value: 'all', label: 'All' }, { value: 'overdue', label: 'Overdue' }]} />);
    expect(screen.getByRole('radio', { name: 'All' }).props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.press(screen.getByRole('radio', { name: 'Overdue' }));
    expect(onChange).toHaveBeenCalledWith('overdue');
  });
});

describe('status badges', () => {
  it('never shows a paid debt as overdue', async () => {
    await render(<DebtStatusBadge status="paid" dueSoon />);
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.queryByText('Overdue')).toBeNull();
  });

  it('flags upcoming open debts', async () => {
    await render(<DebtStatusBadge status="open" dueSoon />);
    expect(screen.getByText('Due soon')).toBeTruthy();
  });

  it('labels pending and reversed payments clearly', async () => {
    await render(<VerificationBadge status="pending" />);
    expect(screen.getByText('Awaiting verification')).toBeTruthy();
    await render(<VerificationBadge status="verified" reversed />);
    expect(screen.getByText('Reversed')).toBeTruthy();
  });
});
