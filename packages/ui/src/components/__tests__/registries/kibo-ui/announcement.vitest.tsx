import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Announcement, AnnouncementTag, AnnouncementTitle } from '../../../registries/kibo-ui/announcement';

describe('Announcement', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Announcement>
        <AnnouncementTag>New</AnnouncementTag>
        <AnnouncementTitle>Test announcement</AnnouncementTitle>
      </Announcement>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
