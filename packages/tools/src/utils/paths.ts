import * as path from 'path';
import * as fs from 'fs';
import { getPnpmWorkspaceNodeModulesPath } from './getNodeModulesPath';

/**
 * Utility class to manage paths across the application
 */
export class Paths {
  private static workspacePath: string | null = null;
  private static toolsPath: string | null = null;

  /**
   * Find the monorepo root by looking for pnpm-workspace.yaml or turbo.json
   * This is more reliable than using node_modules path resolution
   */
  private static findMonorepoRoot(startPath: string): string {
    let currentPath = startPath;
    const maxDepth = 10;
    let depth = 0;

    while (depth < maxDepth) {
      if (fs.existsSync(path.join(currentPath, 'pnpm-workspace.yaml'))) {
        return currentPath;
      }
      if (fs.existsSync(path.join(currentPath, 'turbo.json'))) {
        return currentPath;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
      depth++;
    }

    // Fallback to node_modules-based resolution
    try {
      const nodeModulesPath = getPnpmWorkspaceNodeModulesPath(startPath);
      return path.resolve(nodeModulesPath, '..');
    } catch {
      // Last resort: assume we're somewhere in packages/tools
      return path.resolve(startPath, '..', '..');
    }
  }

  /**
   * Get the workspace path (root of the monorepo)
   */
  static getWorkspacePath(): string {
    if (!this.workspacePath) {
      this.workspacePath = this.findMonorepoRoot(process.cwd());
    }
    return this.workspacePath;
  }

  /**
   * Get the tools package path
   */
  static getToolsPath(): string {
    if (!this.toolsPath) {
      this.toolsPath = path.resolve(this.getWorkspacePath(), 'packages/tools');
    }
    return this.toolsPath;
  }

  /**
   * Get path to domains directory
   */
  static getDomainsPath(): string {
    return path.resolve(this.getWorkspacePath(), 'packages/domains');
  }

  /**
   * Get path to domains source directory
   */
  static getDomainsSourcePath(): string {
    return path.resolve(this.getDomainsPath(), 'src');
  }

  /**
   * Get path to entities directory
   */
  static getEntitiesPath(): string {
    return path.resolve(this.getDomainsSourcePath(), 'entities/generated');
  }

  /**
   * Get path to models directory
   */
  static getModelsPath(): string {
    return path.resolve(this.getDomainsSourcePath(), 'models/generated');
  }

  /**
   * Get path to repositories directory
   */
  static getRepositoriesPath(): string {
    return path.resolve(this.getDomainsSourcePath(), 'repositories/generated');
  }

  /**
   * Get path to mappers directory
   */
  static getMappersPath(): string {
    return path.resolve(this.getDomainsSourcePath(), 'mappers/generated');
  }

  /**
   * Get path to factories directory
   */
  static getFactoriesPath(): string {
    return path.resolve(this.getDomainsSourcePath(), 'factories/generated');
  }

  /**
   * Get path to domain services directory
   */
  static getServicesPath(): string {
    return path.resolve(this.getDomainsSourcePath(), 'services/generated');
  }

  /**
   * Get entities directory for a specific domain
   */
  static getDomainEntitiesPath(domain: string): string {
    return path.resolve(this.getEntitiesPath(), domain);
  }

  /**
   * Get repositories directory for a specific domain
   */
  static getDomainRepositoriesPath(domain: string): string {
    return path.resolve(this.getRepositoriesPath(), domain.toLowerCase());
  }

  /**
   * Get mappers directory for a specific domain
   */
  static getDomainMappersPath(domain: string): string {
    return path.resolve(this.getMappersPath(), domain.toLowerCase());
  }

  /**
   * Get factories directory for a specific domain
   */
  static getDomainFactoriesPath(domain: string): string {
    return path.resolve(this.getFactoriesPath(), domain.toLowerCase());
  }

  /**
   * Get domain services directory for a specific domain
   */
  static getDomainServicesPath(domain: string): string {
    return path.resolve(this.getServicesPath(), domain.toLowerCase());
  }

  /**
   * Get templates directory for a specific generator
   */
  static getTemplatesPath(generatorName: string): string {
    // Support both "repository" and "generate-repository" formats
    const formattedGeneratorName = generatorName.startsWith('generate-') ? generatorName : `generate-${generatorName}`;

    return path.resolve(this.getToolsPath(), 'src', formattedGeneratorName, 'templates');
  }

  /**
   * Get specific template file path
   */
  static getTemplatePath(generatorName: string, templateName: string): string {
    return path.resolve(this.getTemplatesPath(generatorName), `${templateName}.hbs`);
  }

  /**
   * Get output path for a specific generator
   */
  static getGeneratedOutputPath(generatorType: string, domain: string): string {
    let basePath;

    switch (generatorType) {
      case 'repository':
        basePath = this.getRepositoriesPath();
        break;
      case 'mapper':
        basePath = this.getMappersPath();
        break;
      case 'factory':
        basePath = this.getFactoriesPath();
        break;
      case 'domain-service':
        basePath = this.getServicesPath();
        break;
      case 'data-entity':
      case 'data-model':
        basePath = this.getEntitiesPath();
        break;
      default:
        throw new Error(`Unknown generator type: ${generatorType}`);
    }

    return path.resolve(basePath, domain.toLowerCase());
  }

  /**
   * Ensure a directory exists, create it if it doesn't
   */
  static ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Generate index.ts file for a directory to export all TypeScript files
   * @param directoryPath Directory to generate index.ts for
   * @param recursive Whether to recursively generate index files for subdirectories
   * @returns Path to the generated index file
   */
  static generateIndexFile(directoryPath: string, recursive: boolean = false): string {
    const files = fs.readdirSync(directoryPath);
    let indexContent = '';

    files.forEach((file) => {
      const fullPath = path.join(directoryPath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory() && recursive) {
        // Generate index.ts for subdirectory
        this.generateIndexFile(fullPath, recursive);

        // Export from subdirectory
        const dirName = path.basename(file);
        indexContent += `export * from './${dirName}';\n`;
      } else if (file.endsWith('.ts') && file !== 'index.ts') {
        // Export individual file
        const moduleName = path.basename(file, '.ts');
        indexContent += `export * from './${moduleName}';\n`;
      }
    });

    if (indexContent) {
      const indexFilePath = path.join(directoryPath, 'index.ts');
      fs.writeFileSync(indexFilePath, indexContent);
      return indexFilePath;
    }

    return '';
  }

  /**
   * Generate index.ts files for a type of generated files (repositories, mappers, etc.)
   * @param generatorType Type of generator (repository, mapper, etc.)
   * @param domainNames List of domain names to generate index files for (if empty, generates for all domains)
   * @returns List of generated index file paths
   */
  static generateIndicesForType(generatorType: string, domainNames: string[] = []): string[] {
    let basePath;

    switch (generatorType) {
      case 'repository':
        basePath = this.getRepositoriesPath();
        break;
      case 'mapper':
        basePath = this.getMappersPath();
        break;
      case 'factory':
        basePath = this.getFactoriesPath();
        break;
      case 'domain-service':
        basePath = this.getServicesPath();
        break;
      case 'data-entity':
        basePath = this.getEntitiesPath();
        break;
      case 'data-model':
        basePath = this.getModelsPath();
        break;
      default:
        throw new Error(`Unknown generator type: ${generatorType}`);
    }

    // Ensure the base directory exists
    this.ensureDirectoryExists(basePath);

    // If no domain names provided, get all domains from the directory
    if (domainNames.length === 0) {
      try {
        domainNames = fs.readdirSync(basePath).filter((item) => fs.statSync(path.join(basePath, item)).isDirectory());
      } catch (error) {
        // Directory might not exist yet
        return [];
      }
    }

    const generatedIndexFiles: string[] = [];

    // Generate index files for each domain
    for (const domain of domainNames) {
      const domainPath = path.join(basePath, domain.toLowerCase());

      if (fs.existsSync(domainPath) && fs.statSync(domainPath).isDirectory()) {
        const indexPath = this.generateIndexFile(domainPath);
        if (indexPath) {
          generatedIndexFiles.push(indexPath);
        }
      }
    }

    // Generate main index file that exports from all domains
    if (generatedIndexFiles.length > 0) {
      const mainIndexPath = this.generateIndexFile(basePath);
      if (mainIndexPath) {
        generatedIndexFiles.push(mainIndexPath);
      }
    }

    // Generate index file for the parent directory of the 'generated' folder
    const parentDir = path.dirname(basePath);
    if (fs.existsSync(parentDir) && fs.statSync(parentDir).isDirectory()) {
      const parentIndexPath = this.generateIndexFile(parentDir, true);
      if (parentIndexPath) {
        generatedIndexFiles.push(parentIndexPath);
      }
    }

    return generatedIndexFiles;
  }
}
