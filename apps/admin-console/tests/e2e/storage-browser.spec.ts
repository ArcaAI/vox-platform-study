/**
 * Frame 31 — tenant Storage browser against a RUNNING stack (rule 12 gate 3):
 * screen smoke plus axe scans in both themes. Skips with actionable messages
 * when the app or gateway is down.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // These specs exercise the tenant-scoped browser. Since TASK-932 an elevated
  // session with NO working tenant sees the cross-tenant "All tenants" view
  // instead of a gate (covered by task-932-storage-browser.spec.ts), so pick a
  // working tenant first to land on the tenant-scoped surface.
  await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Storage' })).toBeVisible();
  // Data rows are focusable (row click -> select/descend); a tenant with no
  // objects (or no buckets, which disables the listing) settles on the grid
  // empty state instead.
  const dataRows = page.getByRole('grid', { name: 'Bucket objects' }).locator('[data-slot="data-grid-row"]');
  const emptyObjects = page.getByText('No objects here');
  await expect(dataRows.first().or(emptyObjects.first())).toBeVisible();
}

test.describe('storage browser (frame 31)', () => {
  test.beforeEach(async ({ page }) => {
    await mockStorageApi(page, '');
  });
  test('shows the header, toolbar (bucket select + breadcrumb) and fill grid', async ({ page }) => {
    await page.goto('/storage');
    await waitForSettled(page);
    await expect(page.getByRole('button', { name: 'Upload files' }).first()).toBeVisible();
    await expect(page.getByLabel('Search objects')).toBeVisible();
    await expect(page.getByRole('combobox', { name: /bucket/i })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Object prefix' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Bucket objects' })).toBeVisible();
    // Footer status bar carries the storage-health verdict.
    await expect(page.getByText(/reachable|unreachable|Storage not configured/i).first()).toBeVisible();
  });

  test('the object search syncs the URL and keeps the grid region', async ({ page }) => {
    await page.goto('/storage');
    await waitForSettled(page);
    await page.getByLabel('Search objects').fill('wav');
    await expect(page).toHaveURL(/search=wav/);
    await expect(page.getByRole('grid', { name: 'Bucket objects' })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/storage');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/storage');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

function makeTempFile(): { filePath: string; fileName: string } {
  const fileName = `e2e-upload-${randomUUID()}.txt`;
  const filePath = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(filePath, `hope-v2 storage browser e2e fixture ${fileName}`);
  return { filePath, fileName };
}

const UPLOAD_INPUT_ID = 'storage-browser-upload-input';

async function uploadFile(page: Page, filePath: string, fileName: string) {
  await page.getByRole('button', { name: 'Upload files' }).first().click();
  await page.locator(`#${UPLOAD_INPUT_ID}`).setInputFiles(filePath);
  await expect(page.getByText(new RegExp(`Uploaded ${fileName}`))).toBeVisible();
  await expect(objectRow(page, fileName)).toBeVisible();
}

function objectRow(page: Page, fileName: string) {
  return page.getByRole('grid', { name: 'Bucket objects' }).locator('[data-slot="data-grid-row"]').filter({ hasText: fileName });
}
async function mockStorageApi(page: Page, fileName: string): Promise<void> {
  let uploaded = false;
  await page.route('**/api/hope/storage/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (request.method() === 'GET' && pathname.endsWith('/health')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'healthy', connected: true, isMinIO: true }),
      });
      return;
    }

    if (request.method() === 'GET' && pathname.endsWith('/buckets')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'e2e-test-bucket' }]),
      });
      return;
    }

    if (request.method() === 'GET' && pathname.endsWith('/files')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(uploaded ? [{ key: fileName, size: 64 }] : []),
      });
      return;
    }

    if (request.method() === 'POST' && pathname.endsWith('/files')) {
      uploaded = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ key: fileName, size: 64, contentType: 'text/plain' }),
      });
      return;
    }

    if (request.method() === 'DELETE' && pathname.includes('/files/')) {
      uploaded = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: true, key: fileName }),
      });
      return;
    }

    await route.fallback();
  });
}

async function removeFixture(filePath: string): Promise<void> {
  fs.rmSync(filePath, { force: true });
}

async function deleteSelectedObject(page: Page, fileName: string) {
  const actionPanel = page.getByRole('dialog').filter({ hasText: fileName });
  await expect(actionPanel).toBeVisible();
  await actionPanel.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  const confirmButton = dialog.getByRole('button', { name: 'Delete object' });
  const typeInput = dialog.getByLabel(`Type ${fileName} to confirm`);
  await typeInput.fill(fileName);
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(page.getByText('Object deleted')).toBeVisible();
  await expect(objectRow(page, fileName)).not.toBeVisible();
}

test.describe('storage browser — upload, select and delete (frame 31)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    await selectWorkingTenant(page);
  });

  test('uploads a file then deletes it via type-to-confirm', async ({ page }) => {
    const { filePath, fileName } = makeTempFile();
    await mockStorageApi(page, fileName);
    try {
      await page.goto('/storage');
      await waitForSettled(page);
      await uploadFile(page, filePath, fileName);
      await objectRow(page, fileName).click();
      await deleteSelectedObject(page, fileName);
    } finally {
      await removeFixture(filePath);
    }
  });

  test('selecting an object row populates the object actions panel', async ({ page }) => {
    const { filePath, fileName } = makeTempFile();
    await mockStorageApi(page, fileName);
    try {
      await page.goto('/storage');
      await waitForSettled(page);
      await uploadFile(page, filePath, fileName);
      await objectRow(page, fileName).click();
      const drawer = page.getByRole('dialog').filter({ hasText: fileName });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByText(fileName, { exact: false }).first()).toBeVisible();
      await expect(drawer.getByText('Size', { exact: true })).toBeVisible();
      await expect(drawer.getByText('Content type', { exact: true })).toBeVisible();
      await expect(drawer.getByText('text/plain')).toBeVisible();
      await deleteSelectedObject(page, fileName);
    } finally {
      await removeFixture(filePath);
    }
  });
  test('delete confirm dialog gates on typing the exact object key', async ({ page }) => {
    const { filePath, fileName } = makeTempFile();
    await mockStorageApi(page, fileName);
    try {
      await page.goto('/storage');
      await waitForSettled(page);
      await uploadFile(page, filePath, fileName);
      await objectRow(page, fileName).click();
      const actionPanel = page.getByRole('dialog').filter({ hasText: fileName });
      await actionPanel.getByRole('button', { name: 'Delete', exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      const confirmButton = dialog.getByRole('button', { name: 'Delete object' });
      const typeInput = dialog.getByLabel(`Type ${fileName} to confirm`);
      await expect(confirmButton).toBeDisabled();
      await typeInput.fill('not-the-right-name.txt');
      await expect(confirmButton).toBeDisabled();
      await typeInput.fill(fileName);
      await expect(confirmButton).toBeEnabled();
      await confirmButton.click();
      await expect(page.getByText('Object deleted')).toBeVisible();
      await expect(objectRow(page, fileName)).not.toBeVisible();
    } finally {
      await removeFixture(filePath);
    }
  });

  test('searching for a nonsense term shows the no-match empty state', async ({ page }) => {
    await mockStorageApi(page, '');
    await page.goto('/storage');
    await waitForSettled(page);
    await page.getByLabel('Search objects').fill('zzz-no-such-object-zzz');
    await expect(page.getByText('No objects match your search')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByText('No objects match your search')).not.toBeVisible();
    await expect(page.getByLabel('Search objects')).toHaveValue('');
  });
});
