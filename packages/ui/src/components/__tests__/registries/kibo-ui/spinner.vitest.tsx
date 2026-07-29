import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Spinner } from '../../../registries/kibo-ui/spinner';

describe('Spinner', () => {
  it('renders throbber variant without crashing', () => {
    const { container } = render(<Spinner variant="throbber" />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders ellipsis variant without crashing', () => {
    const { container } = render(<Spinner variant="ellipsis" />);
    expect(container.firstChild).toBeTruthy();
  });
});
