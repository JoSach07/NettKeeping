import { PropsWithChildren } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

export const collapsibleLayout = LinearTransition.duration(320);

type CollapsibleBodyProps = PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
}>;

export default function CollapsibleBody({ children, style }: CollapsibleBodyProps) {
  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)} style={style}>
      {children}
    </Animated.View>
  );
}
