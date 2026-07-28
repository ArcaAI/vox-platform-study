import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PaymentDetails } from '@/components/registries/billingsdk';

describe('PaymentDetails', () => {
  it('renders without crashing', () => {
    const { container } = render(<PaymentDetails />);
    expect(container.firstChild).toBeTruthy();
  });
});
