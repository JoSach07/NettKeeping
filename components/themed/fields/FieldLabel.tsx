import { StyleSheet } from 'react-native';

import Text, { TextProps } from '@/components/themed/Text';

type FieldLabelProps = TextProps & {
  label: string;
};

export default function FieldLabel({ label, style, ...textProps }: FieldLabelProps) {
  return (
    <Text style={[styles.label, style]} {...textProps}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 14,
    marginBottom: 10,
  },
});
