import { useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';

import Text from '@/components/themed/Text';
import { useAppTheme } from '@/hooks/useAppTheme';
import { collapseToLatestPerDay, LineChartPoint } from '@/utils/chartPoints';

export type { LineChartPoint } from '@/utils/chartPoints';

type LineChartProps = {
  domainEnd?: Date;
  domainStart?: Date;
  emptyText: string;
  formatValue: (value: number) => string;
  height?: number;
  // 'axis': max/min labels on the right edge (accounts).
  // 'header': latest value and min - max in a row above the chart (investments).
  labels: 'axis' | 'header';
  // Build with the helpers in utils/chartPoints and memoize: the plot is
  // recomputed whenever this array's identity changes.
  points: LineChartPoint[];
};

const defaultHeight = 180;
const chartPadding = 18;
const axisLabelWidth = 62;

// The one line chart, shared by the accounts, investments and home screens.
// Points are collapsed to the latest one per calendar day before plotting
// (see collapseToLatestPerDay).
export default function LineChart({
  domainEnd,
  domainStart,
  emptyText,
  formatValue,
  height = defaultHeight,
  labels,
  points,
}: LineChartProps) {
  const { colors } = useAppTheme();
  const [width, setWidth] = useState(0);
  const rightPadding = labels === 'axis' ? axisLabelWidth : chartPadding;
  const domainStartTime = domainStart?.getTime();
  const domainEndTime = domainEnd?.getTime();
  const { chartPoints, maxValue, minValue, segments } = useMemo(() => {
    const dailyPoints = collapseToLatestPerDay(points);
    const values = dailyPoints.map((point) => point.value);
    const rangeMinValue = values.length ? Math.min(...values) : 0;
    const rangeMaxValue = values.length ? Math.max(...values) : 0;
    const firstPointTime = dailyPoints[0]?.date.getTime();
    const lastPointTime = dailyPoints[dailyPoints.length - 1]?.date.getTime();
    // The domain stretches to reach a point beyond either end rather than
    // letting it sit off the canvas. A point past today is legacy data or a
    // leaked future date — the case where losing it would be most misleading.
    const firstTime = domainStartTime !== undefined && firstPointTime !== undefined
      ? Math.min(domainStartTime, firstPointTime)
      : domainStartTime ?? firstPointTime ?? 0;
    const lastTime = domainEndTime !== undefined && lastPointTime !== undefined
      ? Math.max(domainEndTime, lastPointTime)
      : domainEndTime ?? lastPointTime ?? 0;
    const dateSpan = Math.max(lastTime - firstTime, 1);
    const valueSpan = Math.max(rangeMaxValue - rangeMinValue, 1);
    const usableWidth = Math.max(width - chartPadding - rightPadding, 1);
    const usableHeight = height - chartPadding * 2;
    const plotted = dailyPoints.map((point) => ({
      ...point,
      x: chartPadding + ((point.date.getTime() - firstTime) / dateSpan) * usableWidth,
      y: chartPadding + (1 - (point.value - rangeMinValue) / valueSpan) * usableHeight,
    }));
    const plottedSegments = plotted.slice(0, -1).map((point, index) => {
      const nextPoint = plotted[index + 1];
      const deltaX = nextPoint.x - point.x;
      const deltaY = nextPoint.y - point.y;
      const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      return {
        angle: `${Math.atan2(deltaY, deltaX)}rad`,
        id: `${point.id}-line`,
        left: (point.x + nextPoint.x) / 2 - length / 2,
        length,
        top: (point.y + nextPoint.y) / 2,
      };
    });

    return {
      chartPoints: plotted,
      maxValue: rangeMaxValue,
      minValue: rangeMinValue,
      segments: plottedSegments,
    };
  }, [domainEndTime, domainStartTime, height, points, rightPadding, width]);

  const handleLayout = (event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  };

  if (!chartPoints.length) {
    return (
      <View style={[styles.emptyChart, { borderColor: colors.border, height }]} onLayout={handleLayout}>
        <Text style={[styles.emptyText, { color: colors.textMuted }]}>{emptyText}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {labels === 'header' ? (
        <View style={[styles.valueRow, { borderColor: colors.border }]}>
          <Text style={styles.valueText}>{formatValue(chartPoints[chartPoints.length - 1].value)}</Text>
          <Text style={[styles.rangeText, { color: colors.textMuted }]}>
            {formatValue(minValue)} - {formatValue(maxValue)}
          </Text>
        </View>
      ) : null}
      <View style={[styles.chart, { borderColor: colors.border, height }]} onLayout={handleLayout}>
        {labels === 'axis' ? (
          <View style={styles.axisLabels}>
            <Text style={[styles.axisLabel, { color: colors.textMuted }]}>{formatValue(maxValue)}</Text>
            <Text style={[styles.axisLabel, { color: colors.textMuted }]}>{formatValue(minValue)}</Text>
          </View>
        ) : null}
        {width > 0
          ? segments.map((segment) => (
              <View
                key={segment.id}
                style={[
                  styles.line,
                  {
                    backgroundColor: colors.buttonPrimaryBackground,
                    left: segment.left,
                    top: segment.top,
                    transform: [{ rotate: segment.angle }],
                    width: segment.length,
                  },
                ]}
              />
            ))
          : null}
        {width > 0
          ? chartPoints.map((point) => (
              <View
                key={point.id}
                style={[
                  styles.point,
                  {
                    backgroundColor: colors.buttonPrimaryBackground,
                    borderColor: colors.background,
                    left: point.x - 4,
                    top: point.y - 4,
                  },
                ]}
              />
            ))
          : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  axisLabel: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'right',
  },
  axisLabels: {
    bottom: chartPadding - 2,
    justifyContent: 'space-between',
    position: 'absolute',
    right: 8,
    top: chartPadding - 2,
    width: axisLabelWidth - 14,
    zIndex: 1,
  },
  chart: {
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  emptyChart: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 12,
    padding: 16,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
  line: {
    borderRadius: 1,
    height: 3,
    position: 'absolute',
  },
  point: {
    borderRadius: 5,
    borderWidth: 2,
    height: 10,
    position: 'absolute',
    width: 10,
  },
  rangeText: {
    fontSize: 13,
  },
  valueRow: {
    alignItems: 'baseline',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingBottom: 8,
  },
  valueText: {
    fontSize: 18,
    fontWeight: '600',
  },
  wrap: {
    marginTop: 12,
  },
});
