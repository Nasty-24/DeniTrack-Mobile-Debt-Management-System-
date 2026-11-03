import Feather from '@expo/vector-icons/Feather';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DarkTheme, DefaultTheme, NavigationContainer, type NavigationState, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';

import { LoadingState } from '../components/states';
import { getMeta } from '../database/localDb';
import { useSession } from '../hooks/useSession';
import {
  AuditLogScreen,
  BusinessSetupScreen,
  ChangePasswordScreen,
  MoreScreen,
  NotificationsScreen,
  RemindersScreen,
  SettingsScreen,
  StaffScreen,
  SyncQueueScreen,
} from '../screens/AdminScreens';
import { ForgotPasswordScreen, OnboardingScreen, RegisterScreen, SignInScreen } from '../screens/auth/AuthScreens';
import { CustomerFormScreen, CustomerListScreen, CustomerProfileScreen } from '../screens/CustomerScreens';
import { DashboardScreen } from '../screens/DashboardScreen';
import { DebtDetailScreen, DebtFormScreen, DebtsTabScreen, OverdueDebtsScreen, UpcomingPaymentsScreen } from '../screens/DebtScreens';
import { PaymentDetailScreen, PaymentsTabScreen, ReceiptScreen, RecordPaymentScreen } from '../screens/PaymentScreens';
import { ReportsScreen } from '../screens/ReportsScreen';
import { useTheme, type Scheme } from '../theme/ThemeProvider';
import { colors } from '../theme/tokens';
import type { AppStackParamList, AuthStackParamList, TabParamList } from './types';

function navTheme(scheme: Scheme): Theme {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.brand,
      background: colors.canvas,
      card: colors.surface,
      text: colors.ink,
      border: colors.border,
      notification: colors.danger,
    },
  };
}

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const AppStack = createNativeStackNavigator<AppStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

const TAB_ICONS: Record<keyof TabParamList, keyof typeof Feather.glyphMap> = {
  Home: 'home',
  Customers: 'users',
  Debts: 'file-text',
  Payments: 'credit-card',
  More: 'menu',
};

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.inkMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarIcon: ({ color, size }) => <Feather name={TAB_ICONS[route.name]} color={color} size={size - 2} />,
      })}
    >
      <Tab.Screen name="Home" component={DashboardScreen} />
      <Tab.Screen name="Customers" component={CustomerListScreen} />
      <Tab.Screen name="Debts" component={DebtsTabScreen} />
      <Tab.Screen name="Payments" component={PaymentsTabScreen} />
      <Tab.Screen name="More" component={MoreScreen} />
    </Tab.Navigator>
  );
}

function AuthFlow() {
  const [initial, setInitial] = useState<keyof AuthStackParamList | null>(null);
  useEffect(() => {
    getMeta('onboarding_seen')
      .then((v) => setInitial(v ? 'SignIn' : 'Onboarding'))
      .catch(() => setInitial('Onboarding'));
  }, []);
  if (!initial) return <LoadingState label="" />;
  return (
    <AuthStack.Navigator initialRouteName={initial} screenOptions={{ headerTintColor: colors.ink, headerShadowVisible: false }}>
      <AuthStack.Screen name="Onboarding" component={OnboardingScreen} options={{ headerShown: false }} />
      <AuthStack.Screen name="SignIn" component={SignInScreen} options={{ headerShown: false }} />
      <AuthStack.Screen name="Register" component={RegisterScreen} options={{ title: 'Set up your business' }} />
      <AuthStack.Screen name="ForgotPassword" component={ForgotPasswordScreen} options={{ title: 'Reset password' }} />
    </AuthStack.Navigator>
  );
}

function AppFlow() {
  const { user } = useSession();
  if (user?.must_change_password) {
    return (
      <AppStack.Navigator>
        <AppStack.Screen name="ChangePassword" component={ChangePasswordScreen} initialParams={{ forced: true }} options={{ title: 'Choose a new password' }} />
      </AppStack.Navigator>
    );
  }
  return (
    <AppStack.Navigator screenOptions={{ headerTintColor: colors.ink, headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
      <AppStack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
      <AppStack.Screen name="CustomerProfile" component={CustomerProfileScreen} options={{ title: 'Customer' }} />
      <AppStack.Screen name="CustomerForm" component={CustomerFormScreen} options={{ title: 'Add customer', presentation: 'modal' }} />
      <AppStack.Screen name="DebtForm" component={DebtFormScreen} options={{ title: 'New debt', presentation: 'modal' }} />
      <AppStack.Screen name="DebtDetail" component={DebtDetailScreen} options={{ title: 'Debt' }} />
      <AppStack.Screen name="RecordPayment" component={RecordPaymentScreen} options={{ title: 'Record payment', presentation: 'modal' }} />
      <AppStack.Screen name="PaymentDetail" component={PaymentDetailScreen} options={{ title: 'Payment' }} />
      <AppStack.Screen name="Receipt" component={ReceiptScreen} options={{ title: 'Receipt' }} />
      <AppStack.Screen name="OverdueDebts" component={OverdueDebtsScreen} options={{ title: 'Overdue debts' }} />
      <AppStack.Screen name="UpcomingPayments" component={UpcomingPaymentsScreen} options={{ title: 'Upcoming payments' }} />
      <AppStack.Screen name="Reminders" component={RemindersScreen} />
      <AppStack.Screen name="Reports" component={ReportsScreen} />
      <AppStack.Screen name="Staff" component={StaffScreen} />
      <AppStack.Screen name="Notifications" component={NotificationsScreen} />
      <AppStack.Screen name="AuditLog" component={AuditLogScreen} options={{ title: 'Audit log' }} />
      <AppStack.Screen name="Settings" component={SettingsScreen} />
      <AppStack.Screen name="BusinessSetup" component={BusinessSetupScreen} options={{ title: 'Business setup' }} />
      <AppStack.Screen name="ChangePassword" component={ChangePasswordScreen} options={{ title: 'Change password' }} />
      <AppStack.Screen name="SyncQueue" component={SyncQueueScreen} options={{ title: 'Waiting to sync' }} />
    </AppStack.Navigator>
  );
}

let savedNavState: NavigationState | undefined;

export function RootNavigator() {
  const { status } = useSession();
  const { scheme } = useTheme();
  // Changing theme re-mounts the navigator (keyed on scheme) so every screen re-renders with
  // the new palette; the saved navigation state puts the person back where they were.
  return (
    <NavigationContainer
      key={scheme}
      theme={navTheme(scheme)}
      initialState={savedNavState}
      onStateChange={(s) => {
        savedNavState = s;
      }}
    >
      {status === 'loading' ? <LoadingState label="" /> : status === 'signedIn' ? <AppFlow /> : <AuthFlow />}
    </NavigationContainer>
  );
}
