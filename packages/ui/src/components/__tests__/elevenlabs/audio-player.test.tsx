import { test, expect } from '@playwright/experimental-ct-react';
import { BasicAudioPlayer, AudioPlayerWithSpeed, AudioPlayerWithSpeedButtons, MultiTrackPlayer } from '../fixtures/elevenlabs/audio-player-fixtures';

test.describe('AudioPlayer', () => {
  test.describe('rendering', () => {
    test('renders audio player', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const player = page.getByTestId('audio-player');
      await expect(player).toBeVisible();
    });

    test('renders play button', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const playButton = page.getByTestId('play-button');
      await expect(playButton).toBeVisible();
    });

    test('renders time display', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const time = page.getByTestId('current-time');
      await expect(time).toBeVisible();
    });

    test('renders duration display', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const duration = page.getByTestId('duration');
      await expect(duration).toBeVisible();
    });

    test('renders progress bar', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const progress = page.getByTestId('progress');
      await expect(progress).toBeVisible();
    });
  });

  test.describe('play button', () => {
    test('play button has accessible label', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const playButton = page.getByTestId('play-button');
      await expect(playButton).toHaveAttribute('aria-label', 'Play');
    });

    test('play button is a button element', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const playButton = page.getByTestId('play-button');
      await expect(playButton).toHaveRole('button');
    });
  });

  test.describe('time display', () => {
    test('initial time is 0:00', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const time = page.getByTestId('current-time');
      await expect(time).toHaveText('0:00');
    });

    test('time has tabular-nums class', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const time = page.getByTestId('current-time');
      await expect(time).toHaveClass(/tabular-nums/);
    });

    test('duration shows placeholder when not loaded', async ({ mount, page }) => {
      await mount(<BasicAudioPlayer />);
      const duration = page.getByTestId('duration');
      const text = await duration.textContent();
      expect(text === '--:--' || /\d+:\d+/.test(text!)).toBeTruthy();
    });
  });

  test.describe('speed control', () => {
    test('renders speed dropdown', async ({ mount, page }) => {
      await mount(<AudioPlayerWithSpeed />);
      const speed = page.getByTestId('speed-control');
      await expect(speed).toBeVisible();
    });

    test('speed button has accessible label', async ({ mount, page }) => {
      await mount(<AudioPlayerWithSpeed />);
      const speed = page.getByLabel('Playback speed');
      await expect(speed).toBeVisible();
    });
  });

  test.describe('speed button group', () => {
    test('renders speed button group', async ({ mount, page }) => {
      await mount(<AudioPlayerWithSpeedButtons />);
      const group = page.getByTestId('speed-buttons');
      await expect(group).toBeVisible();
    });

    test('speed group has accessible label', async ({ mount, page }) => {
      await mount(<AudioPlayerWithSpeedButtons />);
      const group = page.getByRole('group', {
        name: 'Playback speed controls',
      });
      await expect(group).toBeVisible();
    });
  });

  test.describe('multi-track', () => {
    test('renders multiple tracks', async ({ mount, page }) => {
      await mount(<MultiTrackPlayer />);
      const track0 = page.getByTestId('track-0');
      const track1 = page.getByTestId('track-1');
      const track2 = page.getByTestId('track-2');
      await expect(track0).toBeVisible();
      await expect(track1).toBeVisible();
      await expect(track2).toBeVisible();
    });

    test('each track has a play button', async ({ mount, page }) => {
      await mount(<MultiTrackPlayer />);
      const play0 = page.getByTestId('play-0');
      const play1 = page.getByTestId('play-1');
      await expect(play0).toBeVisible();
      await expect(play1).toBeVisible();
    });
  });
});
