import { useState } from 'react';
import { StyleSheet, TextInputProps } from 'react-native';

import Text from '@/components/themed/Text';
import {
  formatMoneyInputForDisplay,
  getMoneyPrefix,
  getMoneyPrecisionError,
  getMoneyPrecisionHelper,
  MoneyCurrency,
  moneyInputHasValidPrecision,
  sanitizeMoneyInput,
} from '@/utils/moneyInput';
import { useAppTheme } from '@/hooks/useAppTheme';

import TextField from './TextField';

type MoneyFieldProps = {
  currency?: MoneyCurrency;
  editable?: boolean;
  error?: boolean;
  // Shown in place of the precision hint while `error` is set, so a field the
  // screen marked red says why. The field's own precision error still wins.
  errorText?: string;
  label: string;
  onChangeText?: (value: string) => void;
  placeholder?: string;
  style?: TextInputProps['style'];
  testID?: string;
  value: string;
};

export default function MoneyField({
  currency,
  editable,
  error,
  errorText,
  label,
  onChangeText,
  placeholder,
  style,
  testID,
  value,
}: MoneyFieldProps) {
  const { colors } = useAppTheme();
  const [focused, setFocused] = useState(false);
  const prefix = getMoneyPrefix(currency);
  const hasPrecisionError = !moneyInputHasValidPrecision(value, currency);
  const helperText = hasPrecisionError
    ? getMoneyPrecisionError(currency)
    : error && errorText
      ? errorText
      : getMoneyPrecisionHelper(currency);
  // Grouping separators must NEVER be rendered while the field is focused.
  // TextInput echoes whatever it displays straight back into handleChangeText,
  // and sanitizeMoneyInput cannot tell a grouping '.' from a decimal '.' when
  // no ',' is present — so a displayed "1.234" comes back as the value 1.234
  // on the very next keystroke. This is why the balance field on Manage
  // Accounts used to break on the 5th digit for decimal currencies.
  const displayValue = focused ? value : formatMoneyInputForDisplay(value);

  const handleChangeText = (nextValue: string) => {
    const sanitizedValue = sanitizeMoneyInput(nextValue, currency);

    // Some native inputs echo the display-only value after blur. Keep grouping
    // separators out of the canonical value used for validation and saving.
    if (!focused && nextValue === displayValue) {
      return;
    }

    onChangeText?.(sanitizedValue);
  };

  return (
    <TextField
      editable={editable}
      error={error || hasPrecisionError}
      helperText={helperText}
      inputMode={currency && currency.NumberToBasic <= 1 ? 'numeric' : 'decimal'}
      keyboardType={currency && currency.NumberToBasic <= 1 ? 'number-pad' : 'decimal-pad'}
      label={label}
      onBlur={() => setFocused(false)}
      onChangeText={handleChangeText}
      onFocus={() => setFocused(true)}
      placeholder={placeholder ?? '0'}
      prefix={prefix ? <Text style={[styles.prefix, { color: colors.text }]}>{prefix}</Text> : undefined}
      style={style}
      testID={testID}
      value={displayValue}
    />
  );
}

const styles = StyleSheet.create({
  prefix: {
    fontSize: 18,
    paddingLeft: 12,
  },
});
