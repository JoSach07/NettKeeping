import palette from "./Palette";

const tintColorLight = '#2f95dc';
const tintColorDark = '#fff';

export default {
  light: {
    // Text colors
    text: palette.neutrals[900],
    successText: palette.success[900],
    warningText: palette.warning[900],
    dangerText: palette.danger[900],
    infoText: palette.info[900],
    textMuted: palette.neutrals[300],

    // Background colors
    background: palette.neutrals[100],
    successBackground: palette.success[100],
    warningBackground: palette.warning[100],
    dangerBackground: palette.danger[100],
    infoBackground: palette.info[100],

    // Border colors
    border: palette.primary[300],
    successBorder: palette.success[300],
    warningBorder: palette.warning[300],
    dangerBorder: palette.danger[300],
    infoBorder: palette.info[300],
    tint: tintColorLight,

    // Primary button colors
    buttonPrimary: palette.primary[500],
    buttonPrimaryBackground: palette.primary[500],
    buttonPrimaryBorder: palette.primary[700],
    buttonPrimaryHighlighted: palette.primary[200],
    buttonDisabled: palette.neutrals[400],

    // Success button colors
    buttonSuccess: palette.success[500],
    buttonSuccessBackground: palette.success[500],
    buttonSuccessBorder: palette.success[700],
    buttonSuccessHighlighted: palette.success[200],

    // Warning button colors
    buttonWarning: palette.warning[500],
    buttonWarningBackground: palette.warning[500],
    buttonWarningBorder: palette.warning[700],
    buttonWarningHighlighted: palette.warning[200],

    // Danger button colors
    buttonDanger: palette.danger[500],
    buttonDangerBackground: palette.danger[500],
    buttonDangerBorder: palette.danger[700],
    buttonDangerHighlighted: palette.danger[200],
  },
  dark: {
    // Text colors
    text: palette.neutrals[100],
    successText: palette.success[100],
    warningText: palette.warning[100],
    dangerText: palette.danger[100],
    infoText: palette.info[100],
    textMuted: palette.neutrals[700],

    // Background colors
    background: palette.neutrals[900],
    successBackground: palette.success[900],
    warningBackground: palette.warning[900],
    dangerBackground: palette.danger[900],
    infoBackground: palette.info[900],

    // Border colors
    border: palette.primary[700],
    successBorder: palette.success[700],
    warningBorder: palette.warning[700],
    dangerBorder: palette.danger[700],
    infoBorder: palette.info[700],
    tint: tintColorDark,

    // Primary button colors
    buttonPrimary: palette.primary[500],
    buttonPrimaryBackground: palette.primary[500],
    buttonPrimaryBorder: palette.primary[700],
    buttonPrimaryHighlighted: palette.primary[300],
    buttonDisabled: palette.neutrals[600],

    // Success button colors
    buttonSuccess: palette.success[500],
    buttonSuccessBackground: palette.success[500],
    buttonSuccessBorder: palette.success[700],
    buttonSuccessHighlighted: palette.success[300],

    // Warning button colors
    buttonWarning: palette.warning[500],
    buttonWarningBackground: palette.warning[500],
    buttonWarningBorder: palette.warning[700],
    buttonWarningHighlighted: palette.warning[300],

    // Danger button colors
    buttonDanger: palette.danger[500],
    buttonDangerBackground: palette.danger[500],
    buttonDangerBorder: palette.danger[700],
    buttonDangerHighlighted: palette.danger[300],
  },
};
