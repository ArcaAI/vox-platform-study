// Define interface for selected items
export interface SelectedItem {
    type: 'model' | 'enum';
    name: string;
    data: any;
}

// Define interface for DMMF.Field
export interface Field {
    name: string;
    type: string;
    kind: string;
    isList: boolean;
    isRequired: boolean;
}

// Define interface for enum values
export interface EnumValue {
    name: string;
}

export interface CommandLineOptions {
    outputPath?: string;
    overwrite?: boolean;
    domain?: string;
    yes?: boolean;
    ci?: boolean;
    check?: boolean;
}

export interface DomainFolder {
    name: string;
    value: string;
    /** Absolute path to the Prisma schema (file or multi-file folder) for this domain. */
    schemaPath: string;
    /** Loaded multi-file Prisma schema tuples ([path, content]) used to derive DMMF/config. */
    schemas: unknown;
}

export type GenerationMode = 'write' | 'check';

export interface ProcessingOptions {
    outputModelsPath: string;
    enumsOutputPath: string;
    shouldOverwrite: boolean;
    /** 'write' actually writes files; 'check' collects output in-memory and diffs (writes nothing). */
    mode: GenerationMode;
    /** When false, all prompts are skipped and every domain/item is selected. */
    interactive: boolean;
    /** Domain chosen via --domain (name or 'all'); undefined means "ask or default to all". */
    selectedDomain?: string;
    /** In check mode, generated file contents are collected here (absolute path → content). */
    outputs: Map<string, string>;
}