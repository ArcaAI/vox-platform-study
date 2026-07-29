import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AnimatedList } from '../../../registries/magicui/animated-list';

describe('AnimatedList', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <AnimatedList>
        <div>Item 1</div>
        <div>Item 2</div>
      </AnimatedList>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
