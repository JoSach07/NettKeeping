import FontAwesome from '@expo/vector-icons/FontAwesome';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';

import Text from '@/components/themed/Text';
import { useAppTheme } from '@/hooks/useAppTheme';
import ModalKeyboardAvoider from '@/components/themed/ModalKeyboardAvoider';

export type PickerModalItem = {
  id: number | string;
  label: string;
  sublabel?: string;
};

type PickerModalProps<T extends PickerModalItem> = {
  emptyText?: string;
  items: T[];
  onClose: () => void;
  // Fires when the end of the (unfiltered) list is reached; use for paged loads.
  onEndReached?: () => void;
  onSelect: (item: T) => void;
  renderTrailing?: (item: T) => ReactNode;
  searchable?: boolean;
  selectedId?: number | string | null;
  title: string;
  visible: boolean;
};

export default function PickerModal<T extends PickerModalItem>({
  emptyText = 'No options available.',
  items,
  onClose,
  onEndReached,
  onSelect,
  renderTrailing,
  searchable = false,
  selectedId = null,
  title,
  visible,
}: PickerModalProps<T>) {
  const { colors } = useAppTheme();
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!visible) {
      setSearch('');
    }
  }, [visible]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return items;
    }

    return items.filter((item) => item.label.toLowerCase().includes(query));
  }, [items, search]);

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <ModalKeyboardAvoider>
        <View style={styles.backdrop}>
          <Pressable accessibilityLabel="Close picker" style={styles.backdropPressable} onPress={onClose} testID="picker.backdrop" />
          <View style={[styles.panel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={styles.title}>{title}</Text>

            {searchable ? (
              <TextInput
                accessibilityLabel={`Search ${title.toLowerCase()}`}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setSearch}
                placeholder="Search"
                placeholderTextColor={colors.textMuted}
                style={[styles.searchInput, { borderColor: colors.border, color: colors.text }]}
                testID="picker.search"
                value={search}
              />
            ) : null}

            <FlatList
              data={filteredItems}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(item) => String(item.id)}
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: colors.textMuted }]}>
                  {search ? 'No results found.' : emptyText}
                </Text>
              }
              onEndReached={search ? undefined : onEndReached}
              onEndReachedThreshold={0.4}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: item.id === selectedId }}
                  onPress={() => onSelect(item)}
                  testID={`picker.option.${item.label}`}
                  style={({ pressed }) => [
                    styles.optionRow,
                    item.id === selectedId && { backgroundColor: colors.buttonPrimaryHighlighted },
                    pressed && styles.pressed,
                  ]}>
                  <View style={styles.optionText}>
                    <Text style={styles.optionLabel}>{item.label}</Text>
                    {item.sublabel ? (
                      <Text style={[styles.optionSublabel, { color: colors.textMuted }]}>{item.sublabel}</Text>
                    ) : null}
                  </View>
                  {renderTrailing ? renderTrailing(item) : null}
                  {item.id === selectedId ? <FontAwesome name="check" size={18} color={colors.text} /> : null}
                </Pressable>
              )}
              style={styles.list}
            />
          </View>
        </View>
      </ModalKeyboardAvoider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    flex: 1,
    justifyContent: 'center',
    padding: 16,
  },
  backdropPressable: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  emptyText: {
    fontSize: 14,
    paddingVertical: 16,
    textAlign: 'center',
  },
  list: {
    flexGrow: 0,
  },
  optionLabel: {
    fontSize: 18,
  },
  optionRow: {
    alignItems: 'center',
    borderRadius: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 12,
  },
  optionSublabel: {
    fontSize: 13,
    marginTop: 2,
  },
  optionText: {
    flex: 1,
    paddingVertical: 8,
  },
  // flexShrink lets the panel give up height when the keyboard shrinks the
  // Modal area (window resize or ModalKeyboardAvoider); the FlatList inside
  // shrinks with it and scrolls — see formModalPanel in manageCategories.
  panel: {
    borderRadius: 8,
    borderWidth: 1,
    flexShrink: 1,
    maxHeight: '78%',
    maxWidth: 360,
    padding: 16,
    width: '90%',
  },
  pressed: {
    opacity: 0.65,
  },
  searchInput: {
    borderRadius: 6,
    borderWidth: 1,
    fontSize: 16,
    marginBottom: 10,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 14,
  },
});
