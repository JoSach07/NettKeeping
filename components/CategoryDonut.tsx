import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import Text from '@/components/themed/Text';
import { useAppTheme } from '@/hooks/useAppTheme';

type DonutItem = {
  amount: number;
  color: string;
  label: string;
};

type CategoryDonutProps = {
  items: DonutItem[];
  subtitle: string;
  title: string;
};

const tickCount = 96;
const chartSize = 190;
const tickHeight = 20;
const tickWidth = 4;

export default function CategoryDonut({ items, subtitle, title }: CategoryDonutProps) {
  const { colors } = useAppTheme();
  const tickColors = useMemo(() => {
    const positiveItems = items.filter((item) => item.amount > 0);
    const total = positiveItems.reduce((sum, item) => sum + item.amount, 0);

    if (!total) {
      return Array.from({ length: tickCount }, () => colors.border);
    }

    const cumulativeItems = positiveItems.reduce<Array<DonutItem & { end: number }>>((segments, item) => {
      const previousEnd = segments[segments.length - 1]?.end ?? 0;
      segments.push({
        ...item,
        end: previousEnd + item.amount / total,
      });
      return segments;
    }, []);

    return Array.from({ length: tickCount }, (_, index) => {
      const tickPoint = (index + 0.5) / tickCount;
      return (
        cumulativeItems.find((item) => tickPoint <= item.end)?.color ??
        cumulativeItems[cumulativeItems.length - 1]?.color
      );
    });
  }, [colors.border, items]);

  return (
    <View style={styles.wrap} accessibilityRole="image">
      <View style={styles.chart}>
        {tickColors.map((tickColor, index) => (
          <View
            key={index}
            style={[
              styles.tick,
              {
                backgroundColor: tickColor,
                transform: [{ rotate: `${(360 / tickCount) * index}deg` }, { translateY: -chartSize / 2 + tickHeight / 2 }],
              },
            ]}
          />
        ))}
        <View style={[styles.center, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <Text style={styles.centerTitle}>{title}</Text>
          <Text style={[styles.centerSubtitle, { color: colors.textMuted }]}>{subtitle}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    borderRadius: 62,
    borderWidth: 1,
    height: 124,
    justifyContent: 'center',
    paddingHorizontal: 12,
    position: 'absolute',
    width: 124,
  },
  centerSubtitle: {
    fontSize: 13,
    marginTop: 2,
    textAlign: 'center',
  },
  centerTitle: {
    fontSize: 19,
    fontWeight: '600',
    textAlign: 'center',
  },
  chart: {
    alignItems: 'center',
    height: chartSize,
    justifyContent: 'center',
    width: chartSize,
  },
  tick: {
    borderRadius: tickWidth / 2,
    height: tickHeight,
    left: chartSize / 2 - tickWidth / 2,
    position: 'absolute',
    top: chartSize / 2 - tickHeight / 2,
    width: tickWidth,
  },
  wrap: {
    alignItems: 'center',
    paddingVertical: 14,
  },
});
