import { Text as DefaultText } from 'react-native';

import { useAppTheme } from '@/hooks/useAppTheme';

type ThemeProps = {
  lightColor?: string;
  darkColor?: string;
};

export type TextProps = ThemeProps & DefaultText['props'];

export default function Text(props: TextProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const { theme, colors } = useAppTheme();
  const color = theme === 'dark' ? darkColor : lightColor;

  return <DefaultText style={[{ color: color ?? colors.text }, style]} {...otherProps} />;
}
