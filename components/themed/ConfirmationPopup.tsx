import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Platform, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { useAppTheme } from '@/hooks/useAppTheme';

import Text from './Text';

type ConfirmationVariant = 'danger' | 'info' | 'warning';
type ConfirmationActionVariant = 'danger' | 'default' | 'primary' | 'success' | 'warning';

// The header is deliberately never mirrored — see the matching note in Popup.
type ConfirmationPopupProps = {
  // 'end' keeps both buttons grouped on the right; 'spread' pushes Cancel to
  // the left edge and the confirm button to the right, matching the Cancel/Save
  // row on the Manage Accounts form.
  actionsLayout?: 'end' | 'spread';
  confirmLabel: string;
  confirmVariant?: ConfirmationActionVariant;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  style?: StyleProp<ViewStyle>;
  title: string;
  variant?: ConfirmationVariant;
};

const variantMeta: Record<ConfirmationVariant, { icon: keyof typeof FontAwesome.glyphMap }> = {
  danger: {
    icon: 'exclamation-circle',
  },
  info: {
    icon: 'info-circle',
  },
  warning: {
    icon: 'exclamation-circle',
  },
};

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

export default function ConfirmationPopup({
  actionsLayout = 'end',
  confirmLabel,
  confirmVariant = 'primary',
  message,
  onCancel,
  onConfirm,
  style,
  title,
  variant = 'info',
}: ConfirmationPopupProps) {
  const { colors } = useAppTheme();
  const meta = variantMeta[variant];
  const backgroundColor =
    variant === 'warning' ? colors.warningBackground : variant === 'info' ? colors.infoBackground : colors.dangerBackground;
  const borderColor =
    variant === 'warning' ? colors.warningBorder : variant === 'info' ? colors.infoBorder : colors.dangerBorder;
  const textColor = variant === 'warning' ? colors.warningText : variant === 'info' ? colors.infoText : colors.dangerText;
  const getActionColors = (actionVariant: ConfirmationActionVariant) => {
    if (actionVariant === 'danger') {
      return { backgroundColor: colors.buttonDangerBackground, borderColor: colors.buttonDangerBorder };
    }

    if (actionVariant === 'success') {
      return { backgroundColor: colors.buttonSuccessBackground, borderColor: colors.buttonSuccessBorder };
    }

    if (actionVariant === 'warning') {
      return { backgroundColor: colors.buttonWarningBackground, borderColor: colors.buttonWarningBorder };
    }

    if (actionVariant === 'primary') {
      return { backgroundColor: colors.buttonPrimaryBackground, borderColor: colors.buttonPrimaryBorder };
    }

    return { backgroundColor: colors.background, borderColor: colors.border };
  };

  const confirmButtonStyle = getActionColors(confirmVariant);
  const cancelButtonStyle = getActionColors('default');

  return (
    <View
      accessibilityRole="alert"
      testID={`confirm.${variant}`}
      style={[
        styles.popup,
        {
          backgroundColor,
          borderColor,
        },
        style,
      ]}>
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <FontAwesome name={meta.icon} size={17} color={textColor} />
          <Text style={[styles.title, { color: textColor }]}>{title}</Text>
        </View>
        <Pressable accessibilityLabel="Cancel confirmation" accessibilityRole="button" onPress={onCancel} style={styles.closeButton} testID="confirm.close">
          <FontAwesome name="times" size={16} color={textColor} />
        </Pressable>
      </View>

      <Text style={[styles.message, { color: textColor }]} testID="confirm.message">{message}</Text>

      <View style={[styles.actions, actionsLayout === 'spread' && styles.actionsSpread]}>
        <Pressable accessibilityRole="button" onPress={onCancel} testID="confirm.cancel" style={({ pressed }) => [styles.actionButton, cancelButtonStyle, pressed && styles.pressed]}>
          <Text style={styles.actionText}>Cancel</Text>
        </Pressable>

        <Pressable accessibilityRole="button" onPress={onConfirm} testID="confirm.ok" style={({ pressed }) => [styles.actionButton, confirmButtonStyle, pressed && styles.pressed]}>
          <Text style={styles.actionText}>{confirmLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    justifyContent: 'center',
    minWidth: 82,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 12,
  },
  actionsSpread: {
    justifyContent: 'space-between',
  },
  actionText: {
    fontSize: 14,
  },
  closeButton: {
    alignItems: 'center',
    height: 30,
    justifyContent: 'center',
    width: 30,
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
  pressed: {
    opacity: 0.65,
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
