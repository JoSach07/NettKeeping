import { ActivityIndicator, StyleSheet, View, ViewProps } from 'react-native';

import { useAppTheme } from '@/hooks/useAppTheme';

type LoadingSpinnerProps = ViewProps & {
  size?: 'small' | 'large';
};

export default function LoadingSpinner({ size = 'large', style, ...viewProps }: LoadingSpinnerProps) {
  const { colors } = useAppTheme();

  return (
    <View accessibilityLabel="Loading" style={[styles.wrap, style]} {...viewProps}>
      <ActivityIndicator color={colors.text} size={size} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
  },
});
