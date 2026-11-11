import { useEffect, useMemo, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, View } from 'react-native';

import { newIdempotencyKey } from '../services/api';
import {
  getContactsAccess,
  loadPhoneBook,
  requestContactsAccess,
  searchPhoneBook,
  type ContactsAccess,
  type PhoneBookEntry,
} from '../services/contacts';
import { colors, radius, space, themedStyles, touchTarget } from '../theme/tokens';
import { formatPhone } from '../utils/phone';
import { LoadingState } from './states';
import { AppText, Button, Card, Divider, ListRow, SectionHeader, TextField } from './ui';

/** A person picked from the phone's contacts, not yet saved as a customer. */
export interface NewPerson {
  kind: 'new';
  name: string;
  /** International format, e.g. +254712345678. */
  phone: string;
  /** Idempotency key for creating this customer, so saving again never adds them twice. */
  key: string;
}

const MIN_QUERY = 2;

function numberLabel(n: { raw: string; e164: string | null }): string {
  return n.e164 ? formatPhone(n.e164) : n.raw;
}

interface Chosen {
  entry: PhoneBookEntry;
  name: string;
  index: number;
}

/**
 * "From your phone": contacts matching `query`, read on the phone only. Picking one asks for
 * the name to use and, when the contact has several, which number.
 */
export function ContactResults({
  query,
  knownPhones,
  onPick,
}: {
  query: string;
  knownPhones: ReadonlySet<string>;
  onPick: (p: NewPerson) => void;
}) {
  const [access, setAccess] = useState<ContactsAccess | null>(null);
  const [book, setBook] = useState<PhoneBookEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const active = query.trim().length >= MIN_QUERY || chosen !== null;

  useEffect(() => {
    if (!active || access !== null) return;
    let live = true;
    getContactsAccess()
      .then((a) => live && setAccess(a))
      .catch(() => live && setAccess('denied'));
    return () => {
      live = false;
    };
  }, [active, access]);

  // After "Open settings", notice when the person allows contacts and comes back.
  useEffect(() => {
    if (access !== 'denied') return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void getContactsAccess().then(setAccess).catch(() => undefined);
    });
    return () => sub.remove();
  }, [access]);

  useEffect(() => {
    if (access !== 'granted' || book !== null || failed) return;
    let live = true;
    loadPhoneBook()
      .then((b) => live && setBook(b))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [access, book, failed]);

  const results = useMemo(() => (book ? searchPhoneBook(book, query, knownPhones) : []), [book, query, knownPhones]);

  if (!active) return null;

  const choose = (entry: PhoneBookEntry) => {
    const usable = entry.numbers.findIndex((n) => n.e164 !== null);
    setChosen({ entry, name: entry.name, index: usable });
  };

  let body;
  if (access === null) {
    body = <LoadingState />;
  } else if (access === 'undetermined') {
    body = (
      <View style={{ padding: space.lg, gap: space.sm }}>
        <AppText color={colors.inkMuted}>Find people in your contacts and add them as customers.</AppText>
        <Button title="Search your phone's contacts" variant="secondary" compact onPress={() => void requestContactsAccess().then(setAccess)} />
      </View>
    );
  } else if (access === 'denied') {
    body = (
      <View style={{ padding: space.lg, gap: space.sm }}>
        <AppText color={colors.inkMuted}>Contacts are off for DeniTrack.</AppText>
        <Button title="Open settings" variant="secondary" compact onPress={() => void Linking.openSettings()} />
      </View>
    );
  } else if (failed) {
    body = (
      <View style={{ padding: space.lg }}>
        <AppText color={colors.inkMuted}>{"Couldn't read your contacts."}</AppText>
      </View>
    );
  } else if (book === null) {
    body = <LoadingState />;
  } else if (chosen) {
    const number = chosen.index >= 0 ? chosen.entry.numbers[chosen.index] : null;
    body = (
      <ConfirmPerson
        chosen={chosen}
        onChange={setChosen}
        onCancel={() => setChosen(null)}
        onUse={
          number?.e164 && chosen.name.trim()
            ? () => {
                onPick({ kind: 'new', name: chosen.name.trim(), phone: number.e164!, key: newIdempotencyKey() });
                setChosen(null);
              }
            : undefined
        }
      />
    );
  } else if (results.length === 0) {
    body = (
      <View style={{ padding: space.lg }}>
        <AppText color={colors.inkMuted}>No contacts match.</AppText>
      </View>
    );
  } else {
    body = results.map((entry, i) => (
      <View key={entry.id}>
        {i > 0 ? <Divider inset={space.lg} /> : null}
        <ListRow title={entry.name} subtitle={entry.numbers.map(numberLabel).join(' · ')} onPress={() => choose(entry)} />
      </View>
    ));
  }

  return (
    <View style={{ marginTop: space.md }}>
      <SectionHeader title="From your phone" />
      <Card padded={false}>{body}</Card>
    </View>
  );
}

function ConfirmPerson({
  chosen,
  onChange,
  onCancel,
  onUse,
}: {
  chosen: Chosen;
  onChange: (c: Chosen) => void;
  onCancel: () => void;
  onUse?: () => void;
}) {
  const styles = getStyles();
  return (
    <View style={{ padding: space.lg }}>
      <TextField label="Name" value={chosen.name} onChangeText={(name) => onChange({ ...chosen, name })} autoCapitalize="words" />
      <AppText variant="caption" color={colors.inkMuted} style={{ marginBottom: space.xs }}>
        Number
      </AppText>
      {chosen.entry.numbers.map((n, i) => {
        const usable = n.e164 !== null;
        const checked = i === chosen.index;
        return (
          <Pressable
            key={`${n.raw}-${i}`}
            accessibilityRole="radio"
            accessibilityLabel={numberLabel(n)}
            accessibilityState={{ checked, disabled: !usable }}
            disabled={!usable}
            onPress={() => onChange({ ...chosen, index: i })}
            style={[styles.option, checked && styles.optionChecked]}
          >
            <AppText color={usable ? colors.ink : colors.inkFaint}>{numberLabel(n)}</AppText>
            {usable ? null : (
              <AppText variant="caption" color={colors.inkMuted}>
                Not a mobile number
              </AppText>
            )}
          </Pressable>
        );
      })}
      <Button title="Use this person" disabled={!onUse} onPress={onUse} style={{ marginTop: space.md }} />
      <Button title="Back" variant="ghost" compact onPress={onCancel} style={{ alignSelf: 'flex-start', marginTop: space.xs }} />
    </View>
  );
}

const getStyles = themedStyles((c) =>
  StyleSheet.create({
    option: {
      minHeight: touchTarget,
      justifyContent: 'center',
      paddingHorizontal: space.md,
      marginBottom: space.xs,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    optionChecked: { borderColor: c.brand, borderWidth: 2, backgroundColor: c.surfaceSunken },
  }),
);
