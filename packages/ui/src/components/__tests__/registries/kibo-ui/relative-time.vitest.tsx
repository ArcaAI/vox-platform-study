import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RelativeTime, RelativeTimeZone, RelativeTimeZoneDisplay, RelativeTimeZoneLabel } from '../../../registries/kibo-ui/relative-time';

describe('RelativeTime', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <RelativeTime>
        <RelativeTimeZone zone="UTC">
          <RelativeTimeZoneLabel>UTC</RelativeTimeZoneLabel>
          <RelativeTimeZoneDisplay />
        </RelativeTimeZone>
      </RelativeTime>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
