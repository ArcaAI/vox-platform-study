import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

interface ModelMetadata {
    modelName: string;
    baseClassName: string;
    properties: Array<{
        name: string;
        type: string;
        isRelationship: boolean;
        isOptional: boolean;
        isArray: boolean;
    }>;
}

// Helper function to check if a node has a decorator containing the given name
function hasDecoratorWithName(node: ts.Node, decoratorNamePattern: string, sourceFile: ts.SourceFile): boolean {
    // Use proper TypeScript API to check for decorators
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    if (!decorators || decorators.length === 0) {
        return false;
    }

    return decorators.some((decorator: ts.Decorator) => {
        const decoratorText = decorator.expression.getText(sourceFile);
        return decoratorText.includes(decoratorNamePattern);
    });
}

// Helper function to get decorator text if it exists
function getDecoratorText(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
    // Use proper TypeScript API to check for decorators
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    if (!decorators || decorators.length === 0) {
        return undefined;
    }

    const decorator = decorators[0];
    return decorator.expression.getText(sourceFile);
}

function parseModelFile(filePath: string): ModelMetadata {
    // Validate the file exists
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    // Check if it's a TypeScript file
    if (!filePath.endsWith('.ts')) {
        throw new Error('Only TypeScript (.ts) files are supported');
    }

    // Read file content
    const fileContent = fs.readFileSync(filePath, 'utf8');

    // Create a TS source file
    const sourceFile = ts.createSourceFile(
        path.basename(filePath),
        fileContent,
        ts.ScriptTarget.Latest,
        true
    );

    const result: ModelMetadata = {
        modelName: '',
        baseClassName: '',
        properties: []
    };

    // Find the class that extends from a base class or any class if none extends
    ts.forEachChild(sourceFile, (node) => {
        if (ts.isClassDeclaration(node) && node.name) {
            // Check if class extends a base class
            let foundModelClass = false;
            if (
                node.heritageClauses &&
                node.heritageClauses.length > 0 &&
                node.heritageClauses[0].token === ts.SyntaxKind.ExtendsKeyword &&
                node.heritageClauses[0].types.length > 0
            ) {
                result.modelName = node.name.text;
                result.baseClassName = node.heritageClauses[0].types[0].expression.getText(sourceFile);
                foundModelClass = true;
            } else if (!result.modelName) {
                // If we haven't found a model class yet, use this one even if it doesn't extend anything
                result.modelName = node.name.text;
                result.baseClassName = 'None'; // Indicate this class doesn't extend anything
                foundModelClass = true;
            }

            if (foundModelClass) {
                // Process class properties
                node.members.forEach((member) => {
                    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
                        const propertyName = member.name.text;
                        let propertyType = 'unknown';
                        let isOptional = false;
                        let isArray = false;

                        // Check for VirtualDbProperty decorator
                        const isRelationship = hasDecoratorWithName(member, 'VirtualDbProperty', sourceFile);

                        // Extract property type if available
                        if (member.type) {
                            propertyType = member.type.getText(sourceFile);

                            // Check if it's optional (has null or undefined type)
                            isOptional = propertyType.includes('|') &&
                                (propertyType.includes('null') ||
                                    propertyType.includes('undefined'));

                            // Check if it's an array type
                            isArray = propertyType.includes('[]') ||
                                propertyType.includes('Array<');
                        }

                        // Add property to result
                        result.properties.push({
                            name: propertyName,
                            type: propertyType,
                            isRelationship,
                            isOptional,
                            isArray
                        });
                    }
                });
            }
        }
    });

    if (!result.modelName) {
        throw new Error('No class found in the file');
    }

    // Clean up property types
    result.properties = result.properties.map(prop => {
        let cleanType = prop.type;

        // Remove null, undefined and clean up type
        if (prop.isOptional) {
            cleanType = cleanType
                .replace(/\s*\|\s*null/g, '')
                .replace(/null\s*\|\s*/g, '')
                .replace(/\s*\|\s*undefined/g, '')
                .replace(/undefined\s*\|\s*/g, '')
                .trim();
        }

        // Remove array brackets
        if (prop.isArray) {
            cleanType = cleanType
                .replace(/\[\]/g, '')
                .replace(/Array<(.*)>/g, '$1')
                .trim();
        }

        return {
            ...prop,
            type: cleanType
        };
    });

    return result;
}

function printModelMetadata(metadata: ModelMetadata): void {
    console.log(`Model Name: ${metadata.modelName}`);
    console.log(`Base Class: ${metadata.baseClassName}`);

    console.log('\nProperties:');
    metadata.properties.forEach(prop => {
        const relationTag = prop.isRelationship ? ' (Relation)' : '';
        const optionalTag = prop.isOptional ? ' (Optional)' : '';
        const arrayTag = prop.isArray ? ' (Array)' : '';
        console.log(`- ${prop.name}: ${prop.type}${relationTag}${optionalTag}${arrayTag}`);
    });
}

// Pretty print to JSON
function printJsonMetadata(metadata: ModelMetadata): void {
    console.log(JSON.stringify(metadata, null, 2));
}

// Example usage
if (require.main === module) {
    if (process.argv.length < 3) {
        console.error('Please provide a file path to parse');
        process.exit(1);
    }

    const filePath = process.argv[2];
    const jsonOutput = process.argv.includes('--json');

    try {
        const metadata = parseModelFile(filePath);

        if (jsonOutput) {
            printJsonMetadata(metadata);
        } else {
            printModelMetadata(metadata);
        }
    } catch (error) {
        console.error('Error parsing file:', error);
        process.exit(1);
    }
}

export { parseModelFile };
export type { ModelMetadata };