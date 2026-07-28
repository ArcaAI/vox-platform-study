import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PricingTableTwo } from '@/components/registries/billingsdk';
import { plans } from '@/lib/billingsdk-config';

describe('PricingTableTwo', () => {
  it('renders without crashing', () => {
    const { container } = render(<PricingTableTwo plans={plans} />);
    expect(container.firstChild).toBeTruthy();
  });
});
