import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import Text from '@/components/themed/Text';
import { useAppTheme } from '@/hooks/useAppTheme';

import FieldLabel from './FieldLabel';

type SelectFieldProps = {
  containerStyle?: StyleProp<ViewStyle>;
  disabled?: boolean;
  error?: boolean;
  helperText?: string;
  label: string;
  onPress: () => void;
  placeholder: string;
  testID?: string;
  value?: string;
};

export default function SelectField({
  containerStyle,
  disabled,
  error,
  helperText,
  label,
  onPress,
  placeholder,
  testID,
  value,
}: SelectFieldProps) {
  const { colors } = useAppTheme();

  return (
    <View style={[styles.field, containerStyle]}>
      <FieldLabel label={label} />
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        testID={testID}
        style={({ pressed }) => [
          styles.selectButton,
          {
            backgroundColor: colors.background,
            borderColor: error ? colors.dangerBorder : colors.border,
            opacity: disabled ? 0.55 : 1,
          },
          pressed && styles.pressed,
        ]}>
        <Text style={[styles.selectText, error && { color: colors.dangerText }, !value && { color: colors.textMuted }]}>
          {value || placeholder}
        </Text>
        <FontAwesome name="angle-down" size={24} color={error ? colors.dangerText : colors.text} />
      </Pressable>
      {helperText ? (
        <Text style={[styles.helperText, { color: error ? colors.dangerText : colors.textMuted }]}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    marginBottom: 15,
  },
  // Kept in sync with TextField's helperText so the two field types read the
  // same when either one explains itself below the control.
  helperText: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
  pressed: {
    opacity: 0.65,
  },
  selectButton: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    flexDirection: 'row',
    height: 54,
    justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  selectText: {
    flex: 1,
    fontSize: 18,
  },
});
