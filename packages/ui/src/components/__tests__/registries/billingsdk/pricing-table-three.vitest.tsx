import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PricingTableThree } from '@/components/registries/billingsdk';
import { plans } from '@/lib/billingsdk-config';

describe('PricingTableThree', () => {
  it('renders without crashing', () => {
    const { container } = render(<PricingTableThree plans={plans} />);
    expect(container.firstChild).toBeTruthy();
  });
});
