/**
 * Session bootstrap (project "setup", runs once before the chromium project).
 *
 * The gateway login route is throttled (5 requests / 60s), so per-test UI
 * logins trip `ThrottlerException: Too Many Requests` as soon as a few
 * authenticated specs run back-to-back. This setup logs in ONCE through the
 * real form and saves the browser storage state (the encrypted httpOnly BFF
 * session cookie) to ADMIN_STORAGE_STATE; the chromium project loads it as its
 * default `storageState`, and `loginAsAdmin()` short-circuits when the session
 * is already present.
 *
 * When the stack is down we still write an EMPTY state file so the dependent
 * project can start — its specs then skip via their own appAvailable()/
 * apiAvailable() gates, preserving the skip-not-fail harness contract.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { ADMIN_CREDENTIALS, apiAvailable, appAvailable } from './helpers/stack';

export const ADMIN_STORAGE_STATE = 'test-results/.auth/admin.json';

setup('authenticate as seeded super admin', async ({ page }) => {
  mkdirSync(dirname(ADMIN_STORAGE_STATE), { recursive: true });
  if (!(await appAvailable()) || !(await apiAvailable())) {
    writeFileSync(ADMIN_STORAGE_STATE, JSON.stringify({ cookies: [], origins: [] }));
    return;
  }
  await page.goto('/login');
  await page.getByLabel('Username').fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_CREDENTIALS.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
});
