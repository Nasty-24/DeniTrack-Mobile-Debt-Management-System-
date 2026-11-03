/**
 * Form validation. These mirror the server's rules for fast feedback; the server
 * re-validates everything and remains authoritative.
 */
import { z } from 'zod';

import { isValidISODate } from '../utils/dates';
import { compare, isValidAmountInput, parseAmountInput } from '../utils/money';
import { normalizeKenyanPhone } from '../utils/phone';

const amount = z
  .string()
  .trim()
  .min(1, 'Enter an amount')
  .refine(isValidAmountInput, 'Enter an amount like 1500 or 1500.50')
  .refine((v) => !isValidAmountInput(v) || compare(parseAmountInput(v), '0.00') > 0, 'Amount must be more than zero');

const phone = z
  .string()
  .trim()
  .min(1, 'Enter a phone number')
  .refine((v) => normalizeKenyanPhone(v) !== null, 'Enter a valid phone number, e.g. 0712 345 678');

const isoDate = z.string().trim().refine(isValidISODate, 'Use the format YYYY-MM-DD');
const email = z.string().trim().toLowerCase().email('Enter a valid email address');
const optionalText = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters`);

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password'),
});

export const strongPassword = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Include at least one letter and one number');

export const registerSchema = z
  .object({
    full_name: z.string().trim().min(2, 'Enter your name'),
    business_name: z.string().trim().min(2, 'Enter your business name'),
    email,
    phone,
    password: strongPassword,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

export const resetRequestSchema = z.object({ email });

export const resetConfirmSchema = z
  .object({
    token: z.string().trim().min(10, 'Paste the full reset code'),
    new_password: strongPassword,
    confirm: z.string(),
  })
  .refine((v) => v.new_password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, 'Enter your current password'),
    new_password: strongPassword,
    confirm: z.string(),
  })
  .refine((v) => v.new_password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

export const customerSchema = z.object({
  name: z.string().trim().min(2, 'Enter the customer or business name').max(160),
  phone,
  email: z.union([z.literal(''), email]),
  address: optionalText(300),
  notes: optionalText(1000),
  sms_opt_in: z.boolean(),
});

export const debtSchema = z
  .object({
    customer_id: z.string().min(1, 'Choose a customer'),
    description: z.string().trim().min(2, 'Describe the goods or service').max(500),
    principal: amount,
    incurred_on: isoDate,
    due_date: isoDate,
    terms: optionalText(500),
    reference: optionalText(64),
    use_installments: z.boolean(),
    installment_count: z.string().trim(),
    installment_frequency: z.enum(['weekly', 'monthly']),
    first_due_date: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    if (isValidISODate(v.incurred_on) && isValidISODate(v.due_date) && v.due_date < v.incurred_on) {
      ctx.addIssue({ code: 'custom', path: ['due_date'], message: 'Due date cannot be before the debt was incurred' });
    }
    if (v.use_installments) {
      const n = Number(v.installment_count);
      if (!Number.isInteger(n) || n < 2 || n > 60) {
        ctx.addIssue({ code: 'custom', path: ['installment_count'], message: 'Choose between 2 and 60 installments' });
      }
      if (!isValidISODate(v.first_due_date)) {
        ctx.addIssue({ code: 'custom', path: ['first_due_date'], message: 'Use the format YYYY-MM-DD' });
      } else if (isValidISODate(v.incurred_on) && v.first_due_date < v.incurred_on) {
        ctx.addIssue({ code: 'custom', path: ['first_due_date'], message: 'First installment cannot be before the debt' });
      }
    }
  });

export const paymentMethods = ['cash', 'mpesa', 'bank_transfer', 'card', 'other'] as const;

export const paymentSchema = z
  .object({
    customer_id: z.string().min(1, 'Choose a customer'),
    amount,
    method: z.enum(paymentMethods),
    external_reference: z.string().trim().toUpperCase(),
    notes: optionalText(500),
    debt_id: z.string(), // '' = settle oldest debts first
  })
  .superRefine((v, ctx) => {
    if (v.method === 'mpesa' && !/^[A-Z0-9]{10}$/.test(v.external_reference)) {
      ctx.addIssue({
        code: 'custom',
        path: ['external_reference'],
        message: 'Enter the 10-character M-Pesa code from the confirmation SMS',
      });
    }
    if (v.method === 'bank_transfer' && v.external_reference.length < 4) {
      ctx.addIssue({ code: 'custom', path: ['external_reference'], message: 'Enter the bank transaction reference' });
    }
  });

/** Extra rule that needs the live balance: refuses overpayment before submitting. */
export function checkNotOverpaying(amountInput: string, payable: string): string | null {
  if (!isValidAmountInput(amountInput)) return null;
  return compare(parseAmountInput(amountInput), payable) > 0
    ? 'This is more than the customer owes. Overpayments are not accepted.'
    : null;
}

export const staffSchema = z.object({
  full_name: z.string().trim().min(2, 'Enter their name'),
  email,
  phone: z.union([z.literal(''), phone]),
  role: z.enum(['admin', 'cashier']),
  temporary_password: strongPassword,
});

export const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Give a short reason (at least 5 characters)') });

export const templateSchema = z.object({
  body: z
    .string()
    .trim()
    .min(20, 'Template is too short')
    .max(480, 'Keep the message under 480 characters')
    .refine((v) => v.includes('{amount}'), 'The message must include {amount}'),
});

export type LoginForm = z.infer<typeof loginSchema>;
export type RegisterForm = z.infer<typeof registerSchema>;
export type CustomerForm = z.infer<typeof customerSchema>;
export type DebtForm = z.infer<typeof debtSchema>;
export type PaymentForm = z.infer<typeof paymentSchema>;
export type StaffForm = z.infer<typeof staffSchema>;
