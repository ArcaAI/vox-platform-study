import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DateTimePicker } from '../../../registries/manifest/date-time-picker';

describe('DateTimePicker', () => {
  it('renders without crashing', () => {
    const { container } = render(<DateTimePicker />);
    expect(container.firstChild).toBeTruthy();
  });
});
