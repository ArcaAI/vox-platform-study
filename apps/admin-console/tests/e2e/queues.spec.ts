'use strict';

import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { Queue, Worker } from 'bullmq';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const QUEUE_CANDIDATES = ['WebCrawler', 'ReceiveEmail', 'ReceiveSms', 'SendSms', 'UserActivity'] as const;
const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? '6379'),
  password: process.env.REDIS_PASS ?? process.env.REDIS_PASSWORD ?? 'redis-password',
};

type QueueFixture = {
  queue: Queue;
  queueName: string;
  failedJobId: string;
  delayedJobId: string;
  bulkJobId: string;
  detailJobId: string;
  createdJobIds: string[];
  wasPaused: boolean;
};

let activeFixture: QueueFixture | undefined;

async function findEmptyQueue(): Promise<Queue> {
  for (const queueName of QUEUE_CANDIDATES) {
    const queue = new Queue(queueName, { connection: REDIS_CONNECTION });
    let available = false;
    try {
      await queue.waitUntilReady();
      const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized');
      const workers = await queue.getWorkers();
      if (Object.values(counts).every((count) => count === 0) && workers.length === 0) {
        available = true;
        return queue;
      }
    } finally {
      if (!available) await queue.close();
    }
  }
  throw new Error('No empty BullMQ queue is available for the queues E2E fixture');
}

async function createQueueFixture(): Promise<QueueFixture> {
  const queue = await findEmptyQueue();
  const queueName = queue.name;
  const failedJobId = `queues-e2e-failed-${randomUUID()}`;
  const delayedJobId = `queues-e2e-delayed-${randomUUID()}`;
  const bulkJobId = `queues-e2e-bulk-${randomUUID()}`;
  const detailJobId = `queues-e2e-detail-${randomUUID()}`;
  const createdJobIds: string[] = [];
  const wasPaused = await queue.isPaused();
  let worker: Worker | undefined;

  try {
    if (wasPaused) await queue.resume();
    worker = new Worker(
      queueName,
      async (job) => {
        if (job.id === failedJobId) throw new Error('queues E2E fixture failure');
        return undefined;
      },
      { connection: REDIS_CONNECTION },
    );
    await worker.waitUntilReady();

    const failedJobPromise = new Promise<void>((resolve, reject) => {
      const onFailed = (job: { id?: string | number } | undefined) => {
        if (job?.id !== failedJobId) return;
        worker?.off('failed', onFailed);
        worker?.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        worker?.off('failed', onFailed);
        worker?.off('error', onError);
        reject(error);
      };
      worker?.on('failed', onFailed);
      worker?.on('error', onError);
    });
    await queue.add('queues-e2e-failed', { fixture: true }, { jobId: failedJobId, attempts: 1, removeOnFail: false });
    createdJobIds.push(failedJobId);
    await failedJobPromise;
    await worker.close();
    worker = undefined;

    await queue.pause();
    await queue.add('queues-e2e-delayed', { fixture: true }, { jobId: delayedJobId, delay: 60_000, removeOnFail: false });
    await queue.add('queues-e2e-bulk', { fixture: true }, { jobId: bulkJobId, removeOnFail: false });
    await queue.add('queues-e2e-detail', { fixture: true }, { jobId: detailJobId, removeOnFail: false });
    createdJobIds.push(delayedJobId, bulkJobId, detailJobId);

    return { queue, queueName, failedJobId, delayedJobId, bulkJobId, detailJobId, createdJobIds, wasPaused };
  } catch (error) {
    if (worker) await worker.close().catch(() => undefined);
    for (const jobId of createdJobIds) await queue.remove(jobId).catch(() => undefined);
    if ((await queue.isPaused()) !== wasPaused) {
      if (wasPaused) await queue.pause();
      else await queue.resume();
    }
    await queue.close();
    throw error;
  }
}

async function cleanupQueueFixture(fixture: QueueFixture): Promise<void> {
  for (const jobId of fixture.createdJobIds) await fixture.queue.remove(jobId).catch(() => undefined);
  // The queue was verified EMPTY at acquisition (findEmptyQueue), so anything
  // still in it is this fixture's. remove() does not reliably clear jobs the
  // fixture's own Worker has already moved to completed/failed, and
  // findEmptyQueue counts those states — so every run permanently burned one
  // candidate queue until all five were dirty and the suite could not start.
  for (const state of ['completed', 'failed', 'delayed', 'wait', 'paused', 'prioritized'] as const) {
    await fixture.queue.clean(0, 10_000, state).catch(() => undefined);
  }
  if ((await fixture.queue.isPaused()) !== fixture.wasPaused) {
    if (fixture.wasPaused) await fixture.queue.pause();
    else await fixture.queue.resume();
  }
  await fixture.queue.close();
}

function getFixture(): QueueFixture {
  if (!activeFixture) throw new Error('Queues E2E fixture is not initialized');
  return activeFixture;
}

function queuesGrid(page: Page): Locator {
  return page.getByRole('grid', { name: 'Queues' });
}

function queueRow(page: Page, queueName = getFixture().queueName): Locator {
  return queuesGrid(page)
    .locator('[data-slot="data-grid-row"]')
    .filter({ has: page.getByText(queueName, { exact: true }) });
}

function jobsGrid(page: Page): Locator {
  return page.getByRole('grid', { name: 'Jobs' });
}

function jobRow(page: Page, jobId: string): Locator {
  return jobsGrid(page).locator('[data-slot="data-grid-row"]').filter({ hasText: jobId });
}

async function openQueues(page: Page): Promise<void> {
  await page.goto('/queues');
  await expect(page.getByRole('heading', { level: 1, name: 'Queues & Jobs' })).toBeVisible();
  await expect(page.getByLabel('Search')).toBeVisible();
  await expect(queueRow(page)).toHaveCount(1);
  await expect(queueRow(page)).toBeVisible();
}

async function openQueueDetail(page: Page): Promise<void> {
  const fixture = getFixture();
  await openQueues(page);
  await queueRow(page, fixture.queueName).click();
  await page.waitForURL(`**/queues/${fixture.queueName}**`);
  await expect(page.getByRole('heading', { level: 1, name: fixture.queueName })).toBeVisible();
  await expect(jobsGrid(page)).toBeVisible();
}

async function expectJobRow(page: Page, jobId: string): Promise<Locator> {
  const row = jobRow(page, jobId);
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  return row;
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  activeFixture = await createQueueFixture();
});

test.afterEach(async () => {
  if (!activeFixture) return;
  const fixture = activeFixture;
  activeFixture = undefined;
  await cleanupQueueFixture(fixture);
});

test.describe('queues screen', () => {
  test('renders the list with no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openQueues(page);
    await expectNoA11yViolations(page);
  });

  test('renders the list with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openQueues(page);
    await expectNoA11yViolations(page);
  });

  test('opens the fixture queue detail', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openQueueDetail(page);
    await expectNoA11yViolations(page);
  });

  test('filters queues by status via the facet', async ({ page }) => {
    await openQueues(page);
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('option', { name: 'Paused' }).click();
    await page.keyboard.press('Escape');
    const row = queueRow(page);
    await expect(row).toBeVisible();
    await expect(row.getByText('Paused', { exact: true })).toBeVisible();
  });

  test('opens the queue row action menu with pause/resume and clean, then cancels clean', async ({ page }) => {
    const fixture = getFixture();
    await openQueues(page);
    await queueRow(page)
      .getByRole('button', { name: `Actions for ${fixture.queueName}` })
      .click();
    await expect(page.getByRole('menuitem', { name: /^(Pause|Resume)$/u })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Clean jobs' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Clean jobs' }).click();
    const dialog = page.getByRole('dialog', { name: /^Clean queue/u });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Clean queue' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('queue detail header exposes pause/resume and clean, cancels clean', async ({ page }) => {
    await openQueueDetail(page);
    await expect(page.getByRole('button', { name: /^(Pause|Resume)$/u })).toBeVisible();
    const cleanButton = page.getByRole('button', { name: 'Clean jobs' });
    await expect(cleanButton).toBeVisible();
    await cleanButton.click();
    await expect(page.getByRole('dialog', { name: /^Clean queue/u })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('opens the failed job action menu', async ({ page }) => {
    const fixture = getFixture();
    await openQueueDetail(page);
    const row = await expectJobRow(page, fixture.failedJobId);
    await row.getByRole('button', { name: `Actions for job ${fixture.failedJobId}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Remove' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Retry' })).toHaveCount(0);
  });

  test('opens the delayed job action menu', async ({ page }) => {
    const fixture = getFixture();
    await openQueueDetail(page);
    const row = await expectJobRow(page, fixture.delayedJobId);
    await row.getByRole('button', { name: `Actions for job ${fixture.delayedJobId}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Remove' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Promote' })).toHaveCount(0);
  });

  test('selecting job rows shows the bulk action toolbar with a count and clear', async ({ page }) => {
    const fixture = getFixture();
    await openQueueDetail(page);
    const row = await expectJobRow(page, fixture.bulkJobId);
    await row.getByRole('checkbox', { name: 'Select row' }).click();
    const toolbar = page.getByRole('toolbar', { name: 'Bulk job actions' });
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByText('1 selected')).toBeVisible();
    await toolbar.getByRole('button', { name: 'Clear' }).click();
    await expect(toolbar).toHaveCount(0);
  });

  test('opens the job detail sheet when a job row is clicked', async ({ page }) => {
    const fixture = getFixture();
    await openQueueDetail(page);
    const row = await expectJobRow(page, fixture.detailJobId);
    await row.click();
    const sheet = page.getByRole('dialog').filter({ hasText: fixture.detailJobId });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Payload' })).toBeVisible();
  });
});
