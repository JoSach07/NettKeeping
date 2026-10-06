import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useState } from 'react';
import { Pressable, StyleProp, StyleSheet, TextStyle, View, ViewStyle } from 'react-native';

import Text from './Text';

type Align = 'center' | 'left';

type DetailToggleProps = {
  color: string;
  detail: string;
  // Matches the message above it, so the toggle sits under its text.
  align?: Align;
};

// The Details / Hide details toggle from Popup, for errors written straight
// onto a screen instead of shown in a popup. The raw text stays hidden until
// asked for, and is selectable so it can be copied into a bug report.
export function DetailToggle({ align = 'center', color, detail }: DetailToggleProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => setExpanded((current) => !current)}
        style={[styles.toggle, { alignSelf: align === 'center' ? 'center' : 'flex-start' }]}>
        <Text style={[styles.toggleLabel, { color }]}>{expanded ? 'Hide details' : 'Details'}</Text>
        <FontAwesome name={expanded ? 'angle-up' : 'angle-down'} size={16} color={color} />
      </Pressable>
      {expanded ? (
        <Text selectable style={[styles.detailText, { color, textAlign: align }]}>
          {detail}
        </Text>
      ) : null}
    </>
  );
}

type ErrorTextProps = {
  color: string;
  // Raw technical text behind the message, from describeError / a result's Detail.
  detail?: string | null;
  message: string;
  align?: Align;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

export default function ErrorText({ align = 'center', color, detail, message, style, textStyle }: ErrorTextProps) {
  return (
    <View style={style}>
      <Text style={[textStyle, { color }]}>{message}</Text>
      {detail ? <DetailToggle align={align} color={color} detail={detail} /> : null}
    </View>
  );
}

// Same metrics as Popup's toggle.
const styles = StyleSheet.create({
  detailText: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
    opacity: 0.85,
  },
  toggle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
    minHeight: 28,
  },
  toggleLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
});
