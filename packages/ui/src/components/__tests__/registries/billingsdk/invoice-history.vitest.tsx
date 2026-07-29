import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { InvoiceHistory } from '@/components/registries/billingsdk';

describe('InvoiceHistory', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <InvoiceHistory
        invoices={[
          {
            id: '1',
            date: '2024-01-15',
            amount: '$20',
            status: 'paid',
            description: 'Plan',
          },
        ]}
      />,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
