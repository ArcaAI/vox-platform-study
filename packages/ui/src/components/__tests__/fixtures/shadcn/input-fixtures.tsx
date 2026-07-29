import * as React from 'react';
import { Input } from '../../../shadcn/input';

export function InputChangeTracker() {
  const [value, setValue] = React.useState('');
  return (
    <div>
      <Input onChange={(e) => setValue(e.target.value)} data-testid="input" />
      <span data-testid="change-value">{value}</span>
    </div>
  );
}

export function InputFocusBlurTracker() {
  const [status, setStatus] = React.useState('');
  return (
    <div>
      <Input onFocus={() => setStatus('focused')} onBlur={() => setStatus('blurred')} data-testid="input" />
      <span data-testid="focus-status">{status}</span>
    </div>
  );
}

export function InputKeyTracker() {
  const [key, setKey] = React.useState('');
  return (
    <div>
      <Input onKeyDown={(e) => setKey(e.key)} data-testid="input" />
      <span data-testid="key-value">{key}</span>
    </div>
  );
}
