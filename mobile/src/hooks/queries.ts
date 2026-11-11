import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';

import { readCache, writeCache } from '../database/localDb';
import { api } from '../services/api';
import { ApiError, type RequestOptions } from '../services/apiClient';
import type {
  AppNotification,
  AuditEntry,
  Business,
  BusinessSettings,
  Customer,
  DashboardSummary,
  Debt,
  DebtDetail,
  MpesaName,
  MpesaSms,
  Page,
  Payment,
  Receipt,
  Reminder,
  ReminderTemplate,
  Staff,
} from '../types/api';
import { useBusinessId } from './useSession';

/** Server data plus where it came from. `fromCache` data is never presented as live. */
export interface Fetched<T> {
  data: T;
  fromCache: boolean;
  savedAt: number;
}

export function bizPath(businessId: string, path: string): string {
  return `/api/v1/businesses/${businessId}${path}`;
}

/**
 * GET with offline fallback: successful responses are saved to the encrypted local
 * cache; if the network is unreachable the last saved copy is returned, flagged.
 */
export async function fetchWithCache<T>(
  businessId: string,
  path: string,
  query?: RequestOptions['query'],
  cacheable = true,
): Promise<Fetched<T>> {
  const cacheKey = `${businessId}:${path}:${JSON.stringify(query ?? {})}`;
  try {
    const data = await api.get<T>(bizPath(businessId, path), { query });
    if (cacheable) await writeCache(cacheKey, businessId, data).catch(() => undefined);
    return { data, fromCache: false, savedAt: Date.now() };
  } catch (e) {
    if (cacheable && e instanceof ApiError && e.isNetwork) {
      const cached = await readCache<T>(cacheKey).catch(() => null);
      if (cached) return { data: cached.body, fromCache: true, savedAt: cached.savedAt };
    }
    throw e;
  }
}

function useBizQuery<T>(key: QueryKey, path: string, query?: RequestOptions['query'], opts: { enabled?: boolean; cacheable?: boolean } = {}) {
  const businessId = useBusinessId();
  return useQuery({
    queryKey: [businessId, ...key, query ?? {}],
    queryFn: () => fetchWithCache<T>(businessId, path, query, opts.cacheable ?? true),
    enabled: opts.enabled ?? true,
  });
}

export const useDashboard = () => useBizQuery<DashboardSummary>(['dashboard'], '/dashboard');
export const useBusiness = () => useBizQuery<Business>(['business'], '');
export const useSettings = () => useBizQuery<BusinessSettings>(['settings'], '/settings');

export const useCustomers = (params: { q?: string; balance?: string; sort?: string; status?: string }) =>
  useBizQuery<Page<Customer>>(['customers'], '/customers', { limit: 200, ...params });
export const useCustomer = (id: string, enabled = true) =>
  useBizQuery<Customer>(['customer', id], `/customers/${id}`, undefined, { enabled: enabled && !!id });
export const useCustomerDebts = (id: string, enabled = true) =>
  useBizQuery<Debt[]>(['customer', id, 'debts'], `/customers/${id}/debts`, undefined, { enabled: enabled && !!id });
export const useCustomerMpesaNames = (id: string, enabled = true) =>
  useBizQuery<MpesaName[]>(['customer', id, 'mpesa-names'], `/customers/${id}/mpesa-names`, undefined, { enabled: enabled && !!id });
export const useCustomerPayments = (id: string) =>
  useBizQuery<Payment[]>(['customer', id, 'payments'], `/customers/${id}/payments`);

export const useDebts = (params: { status?: string; due_within_days?: number; sort?: string; q?: string; customer_id?: string }) =>
  useBizQuery<Page<Debt>>(['debts'], '/debts', { limit: 200, ...params });
export const useDebt = (id: string) => useBizQuery<DebtDetail>(['debt', id], `/debts/${id}`);

export const usePayments = (params: Record<string, string | undefined>) =>
  useBizQuery<Page<Payment>>(['payments'], '/payments', { limit: 100, ...params });
export const usePayment = (id: string) => useBizQuery<Payment>(['payment', id], `/payments/${id}`);
export const useReceipt = (paymentId: string) =>
  useBizQuery<Receipt>(['receipt', paymentId], `/payments/${paymentId}/receipt`);

export const useReminders = (params: Record<string, string | undefined>) =>
  useBizQuery<Page<Reminder>>(['reminders'], '/reminders', params);
export const useMpesaMessages = (status?: string) =>
  useBizQuery<Page<MpesaSms>>(['mpesa-sms'], '/mpesa-sms', { limit: 100, status }, { cacheable: false });
export const useTemplates = () => useBizQuery<ReminderTemplate[]>(['templates'], '/reminder-templates');
export const useNotifications = () => useBizQuery<Page<AppNotification>>(['notifications'], '/notifications');
export const useAuditLog = (params: Record<string, string | undefined>) =>
  useBizQuery<Page<AuditEntry>>(['audit'], '/audit-logs', { limit: 100, ...params }, { cacheable: false });
export const useStaff = (enabled: boolean) => useBizQuery<Staff[]>(['staff'], '/staff', undefined, { enabled });
export function useReport<T>(name: string, params: Record<string, string | undefined>, enabled = true) {
  return useBizQuery<T>(['report', name], `/reports/${name}`, params, { enabled });
}

/** Mutation helper for online-only actions (verification, reversal, settings...). */
export function useBizMutation<TBody, TResult>(
  method: 'post' | 'patch' | 'put',
  pathFor: (body: TBody) => string,
) {
  const businessId = useBusinessId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: TBody & { __key?: string }) => {
      const { __key, ...rest } = body as TBody & { __key?: string };
      const path = bizPath(businessId, pathFor(body));
      const options = __key ? { idempotencyKey: __key } : undefined;
      return api[method]<TResult>(path, rest, options);
    },
    onSuccess: async () => {
      // Financial data is interrelated: refresh everything for this business.
      await qc.invalidateQueries({ queryKey: [businessId] });
    },
  });
}
