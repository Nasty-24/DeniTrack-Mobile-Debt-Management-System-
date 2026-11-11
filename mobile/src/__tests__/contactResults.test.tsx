/** "From your phone": permission states, picking a contact, and the customer search around it. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Contacts from 'expo-contacts';
import type { ReactNode } from 'react';
import { AppState, Linking } from 'react-native';

import { ContactResults } from '../components/ContactResults';
import { CustomerPicker } from '../components/CustomerPicker';
import { wipeLocalData } from '../database/localDb';
import { api } from '../services/api';

jest.mock('../hooks/useSession', () => ({ useSession: () => ({ businessId: 'biz-1' }), useBusinessId: () => 'biz-1' }));
jest.mock('../hooks/useOutbox', () => ({ useOutbox: () => ({ ops: [] }) }));

const permissions = Contacts.getPermissionsAsync as jest.Mock;
const request = Contacts.requestPermissionsAsync as jest.Mock;
const getAllDetails = Contacts.Contact.getAllDetails as jest.Mock;
const NONE = new Set<string>();
const MAMA = { id: '1', fullName: 'Mama Njeri Kibanda', phones: [{ id: 'p1', number: '0712 345 678' }] };
const access = (status: string) => ({ status, granted: status === 'granted', canAskAgain: true, expires: 'never' });

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await wipeLocalData();
  permissions.mockReset().mockResolvedValue(access('granted'));
  request.mockReset().mockResolvedValue(access('granted'));
  getAllDetails.mockReset().mockResolvedValue([MAMA]);
});

describe('ContactResults', () => {
  it('offers to search contacts before permission is given', async () => {
    permissions.mockResolvedValue(access('undetermined'));
    await render(<ContactResults query="njeri" knownPhones={NONE} onPick={jest.fn()} />);
    await fireEvent.press(await screen.findByRole('button', { name: "Search your phone's contacts" }));
    expect(request).toHaveBeenCalled();
    expect(await screen.findByText('Mama Njeri Kibanda')).toBeTruthy();
  });

  it('explains when contacts are off', async () => {
    permissions.mockResolvedValue(access('denied'));
    const settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await render(<ContactResults query="njeri" knownPhones={NONE} onPick={jest.fn()} />);
    expect(await screen.findByText('Contacts are off for DeniTrack.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Open settings' }));
    expect(settings).toHaveBeenCalled();
    expect(getAllDetails).not.toHaveBeenCalled();
  });

  it('notices when contacts are allowed in Settings', async () => {
    const listeners: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, cb: (state: string) => void) => {
      listeners.push(cb);
      return { remove: jest.fn() };
    }) as never);
    permissions.mockResolvedValue(access('denied'));
    await render(<ContactResults query="njeri" knownPhones={NONE} onPick={jest.fn()} />);
    expect(await screen.findByText('Contacts are off for DeniTrack.')).toBeTruthy();
    permissions.mockResolvedValue(access('granted'));
    await act(async () => listeners.forEach((cb) => cb('active'))); // back from Settings
    expect(await screen.findByText('Mama Njeri Kibanda')).toBeTruthy();
  });

  it('picks a contact and lets the name be edited', async () => {
    const onPick = jest.fn();
    await render(<ContactResults query="njeri" knownPhones={NONE} onPick={onPick} />);
    await fireEvent.press(await screen.findByText('Mama Njeri Kibanda'));
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Mama Njeri');
    await fireEvent.press(screen.getByRole('button', { name: 'Use this person' }));
    expect(onPick).toHaveBeenCalledWith({ kind: 'new', name: 'Mama Njeri', phone: '+254712345678', key: expect.any(String) });
  });

  it('cannot pick a landline', async () => {
    getAllDetails.mockResolvedValue([
      { id: '6', fullName: 'Duka Kubwa', phones: [{ id: 'a', number: '020 222 3333' }, { id: 'b', number: '0712 345 678' }] },
    ]);
    await render(<ContactResults query="duka" knownPhones={NONE} onPick={jest.fn()} />);
    await fireEvent.press(await screen.findByText('Duka Kubwa'));
    expect(screen.getByRole('radio', { name: '020 222 3333' }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText('Not a mobile number')).toBeTruthy();
    expect(screen.getByRole('radio', { name: '0712 345 678' }).props.accessibilityState).toMatchObject({ checked: true });
  });

  it('shows nothing for a one-letter search', async () => {
    await render(<ContactResults query="n" knownPhones={NONE} onPick={jest.fn()} />);
    expect(screen.queryByText('From your phone')).toBeNull();
  });
});

describe('CustomerPicker with contacts', () => {
  const page = {
    items: [{ id: 'c1', name: 'Achieng Atieno', customer_number: 'C-00001', phone: '+254700000001', outstanding_balance: '0.00' }],
    total: 1,
    limit: 200,
    offset: 0,
  };

  async function search(text: string) {
    await fireEvent.changeText(screen.getByLabelText('Customer'), text);
    await act(() => new Promise((r) => setTimeout(r, 400))); // the search waits for typing to pause
  }

  it("keeps working when contacts can't be read", async () => {
    jest.spyOn(api, 'get').mockResolvedValue(page);
    getAllDetails.mockRejectedValue(new Error('no access'));
    await render(wrap(<CustomerPicker value={null} onChange={jest.fn()} onPickNew={jest.fn()} />));
    await search('ach');
    expect(await screen.findByText("Couldn't read your contacts.")).toBeTruthy();
    expect(screen.getByText('Achieng Atieno')).toBeTruthy();
  });

  it('shows no contacts unless allowed', async () => {
    jest.spyOn(api, 'get').mockResolvedValue(page);
    await render(wrap(<CustomerPicker value={null} onChange={jest.fn()} />));
    await search('njeri');
    expect(screen.queryByText('From your phone')).toBeNull();
    expect(getAllDetails).not.toHaveBeenCalled();
  });

  it('shows a picked contact as a new customer', async () => {
    await render(
      wrap(<CustomerPicker value={{ kind: 'new', name: 'Mama Njeri', phone: '+254712345678', key: 'k1' }} onChange={jest.fn()} />),
    );
    expect(screen.getByText('Mama Njeri')).toBeTruthy();
    expect(screen.getByText('0712 345 678')).toBeTruthy();
    expect(screen.getByText('New customer · added when you save')).toBeTruthy();
  });
});
