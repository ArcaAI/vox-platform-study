import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { OrderConfirm } from '../../../registries/manifest/order-confirm';

describe('OrderConfirm', () => {
  it('renders without crashing', () => {
    const { container } = render(<OrderConfirm />);
    expect(container.firstChild).toBeTruthy();
  });
});
