import { StyleProp, StyleSheet, TextInput, TextInputProps, View, ViewStyle } from 'react-native';

import Text from '@/components/themed/Text';
import { useAppTheme } from '@/hooks/useAppTheme';

import FieldLabel from './FieldLabel';

type TextAreaFieldProps = TextInputProps & {
  containerStyle?: StyleProp<ViewStyle>;
  label: string;
  showCounter?: boolean;
  // Treats maxLength as advisory: the user can type past it and the field turns
  // red, rather than the input silently swallowing keystrokes at the limit.
  // Callers using this must reject over-length values themselves on submit.
  softLimit?: boolean;
};

export default function TextAreaField({
  containerStyle,
  label,
  maxLength,
  placeholderTextColor,
  showCounter,
  softLimit,
  style,
  value,
  ...inputProps
}: TextAreaFieldProps) {
  const { colors } = useAppTheme();
  const characterCount = typeof value === 'string' ? value.length : 0;
  // A hard limit clamps the input, so the count can never exceed maxLength and
  // sitting on it is the only signal available. A soft limit lets the user
  // overshoot, and only overshooting is a problem — being exactly at the limit
  // is still a valid value.
  const isOverLimit =
    maxLength !== undefined && (softLimit ? characterCount > maxLength : characterCount >= maxLength);

  return (
    <View style={[styles.field, containerStyle]}>
      <FieldLabel label={label} />
      <TextInput
        maxLength={softLimit ? undefined : maxLength}
        multiline
        placeholderTextColor={placeholderTextColor ?? colors.textMuted}
        style={[
          styles.input,
          {
            backgroundColor: colors.background,
            borderColor: isOverLimit ? colors.dangerBorder : colors.border,
            color: isOverLimit ? colors.dangerText : colors.text,
          },
          style,
        ]}
        value={value}
        {...inputProps}
      />
      {showCounter && maxLength ? (
        <Text
          style={[styles.counter, { color: isOverLimit ? colors.dangerText : colors.textMuted }]}
          testID={inputProps.testID ? `${inputProps.testID}Counter` : undefined}>
          {characterCount}/{maxLength}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  counter: {
    alignSelf: 'flex-end',
    fontSize: 11,
    marginTop: 6,
  },
  field: {
    marginBottom: 15,
  },
  input: {
    borderRadius: 5,
    borderWidth: 1,
    fontSize: 18,
    lineHeight: 28,
    minHeight: 102,
    paddingHorizontal: 12,
    paddingTop: 10,
    textAlignVertical: 'top',
  },
});
