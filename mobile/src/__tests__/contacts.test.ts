/** Reading and searching the phone book: names, numbers in any format, and what is left out. */
import * as Contacts from 'expo-contacts';

import { getContactsAccess, loadPhoneBook, searchPhoneBook, type PhoneBookEntry } from '../services/contacts';

const mocked = Contacts as jest.Mocked<typeof Contacts>;
const getAllDetails = Contacts.Contact.getAllDetails as jest.Mock;

const RAW = [
  { id: '1', fullName: 'Mama Njeri Kibanda', phones: [{ id: 'p1', number: '0712 345 678' }] },
  { id: '2', fullName: 'Office', phones: [{ id: 'p2', number: '020 222 3333' }] },
  { id: '3', fullName: 'Uncle Tom', phones: [{ id: 'p3', number: '+44 7911 123456' }] },
  { id: '4', fullName: '  ', phones: [{ id: 'p4', number: '0733 000 111' }] },
  { id: '5', fullName: 'No Number', phones: [] },
];

async function book(): Promise<PhoneBookEntry[]> {
  getAllDetails.mockResolvedValueOnce(RAW);
  return loadPhoneBook();
}

const NONE = new Set<string>();
const names = (entries: PhoneBookEntry[]) => entries.map((e) => e.name);

beforeEach(() => jest.clearAllMocks());

describe('phone book', () => {
  it('finds contacts by name, ignoring case', async () => {
    expect(names(searchPhoneBook(await book(), 'njeri', NONE))).toEqual(['Mama Njeri Kibanda']);
  });

  it('finds contacts by number in any format', async () => {
    const b = await book();
    for (const q of ['0712345', '254712345', '+254 712 345', '(0712) 345', '712-345']) {
      expect(names(searchPhoneBook(b, q, NONE))).toEqual(['Mama Njeri Kibanda']);
    }
  });

  it('leaves out contacts who are already customers', async () => {
    expect(searchPhoneBook(await book(), 'njeri', new Set(['+254712345678']))).toEqual([]);
  });

  it("marks numbers the app can't use", async () => {
    const b = await book();
    expect(b.find((e) => e.name === 'Office')?.numbers[0].e164).toBeNull();
    expect(b.find((e) => e.name === 'Uncle Tom')?.numbers[0].e164).toBe('+447911123456');
    expect(b.find((e) => e.id === '1')?.numbers[0]).toEqual({ raw: '0712 345 678', e164: '+254712345678' });
  });

  it('names a contact saved with only a number by that number', async () => {
    expect((await book()).find((e) => e.id === '4')?.name).toBe('0733 000 111');
  });

  it('drops contacts without numbers', async () => {
    expect((await book()).find((e) => e.id === '5')).toBeUndefined();
  });

  it('asks only for names and numbers', async () => {
    await book();
    expect(getAllDetails).toHaveBeenCalledWith(['fullName', 'phones']);
  });

  it('ignores one-letter searches', async () => {
    expect(searchPhoneBook(await book(), 'n', NONE)).toEqual([]);
  });

  it('returns at most 20 matches', () => {
    const big: PhoneBookEntry[] = Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      name: `Njeri ${i}`,
      numbers: [{ raw: `07${String(i).padStart(8, '0')}`, e164: `+2547${String(i).padStart(8, '0')}` }],
    }));
    expect(searchPhoneBook(big, 'njeri', NONE)).toHaveLength(20);
  });

  it('maps permission answers', async () => {
    for (const status of ['granted', 'undetermined', 'denied'] as const) {
      mocked.getPermissionsAsync.mockResolvedValueOnce({ status, granted: status === 'granted', canAskAgain: true, expires: 'never' } as never);
      expect(await getContactsAccess()).toBe(status);
    }
  });
});
