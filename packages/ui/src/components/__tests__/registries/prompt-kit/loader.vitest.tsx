import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Loader } from '../../../registries/prompt-kit/loader';

describe('Loader', () => {
  it('renders without crashing', () => {
    const { container } = render(<Loader />);
    expect(container.firstChild).toBeTruthy();
  });
});
