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
  { name: 'SMR', envVar: 'SMR_PROCESS_PID' },
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

    // Stop Docker containers
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

  console.log('✨ Cleanup complete!\n');
}

export default globalTeardown;
