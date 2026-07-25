#!/usr/bin/env node

import { generateDevToken, getAvailableUsernames, getDefaultUser } from './generate';
import { Command } from 'commander';
import figlet from 'figlet';
import chalk from 'chalk';

console.log(chalk.green(figlet.textSync('Dev Token', { horizontalLayout: 'default' })));

const program = new Command();

const defaultUser = getDefaultUser();
const availableUsers = getAvailableUsernames();

program
  .version('1.0.0')
  .description('Generate a development JWT token for testing API endpoints')
  .option('-u, --username <username>', `Username to generate token for (default: "${defaultUser.username}")`, defaultUser.username)
  .option('-e, --expires <expires>', 'Token expiration time (e.g., 1h, 24h, 7d, 30d)', '24h')
  .option('-t, --tenant <tenantId>', 'Override tenant ID for the token')
  .option('-r, --roles <roles>', 'Override roles (comma-separated, e.g., "ADMIN,USER")')
  .option('-p, --print', 'Print token payload details', false)
  .option('-l, --list', 'List available users', false)
  .action(async (options) => {
    try {
      // Handle --list flag
      if (options.list) {
        console.log(chalk.blue('\nAvailable users:'));
        console.log(chalk.cyan('─'.repeat(50)));
        for (const username of availableUsers) {
          console.log(chalk.yellow(`  • ${username}`));
        }
        console.log(chalk.cyan('─'.repeat(50)));
        console.log(chalk.gray('\nUse -u <username> to generate a token for a specific user'));
        return;
      }

      // Parse roles if provided
      const roles = options.roles ? options.roles.split(',').map((r: string) => r.trim().toUpperCase()) : undefined;

      const result = await generateDevToken({
        username: options.username,
        expires: options.expires,
        tenantId: options.tenant,
        roles,
      });

      console.log(chalk.blue('\n📝 Generated JWT Token:'));
      console.log(chalk.cyan('─'.repeat(80)));
      console.log(chalk.yellow(result.token));
      console.log(chalk.cyan('─'.repeat(80)));

      if (options.print) {
        console.log(chalk.blue('\n📋 Token Payload:'));
        console.log(chalk.cyan(JSON.stringify(result.payload, null, 2)));
      }

      // Always show summary
      console.log(chalk.blue('\n📊 Token Summary:'));
      console.log(chalk.white(`  User:     ${result.payload.username}`));
      console.log(chalk.white(`  Email:    ${result.payload.email}`));
      console.log(chalk.white(`  Roles:    ${result.payload.roles.join(', ')}`));
      console.log(chalk.white(`  Tenant:   ${result.payload.tenantId || 'Global (no tenant)'}`));
      console.log(chalk.white(`  Expires:  ${new Date(result.payload.exp! * 1000).toLocaleString()}`));

      console.log(chalk.green('\n✅ Token generated successfully!'));

      // Copy hint
      console.log(chalk.gray('\nTip: Use this token in the Authorization header:'));
      console.log(chalk.gray('  Authorization: Bearer <token>'));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red('\n❌ Error:'), error.message);
      } else {
        console.error(chalk.red('\n❌ Error:'), error);
      }
      process.exit(1);
    }
  });

program.parse(process.argv);
