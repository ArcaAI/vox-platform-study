import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { GridPattern } from '../../../registries/magicui/grid-pattern';

describe('GridPattern', () => {
  it('renders without crashing', () => {
    const { container } = render(<GridPattern />);
    expect(container.firstChild).toBeTruthy();
  });
});
