import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import Button from '@/components/themed/Button';
import Text from '@/components/themed/Text';
import { deleteInvestmentAdjustment, InvestmentHistory } from '@/database/tables/investmentHistories';
import { useAppTheme } from '@/hooks/useAppTheme';

export type DeleteAdjustmentOutcome = {
  detail?: string;
  message: string;
  title?: string;
  variant: 'success' | 'danger';
};

// Same confirmation as Account Transactions' delete: a centred panel over the
// screen, Cancel left, Delete right.
export default function DeleteAdjustmentModal({
  adjustment,
  onCancel,
  onDone,
}: {
  adjustment: InvestmentHistory | null;
  onCancel: () => void;
  onDone: (outcome: DeleteAdjustmentOutcome) => void;
}) {
  const { colors } = useAppTheme();
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (adjustment) {
      setDeleting(false);
    }
  }, [adjustment]);

  const cancel = () => {
    if (!deleting) {
      onCancel();
    }
  };

  const confirmDelete = async () => {
    if (!adjustment) {
      return;
    }
    setDeleting(true);
    const result = await deleteInvestmentAdjustment(adjustment.Id);
    setDeleting(false);

    if (result.Status === 'Success') {
      onDone({ message: 'Adjustment deleted.', title: 'Deleted', variant: 'success' });
      return;
    }
    onDone({ detail: result.Detail, message: result.Message ?? 'Failed to delete the adjustment.', variant: 'danger' });
  };

  return (
    <Modal animationType="fade" transparent visible={adjustment !== null} onRequestClose={cancel}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropPressable} onPress={cancel} />
        <View style={[styles.panel, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <Text style={styles.title}>Delete Adjustment</Text>
          <Text style={styles.text}>
            Delete this adjustment? The investment&apos;s quantity and value are recalculated without it.
          </Text>
          <View style={styles.actions}>
            <Button disabled={deleting} onPress={cancel} size="small" testID="deleteAdjustment.cancel">
              Cancel
            </Button>
            <Button disabled={deleting} onPress={confirmDelete} size="small" testID="deleteAdjustment.confirm" variant="danger">
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
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
  panel: {
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 390,
    padding: 16,
    width: '92%',
  },
  text: {
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 14,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 14,
  },
});
