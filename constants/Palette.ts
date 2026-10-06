export const palette = {
  neutrals: {
    100: '#E5EEEA',
    200: '#BED1CA',
    300: '#9AB5AB',
    400: '#7A998D',
    500: '#5D7C70',
    600: '#3D6354',
    700: '#30634F',
    800: '#103024',
    900: '#051710',
  },
  primary: {
    100: '#CFE5DA',
    200: '#97E0BC',
    300: '#63DB9F',
    400: '#31D684',
    500: '#00D26A',
    600: '#03AB57',
    700: '#048746',
    800: '#046334',
    900: '#034022',
  },
  success: {
    100: '#CFE5D0',
    200: '#98E39B',
    300: '#65E06B',
    400: '#30DB3C',
    500: '#00D90E',
    600: '#02B20E',
    700: '#038C0C',
    800: '#04690B',
    900: '#034207',
  },
  warning: {
    100: '#F2F3D0',
    200: '#EDF09E',
    300: '#E6EB6E',
    400: '#E2E83F',
    500: '#DEE511',
    600: '#B7BD0B',
    700: '#929608',
    800: '#6A6E04',
    900: '#424502',
  },
  danger: {
    100: '#F6DFDF',
    200: '#F2A7A7',
    300: '#ED7272',
    400: '#E53E3E',
    500: '#E00E0E',
    600: '#BD0909',
    700: '#990505',
    800: '#750202',
    900: '#510000',
  },
  info: {
    100: '#CAF0F4',
    200: '#97E7F0',
    300: '#65DDEB',
    400: '#35D4E5',
    500: '#05C9DF',
    600: '#05A3B5',
    700: '#067C8A',
    800: '#06555E',
    900: '#042F33',
  },
} as const;

// Preset swatches offered when choosing a category colour. Shared by Manage
// Categories and the inline "New Category" popup so a category created either
// way looks the same. Green and red lead, since spending/income categories are
// the common cases.
export const categoryColorOptions = [
  '#4CE466',
  '#E21B1B',
  '#2F80ED',
  '#F2C94C',
  '#BB6BD9',
  '#F2994A',
  '#00C2A8',
  '#EB5757',
];

export default palette;
