#!/usr/bin/env node
import { program } from 'commander';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import generateController, { ControllerGeneratorOptions } from './generator';
import { Logger } from '../utils/Logger';

const logger = new Logger('generate-controller');

interface ServiceInfo {
  name: string;
  path: string;
  interfaceName: string;
}

async function scanServices(): Promise<Record<string, ServiceInfo[]>> {
  const servicesPath = path.resolve(process.cwd(), '../../', 'packages/applications/src/services');

  logger.info(`Scanning for services in: ${servicesPath}`);

  if (!fs.existsSync(servicesPath)) {
    logger.warn(`Services directory not found: ${servicesPath}`);
    return {};
  }

  // Scan all service directories
  const servicesByGroup: Record<string, ServiceInfo[]> = {};

  // Get all immediate subdirectories as potential service groups
  const topDirs = fs.readdirSync(servicesPath).filter((item) => fs.statSync(path.join(servicesPath, item)).isDirectory());

  logger.info(`Found ${topDirs.length} top-level directories to scan`);

  // Check if each directory contains service interfaces
  for (const dir of topDirs) {
    const dirPath = path.join(servicesPath, dir);

    // See if this is a service group (has subdirectories) or a single service
    const contents = fs.readdirSync(dirPath);
    const hasSubdirs = contents.some((item) => fs.statSync(path.join(dirPath, item)).isDirectory());

    if (hasSubdirs) {
      // This is likely a service group
      const services = fs.readdirSync(dirPath).filter((item) => fs.statSync(path.join(dirPath, item)).isDirectory());

      if (services.length > 0) {
        servicesByGroup[dir] = [];

        for (const service of services) {
          const servicePath = path.join(dirPath, service);
          const interfaceFiles = await glob('I*Service.ts', { cwd: servicePath });

          if (interfaceFiles.length > 0) {
            const interfaceName = path.basename(interfaceFiles[0], '.ts');
            servicesByGroup[dir].push({
              name: service,
              path: servicePath,
              interfaceName,
            });
          }
        }
      }
    } else {
      // This might be a direct service
      const interfaceFiles = await glob('I*Service.ts', { cwd: dirPath });

      if (interfaceFiles.length > 0) {
        const serviceName = path.basename(dirPath);
        const groupName = '_root'; // Use a special name for root-level services

        if (!servicesByGroup[groupName]) {
          servicesByGroup[groupName] = [];
        }

        const interfaceName = path.basename(interfaceFiles[0], '.ts');
        servicesByGroup[groupName].push({
          name: serviceName,
          path: dirPath,
          interfaceName,
        });
      }
    }
  }

  // Summary of what we found
  const groupCount = Object.keys(servicesByGroup).length;
  const totalServices = Object.values(servicesByGroup).reduce((sum, services) => sum + services.length, 0);

  logger.info(`Scan complete. Found ${totalServices} services across ${groupCount} groups`);

  // Print details of each group and its services
  Object.entries(servicesByGroup).forEach(([group, services]) => {
    const sampleServices = services
      .slice(0, 5)
      .map((s) => s.name)
      .join(', ');
    const moreCount = services.length > 5 ? ` and ${services.length - 5} more` : '';
    logger.info(`Group: ${group} - ${services.length} services: ${sampleServices}${moreCount}`);
  });

  return servicesByGroup;
}

async function promptForOptions(): Promise<ControllerGeneratorOptions> {
  const servicesByGroup = await scanServices();
  const groups = Object.keys(servicesByGroup).sort();

  let selectedGroup: string;
  let serviceName: string;
  let interfaceName: string;

  // Check if any groups were found
  if (groups.length === 0) {
    logger.warn('No service groups found. Make sure the services exist in packages/applications/src/services');
    logger.info('Proceeding with manual controller name input...');

    // Ask for custom controller name
    const { customName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customName',
        message: 'Enter a controller name:',
        validate: (input: string) => {
          if (!input) {
            return 'Controller name is required';
          }
          return true;
        },
      },
    ]);
    serviceName = customName;
    interfaceName = `I${serviceName.charAt(0).toUpperCase() + serviceName.slice(1)}Service`;
  } else {
    // First ask for group
    const groupAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedGroup',
        message: 'Select a service group:',
        choices: [...groups.map((g) => (g === '_root' ? 'Root Services' : g)), 'Other'],
      },
    ]);
    selectedGroup = groupAnswer.selectedGroup === 'Root Services' ? '_root' : groupAnswer.selectedGroup;

    if (selectedGroup === 'Other') {
      // If "Other" selected, ask for custom controller name
      const { customName } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customName',
          message: 'Enter a custom controller name:',
          validate: (input: string) => {
            if (!input) {
              return 'Controller name is required';
            }
            return true;
          },
        },
      ]);
      serviceName = customName;
      interfaceName = `I${serviceName.charAt(0).toUpperCase() + serviceName.slice(1)}Service`;
    } else {
      // If group selected, show services from that group
      const groupServices = servicesByGroup[selectedGroup];

      // Handle potential empty group (could happen with complex directory structures)
      if (!groupServices || groupServices.length === 0) {
        logger.warn(`No services found in group: ${selectedGroup}`);

        // Collect all services from all groups as a fallback
        const allServices: ServiceInfo[] = [];
        Object.values(servicesByGroup).forEach((services) => allServices.push(...services));

        if (allServices.length > 0) {
          logger.info(`Showing all available services (${allServices.length} total) as a fallback`);

          // Sort all services alphabetically
          const sortedAllServices = allServices.sort((a, b) => a.name.localeCompare(b.name));

          const { selectedServiceFromAll } = await inquirer.prompt([
            {
              type: 'list',
              name: 'selectedServiceFromAll',
              message: 'Select a service from all available:',
              choices: sortedAllServices.map((service) => ({
                name: service.name,
                value: JSON.stringify({ name: service.name, interfaceName: service.interfaceName }),
              })),
            },
          ]);

          const parsed = JSON.parse(selectedServiceFromAll);
          serviceName = parsed.name;
          interfaceName = parsed.interfaceName;
        } else {
          // If somehow we got here with no services, ask for custom name
          const { customName } = await inquirer.prompt([
            {
              type: 'input',
              name: 'customName',
              message: 'Enter a custom controller name:',
              validate: (input: string) => {
                if (!input) {
                  return 'Controller name is required';
                }
                return true;
              },
            },
          ]);
          serviceName = customName;
          interfaceName = `I${serviceName.charAt(0).toUpperCase() + serviceName.slice(1)}Service`;
        }
      } else {
        // Sort services alphabetically
        const sortedServices = groupServices.sort((a, b) => a.name.localeCompare(b.name));

        const { selectedService } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedService',
            message: `Select a service from ${selectedGroup === '_root' ? 'root services' : selectedGroup}:`,
            choices: sortedServices.map((service) => ({
              name: service.name,
              value: JSON.stringify({ name: service.name, interfaceName: service.interfaceName }),
            })),
          },
        ]);

        const parsed = JSON.parse(selectedService);
        serviceName = parsed.name;
        interfaceName = parsed.interfaceName;
      }
    }
  }

  // Continue with the rest of the options
  const { outputPath, apiTag, overwrite } = await inquirer.prompt([
    {
      type: 'input',
      name: 'outputPath',
      message: 'What is the output path for the controller?',
      default: '../../apps/api/src/controllers',
    },
    {
      type: 'input',
      name: 'apiTag',
      message: 'What API tag should be used for Swagger documentation?',
      default: serviceName.toLowerCase(),
    },
    {
      type: 'confirm',
      name: 'overwrite',
      message: 'Overwrite existing files?',
      default: false,
    },
  ]);

  return {
    name: serviceName,
    interfaceName,
    outputPath,
    apiTag,
    overwrite,
  };
}

async function main(): Promise<void> {
  try {
    program
      .description('Generates a controller module for an existing service')
      .option('-n, --name <string>', 'Name of the controller')
      .option('-i, --interface-name <string>', 'Name of the service interface')
      .option('-o, --output-path <string>', 'Output path for the controller files')
      .option('-t, --api-tag <string>', 'API tag for Swagger documentation')
      .option('--overwrite', 'Overwrite existing files')
      .action(async (options) => {
        try {
          if (options.name && options.interfaceName && options.outputPath) {
            // Use command line options if all required ones are provided
            await generateController({
              name: options.name,
              interfaceName: options.interfaceName,
              outputPath: options.outputPath,
              apiTag: options.apiTag || options.name.toLowerCase(),
              overwrite: !!options.overwrite,
            });
          } else {
            // Otherwise, prompt for options
            const promptedOptions = await promptForOptions();
            await generateController(promptedOptions);
          }
        } catch (error) {
          logger.error('Error running generator:', error);
          process.exit(1);
        }
      });

    await program.parseAsync(process.argv);
  } catch (error) {
    logger.error('Error running command:', error);
    process.exit(1);
  }
}

main();

export default generateController;
