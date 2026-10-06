import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useEffect } from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

type AnimatedChevronProps = {
  color: string;
  expanded: boolean;
  size?: number;
};

export default function AnimatedChevron({ color, expanded, size = 24 }: AnimatedChevronProps) {
  const progress = useSharedValue(expanded ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, { duration: 240 });
  }, [expanded, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 180}deg` }],
  }));

  return (
    <Animated.View style={animatedStyle}>
      <FontAwesome name="angle-down" size={size} color={color} />
    </Animated.View>
  );
}
