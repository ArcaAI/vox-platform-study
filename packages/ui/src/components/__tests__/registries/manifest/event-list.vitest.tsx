import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { EventList } from '../../../registries/manifest/event-list';

describe('EventList', () => {
  it('renders without crashing', () => {
    const { container } = render(<EventList />);
    expect(container.firstChild).toBeTruthy();
  });
});
