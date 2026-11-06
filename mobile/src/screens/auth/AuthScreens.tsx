import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { applyServerErrors, FormField } from '../../components/form';
import { Screen } from '../../components/Screen';
import { Banner } from '../../components/states';
import { AppText, Button, TextField } from '../../components/ui';
import { setMeta } from '../../database/localDb';
import { useSession } from '../../hooks/useSession';
import type { AuthScreenProps } from '../../navigation/types';
import { api, getApiUrl, setApiUrl } from '../../services/api';
import { colors, space } from '../../theme/tokens';
import { normalizeKenyanPhone } from '../../utils/phone';
import {
  loginSchema,
  registerSchema,
  resetConfirmSchema,
  resetRequestSchema,
  type LoginForm,
  type RegisterForm,
} from '../../validation/schemas';

const POINTS = [
  ['Every credit sale on record', 'Record what each customer took, how much, and when it is due.'],
  ['Every payment tracked', 'Cash, M-Pesa and bank payments reduce balances only once they are confirmed.'],
  ['Reminders that stay polite', 'Friendly SMS reminders before and after due dates, never more than you allow.'],
] as const;

export function OnboardingScreen({ navigation }: AuthScreenProps<'Onboarding'>) {
  const finish = async (to: 'SignIn' | 'Register') => {
    await setMeta('onboarding_seen', '1').catch(() => undefined);
    navigation.replace(to);
  };
  return (
    <Screen edges={['top', 'bottom']}>
      <View style={{ marginTop: space.xxl }}>
        <AppText variant="label" color={colors.brandText}>
          DeniTrack
        </AppText>
        <AppText variant="display" style={{ marginTop: space.sm }}>
          Every debt accounted for.{'\n'}Every payment tracked.
        </AppText>
      </View>
      <View style={{ marginTop: space.xxl, gap: space.xl }}>
        {POINTS.map(([title, body], i) => (
          <View key={title} style={styles.point}>
            <AppText variant="heading" color={colors.brandText} style={styles.pointNo}>
              {i + 1}
            </AppText>
            <View style={{ flex: 1 }}>
              <AppText variant="heading">{title}</AppText>
              <AppText color={colors.inkMuted} style={{ marginTop: space.xs }}>
                {body}
              </AppText>
            </View>
          </View>
        ))}
      </View>
      <View style={{ marginTop: space.xxxl, gap: space.md }}>
        <Button title="Set up my business" onPress={() => finish('Register')} />
        <Button title="I already have an account" variant="secondary" onPress={() => finish('SignIn')} />
      </View>
    </Screen>
  );
}

export function SignInScreen({ navigation }: AuthScreenProps<'SignIn'>) {
  const { signIn } = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const { control, handleSubmit, setError, formState } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const onSubmit = handleSubmit(async (v) => {
    setFormError(null);
    try {
      await signIn(v.email, v.password);
    } catch (e) {
      setFormError(applyServerErrors(e, setError, ['email', 'password']));
    }
  });
  return (
    <Screen edges={['top', 'bottom']}>
      <AppText variant="title" style={{ marginTop: space.xl, marginBottom: space.xl }} accessibilityRole="header">
        Sign in
      </AppText>
      {formError ? <Banner tone="danger">{formError}</Banner> : null}
      <FormField control={control} name="email" label="Email" keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" />
      <FormField control={control} name="password" label="Password" secureTextEntry autoComplete="password" textContentType="password" onSubmitEditing={() => void onSubmit()} />
      <Button title="Sign in" onPress={() => void onSubmit()} loading={formState.isSubmitting} />
      <Button title="Forgot password?" variant="ghost" onPress={() => navigation.navigate('ForgotPassword')} style={{ marginTop: space.sm }} />
      <Button title="Create a business account" variant="ghost" onPress={() => navigation.navigate('Register')} />
      <ServerAddress />
    </Screen>
  );
}

/** Lets a business point the app at its own DeniTrack server (checked before saving). */
export function ServerAddress() {
  const [url, setUrl] = useState(getApiUrl());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(url);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      setUrl(await setApiUrl(draft));
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the address');
    } finally {
      setBusy(false);
    }
  };
  if (!editing) {
    return (
      <View style={{ marginTop: space.xxl, alignItems: 'center' }}>
        <AppText variant="caption" color={colors.inkMuted}>
          Server: {url}
        </AppText>
        <Button title="Change server" variant="ghost" compact onPress={() => { setDraft(url); setEditing(true); }} />
      </View>
    );
  }
  return (
    <View style={{ marginTop: space.xl }}>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <TextField
        label="Server address"
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="192.168.1.20:8000 or https://api.example.co.ke"
        hint="Ask whoever runs your DeniTrack server for this address."
      />
      <Button title="Check and save" onPress={() => void save()} loading={busy} />
      <Button title="Cancel" variant="ghost" onPress={() => setEditing(false)} style={{ marginTop: space.sm }} />
    </View>
  );
}

export function RegisterScreen({ navigation }: AuthScreenProps<'Register'>) {
  const { register } = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const { control, handleSubmit, setError, formState } = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: { full_name: '', business_name: '', email: '', phone: '', password: '', confirm: '' },
  });
  const onSubmit = handleSubmit(async ({ confirm: _confirm, ...v }) => {
    setFormError(null);
    try {
      await register({ ...v, phone: normalizeKenyanPhone(v.phone) });
    } catch (e) {
      setFormError(applyServerErrors(e, setError, ['full_name', 'business_name', 'email', 'phone', 'password']));
    }
  });
  return (
    <Screen edges={['bottom']}>
      <AppText color={colors.inkMuted} style={{ marginBottom: space.xl }}>
        You will be the owner. You can add cashiers and administrators later.
      </AppText>
      {formError ? <Banner tone="danger">{formError}</Banner> : null}
      <FormField control={control} name="business_name" label="Business name" autoCapitalize="words" />
      <FormField control={control} name="full_name" label="Your full name" autoCapitalize="words" autoComplete="name" />
      <FormField control={control} name="phone" label="Phone number" keyboardType="phone-pad" placeholder="0712 345 678" hint="Used for password recovery codes" />
      <FormField control={control} name="email" label="Email" keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
      <FormField control={control} name="password" label="Password" secureTextEntry hint="At least 10 characters, with letters and numbers" autoComplete="new-password" />
      <FormField control={control} name="confirm" label="Confirm password" secureTextEntry autoComplete="new-password" />
      <AppText variant="caption" color={colors.inkMuted} style={{ marginBottom: space.lg }}>
        DeniTrack stores your customers’ names, phone numbers and balances to manage credit you have extended. Only
        your business’s staff can see them. See the privacy notice in Settings.
      </AppText>
      <Button title="Create account" onPress={() => void onSubmit()} loading={formState.isSubmitting} />
      <Button title="I already have an account" variant="ghost" onPress={() => navigation.navigate('SignIn')} style={{ marginTop: space.sm }} />
      <ServerAddress />
    </Screen>
  );
}

export function ForgotPasswordScreen({ navigation }: AuthScreenProps<'ForgotPassword'>) {
  const [stage, setStage] = useState<'request' | 'confirm' | 'done'>('request');
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const req = useForm({ resolver: zodResolver(resetRequestSchema), defaultValues: { email: '' } });
  const conf = useForm({
    resolver: zodResolver(resetConfirmSchema),
    defaultValues: { token: '', new_password: '', confirm: '' },
  });

  const sendCode = req.handleSubmit(async (v) => {
    setMessage(null);
    try {
      await api.post('/api/v1/auth/password-reset/request', v, { auth: false });
      setStage('confirm');
      setMessage({ tone: 'success', text: 'If that account exists, a reset code was sent to its phone number.' });
    } catch (e) {
      setMessage({ tone: 'danger', text: applyServerErrors(e, req.setError, ['email']) ?? 'Check the email address.' });
    }
  });
  const reset = conf.handleSubmit(async ({ token, new_password }) => {
    setMessage(null);
    try {
      await api.post('/api/v1/auth/password-reset/confirm', { token, new_password }, { auth: false });
      setStage('done');
    } catch (e) {
      setMessage({ tone: 'danger', text: applyServerErrors(e, conf.setError, ['token', 'new_password']) ?? 'Check the code.' });
    }
  });

  if (stage === 'done') {
    return (
      <Screen edges={['bottom']}>
        <Banner tone="success">Your password was changed and all devices were signed out.</Banner>
        <Button title="Sign in" onPress={() => navigation.navigate('SignIn')} />
      </Screen>
    );
  }
  return (
    <Screen edges={['bottom']}>
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      {stage === 'request' ? (
        <>
          <AppText color={colors.inkMuted} style={{ marginBottom: space.lg }}>
            Enter the email you sign in with. We will send a reset code by SMS to the phone number on the account.
          </AppText>
          <FormField control={req.control} name="email" label="Email" keyboardType="email-address" autoCapitalize="none" />
          <Button title="Send reset code" onPress={() => void sendCode()} loading={req.formState.isSubmitting} />
        </>
      ) : (
        <>
          <FormField control={conf.control} name="token" label="Reset code" autoCapitalize="none" autoCorrect={false} />
          <FormField control={conf.control} name="new_password" label="New password" secureTextEntry />
          <FormField control={conf.control} name="confirm" label="Confirm new password" secureTextEntry />
          <Button title="Change password" onPress={() => void reset()} loading={conf.formState.isSubmitting} />
          <Button title="Send a new code" variant="ghost" onPress={() => setStage('request')} style={{ marginTop: space.sm }} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  point: { flexDirection: 'row', gap: space.lg },
  pointNo: { width: 24 },
});
