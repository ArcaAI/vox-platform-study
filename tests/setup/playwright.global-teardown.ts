/**
 * Playwright Global Teardown
 *
 * This file runs once after all Playwright tests complete.
 * It cleans up the test infrastructure including API and Python services.
 */

import { FullConfig } from '@playwright/test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SERVICE_PID_ENV_VARS = [
  { name: 'API', envVar: 'API_PROCESS_PID' },
  { name: 'STT', envVar: 'STT_PROCESS_PID' },
  { name: 'SMR', envVar: 'TEXT_PROCESS_PID' },
  { name: 'NLP', envVar: 'NLP_PROCESS_PID' },
];

async function globalTeardown(config: FullConfig): Promise<void> {
  console.log('\n🧹 Cleaning up Playwright test infrastructure...\n');

  // Restore original API .env file if backup exists
  const apiEnvPath = path.resolve(process.cwd(), 'apps/api/.env');
  const apiEnvBackupPath = path.resolve(process.cwd(), 'apps/api/.env.backup');

  if (fs.existsSync(apiEnvBackupPath)) {
    try {
      fs.renameSync(apiEnvBackupPath, apiEnvPath);
      console.log('✅ Restored original API .env file\n');
    } catch (error) {
      console.warn('⚠️ Could not restore API .env file:', error);
    }
  }

  if (!process.env.CI) {
    // Stop all service processes that were started by tests
    for (const { name, envVar } of SERVICE_PID_ENV_VARS) {
      const pid = process.env[envVar];
      if (pid) {
        try {
          console.log(`Stopping ${name} server (PID: ${pid})...`);
          process.kill(-parseInt(pid, 10), 'SIGTERM');
          console.log(`✅ ${name} server stopped`);
        } catch (error) {
          console.warn(`⚠️ Could not stop ${name} server (may already be stopped)`);
        }
      }
    }

    // Stop Docker containers — ONLY when this run is the one that owns them.
    //
    // This used to run unconditionally, including after a FAILED globalSetup (Playwright always
    // runs teardown), and with `-v`, which removes the VOLUMES too. The practical consequence:
    // a single `npx playwright test <one-spec>` against an already-running, already-seeded stack
    // destroyed that stack and everything in it — and because setup can fail for reasons that have
    // nothing to do with infra (a bad health-probe URL, say), it destroyed it without ever running
    // a test. That is a foot-gun for anyone doing single-spec iteration, and it is fatal when
    // several agents or terminals share one test stack.
    //
    // `RESET_DB=false` is the existing signal for "the caller manages the database/infra
    // lifecycle" (globalSetup already honours it by skipping the reset). Honour it here too, so
    // the contract is symmetric: if we did not set it up, we do not tear it down.
    const callerOwnsInfra = process.env.RESET_DB === 'false';
    if (callerOwnsInfra) {
      console.log('\n⏭️  Leaving Docker test containers up (RESET_DB=false — caller owns the infra lifecycle).');
      console.log('   Stop them yourself with: pnpm infra:test:down\n');
    } else {
      try {
        console.log('\nStopping Docker test containers...');
        execSync('docker compose -f tests/docker-compose.test.yml down -v', {
          stdio: 'inherit',
          cwd: process.cwd(),
        });
        console.log('✅ Docker containers stopped\n');
      } catch (error) {
        console.warn('⚠️ Could not stop Docker containers (may already be stopped)');
      }
    }
  }

  console.log('✨ Cleanup complete!\n');
}

export default globalTeardown;
