import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Timeline, TimelineItem, TimelineHeader, TimelineDot, TimelineContent, TimelineTitle } from '@/components/registries/diceui/timeline';

describe('Timeline', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Timeline>
        <TimelineItem>
          <TimelineHeader>
            <TimelineDot />
          </TimelineHeader>
          <TimelineContent>
            <TimelineTitle>Event</TimelineTitle>
          </TimelineContent>
        </TimelineItem>
      </Timeline>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
