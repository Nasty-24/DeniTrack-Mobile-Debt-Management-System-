import { Controller, type Control, type FieldPath, type FieldValues, type UseFormSetError } from 'react-hook-form';
import type { TextInputProps } from 'react-native';

import { ApiError } from '../services/apiClient';
import { TextField } from './ui';

interface FormFieldProps<T extends FieldValues> extends Omit<TextInputProps, 'value' | 'onChangeText'> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  hint?: string;
  prefix?: string;
}

export function FormField<T extends FieldValues>({ control, name, label, hint, prefix, ...input }: FormFieldProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field: { onChange, onBlur, value }, fieldState: { error } }) => (
        <TextField
          label={label}
          hint={hint}
          prefix={prefix}
          value={value == null ? '' : String(value)}
          onChangeText={onChange}
          onBlur={onBlur}
          error={error?.message}
          {...input}
        />
      )}
    />
  );
}

/**
 * Puts server-side field errors on the matching inputs. Returns the message for the
 * form-level banner when the error is not tied to a single field.
 */
export function applyServerErrors<T extends FieldValues>(error: unknown, setError: UseFormSetError<T>, fields: string[]): string | null {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'Something went wrong.';
  const byField = error.fieldErrors();
  let matched = false;
  for (const [field, message] of Object.entries(byField)) {
    if (fields.includes(field)) {
      setError(field as FieldPath<T>, { message });
      matched = true;
    }
  }
  if (error.code === 'invalid_phone' && fields.includes('phone')) {
    setError('phone' as FieldPath<T>, { message: error.message });
    return null;
  }
  return matched ? null : error.message;
}
