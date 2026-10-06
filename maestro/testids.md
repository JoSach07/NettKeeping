# NettKeeping — testIDs

The testIDs used by the Maestro flows. Implemented 2026-10-05. If you rename one in code, rename it here and in `maestro/flows` too.

## Naming rules

- Format: `<screen>.<element>`, camelCase on both sides. Example: `createTransaction.save`.
- `<screen>` is the full file/component name (minus `Modal`), never abbreviated: `selectTransactionField`, `categoryBreakdown`, `investmentAdjust`, `excelExport`. Exceptions: `home`, `settings`, `lock`.
- Repeated rows use the **name** as the suffix: `accounts.card.BCA`, `manageAccounts.edit.BCA`. Flows create their own data with known names, so this reads better than IDs. One catch: Maestro's `id:` is a regex, so names used in flows must avoid `( ) . + ?`. The seed data will keep to that.
- Shared components (popups, pickers, calendar) use **global** IDs with no screen prefix, because only one is ever open at a time: `popup.close`, `picker.search`.
- Popups carry their variant: `popup.success` / `popup.danger` / `popup.info` / `popup.warning`. That lets a flow assert the *outcome* without depending on the exact message text.

## Component changes needed first

| Component | Today | Change |
|---|---|---|
| `Button`, `TextField`, `TextAreaField`, `NumericField` | Already spread props onto the native element | None. Passing `testID` works as-is |
| `SelectField`, `MoneyField`, `QuantityField` | Fixed prop lists, so `testID` is silently dropped | Add a `testID?: string` prop and forward it (to the Pressable / TextInput) |
| `Popup` | — | Container `popup.<variant>`, plus `popup.close`, `popup.message`, `popup.detailsToggle`, `popup.detail` |
| `ConfirmationPopup` | — | Container `confirm.<variant>`, plus `confirm.ok`, `confirm.cancel`, `confirm.close`, `confirm.message` |
| `PickerModal` | — | `picker.search`, `picker.option.<label>`, `picker.backdrop` |
| `CalendarPickerModal` (createTransaction date, InvestmentAdjustModal) | — | `calendar.prev`, `calendar.next`, `calendar.day.<1-31>`, `calendar.title` (one shared component, so one subflow drives either) |
| `MonthYearPickerField` | — | Takes a `testID` prefix: `<prefix>` (field), `<prefix>.prevYear`, `<prefix>.nextYear`, `<prefix>.<1-12>` |
| `BottomNav` | — | `nav.home`, `nav.accounts`, `nav.create`, `nav.investments`, `nav.settings` |
| `SettingButton`, `SettingSwitch` (appSettings) | — | Add a `testID` prop; the switch gets `<id>.switch` |

Runtime cost is zero: on Android a testID is just a view tag. About 22 files get touched, but every change is one attribute or a forwarded prop. No logic changes.

## Screens

### Create Transaction (`createTransaction`)
| ID | Element |
|---|---|
| `createTransaction.bulkInsert` | Upload icon in header |
| `createTransaction.type.income` / `createTransaction.type.spending` | Type buttons |
| `createTransaction.category` | Category select |
| `createTransaction.transferFromAccount` / `createTransaction.transferToAccount` | Transfer selects |
| `createTransaction.account` | Account select |
| `createTransaction.investment` | Investment select |
| `createTransaction.investmentQuantity` / `.investmentUnitValue` / `.investmentFees` / `.investmentTotalAmount` | Investment fields |
| `createTransaction.amount` | Amount |
| `createTransaction.transferExchangeRate` / `createTransaction.transferExchangeSwap` | Cross-currency transfer |
| `createTransaction.transferToAmount` | "To Account Receives" |
| `createTransaction.date` | Date field (opens `calendar.*`) |
| `createTransaction.description` / `createTransaction.descriptionCounter` | Description + the 255 counter |
| `createTransaction.clear` / `createTransaction.save` | Action buttons |

### Select Transaction Field (`selectTransactionField`)
| ID | Element |
|---|---|
| `selectTransactionField.back` / `selectTransactionField.search` | Header |
| `selectTransactionField.newInvestment` / `selectTransactionField.newCategory` | "New …" rows |
| `selectTransactionField.option.<name>` | Option rows |
| `selectTransactionField.newCategory.name` / `.color.<hex without #>` / `.cancel` / `.save` | New Category modal |
| `selectTransactionField.newInvestment.name` / `.category` / `.decimals` / `.cancel` / `.save` | New Investment modal |

### Select Investment Category (`selectInvestmentCategory`)
`selectInvestmentCategory.back`, `.search`, `.new`, `.option.<name>`, `.new.name`, `.new.cancel`, `.new.save`

### Bulk Insert modal (`bulkInsert`)
| ID | Element |
|---|---|
| `bulkInsert.close` / `bulkInsert.downloadTemplate` / `bulkInsert.upload` | First view |
| `bulkInsert.preview.list` / `bulkInsert.preview.row.<rowLabel>` / `bulkInsert.preview.errors` | Preview |
| `bulkInsert.back` / `bulkInsert.import` | Preview actions |

### Home (`home`)
| ID | Element |
|---|---|
| `home.export` | Excel icon |
| `home.account` / `home.month` (MonthYearPicker prefix) | Cash-flow filters |
| `home.mode.spending` / `home.mode.income` | Toggle |
| `home.donut` / `home.breakdown.row.<category>` / `home.breakdown.viewAll` | Breakdown |
| `home.investment` / `home.range.<1w / 1m / ytd / 1y>` / `home.investmentChart` | Investment card |

### Category Breakdown (`categoryBreakdown`)
`categoryBreakdown.back`, `categoryBreakdown.account`, `categoryBreakdown.month`, `categoryBreakdown.mode.spending`, `categoryBreakdown.mode.income`, `categoryBreakdown.row.<category>`

### Accounts (`accounts`)
| ID | Element |
|---|---|
| `accounts.manage` | Manage button |
| `accounts.card.<name>` | Card header (collapse/expand) |
| `accounts.balance.<name>` / `accounts.balanceToggle.<name>` | Balance + eye |
| `accounts.range.<name>.<1d / 1w / 1m / 3m / 6m / ytd / 1y / 5y>` | Range buttons |
| `accounts.chart.<name>` | Balance chart |
| `accounts.allTransactions.<name>` / `accounts.export.<name>` | Card buttons |

### Account Transactions (`accountTransactions`)
`accountTransactions.back`, `accountTransactions.list`, `accountTransactions.row.<id>`, `accountTransactions.edit.<id>`, `accountTransactions.delete.<id>`, `accountTransactions.deleteCancel`, `accountTransactions.deleteConfirm`
*(Rows are keyed by transaction Id here: descriptions aren't unique, and a fresh install gives predictable Ids.)*

### Manage Accounts (`manageAccounts`)
| ID | Element |
|---|---|
| `manageAccounts.back` / `manageAccounts.add` | Header |
| `manageAccounts.row.<name>` / `.balanceToggle.<name>` / `.edit.<name>` / `.delete.<name>` | Rows |
| `manageAccounts.form.name` / `.currency` / `.balance` / `.cancel` / `.save` | Add/Edit modal |
| `manageAccounts.deleteCancel` / `manageAccounts.deleteConfirm` | Delete modal |

### Investments (`investments`)
| ID | Element |
|---|---|
| `investments.manage` | Manage button |
| `investments.card.<name>` | Card header |
| `investments.range.<1w / 1m / ytd / 1y>` | Range buttons |
| `investments.chart.vpu.<name>` / `.chart.total.<name>` / `.chart.quantity.<name>` | Charts |
| `investments.valueHistory.<name>` / `.adjust.<name>` / `.quantityHistory.<name>` / `.export.<name>` | 2×2 buttons |

### Investment Adjust modal (`investmentAdjust`)
`investmentAdjust.date`, `investmentAdjust.add`, `investmentAdjust.remove`, `investmentAdjust.quantity`, `investmentAdjust.unitValue`, `investmentAdjust.note`, `investmentAdjust.cancel`, `investmentAdjust.save`

### Value / Quantity History (`investmentValueHistory`, `investmentQuantityHistory`)
`<screen>.back`, `<screen>.row.<index>` (0 = newest: the list is newest first), `<screen>.row.<index>.kind` (Opening / Buy / Sell / Adjustment), `<screen>.row.<index>.amount` (value per unit, or quantity change; the opening row shows its quantity), `<screen>.edit.<index>` / `<screen>.delete.<index>` (Adjustment rows only)

Delete confirmation: `deleteAdjustment.cancel`, `deleteAdjustment.confirm`

### Manage Investments (`manageInvestments`)
| ID | Element |
|---|---|
| `manageInvestments.back` / `.add` | Header |
| `manageInvestments.view.<name>` / `.edit.<name>` / `.delete.<name>` | Rows |
| `manageInvestments.form.name` / `.category` / `.currency` / `.unit` / `.decimals` / `.quantity` / `.unitValue` / `.cancel` / `.save` | Form |
| `manageInvestments.deleteCancel` / `.deleteConfirm` | Delete modal |

### Manage Categories (`manageCategories`)
| ID | Element |
|---|---|
| `manageCategories.back` / `.filter` / `.add` | Header |
| `manageCategories.color.<name>` / `.edit.<name>` / `.delete.<name>` | Rows |
| `manageCategories.form.name` / `.type` / `.hex` / `.h` / `.s` / `.l` / `.cancel` / `.save` | Add/Edit |
| `manageCategories.colorForm.hex` / `.h` / `.s` / `.l` / `.cancel` / `.save` | Change Color |
| `manageCategories.delete.replacement` / `.deleteCancel` / `.deleteConfirm` | Delete modal |

### Manage Investment Categories (`manageInvestmentCategories`)
`.back`, `.add`, `.edit.<name>`, `.delete.<name>`, `.form.name`, `.form.cancel`, `.form.save`, `.delete.replacement`, `.deleteCancel`, `.deleteConfirm`

### Excel Export modal (`excelExport`)
`excelExport.close`, `excelExport.mode.yearly`, `excelExport.mode.monthly`, `excelExport.month` (prefix), `excelExport.prevYear`, `excelExport.nextYear`, `excelExport.cancel`, `excelExport.confirm`

### Settings (`settings`)
| ID | Element |
|---|---|
| `settings.info` / `settings.info.close` | Help popup |
| `settings.theme` / `settings.theme.option.<device / light / dark>` | Theme |
| `settings.leftHanded` / `settings.startOnCreate` | Switch rows (`.switch` suffix on the toggle) |
| `settings.accounts` / `.investments` / `.transactionCategories` / `.investmentCategories` | Nav rows |
| `settings.exportDir` / `settings.exportData` / `settings.importData` | Data rows |
| `settings.backup.password` / `.confirmPassword` / `.status` / `.cancel` / `.confirm` | Backup modal |
| `settings.pin` / `settings.biometrics` | Security switches |
| `settings.pinForm.pin` / `.confirmPin` / `.currentPin` / `.status` / `.cancel` / `.save` | PIN modal |
| `settings.recovery.code` / `.copy` / `.done` | Recovery code modal |

### Lock screen (`lock`)
`lock.pin`, `lock.unlock`, `lock.biometric`, `lock.forgot`, `lock.recoveryCode`, `lock.verifyRecovery`, `lock.backToPin`, `lock.newPin`, `lock.confirmNewPin`, `lock.saveNewPin`, `lock.recoveryCopy`, `lock.recoveryDone`, `lock.retry`

## Flows, manual checklist, findings

See `README.md` in this folder.
