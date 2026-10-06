import { TextInputProps } from 'react-native';

import TextField from './TextField';

type NumericFieldProps = TextInputProps & {
  error?: boolean;
  // Forwarded to TextField, which renders it under the input. Declared here
  // because the spread below passes it through either way.
  helperText?: string;
  label: string;
};

export default function NumericField(props: NumericFieldProps) {
  return <TextField keyboardType="number-pad" inputMode="numeric" {...props} />;
}
