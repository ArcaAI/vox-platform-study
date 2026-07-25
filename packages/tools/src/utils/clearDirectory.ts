import * as fs from 'fs';
import * as rimraf from 'rimraf';

export function clearDirectory(outputPath: string): void {
  console.log('Cleaning directory: ', outputPath);
  rimraf.sync(outputPath);
  fs.mkdirSync(outputPath, { recursive: true });
}

export default clearDirectory;
