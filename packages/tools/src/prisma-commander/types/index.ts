export type PrismaActivity = 'generate' | 'push' | 'push:force' | 'migrate' | 'seed' | 'studio';

export interface Domain {
  name: string;
  path: string;
  schemaFilePath?: string;
}

export interface ActivityConfig {
  name: PrismaActivity;
  label: string;
  description: string;
  execute: (domains: Domain[], options?: ActivityOptions) => Promise<void>;
}

export interface ActivityOptions {
  migrationName?: string;
  force?: boolean;
}

export interface PrismaCommandOptions {
  domains: Domain[];
  activity: ActivityConfig;
  options?: ActivityOptions;
}

export interface CLIOptions {
  activity?: string;
  domain?: string[];
  all?: boolean;
  force?: boolean;
  migrationName?: string;
  interactive?: boolean;
  listActivities?: boolean;
  listDomains?: boolean;
}
