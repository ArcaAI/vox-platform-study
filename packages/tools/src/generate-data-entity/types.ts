import { DMMF } from '@prisma/generator-helper';

export interface DomainFolder {
    name: string;
    value: string;
    folderPath: string;
    module: string;
}

export interface GenerateEntityOptions {
    outputPath: string;
    overwrite: boolean;
    prismaPath?: string;
    selectedDomains?: string[];
}

export interface EntityField {
    name: string;
    type: string;
    isRelationship: boolean;
    isRequired: boolean;
}

export interface EntityMetadata {
    entityName: string;
    entityPropsName: string;
    baseClassName: string;
    baseClassPropsName: string;
    ignoreTenantId: boolean;
    properties: EntityField[];
    hasDecimal: boolean;
}

export interface SelectedItem {
    type: 'model';
    name: string;
    data: any;
}