import * as fs from 'fs';
import * as path from 'path';

/**
 * Recursively generates a barrel file (`index.ts`) for a given directory.
 * The barrel file exports all TypeScript modules within that directory and its subdirectories.
 *
 * @param directoryPath - The path to the directory for which to create the barrel file.
 */
export function exportFromDirectory(directoryPath: string): void {
  const files = fs.readdirSync(directoryPath);

  let barrelContent = '';

  files.forEach((file) => {
    const fullPath = path.join(directoryPath, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      exportFromDirectory(fullPath);
      const relativePath = `./${file}`;
      barrelContent += `export * from '${relativePath}';\n`;
    } else if (file.endsWith('.ts') && file !== 'index.ts') {
      const moduleName = path.basename(file, '.ts');
      const relativePath = `./${moduleName}`;
      barrelContent += `export * from '${relativePath}';\n`;
    }
  });

  if (barrelContent) {
    const barrelFilePath = path.join(directoryPath, 'index.ts');
    fs.writeFileSync(barrelFilePath, barrelContent);
  }
}

export default exportFromDirectory;
