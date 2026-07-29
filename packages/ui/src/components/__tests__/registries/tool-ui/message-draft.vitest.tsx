import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MessageDraft } from '../../../registries/tool-ui/message-draft';

describe('MessageDraft', () => {
  it('renders without crashing', () => {
    const { container } = render(<MessageDraft id="1" channel="email" to={['user@example.com']} subject="Hello" body="Draft message" />);
    expect(container.firstChild).toBeTruthy();
  });
});
