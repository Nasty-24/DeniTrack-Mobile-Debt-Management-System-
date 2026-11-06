import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type AuthStackParamList = {
  Onboarding: undefined;
  SignIn: undefined;
  Register: undefined;
  ForgotPassword: undefined;
};

export type TabParamList = {
  Home: undefined;
  Customers: undefined;
  Debts: undefined;
  Payments: undefined;
  More: undefined;
};

export type AppStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  CustomerProfile: { customerId: string };
  CustomerForm: { customerId?: string } | undefined;
  DebtForm: { customerId?: string; customerName?: string } | undefined;
  DebtDetail: { debtId: string };
  RecordPayment: { customerId?: string; debtId?: string } | undefined;
  PaymentDetail: { paymentId: string };
  Receipt: { paymentId: string };
  OverdueDebts: undefined;
  UpcomingPayments: undefined;
  Reminders: undefined;
  Reports: undefined;
  Staff: undefined;
  Notifications: undefined;
  AuditLog: undefined;
  Settings: undefined;
  BusinessSetup: undefined;
  ChangePassword: { forced?: boolean } | undefined;
  SyncQueue: undefined;
  MpesaMessages: undefined;
};

export type AppScreenProps<T extends keyof AppStackParamList> = NativeStackScreenProps<AppStackParamList, T>;
export type AuthScreenProps<T extends keyof AuthStackParamList> = NativeStackScreenProps<AuthStackParamList, T>;

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends AppStackParamList {}
  }
}
