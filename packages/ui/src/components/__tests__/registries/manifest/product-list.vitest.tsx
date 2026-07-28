import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProductList } from '../../../registries/manifest/product-list';

describe('ProductList', () => {
  it('renders without crashing', () => {
    const { container } = render(<ProductList />);
    expect(container.firstChild).toBeTruthy();
  });
});
