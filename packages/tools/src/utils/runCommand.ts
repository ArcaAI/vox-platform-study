import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface RunCommandOptions {
    command: string;
    cwd?: string;
}

/**
 * Runs a command in the shell asynchronously.
 * @param options - Options for running the command.
 * @returns - A promise resolving with the command's output.
 */
export async function runCommand(
    options: RunCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
    const { command, cwd } = options;

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: cwd || process.cwd(),
        });

        if (stdout) {
            console.log(stdout);
        }
        if (stderr) {
            console.error(stderr);
        }

        return { stdout, stderr };
    } catch (error) {
        console.error('Failed to run command:', error);
        throw error;
    }
}

export default runCommand;
