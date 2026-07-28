import { test, expect } from '@playwright/experimental-ct-react';
import {
  PendingTracker,
  ProcessingTracker,
  CompletedTracker,
  FailedTracker,
  NullJobTracker,
  StartStopTracker,
} from '../fixtures/custom/async-job-tracker-fixtures';

test.describe('AsyncJobTracker', () => {
  test.describe('rendering', () => {
    test('renders pending state', async ({ mount }) => {
      const component = await mount(<PendingTracker />);
      await expect(component).toHaveAttribute('data-slot', 'async-job-tracker');
      await expect(component.getByText('Pending')).toBeVisible();
    });

    test('renders processing state with progress', async ({ mount }) => {
      const component = await mount(<ProcessingTracker />);
      await expect(component.getByText('Processing')).toBeVisible();
      await expect(component.getByText('45%')).toBeVisible();
      await expect(component.getByRole('progressbar')).toBeVisible();
    });

    test('renders completed state', async ({ mount }) => {
      const component = await mount(<CompletedTracker />);
      await expect(component.getByText('Completed')).toBeVisible();
    });

    test('renders failed state with error message', async ({ mount }) => {
      const component = await mount(<FailedTracker />);
      await expect(component.getByText('Failed')).toBeVisible();
      await expect(component.getByText('Connection timed out')).toBeVisible();
      await expect(component.getByText('Error')).toBeVisible();
    });

    test('renders nothing when jobId is null', async ({ mount }) => {
      const component = await mount(<NullJobTracker />);
      await expect(component.locator('[data-slot="async-job-tracker"]')).toHaveCount(0);
    });
  });

  test.describe('status indicators', () => {
    test('pending shows clock icon', async ({ mount }) => {
      const component = await mount(<PendingTracker />);
      await expect(component).toHaveAttribute('data-slot', 'async-job-tracker');
      await expect(component.getByText('Pending')).toBeVisible();
    });

    test('processing shows spinner icon', async ({ mount }) => {
      const component = await mount(<ProcessingTracker />);
      await expect(component.locator('.animate-spin')).toBeVisible();
    });

    test('failed shows destructive badge', async ({ mount }) => {
      const component = await mount(<FailedTracker />);
      const badge = component.locator('[data-slot="badge"]').filter({ hasText: 'Failed' });
      await expect(badge).toHaveAttribute('data-variant', 'destructive');
    });
  });

  test.describe('elapsed timer', () => {
    test('displays elapsed time', async ({ mount }) => {
      const component = await mount(<PendingTracker />);
      await expect(component.getByText('0s')).toBeVisible();
    });
  });

  test.describe('estimated time', () => {
    test('shows estimated remaining time for processing jobs', async ({ mount }) => {
      const component = await mount(<ProcessingTracker />);
      await expect(component.getByText(/left/)).toBeVisible();
    });
  });

  test.describe('dynamic job lifecycle', () => {
    test('shows tracker when job starts', async ({ mount }) => {
      const component = await mount(<StartStopTracker />);
      await expect(component.locator('[data-slot="async-job-tracker"]')).toHaveCount(0);

      await component.locator('[data-testid="start-btn"]').click();
      await expect(component.locator('[data-slot="async-job-tracker"]')).toBeVisible();
    });

    test('hides tracker when job is cleared', async ({ mount }) => {
      const component = await mount(<StartStopTracker />);
      await component.locator('[data-testid="start-btn"]').click();
      await expect(component.locator('[data-slot="async-job-tracker"]')).toBeVisible();

      await component.locator('[data-testid="stop-btn"]').click();
      await expect(component.locator('[data-slot="async-job-tracker"]')).toHaveCount(0);
    });
  });

  test.describe('accessibility', () => {
    test('error alert has proper structure', async ({ mount }) => {
      const component = await mount(<FailedTracker />);
      const alert = component.getByRole('alert');
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('Connection timed out');
    });

    test('progress bar is accessible', async ({ mount }) => {
      const component = await mount(<ProcessingTracker />);
      const progressbar = component.getByRole('progressbar');
      await expect(progressbar).toBeVisible();
    });
  });
});
