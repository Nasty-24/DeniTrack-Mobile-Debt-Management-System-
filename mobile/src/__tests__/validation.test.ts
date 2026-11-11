import { checkNotOverpaying, customerSchema, debtSchema, paymentSchema, registerSchema, staffSchema, templateSchema } from '../validation/schemas';

const errorsOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('payment form', () => {
  const base = { customer_id: 'c1', amount: '500', method: 'cash' as const, external_reference: '', notes: '', debt_id: '' };

  it('accepts a cash payment', () => {
    expect(paymentSchema.safeParse(base).success).toBe(true);
  });

  it.each([['0'], ['-10'], ['abc'], [''], ['10.555']])('rejects amount %p', (amount) => {
    const r = paymentSchema.safeParse({ ...base, amount });
    expect(r.success).toBe(false);
    expect(errorsOf(r).amount).toBeDefined();
  });

  it('requires a valid 10-character M-Pesa code, uppercasing it', () => {
    expect(errorsOf(paymentSchema.safeParse({ ...base, method: 'mpesa' })).external_reference).toMatch(/M-Pesa code/);
    expect(paymentSchema.safeParse({ ...base, method: 'mpesa', external_reference: 'SLK4H7R2Q' }).success).toBe(false);
    const ok = paymentSchema.safeParse({ ...base, method: 'mpesa', external_reference: 'slk4h7r2qx' });
    expect(ok.success && ok.data.external_reference).toBe('SLK4H7R2QX');
  });

  it('refuses overpayment before submitting', () => {
    expect(checkNotOverpaying('1000.01', '1000.00')).toMatch(/more than the customer owes/);
    expect(checkNotOverpaying('1000', '1000.00')).toBeNull();
    expect(checkNotOverpaying('0.01', '0.00')).not.toBeNull();
  });
});

describe('debt form', () => {
  const base = {
    customer_id: 'c1',
    description: 'Cement 20 bags',
    principal: '12500',
    incurred_on: '2026-10-01',
    due_date: '2026-10-31',
    terms: '',
    reference: '',
    use_installments: false,
    installment_count: '3',
    installment_frequency: 'monthly' as const,
    first_due_date: '2026-11-01',
    notify_customer: true,
  };

  it('accepts a simple debt', () => expect(debtSchema.safeParse(base).success).toBe(true));

  it('rejects a due date before the sale', () => {
    expect(errorsOf(debtSchema.safeParse({ ...base, due_date: '2026-09-30' })).due_date).toMatch(/before/);
  });

  it('validates installment plans', () => {
    const r = debtSchema.safeParse({ ...base, use_installments: true, installment_count: '1', first_due_date: '2026-09-01' });
    const e = errorsOf(r);
    expect(e.installment_count).toBeDefined();
    expect(e.first_due_date).toMatch(/before the debt/);
  });

  it('requires a customer and a real date', () => {
    const e = errorsOf(debtSchema.safeParse({ ...base, customer_id: '', incurred_on: '2026-02-30' }));
    expect(e.customer_id).toBeDefined();
    expect(e.incurred_on).toBeDefined();
  });
});

describe('customer, account and template forms', () => {
  it('validates Kenyan phone numbers', () => {
    const base = { name: 'Achieng Atieno', phone: '0712345678', email: '', address: '', notes: '', sms_opt_in: true };
    expect(customerSchema.safeParse(base).success).toBe(true);
    expect(errorsOf(customerSchema.safeParse({ ...base, phone: '12345' })).phone).toBeDefined();
    expect(errorsOf(customerSchema.safeParse({ ...base, email: 'not-an-email' })).email).toBeDefined();
  });

  it('enforces strong, matching passwords', () => {
    const base = { full_name: 'Wanjiru', business_name: 'Duka', email: 'a@example.com', phone: '0712345678' };
    expect(errorsOf(registerSchema.safeParse({ ...base, password: 'short', confirm: 'short' })).password).toBeDefined();
    expect(errorsOf(registerSchema.safeParse({ ...base, password: 'onlyletters', confirm: 'onlyletters' })).password).toBeDefined();
    expect(errorsOf(registerSchema.safeParse({ ...base, password: 'Correct-Horse-9', confirm: 'Correct-Horse-8' })).confirm).toMatch(/match/);
    expect(registerSchema.safeParse({ ...base, password: 'Correct-Horse-9', confirm: 'Correct-Horse-9' }).success).toBe(true);
  });

  it('only allows admin or cashier roles for staff', () => {
    const r = staffSchema.safeParse({ full_name: 'Otieno', email: 'o@example.com', phone: '', role: 'owner', temporary_password: 'Temporary-1x' });
    expect(errorsOf(r).role).toBeDefined();
  });

  it('requires {amount} in reminder templates', () => {
    expect(templateSchema.safeParse({ body: 'Hello {customer_name}, please pay soon. Thank you.' }).success).toBe(false);
    expect(templateSchema.safeParse({ body: 'Hello {customer_name}, your balance is KSh {amount}.' }).success).toBe(true);
  });
});
