import { useState } from 'react';
import { TextInputProps } from 'react-native';

import {
  formatQuantityInputForDisplay,
  getQuantityPrecisionError,
  getQuantityPrecisionHelper,
  normalizeQuantityDecimals,
  quantityInputHasValidPrecision,
  sanitizeQuantityInput,
} from '@/utils/investmentNumbers';

import TextField from './TextField';

type QuantityFieldProps = {
  // The investment's QuantityDecimals (0-8).
  decimals: number;
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
  // Canonical value: '.' as the decimal separator, no grouping.
  value: string;
};

// MoneyField's twin for investment quantities. Same rule: grouping separators
// are only rendered while blurred, because TextInput echoes the displayed text
// back into onChangeText and a grouping '.' would be re-read as a decimal one.
export default function QuantityField({
  decimals,
  editable,
  error,
  errorText,
  label,
  onChangeText,
  placeholder,
  style,
  testID,
  value,
}: QuantityFieldProps) {
  const [focused, setFocused] = useState(false);
  const places = normalizeQuantityDecimals(decimals);
  const hasPrecisionError = !quantityInputHasValidPrecision(value, places);
  const helperText = hasPrecisionError
    ? getQuantityPrecisionError(places)
    : error && errorText
      ? errorText
      : getQuantityPrecisionHelper(places);
  const displayValue = focused ? value : formatQuantityInputForDisplay(value);

  const handleChangeText = (nextValue: string) => {
    if (!focused && nextValue === displayValue) {
      return;
    }
    onChangeText?.(sanitizeQuantityInput(nextValue, places));
  };

  return (
    <TextField
      editable={editable}
      error={error || hasPrecisionError}
      helperText={helperText}
      inputMode={places === 0 ? 'numeric' : 'decimal'}
      keyboardType={places === 0 ? 'number-pad' : 'decimal-pad'}
      label={label}
      onBlur={() => setFocused(false)}
      onChangeText={handleChangeText}
      onFocus={() => setFocused(true)}
      placeholder={placeholder ?? '0'}
      style={style}
      testID={testID}
      value={displayValue}
    />
  );
}
