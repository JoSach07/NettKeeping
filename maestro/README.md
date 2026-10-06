# NettKeeping — Maestro suite

Automated version of the FCT, written 2026-10-05 against an EAS `preview`
build (`io.github.josach07.nettkeeping`) on a Galaxy A9 2018.

## Running

From the repo root, with the phone on `adb devices`:

```
maestro test maestro/flows                     # everything (about 1.5 h on the A9)
maestro test maestro/flows/04-home.yaml        # one flow
maestro test maestro/flows --exclude-tags known-bug
```

Every flow wipes NettKeeping's data first (`clearState`), so never point this at
your real phone. Screenshots for the visual checks land in
`maestro/screenshots/` (git-ignored).

## Flows

Last full run: 2026-10-07 (second run, preview build with the #21-#23 fixes
and the #22 keyboard-blur fix) on the A9: every flow passed end to end, each
flow in one go, every Save/Clear tapped once with no retries. Times are rough: 01 ~5 min, 02 ~13, 03 ~8, 04 ~10,
05 ~6, 06 ~7, 07 ~8, 08 ~5, 09 ~11, 10 ~3, 11 ~3, 12 ~3, 13 ~4, so about
1.5 h for the suite.

| Flow | FCT sheet / feature | Status (2026-10-07) |
|---|---|---|
| 01-manage-accounts | Manage Accounts | Pass |
| 02-create-transaction | Create Transaction (income, spending, transfer, description, clear, re-pick, date) | Pass |
| 03-create-investment-transaction | Create Transaction (investment rows) + decimal quantities | Pass |
| 04-home | Home | Pass |
| 05-accounts | Accounts + Account Transactions | Pass |
| 06-investments | Investment screen + back-dated edit (FCT history bugs) | Pass |
| 07-manage-investments | Manage Investments + opening anchor | Pass |
| 08-investment-adjust | Adjust (October) | Pass |
| 09-manage-categories | Manage Categories | Pass |
| 10-manage-investment-categories | Manage Investment Category | Pass (used-category half now runs; replaces into a "Commodities" category the flow creates) |
| 11-settings | Settings (theme, left-handed, startup, nav rows, help, backup validation) | Pass |
| 12-lock | PIN set up, unlock, recovery code reset, disable | Pass |
| 13-bulk-insert | Bulk insert dialog | Pass |

Screenshots for the visual checks default to `maestro/screenshots/` relative to
where you run Maestro. If you run it from somewhere other than the repo root
(e.g. through a tool), pass `-e SHOTS=<absolute path to maestro/screenshots>`.

## Manual checklist (Maestro can't do these)

- [ ] Biometrics: enable, unlock with fingerprint
- [ ] Export output directory: pick a folder
- [ ] Excel export from Home, an account card and an investment card: file
      saved, success popup centred (FCT bug), file opens and looks right
- [ ] Export data (backup) with a valid password; Import data from that file,
      including picking a non-backup file
- [ ] Bulk insert: download template, upload a filled file (`outputs/fillTemplate.py`),
      preview, import; a Google Sheets file shows the "document from another app" message
- [ ] Charts: look at `maestro/screenshots/*` — no flat 0 line on a new investment
- [ ] Description over 255: counter and border red (`02-description-over-limit.png`)
- [ ] Dark theme looks right (`11-settings-dark.png`)

## Things the flows work around (keep these in mind when editing)

- Pickers (`PickerModal`) no longer focus their search box on open, so don't
  `hideKeyboard` after opening one: it would press Back and close the picker.
- Long lists (about 30 transaction categories) take more than Maestro's default
  20 s to scroll on the A9: the category screens and pickers use `timeout: 60000`.
- Scroll to the very top of Create Transaction (`createTransaction.bulkInsert`)
  before tapping Income/Spending: a type button half under the status bar
  ignores the tap.
- Account balances are anchored to the account's creation day: a transaction
  dated before it moves the opening balance, not the current balance. Flows
  that check balances must save with today's date.
- Investment categories: a fresh install seeds "General" (reserved: no
  rename/delete) plus Bonds, Crypto, Mutual Funds, Precious Metals, Stocks and
  Time Deposits. Don't create a category with one of those names.
- `hideKeyboard` with no keyboard open presses **Back**. Only call it right
  after typing. `subflows/type.yaml` checks the field took focus first.
- A field under the status bar doesn't focus when tapped; `type.yaml`
  scrolls it to the middle first.
- Closing the keyboard with Back used to make the next tap get swallowed on
  Android 10 (the A9): RN's ScrollView still saw the focused field as having
  an open keyboard. Fixed 2026-10-07 in the app (`useBlurInputOnKeyboardHide`);
  the flows tap once and must not retry.
- The success popup auto-hides in 3 s and is easy to miss on the A9;
  `save-transaction.yaml` waits for the "Saving…" popup to go instead.
- Searchable pickers open the keyboard over the list: hide it before tapping
  an option.
- The Adjust panel and the investment form are taller than the A9 screen:
  scroll to Save/Cancel/Delete before tapping.
- A fresh install seeds 11 income and 17 spending starter categories (since
  2026-10-06; Salary and Bonus among them), so category lists are long: scroll
  to rows before tapping, and don't create a category with a starter name.
- History screens list **newest first** (since 2026-10-06): `row.0` is the latest entry.
  Only Adjustment rows have `<screen>.edit.N` / `<screen>.delete.N`; deleting
  confirms with `deleteAdjustment.confirm`.

## Found while writing the suite (2026-10-05, not fixed)

1. ~~**Re-picking the same value on Create Transaction is ignored.**~~ FIXED
   2026-10-06: the selection screen now returns a `selectionNonce`. Covered by
   the re-pick section of `02-create-transaction.yaml`.
2. ~~**A category created from the dropdown is sometimes not selected.**~~
   FIXED 2026-10-06: createTransaction now applies an unknown category id together
   with the refreshed category list. Device-checked 10/10.
3. **Create Transaction: "Clear" wraps to "Clea / r" and Save shifts left** after
   the keyboard has been shown once.
4. ~~**Adjust panel's buttons are cut off at the bottom** on the A9 until you
   scroll the panel.~~ ACCEPTED 2026-10-06, not fixing: same as the other tall
   form modals. The delete-confirmation half is gone (delete moved to the
   history rows).
5. ~~Fresh install: Income defaults to the reserved **Investment Liquidation**.~~
   FIXED 2026-10-06: starter categories are seeded on a fresh install.
6. Smaller: the quantity helper turns red but still says "allows 2 decimals"
   when the real error is selling more than held; the recovery code wraps its
   last character onto a second line; Quantity History didn't refresh when I came
   back to it after saving elsewhere (seen once); the PIN help text says
   the PIN protects exports, but exports ask for their own backup password
   (from reading the code, worth a look).
