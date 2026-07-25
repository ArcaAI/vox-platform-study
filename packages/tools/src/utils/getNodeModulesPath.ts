import path from 'path';
import fs from 'fs';
import Logger from './Logger';

/**
 * Gets the absolute path to the node_modules directory for the current workspace
 * @param workspaceRoot Optional workspace root path (defaults to process.cwd())
 * @returns Absolute path to the node_modules folder
 * @throws Error if node_modules cannot be found
 */
export function getNodeModulesPath(workspaceRoot: string = process.cwd()): string {
  const logger = new Logger('getNodeModulesPath');
  logger.debug(`Searching for node_modules from workspace root: ${workspaceRoot}`);

  // Start with the provided workspace root
  let currentPath = workspaceRoot;

  // Check up to 5 levels up from the current directory
  for (let i = 0; i < 5; i++) {
    const nodeModulesPath = path.resolve(currentPath, 'node_modules');
    logger.debug(`Checking path: ${nodeModulesPath}`);

    if (fs.existsSync(nodeModulesPath) && fs.statSync(nodeModulesPath).isDirectory()) {
      logger.info(`Found node_modules at: ${nodeModulesPath}`);
      return nodeModulesPath;
    }

    // Move one level up
    const parentPath = path.dirname(currentPath);

    // If we've reached the root directory and can't go up further, break
    if (parentPath === currentPath) {
      logger.debug('Reached filesystem root, stopping search');
      break;
    }

    currentPath = parentPath;
    logger.debug(`Moving up to parent directory: ${currentPath}`);
  }

  // If we couldn't find node_modules after checking 5 levels up
  logger.error(`Failed to find node_modules within 5 directory levels up from ${workspaceRoot}`);
  throw new Error(`node_modules directory not found within 5 directory levels up from ${workspaceRoot}`);
}

/**
 * Gets the absolute path to the node_modules directory for the current pnpm workspace
 * This function specifically looks for pnpm-workspace.yaml to identify the workspace root
 * @param startPath Optional starting path for the search (defaults to process.cwd())
 * @returns Absolute path to the workspace node_modules folder
 * @throws Error if pnpm workspace root or node_modules cannot be found
 */
export function getPnpmWorkspaceNodeModulesPath(startPath: string = process.cwd()): string {
  const logger = new Logger('getPnpmWorkspaceNodeModulesPath');
  logger.debug(`Searching for pnpm workspace root from: ${startPath}`);

  let currentPath = startPath;

  // Check up to 10 levels up from the current directory
  for (let i = 0; i < 10; i++) {
    const workspaceYamlPath = path.resolve(currentPath, 'pnpm-workspace.yaml');
    const packageJsonPath = path.resolve(currentPath, 'package.json');

    // Check if we found the workspace root (has pnpm-workspace.yaml or package.json with workspaces)
    if (fs.existsSync(workspaceYamlPath)) {
      logger.debug(`Found pnpm-workspace.yaml at: ${currentPath}`);
      const nodeModulesPath = path.resolve(currentPath, 'node_modules');

      if (fs.existsSync(nodeModulesPath) && fs.statSync(nodeModulesPath).isDirectory()) {
        logger.info(`Found workspace node_modules at: ${nodeModulesPath}`);
        return nodeModulesPath;
      } else {
        logger.error(`Found workspace root at ${currentPath} but node_modules directory doesn't exist`);
        throw new Error(`node_modules directory not found in pnpm workspace root at ${currentPath}`);
      }
    } else if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.workspaces) {
          logger.debug(`Found package.json with workspaces at: ${currentPath}`);
          const nodeModulesPath = path.resolve(currentPath, 'node_modules');

          if (fs.existsSync(nodeModulesPath) && fs.statSync(nodeModulesPath).isDirectory()) {
            logger.info(`Found workspace node_modules at: ${nodeModulesPath}`);
            return nodeModulesPath;
          } else {
            logger.error(`Found workspace root at ${currentPath} but node_modules directory doesn't exist`);
            throw new Error(`node_modules directory not found in pnpm workspace root at ${currentPath}`);
          }
        }
      } catch (error) {
        logger.debug(`Error parsing package.json at ${packageJsonPath}: ${error}`);
      }
    }

    // Move one level up
    const parentPath = path.dirname(currentPath);

    // If we've reached the root directory and can't go up further, break
    if (parentPath === currentPath) {
      logger.debug('Reached filesystem root, stopping search');
      break;
    }

    currentPath = parentPath;
    logger.debug(`Moving up to parent directory: ${currentPath}`);
  }

  // If we couldn't find the workspace root
  logger.error(`Failed to find pnpm workspace root within 10 directory levels up from ${startPath}`);
  throw new Error(`pnpm workspace root not found within 10 directory levels up from ${startPath}`);
}

export default getNodeModulesPath;
