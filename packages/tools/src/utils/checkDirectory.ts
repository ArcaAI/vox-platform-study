import fs from 'fs';
import path from 'path';

/**
 * Checks if a directory exists
 * @param dirPath Path to check (absolute or relative)
 * @param workspacePath Optional workspace root path for resolving relative paths
 * @returns Boolean indicating if the directory exists
 */
export function checkDirectory(dirPath: string, workspacePath?: string): boolean {
  try {
    // If path is relative and workspace is provided, resolve it against workspace
    const resolvedPath = path.isAbsolute(dirPath) ? dirPath : workspacePath ? path.resolve(workspacePath, dirPath) : path.resolve(dirPath);

    // Check if path exists and is a directory
    return fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory();
  } catch (error) {
    return false;
  }
}

export default checkDirectory;
