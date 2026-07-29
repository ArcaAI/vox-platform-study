import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Android } from '../../../registries/magicui/android';

describe('Android', () => {
  it('renders without crashing', () => {
    const { container } = render(<Android />);
    expect(container.firstChild).toBeTruthy();
  });
});
