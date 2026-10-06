import FontAwesome from '@expo/vector-icons/FontAwesome';
import { usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '@/hooks/useAppTheme';

type NavButtonProps = {
  active: boolean;
  icon: React.ComponentProps<typeof FontAwesome>['name'];
  iconSize: number;
  label: string;
  marginHorizontal: number;
  navHeight: number;
  onPress: () => void;
  size: number;
  slotWidth: number;
  testID: string;
  variant: 'primary' | 'secondary';
};

function NavButton({
  active,
  icon,
  iconSize,
  label,
  marginHorizontal,
  navHeight,
  onPress,
  size,
  slotWidth,
  testID,
  variant,
}: NavButtonProps) {
  const { colors } = useAppTheme();
  const buttonColor = active ? colors.buttonPrimaryHighlighted : colors.buttonPrimary;
  const iconColor =
    variant === 'secondary'
      ? active
        ? colors.buttonPrimaryHighlighted
        : colors.text
      : active
        ? colors.buttonPrimary
        : colors.text;

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.centered,
        {
          height: navHeight,
          marginHorizontal,
          width: slotWidth,
        },
        pressed && styles.pressed,
      ]}>
      {variant === 'primary' ? (
        <View
          style={[
            styles.centered,
            {
              borderRadius: size / 2,
              height: size,
              width: size,
              backgroundColor: buttonColor,
              borderColor: active ? buttonColor : colors.buttonPrimaryBorder,
            },
          ]}>
          <FontAwesome name={icon} size={iconSize} color={iconColor} />
        </View>
      ) : (
        <FontAwesome name={icon} size={iconSize} color={iconColor} />
      )}
    </Pressable>
  );
}

export default function BottomNav() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  // Calculations for various element sizes.
  /// Most are to prevent overly small or large element on devices with unusual aspect ratio such as foldables.
  const sizeBasis = Math.min(width, height * 0.55);
  const secondarySlotWidth = sizeBasis * 0.14;
  const primarySlotWidth = sizeBasis * 0.19;
  const slotMargin = sizeBasis * 0.025;
  const secondaryButtonSize = sizeBasis * 0.15;
  const secondaryIconSize = secondaryButtonSize * 0.54;
  const primaryButtonSize = sizeBasis * 0.16;
  const navHeight = Math.max(height * 0.045, primaryButtonSize * 1.1);

  return (
    <View
      style={[
        styles.container,
        {
          height: navHeight + insets.bottom,
          paddingBottom: insets.bottom,
          backgroundColor: colors.background,
        },
      ]}>
      <NavButton
        active={pathname === '/'}
        icon="home"
        iconSize={secondaryIconSize}
        label="Home"
        marginHorizontal={slotMargin}
        navHeight={navHeight}
        onPress={() => router.navigate('/')}
        testID="nav.home"
        size={secondaryButtonSize}
        slotWidth={secondarySlotWidth}
        variant="secondary"
      />
      <NavButton
        active={pathname === '/accounts' || pathname === '/accountTransactions'}
        icon="university"
        iconSize={secondaryIconSize}
        label="Accounts"
        marginHorizontal={slotMargin}
        navHeight={navHeight}
        onPress={() => router.navigate('/accounts')}
        testID="nav.accounts"
        size={secondaryButtonSize}
        slotWidth={secondarySlotWidth}
        variant="secondary"
      />
      <NavButton
        active={pathname === '/createTransaction'}
        icon="dollar"
        iconSize={secondaryIconSize}
        label="Create transaction"
        marginHorizontal={slotMargin}
        navHeight={navHeight}
        onPress={() => router.navigate('/createTransaction')}
        testID="nav.create"
        size={primaryButtonSize}
        slotWidth={primarySlotWidth}
        variant="primary"
      />
      <NavButton
        active={pathname === '/investments' || pathname === '/investmentValueHistory' || pathname === '/investmentQuantityHistory'}
        icon="line-chart"
        iconSize={secondaryIconSize}
        label="Investments"
        marginHorizontal={slotMargin}
        navHeight={navHeight}
        onPress={() => router.navigate('/investments')}
        testID="nav.investments"
        size={secondaryButtonSize}
        slotWidth={secondarySlotWidth}
        variant="secondary"
      />
      <NavButton
        active={pathname === '/appSettings'}
        icon="cog"
        iconSize={secondaryIconSize}
        label="App settings"
        marginHorizontal={slotMargin}
        navHeight={navHeight}
        onPress={() => router.navigate('/appSettings')}
        testID="nav.settings"
        size={secondaryButtonSize}
        slotWidth={secondarySlotWidth}
        variant="secondary"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
});
