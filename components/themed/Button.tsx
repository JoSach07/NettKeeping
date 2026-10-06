import { ReactNode } from 'react';
import { Pressable, PressableProps, StyleProp, StyleSheet, TextStyle, useWindowDimensions } from 'react-native';

import { useAppTheme } from '@/hooks/useAppTheme';

import Text from './Text';

// Above this system font scale, labels need the room more than the padding
// does: the padding drops so text fits before it wraps. At or below it nothing
// changes (every label was confirmed to fit at 1.3). Rows that set their own
// padding through `style` keep it, since `style` is applied last.
const compactPaddingFontScale = 1.31;

type ButtonVariant = 'default' | 'primary' | 'danger' | 'success';
type ButtonSize = 'small' | 'regular';

type ButtonProps = PressableProps & {
  children: ReactNode;
  size?: ButtonSize;
  textStyle?: StyleProp<TextStyle>;
  variant?: ButtonVariant;
};

export default function Button({
  children,
  disabled,
  size = 'regular',
  style,
  textStyle,
  variant = 'default',
  ...pressableProps
}: ButtonProps) {
  const { colors } = useAppTheme();
  const { fontScale } = useWindowDimensions();
  const compact = fontScale > compactPaddingFontScale;
  const variantStyle =
    variant === 'primary'
      ? {
          backgroundColor: colors.buttonPrimaryBackground,
          borderColor: colors.buttonPrimaryBorder,
        }
      : variant === 'danger'
        ? {
            backgroundColor: colors.buttonDangerBackground,
            borderColor: colors.buttonDangerBorder,
          }
        : variant === 'success'
          ? {
              backgroundColor: colors.buttonSuccessBackground,
              borderColor: colors.buttonSuccessBorder,
            }
        : {
            backgroundColor: colors.background,
            borderColor: colors.border,
          };

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        size === 'small' ? styles.small : styles.regular,
        compact && (size === 'small' ? styles.smallCompact : styles.regularCompact),
        variantStyle,
        disabled && styles.disabled,
        pressed && styles.pressed,
        typeof style === 'function' ? style({ pressed, hovered: false }) : style,
      ]}
      {...pressableProps}>
      <Text style={[size === 'small' ? styles.smallText : styles.regularText, textStyle]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.55,
  },
  pressed: {
    opacity: 0.65,
  },
  regular: {
    minWidth: 144,
    paddingHorizontal: 36,
    paddingVertical: 9,
  },
  regularCompact: {
    paddingHorizontal: 8,
  },
  regularText: {
    fontSize: 24,
    textAlign: 'center',
  },
  small: {
    minWidth: 92,
    paddingHorizontal: 20,
    paddingVertical: 7,
  },
  smallCompact: {
    paddingHorizontal: 4,
  },
  smallText: {
    fontSize: 18,
    textAlign: 'center',
  },
});
