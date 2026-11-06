/** Shapes returned by the DeniTrack API (backend/app/schemas). Money fields are decimal strings. */

export type Money = string;
export type Role = 'owner' | 'admin' | 'cashier';
export type DebtStatus = 'open' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled' | 'disputed';
export type PaymentMethod = 'cash' | 'mpesa' | 'bank_transfer' | 'card' | 'other';
export type VerificationStatus = 'not_required' | 'pending' | 'verified' | 'rejected';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  must_change_password: boolean;
}

export interface Membership {
  business_id: string;
  business_name: string;
  role: Role;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
  memberships: Membership[];
}

export interface Business {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  currency: string;
  timezone: string;
}

export interface BusinessSettings {
  reminder_offsets: number[];
  reminder_channels: string[];
  reminders_enabled: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  max_reminders_per_customer_per_week: number;
  cashier_can_register_customers: boolean;
  cashier_can_view_reports: boolean;
  payment_methods: PaymentMethod[];
  receipt_footer: string | null;
  /** 'phone': reminder SMS go from the owner's phone; 'provider': from the SMS gateway. */
  sms_sender: 'phone' | 'provider';
}

export interface Customer {
  id: string;
  customer_number: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  status: 'active' | 'archived';
  sms_opt_in: boolean;
  created_at: string;
  updated_at: string;
  version: number;
  outstanding_balance: Money;
  overdue_amount: Money;
  pending_verification: Money;
  open_debts: number;
}

export interface Installment {
  number: number;
  due_date: string;
  amount: Money;
  covered: Money;
  status: 'paid' | 'partially_paid' | 'due' | 'overdue';
}

export interface Debt {
  id: string;
  debt_number: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  description: string;
  currency: string;
  principal: Money;
  adjustments_total: Money;
  total_due: Money;
  paid: Money;
  pending_verification: Money;
  balance: Money;
  overdue_amount: Money;
  status: DebtStatus;
  days_overdue: number;
  incurred_on: string;
  due_date: string;
  next_due_date: string | null;
  terms: string | null;
  reference: string | null;
  flag_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number;
  schedule: Installment[];
}

export interface Adjustment {
  id: string;
  amount: Money;
  reason: string;
  created_by: string;
  created_at: string;
}

export interface Payment {
  id: string;
  customer_id: string;
  customer_name: string;
  amount: Money;
  currency: string;
  method: PaymentMethod;
  paid_at: string;
  external_reference: string | null;
  verification_status: VerificationStatus;
  status: 'posted' | 'reversed';
  receipt_number: string | null;
  notes: string | null;
  recorded_by: string;
  recorded_by_name: string | null;
  reversal_reason: string | null;
  reversed_at: string | null;
  created_at: string;
  allocations: { debt_id: string; amount: Money }[];
}

export interface DebtDetail extends Debt {
  adjustments: Adjustment[];
  payments: Payment[];
}

export interface Receipt {
  receipt_number: string;
  issued_at: string;
  payment_id: string;
  payment_status: 'posted' | 'reversed';
  share_text: string;
  snapshot: {
    business: { name: string; phone: string | null; address: string | null };
    customer: { name: string; number: string; phone: string };
    amount: Money;
    currency: string;
    method: PaymentMethod;
    external_reference: string | null;
    paid_at: string;
    recorded_by: string | null;
    allocations: { debt_number: string; description: string; amount: Money; balance_after: Money }[];
  };
}

export interface DashboardSummary {
  as_of: string;
  currency: string;
  total_outstanding: Money;
  total_overdue: Money;
  overdue_debts: number;
  collected_today: Money;
  collected_this_month: Money;
  pending_verification: Money;
  pending_verification_count: number;
  customers_with_balance: number;
  due_soon: {
    debt_id: string;
    debt_number: string;
    customer_id: string;
    customer_name: string;
    due_date: string;
    balance: Money;
  }[];
  recent_payments: {
    id: string;
    customer_id: string;
    customer_name: string;
    amount: Money;
    method: PaymentMethod;
    paid_at: string;
    receipt_number: string | null;
    verification_status: VerificationStatus;
    status: 'posted' | 'reversed';
  }[];
  recent_debts: {
    id: string;
    debt_number: string;
    customer_id: string;
    customer_name: string;
    principal: Money;
    description: string;
    created_at: string;
  }[];
}

export type MpesaSmsStatus = 'applied' | 'confirmed' | 'already_recorded' | 'needs_review' | 'dismissed';

/** An M-Pesa "you have received" SMS read on the owner's phone, and what was done with it. */
export interface MpesaSms {
  id: string;
  transaction_code: string;
  amount: string;
  payer_name: string;
  payer_phone: string | null;
  received_at: string;
  status: MpesaSmsStatus;
  detail: string | null;
  customer_id: string | null;
  customer_name: string | null;
  suggested_customer_id: string | null;
  suggested_customer_name: string | null;
  payment_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface Reminder {
  id: string;
  debt_id: string;
  customer_id: string;
  channel: 'in_app' | 'push' | 'sms' | 'whatsapp';
  target_date: string;
  offset_days: number;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  message: string | null;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface ReminderTemplate {
  kind: 'upcoming' | 'due_today' | 'overdue';
  body: string;
}

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

export interface Staff {
  membership_id: string;
  user_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: Role;
  is_active: boolean;
}

export interface PaymentRequest {
  id: string;
  debt_id: string;
  amount: Money;
  phone: string;
  provider: string;
  provider_mode: 'mock' | 'sandbox' | 'production';
  status: 'pending' | 'succeeded' | 'failed' | 'needs_review';
  failure_reason: string | null;
  payment_id: string | null;
  created_at: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details: unknown };
}
