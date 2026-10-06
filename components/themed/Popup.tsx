import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { useAppTheme } from '@/hooks/useAppTheme';

import Text from './Text';

type PopupVariant = 'danger' | 'info' | 'success' | 'warning';

// The header is deliberately never mirrored, in left-handed mode or otherwise:
// the icon and title read first and the close button trails. A `closeSide`
// prop used to flip the whole row, which put the X before the title.
type PopupProps = {
  // Raw technical text behind a generic message. Hidden until asked for, so the
  // plain sentence stays the default and the detail is one tap away.
  detail?: string | null;
  message: string;
  onClose: () => void;
  style?: StyleProp<ViewStyle>;
  title?: string;
  variant?: PopupVariant;
};

const variantMeta: Record<PopupVariant, { icon: keyof typeof FontAwesome.glyphMap; title: string }> = {
  danger: {
    icon: 'exclamation-circle',
    title: 'Error',
  },
  info: {
    icon: 'info-circle',
    title: 'Info',
  },
  success: {
    icon: 'check-circle',
    title: 'Success',
  },
  warning: {
    icon: 'exclamation-circle',
    title: 'Warning',
  },
};

const getWordCount = (message: string) => message.trim().split(/\s+/).filter(Boolean).length;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const popupShadow = Platform.select({
  web: {
    boxShadow: '0 2px 5px rgba(0, 0, 0, 0.18)',
  },
  default: {
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
  },
});

const getAutoHideMs = (message: string, variant: PopupVariant) => {
  if (variant === 'danger') {
    return null;
  }

  if (variant === 'warning') {
    return 5000;
  }

  return getWordCount(message) <= 10 ? 3000 : 5000;
};

// Each distinct message gets a fresh PopupBody, and with it fresh Animated
// values. Reusing one instance across messages broke when an info popup was
// replaced by an error while its grow animation was still running (e.g.
// createTransaction's "Saving transaction..." followed by a failed save): the effect
// cleanup stops the native spring, the new message sets the scale to 1, and
// then the stopped spring's end callback arrives and syncs the JS value back to
// wherever the spring had got to — so the error appeared at full size and
// then shrank to ~40%. A new instance has nothing left over to be overwritten.
// Keyed on the same three props the animation effect depends on, so an
// identical repeat message still does not re-animate (see the conventions note
// on clearing popup state before each attempt).
export default function Popup(props: PopupProps) {
  const { message, title, variant = 'danger' } = props;
  return <PopupBody key={`${variant}\u0000${title ?? ''}\u0000${message}`} {...props} />;
}

function PopupBody({
  detail,
  message,
  onClose,
  style,
  title,
  variant = 'danger',
}: PopupProps) {
  const { colors } = useAppTheme();
  const [detailExpanded, setDetailExpanded] = useState(false);
  const growScale = useRef(new Animated.Value(0)).current;
  const shakeX = useRef(new Animated.Value(0)).current;
  const meta = variantMeta[variant];
  const backgroundColor =
    variant === 'success'
      ? colors.successBackground
      : variant === 'warning'
        ? colors.warningBackground
        : variant === 'info'
          ? colors.infoBackground
          : colors.dangerBackground;
  const borderColor =
    variant === 'success'
      ? colors.successBorder
      : variant === 'warning'
        ? colors.warningBorder
        : variant === 'info'
          ? colors.infoBorder
          : colors.dangerBorder;
  const textColor =
    variant === 'success'
      ? colors.successText
      : variant === 'warning'
        ? colors.warningText
        : variant === 'info'
          ? colors.infoText
          : colors.dangerText;
  const autoHideMs = getAutoHideMs(message, variant);

  useEffect(() => {
    // Never time out while the detail is open — the user is reading it.
    if (!autoHideMs || detailExpanded) {
      return;
    }

    const timeoutId = setTimeout(onClose, autoHideMs);
    return () => clearTimeout(timeoutId);
  }, [autoHideMs, detailExpanded, onClose]);

  useEffect(() => {
    growScale.setValue(variant === 'danger' ? 1 : 0);
    shakeX.setValue(0);

    const animations = [];

    if (variant === 'danger') {
      animations.push(
        Animated.sequence([
          Animated.timing(shakeX, { duration: 45, toValue: -8, useNativeDriver: true }),
          Animated.timing(shakeX, { duration: 70, toValue: 8, useNativeDriver: true }),
          Animated.timing(shakeX, { duration: 70, toValue: -6, useNativeDriver: true }),
          Animated.timing(shakeX, { duration: 70, toValue: 6, useNativeDriver: true }),
          Animated.timing(shakeX, { duration: 55, toValue: -3, useNativeDriver: true }),
          Animated.timing(shakeX, { duration: 55, toValue: 0, useNativeDriver: true }),
        ]),
      );
    } else {
      animations.push(
        Animated.spring(growScale, {
          friction: 7,
          tension: 120,
          toValue: 1,
          useNativeDriver: true,
        }),
      );
    }

    const animation = Animated.parallel(animations);

    animation.start();
    return () => animation.stop();
  }, [growScale, message, shakeX, title, variant]);

  const popupContent = (
    <>
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <FontAwesome name={meta.icon} size={17} color={textColor} />
          <Text style={[styles.title, { color: textColor }]}>{title ?? meta.title}</Text>
        </View>
        <View style={styles.closeButton} testID="popup.close">
          <FontAwesome name="times" size={16} color={textColor} />
        </View>
      </View>
      <Text style={[styles.message, { color: textColor }]} testID="popup.message">{message}</Text>
      {detail ? (
        <>
          {/* Nested Pressable, so tapping the toggle does not reach the
              popup's own close handler. */}
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setDetailExpanded((current) => !current)}
            style={styles.detailToggle}
            testID="popup.detailsToggle">
            <Text style={[styles.detailToggleLabel, { color: textColor }]}>
              {detailExpanded ? 'Hide details' : 'Details'}
            </Text>
            <FontAwesome
              name={detailExpanded ? 'angle-up' : 'angle-down'}
              size={16}
              color={textColor}
            />
          </Pressable>
          {detailExpanded ? (
            <Text selectable style={[styles.detailText, { color: textColor }]} testID="popup.detail">
              {detail}
            </Text>
          ) : null}
        </>
      ) : null}
    </>
  );

  return (
    <AnimatedPressable
      accessibilityLabel={`Close ${title ?? meta.title}`}
      accessibilityRole="button"
      onPress={onClose}
      testID={`popup.${variant}`}
      style={[
        styles.popup,
        {
          backgroundColor,
          borderColor,
          transform: [{ translateX: shakeX }, { scale: growScale }],
        },
        style,
      ]}>
      {popupContent}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    alignItems: 'center',
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  detailText: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
    opacity: 0.85,
  },
  detailToggle: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
    minHeight: 28,
  },
  detailToggleLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  message: {
    fontSize: 14,
    marginTop: 4,
  },
  popup: {
    borderRadius: 6,
    borderWidth: 1,
    paddingBottom: 12,
    paddingHorizontal: 14,
    paddingTop: 10,
    zIndex: 10,
    ...popupShadow,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  titleWrap: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
});
