import { ReactNode } from 'react';
import { StyleProp, StyleSheet, TextInput, TextInputProps, View, ViewStyle } from 'react-native';

import { useAppTheme } from '@/hooks/useAppTheme';

import FieldLabel from './FieldLabel';
import Text from '../Text';

type TextFieldProps = TextInputProps & {
  containerStyle?: StyleProp<ViewStyle>;
  error?: boolean;
  helperText?: string;
  label: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
};

export default function TextField({
  containerStyle,
  error,
  helperText,
  label,
  placeholderTextColor,
  prefix,
  style,
  suffix,
  ...inputProps
}: TextFieldProps) {
  const { colors } = useAppTheme();
  const hasAdornment = Boolean(prefix || suffix);
  // Same treatment as SelectField's `disabled`: a field that cannot be edited
  // is drawn at reduced opacity, so it never looks live while refusing focus.
  // Only the bordered box dims; the label and helper text stay as they are,
  // again matching SelectField.
  const isReadOnly = inputProps.editable === false;

  return (
    <View style={[styles.field, containerStyle]}>
      <FieldLabel label={label} />
      {hasAdornment ? (
        <View
          style={[
            styles.inputWrap,
            {
              backgroundColor: colors.background,
              borderColor: error ? colors.dangerBorder : colors.border,
              opacity: isReadOnly ? 0.55 : 1,
            },
          ]}>
          {prefix}
          <TextInput
            placeholderTextColor={placeholderTextColor ?? colors.textMuted}
            style={[styles.inputWithSuffix, { color: error ? colors.dangerText : colors.text }, style]}
            {...inputProps}
          />
          {suffix}
        </View>
      ) : (
        <TextInput
          placeholderTextColor={placeholderTextColor ?? colors.textMuted}
          style={[
            styles.input,
            {
              backgroundColor: colors.background,
              borderColor: error ? colors.dangerBorder : colors.border,
              color: error ? colors.dangerText : colors.text,
              opacity: isReadOnly ? 0.55 : 1,
            },
            style,
          ]}
          {...inputProps}
        />
      )}
      {helperText ? (
        <Text style={[styles.helperText, { color: error ? colors.dangerText : colors.textMuted }]}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
}

const inputBase = {
  fontSize: 18,
  height: 54,
  includeFontPadding: true,
  lineHeight: 28,
  paddingVertical: 0,
  textAlignVertical: 'center' as const,
};

const styles = StyleSheet.create({
  field: {
    marginBottom: 15,
  },
  input: {
    ...inputBase,
    borderRadius: 5,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  inputWithSuffix: {
    ...inputBase,
    flex: 1,
    paddingLeft: 8,
    paddingRight: 8,
  },
  inputWrap: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    flexDirection: 'row',
    height: 54,
  },
  helperText: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
});
