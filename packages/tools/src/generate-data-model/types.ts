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
}

export interface DomainFolder {
    name: string;
    value: string;
    folderPath: string;
    module: string;
}

export interface ProcessingOptions {
    outputModelsPath: string;
    enumsOutputPath: string;
    shouldOverwrite: boolean;
}