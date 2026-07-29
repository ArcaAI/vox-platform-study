import { test, expect } from '@playwright/experimental-ct-react';
import { BasicTranscriptViewer, TranscriptViewerPlayOnly } from '../fixtures/elevenlabs/transcript-viewer-fixtures';

test.describe('TranscriptViewer', () => {
  test.describe('rendering', () => {
    test('renders transcript viewer container', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const root = page.locator('[data-slot="transcript-viewer-root"]');
      await expect(root).toBeVisible();
    });

    test('renders audio element', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const audio = page.locator('[data-slot="transcript-audio"]');
      await expect(audio).toBeAttached();
    });

    test('renders words container', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const words = page.locator('[data-slot="transcript-words"]');
      await expect(words).toBeVisible();
    });

    test('renders play/pause button', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const button = page.getByTestId('play-pause');
      await expect(button).toBeVisible();
    });

    test('renders scrub bar', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const scrubBar = page.locator('[data-slot="transcript-scrub-bar"]');
      await expect(scrubBar).toBeVisible();
    });
  });

  test.describe('play/pause button', () => {
    test('has button role', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const button = page.getByTestId('play-pause');
      await expect(button).toHaveRole('button');
    });

    test('has play aria-label initially', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const button = page.getByTestId('play-pause');
      await expect(button).toHaveAttribute('aria-label', 'Play audio');
    });

    test('has data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const button = page.getByTestId('play-pause');
      await expect(button).toHaveAttribute('data-slot', 'transcript-play-pause-button');
    });

    test('has data-playing attribute', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const button = page.getByTestId('play-pause');
      await expect(button).toHaveAttribute('data-playing', 'false');
    });
  });

  test.describe('accessibility', () => {
    test('play button has cursor-pointer', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const button = page.getByTestId('play-pause');
      await expect(button).toHaveClass(/cursor-pointer/);
    });
  });

  test.describe('words', () => {
    test('renders transcript text', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const words = page.locator('[data-slot="transcript-words"]');
      await expect(words).toBeVisible();
    });

    test('words container has text styling', async ({ mount, page }) => {
      await mount(<BasicTranscriptViewer />);
      const words = page.locator('[data-slot="transcript-words"]');
      await expect(words).toHaveClass(/text-xl/);
    });
  });

  test.describe('play only', () => {
    test('renders without scrub bar', async ({ mount, page }) => {
      await mount(<TranscriptViewerPlayOnly />);
      const button = page.getByTestId('play-pause');
      await expect(button).toBeVisible();
      const scrubBar = page.locator('[data-slot="transcript-scrub-bar"]');
      await expect(scrubBar).not.toBeVisible();
    });
  });
});
