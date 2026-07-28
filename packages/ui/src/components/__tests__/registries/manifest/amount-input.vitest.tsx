import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AmountInput } from '../../../registries/manifest/amount-input';

describe('AmountInput', () => {
  it('renders without crashing', () => {
    const { container } = render(<AmountInput />);
    expect(container.firstChild).toBeTruthy();
  });
});
