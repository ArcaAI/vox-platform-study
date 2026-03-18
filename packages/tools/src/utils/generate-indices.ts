#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { Paths } from './paths';

interface GenerateIndicesOptions {
    type: string;
    domains?: string[];
    recursive?: boolean;
}

/**
 * Generate indices for the specified generator type and domains
 */
function generateIndices(options: GenerateIndicesOptions): string[] {
    const { type, domains = [], recursive = false } = options;

    console.log(chalk.blue(`Generating index files for ${type}...`));

    // Get all domains if none specified
    const domainNames = domains.length > 0 ? domains : [];

    try {
        // Generate indices for the specified type
        const indexFiles = Paths.generateIndicesForType(type, domainNames);

        // If recursive is true, generate a root index file that exports from all types
        if (recursive && indexFiles.length > 0) {
            const domainsSourcePath = Paths.getDomainsSourcePath();
            const rootIndexPath = Paths.generateIndexFile(domainsSourcePath, true);
            if (rootIndexPath) {
                indexFiles.push(rootIndexPath);
            }
        }

        return indexFiles;
    } catch (error) {
        console.error(chalk.red(`Error generating indices for ${type}:`), error);
        return [];
    }
}

// Only run as a script if this file is being executed directly
if (require.main === module) {
    const program = new Command();

    program
        .name('generate-indices')
        .description('Generate index.ts files for various generator types')
        .option('-t, --type <type>', 'Type of generator to generate indices for (repository, mapper, etc.)', 'repository')
        .option('-d, --domains <domains...>', 'Specific domains to generate indices for (if not specified, generates for all)')
        .option('-r, --recursive', 'Generate recursive index files including parent directories', false)
        .action((options) => {
            try {
                const indexFiles = generateIndices(options);

                for (const indexFile of indexFiles) {
                    console.log(chalk.green(`Generated index file: ${indexFile}`));
                }

                console.log(chalk.green(`Successfully generated ${indexFiles.length} index files.`));
            } catch (error) {
                console.error(chalk.red('Error generating indices:'), error);
                process.exit(1);
            }
        });

    program.parse(process.argv);
}

export { generateIndices };