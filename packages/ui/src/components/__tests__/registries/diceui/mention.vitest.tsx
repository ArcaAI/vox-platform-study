import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Mention, MentionInput } from '@/components/registries/diceui/mention';

describe('Mention', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Mention>
        <MentionInput placeholder="Type..." />
      </Mention>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
