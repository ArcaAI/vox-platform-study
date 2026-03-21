#!/usr/bin/env node

import { listApiKeys, createApiKey } from './generate';
import { Command } from 'commander';
import figlet from 'figlet';
import chalk from 'chalk';

console.log(
    chalk.green(
        figlet.textSync('API Key', { horizontalLayout: 'default' })
    )
);

const program = new Command();

program
    .version('1.0.0')
    .description('Generate and manage development API keys for example apps');

program
    .command('list')
    .description('List all API keys in the database')
    .action(async () => {
        try {
            const keys = await listApiKeys();

            if (keys.length === 0) {
                console.log(chalk.yellow('\nNo API keys found. Run "create" to generate one, or "pnpm seed" to seed test keys.'));
                return;
            }

            console.log(chalk.blue(`\n🔑 API Keys (${keys.length} total):`));
            console.log(chalk.cyan('─'.repeat(80)));

            for (const key of keys) {
                const status = key.keyStatus === 'ACTIVE'
                    ? chalk.green(key.keyStatus)
                    : chalk.red(key.keyStatus);

                console.log(chalk.white(`  ${key.keyName}`));
                console.log(chalk.gray(`    Prefix:      ${key.keyPrefix}...`));
                console.log(chalk.gray(`    Type:        ${key.keyType}`));
                console.log(chalk.gray(`    Status:      ${status}`));
                console.log(chalk.gray(`    Tenant:      ${key.tenantId || 'Global'}`));
                console.log(chalk.gray(`    Environment: ${key.environment || 'N/A'}`));
                console.log(chalk.gray(`    Usage:       ${key.usageCount} requests`));
                console.log(chalk.gray(`    Created:     ${new Date(key.createdAt).toLocaleString()}`));
                console.log('');
            }

            console.log(chalk.cyan('─'.repeat(80)));
            console.log(chalk.gray('\nNote: Raw keys are only shown at creation time. If you need a key, create a new one.'));
        } catch (error) {
            console.error(chalk.red('\n❌ Error:'), error instanceof Error ? error.message : error);
            process.exit(1);
        }
    });

program
    .command('create')
    .description('Create a new API key')
    .option('-n, --name <name>', 'Key name', 'Example App API Key')
    .option('-t, --type <type>', 'Key type: SDK, WEBHOOK, INTEGRATION, SERVICE_ACCOUNT', 'SDK')
    .option('--tenant <tenantId>', 'Tenant ID', '50000000-0000-0000-0000-000000000000')
    .option('--user <userId>', 'User ID to link the key to')
    .option('-s, --scopes <scopes>', 'Comma-separated scopes', 'read,write,consultations,preferences')
    .option('-r, --rate-limit <limit>', 'Rate limit (requests/minute)', '1000')
    .option('-e, --environment <env>', 'Environment label', 'development')
    .option('-d, --description <desc>', 'Key description')
    .action(async (options) => {
        try {
            const scopes = options.scopes.split(',').map((s: string) => s.trim());

            const result = await createApiKey({
                keyName: options.name,
                keyType: options.type,
                tenantId: options.tenant,
                userId: options.user,
                scopes,
                rateLimit: parseInt(options.rateLimit, 10),
                environment: options.environment,
                description: options.description,
            });

            console.log(chalk.blue('\n🔑 API Key Created Successfully!'));
            console.log(chalk.cyan('─'.repeat(80)));
            console.log(chalk.yellow.bold(`  Raw Key: ${result.rawKey}`));
            console.log(chalk.cyan('─'.repeat(80)));

            console.log(chalk.blue('\n📋 Key Details:'));
            console.log(chalk.white(`  Name:        ${result.record.keyName}`));
            console.log(chalk.white(`  Prefix:      ${result.record.keyPrefix}...`));
            console.log(chalk.white(`  Type:        ${result.record.keyType}`));
            console.log(chalk.white(`  Status:      ${result.record.keyStatus}`));
            console.log(chalk.white(`  Tenant:      ${result.record.tenantId || 'Global'}`));
            console.log(chalk.white(`  Scopes:      ${scopes.join(', ')}`));
            console.log(chalk.white(`  Environment: ${options.environment}`));

            console.log(chalk.blue('\n📝 Usage in example apps:'));
            console.log(chalk.gray('  Vite app  → set VITE_API_KEY in packages/agentic-sdk-v2/examples/vite-app/.env'));
            console.log(chalk.gray('  Next.js   → set NEXT_PUBLIC_API_KEY in packages/agentic-sdk-v2/examples/nextjs-app/.env'));
            console.log(chalk.gray('  Or paste the key into the API Settings panel in the example app UI'));

            console.log(chalk.red('\n⚠️  Save this key now! It cannot be retrieved later.'));
            console.log(chalk.green('\n✅ Done!'));
        } catch (error) {
            console.error(chalk.red('\n❌ Error:'), error instanceof Error ? error.message : error);
            process.exit(1);
        }
    });

program.parse(process.argv);

if (!program.args.length) {
    program.outputHelp();
}
