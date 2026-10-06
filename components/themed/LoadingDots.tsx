import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { useAppTheme } from '@/hooks/useAppTheme';

type LoadingDotsProps = {
  style?: StyleProp<ViewStyle>;
};

const DOT_COUNT = 3;
const CYCLE_MS = 1200;
const DIM_OPACITY = 0.25;

// All three dots are always on screen and only their brightness travels across
// the row. Adding dots one at a time reads as progress filling up, and it also
// changes the row's width on every tick.
const dotOpacityRanges = [
  [1, DIM_OPACITY, DIM_OPACITY, 1],
  [DIM_OPACITY, 1, DIM_OPACITY, DIM_OPACITY],
  [DIM_OPACITY, DIM_OPACITY, 1, DIM_OPACITY],
];

export default function LoadingDots({ style }: LoadingDotsProps) {
  const { colors } = useAppTheme();
  // One clock drives every dot; each reads a different slice of it, so the
  // highlight sweeps instead of all three pulsing in unison.
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    progress.setValue(0);

    const loop = Animated.loop(
      Animated.timing(progress, {
        duration: CYCLE_MS,
        easing: Easing.linear,
        toValue: DOT_COUNT,
        useNativeDriver: true,
      })
    );

    loop.start();

    return () => loop.stop();
  }, [progress]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.row, style]}>
      {dotOpacityRanges.map((outputRange, index) => (
        <Animated.Text
          key={index}
          style={[
            styles.dot,
            {
              color: colors.text,
              // The first and last stops are both bright for dot 0, so the
              // sweep is continuous across the loop boundary.
              opacity: progress.interpolate({
                inputRange: [0, 1, 2, 3],
                outputRange,
              }),
            },
          ]}>
          .
        </Animated.Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Matches the 14/20 metrics of the status labels this sits beside, so the
  // dots line up with the text baseline rather than floating.
  dot: {
    fontSize: 14,
    lineHeight: 20,
    marginLeft: 4,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
  },
});
