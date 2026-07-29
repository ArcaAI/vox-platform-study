import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BillingScreen } from '@/components/registries/billingsdk';

describe('BillingScreen', () => {
  it('renders without crashing', () => {
    const { container } = render(<BillingScreen />);
    expect(container.firstChild).toBeTruthy();
  });
});
