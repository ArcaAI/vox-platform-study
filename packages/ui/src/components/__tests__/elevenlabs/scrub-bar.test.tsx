import { test, expect } from '@playwright/experimental-ct-react';
import { ScrubBarContainer, ScrubBarTrack, ScrubBarProgress, ScrubBarThumb, ScrubBarTimeLabel } from '../../elevenlabs/scrub-bar';
import { BasicScrubBar, ScrubBarAtStart, ScrubBarAtEnd } from '../fixtures/elevenlabs/scrub-bar-fixtures';

test.describe('ScrubBar', () => {
  test.describe('rendering', () => {
    test('renders scrub bar container', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const root = page.locator('[data-slot="scrub-bar-root"]');
      await expect(root).toBeVisible();
    });

    test('renders track', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const track = page.locator('[data-slot="scrub-bar-track"]');
      await expect(track).toBeVisible();
    });

    test('renders progress indicator', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const progress = page.locator('[data-slot="scrub-bar-progress"]');
      await expect(progress).toBeVisible();
    });

    test('renders thumb', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const thumb = page.locator('[data-slot="scrub-bar-thumb"]');
      await expect(thumb).toBeVisible();
    });
  });

  test.describe('time labels', () => {
    test('displays current time', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const timeLabel = page.getByTestId('current-time');
      await expect(timeLabel).toHaveText('0:45');
    });

    test('displays duration', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const duration = page.getByTestId('duration');
      await expect(duration).toHaveText('3:00');
    });

    test('displays 0:00 at start', async ({ mount, page }) => {
      await mount(<ScrubBarAtStart />);
      const timeLabel = page.getByTestId('current-time');
      await expect(timeLabel).toHaveText('0:00');
    });

    test('displays full duration at end', async ({ mount, page }) => {
      await mount(<ScrubBarAtEnd />);
      const timeLabel = page.getByTestId('current-time');
      await expect(timeLabel).toHaveText('3:00');
    });
  });

  test.describe('accessibility', () => {
    test('track has slider role', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const slider = page.getByRole('slider');
      await expect(slider).toBeVisible();
    });

    test('track has aria-valuemin', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const slider = page.getByRole('slider');
      await expect(slider).toHaveAttribute('aria-valuemin', '0');
    });

    test('track has aria-valuemax', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const slider = page.getByRole('slider');
      await expect(slider).toHaveAttribute('aria-valuemax', '180');
    });

    test('track has aria-valuenow', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const slider = page.getByRole('slider');
      await expect(slider).toHaveAttribute('aria-valuenow', '45');
    });
  });

  test.describe('time formatting', () => {
    test('formats time label with tabular-nums', async ({ mount, page }) => {
      await mount(<BasicScrubBar />);
      const timeLabel = page.locator('[data-slot="scrub-bar-time-label"]').first();
      await expect(timeLabel).toHaveClass(/tabular-nums/);
    });
  });
});
