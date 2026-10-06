// Pure replay of an investment's history entries. Shared by
// rebuildInvestmentState (database/tables/transactions.tsx) and the version-6
// migration (database/dbService.ts). Must not import anything that imports
// dbService (the table modules do), or dbService would import itself in a
// cycle; utils/investmentNumbers only imports utils/moneyInput, which has no
// imports, so it is safe.
//
// The creation ("opening") entry means "held this many AS OF the creation
// day" — the same model accounts use for their balance anchor:
// - Entries dated BEFORE the creation day do not add to today's quantity.
//   They explain how the holding got there: the position before the earliest
//   of them is  opening quantity − (sum of their deltas).
// - Entries ON or after the creation day add as usual (same-day counts as
//   after, matching accounts' `>= BalanceAnchorDate`).
// - An opening entry with quantity 0 states no position (an investment created
//   empty, e.g. inline from a transaction), so nothing is anchored and every
//   entry simply adds, starting from zero. Anchoring at 0 would refuse the
//   back-dated purchase that inline creation exists for.
//
// For the opening entry, QuantityDelta holds that stated quantity. The
// replayed running quantity at the opening entry always equals it.

export type InvestmentReplayEntry = {
    Id: number;
    QuantityDelta: number;
    Quantity: number;
    UnitValue: number;
    CreatedAt: string;
    IsOpening: number;
};

export type InvestmentReplayResult =
    | {
          Status: 'Success';
          // Running quantity after each entry, by entry Id.
          quantities: Map<number, number>;
          finalQuantity: number;
          // Unit value of the latest entry, or 0 when there are none.
          lastUnitValue: number;
      }
    | { Status: 'Error'; Message: string };

import { formatQuantity } from '@/utils/investmentNumbers';

const dayOf = (rawDate: string): string => String(rawDate).split(/[ T]/)[0];

// 'YYYY-MM-DD' -> 'DD/MM/YYYY', the format the app shows dates in.
const formatDay = (day: string): string => {
    const [year, month, date] = day.split('-');
    return year && month && date ? `${date}/${month}/${year}` : day;
};

// quantityDecimals only affects how the opening quantity is worded in an error
// message; the replay itself sums scaled integers and never needs the scale.
export const replayInvestmentEntries = (
    entries: InvestmentReplayEntry[],
    quantityDecimals: number = 0
): InvestmentReplayResult => {
    // Date order; within a day the opening entry goes first, so same-day
    // entries land after the anchor; then insertion order.
    const ordered = [...entries].sort((a, b) => {
        const byDay = dayOf(a.CreatedAt).localeCompare(dayOf(b.CreatedAt));
        if (byDay !== 0) {
            return byDay;
        }
        if (Boolean(a.IsOpening) !== Boolean(b.IsOpening)) {
            return a.IsOpening ? -1 : 1;
        }
        return a.Id - b.Id;
    });

    const opening = ordered.find((entry) => entry.IsOpening && entry.QuantityDelta > 0) ?? null;

    let runningQuantity = 0;
    if (opening) {
        const anchorDay = dayOf(opening.CreatedAt);
        const preAnchorChange = ordered
            .filter((entry) => entry !== opening && dayOf(entry.CreatedAt) < anchorDay)
            .reduce((sum, entry) => sum + entry.QuantityDelta, 0);
        runningQuantity = opening.QuantityDelta - preAnchorChange;

        if (runningQuantity < 0) {
            return {
                Status: 'Error',
                Message:
                    `Entries dated before ${formatDay(anchorDay)} add up to more than the ` +
                    `${formatQuantity(opening.QuantityDelta, quantityDecimals)} this investment was created with.`,
            };
        }
    }

    const quantities = new Map<number, number>();
    for (const entry of ordered) {
        if (entry !== opening) {
            runningQuantity += entry.QuantityDelta;
        }
        if (runningQuantity < 0) {
            return {
                Status: 'Error',
                Message: 'This change would make the investment quantity negative at some point in its history.',
            };
        }
        quantities.set(entry.Id, runningQuantity);
    }

    return {
        Status: 'Success',
        quantities,
        finalQuantity: runningQuantity,
        lastUnitValue: ordered[ordered.length - 1]?.UnitValue ?? 0,
    };
};
