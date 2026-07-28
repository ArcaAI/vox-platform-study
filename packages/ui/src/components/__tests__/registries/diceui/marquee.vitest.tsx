import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Marquee, MarqueeContent, MarqueeItem } from '@/components/registries/diceui/marquee';

describe('Marquee', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Marquee>
        <MarqueeContent>
          <MarqueeItem>Item</MarqueeItem>
        </MarqueeContent>
      </Marquee>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
