import * as React from 'react';
import { Textarea } from '../../../shadcn/textarea';

/**
 * Fixture components for Textarea event tests.
 * Callbacks are defined here (not inline in tests) so they can be serialized by Playwright CT.
 */
export function TextareaChangeTracker() {
  const [value, setValue] = React.useState('');
  return (
    <div>
      <Textarea onChange={(e) => setValue(e.target.value)} data-testid="textarea" />
      <span data-testid="change-value">{value}</span>
    </div>
  );
}

export function TextareaFocusBlurTracker() {
  const [status, setStatus] = React.useState('');
  return (
    <div>
      <Textarea onFocus={() => setStatus('focused')} onBlur={() => setStatus('blurred')} data-testid="textarea" />
      <span data-testid="focus-status">{status}</span>
    </div>
  );
}

export function TextareaKeyTracker() {
  const [key, setKey] = React.useState('');
  return (
    <div>
      <Textarea onKeyDown={(e) => setKey(e.key)} data-testid="textarea" />
      <span data-testid="key-value">{key}</span>
    </div>
  );
}
