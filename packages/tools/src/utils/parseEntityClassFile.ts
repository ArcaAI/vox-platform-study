import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

interface EntityMetadata {
  entityName: string;
  baseClassName: string;
  properties: Array<{ name: string; type: string; isRelationship: boolean; isOptional: boolean; isArray: boolean }>;
  interfaceName: string;
}

function parseEntityFile(filePath: string): EntityMetadata {
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
  const sourceFile = ts.createSourceFile(path.basename(filePath), fileContent, ts.ScriptTarget.Latest, true);

  const result: EntityMetadata = {
    entityName: '',
    baseClassName: '',
    properties: [],
    interfaceName: '',
  };

  let interfaceName: string | null = null;
  const interfaceMap: Map<string, ts.InterfaceDeclaration> = new Map();
  // Track omitted properties
  const omittedProperties: Set<string> = new Set();

  // Helper function to find the interface property type
  function findPropertyTypeInInterface(interfaceDeclaration: ts.InterfaceDeclaration, propertyName: string): string | null {
    // Check direct properties in this interface
    for (const member of interfaceDeclaration.members) {
      if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name) && member.name.text === propertyName && member.type) {
        return member.type.getText(sourceFile);
      }
    }

    // Check properties in base interfaces (inheritance)
    if (interfaceDeclaration.heritageClauses) {
      for (const clause of interfaceDeclaration.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const type of clause.types) {
            const baseInterfaceName = type.expression.getText(sourceFile);
            const baseInterface = interfaceMap.get(baseInterfaceName);

            if (baseInterface) {
              const typeInBaseInterface = findPropertyTypeInInterface(baseInterface, propertyName);
              if (typeInBaseInterface) {
                return typeInBaseInterface;
              }
            }
          }
        }
      }
    }

    return null;
  }

  // Helper function to extract omitted property names from Omit type
  function extractOmittedProperties(typeExpression: string): string[] {
    // Match Omit<Type, 'property1' | 'property2' | ...>
    const omitMatch = typeExpression.match(/Omit<[^,]+,\s*(.+)>/);
    if (!omitMatch || !omitMatch[1]) return [];

    // Extract property names (handling both single quotes and double quotes)
    const propertiesStr = omitMatch[1].trim();
    const properties: string[] = [];

    // Handle both single properties and union types (| separated)
    const propMatches = propertiesStr.match(/'([^']+)'|"([^"]+)"/g);
    if (propMatches) {
      propMatches.forEach((match) => {
        // Remove quotes
        const prop = match.replace(/['"]/g, '');
        properties.push(prop);
      });
    }

    return properties;
  }

  // Helper function to find interface declaration by name
  function findInterface(name: string): ts.InterfaceDeclaration | null {
    return interfaceMap.get(name) || null;
  }

  // Helper function to extract property name from indexed access type (e.g., 'name' from SomeInterface['name'])
  function extractPropertyNameFromIndexedAccessType(type: string): string | null {
    // Handle both "Interface['property']" and "Interface["property"]" formats
    const singleQuoteMatch = type.match(/\['([^']+)'\]$/);
    if (singleQuoteMatch && singleQuoteMatch[1]) {
      return singleQuoteMatch[1];
    }

    const doubleQuoteMatch = type.match(/\["([^"]+)"\]$/);
    if (doubleQuoteMatch && doubleQuoteMatch[1]) {
      return doubleQuoteMatch[1];
    }

    // Handle property access without quotes like Interface[property]
    const noQuoteMatch = type.match(/\[([a-zA-Z0-9_]+)\]$/);
    if (noQuoteMatch && noQuoteMatch[1]) {
      return noQuoteMatch[1];
    }

    return null;
  }

  // Helper function to extract actual property name by removing underscore prefix
  function getPropertyNameWithoutPrefix(prefixedName: string): string {
    if (prefixedName.startsWith('_')) {
      return prefixedName.substring(1);
    }
    return prefixedName;
  }

  // First pass - collect all interfaces and classes
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name) {
      interfaceMap.set(node.name.text, node);
    }
  });

  // Second pass - find the main entity interface and class
  const classes: ts.ClassDeclaration[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node)) {
      if (node.heritageClauses && node.heritageClauses.length > 0 && node.heritageClauses[0].token === ts.SyntaxKind.ExtendsKeyword) {
        // Potential entity interface - should be named like XxxEntityProps
        if (node.name.text.endsWith('Props') || node.name.text.endsWith('EntityProps')) {
          interfaceName = node.name.text;
          result.interfaceName = interfaceName;

          // Check for Omit in heritage clause
          for (const type of node.heritageClauses[0].types) {
            const typeText = type.getText(sourceFile);
            if (typeText.includes('Omit<')) {
              // Extract omitted property names
              const omittedProps = extractOmittedProperties(typeText);
              omittedProps.forEach((prop) => omittedProperties.add(prop));
            }
          }
        }
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      classes.push(node);
    }
  });

  // If we didn't find an interface ending with Props, take the first one that extends something
  if (!interfaceName) {
    for (const [name, iface] of interfaceMap) {
      if (iface.heritageClauses && iface.heritageClauses.length > 0 && iface.heritageClauses[0].token === ts.SyntaxKind.ExtendsKeyword) {
        interfaceName = name;
        result.interfaceName = interfaceName;

        // Check for Omit in heritage clause
        for (const type of iface.heritageClauses[0].types) {
          const typeText = type.getText(sourceFile);
          if (typeText.includes('Omit<')) {
            // Extract omitted property names
            const omittedProps = extractOmittedProperties(typeText);
            omittedProps.forEach((prop) => omittedProperties.add(prop));
          }
        }

        break;
      }
    }
  }

  if (!interfaceName) {
    throw new Error('No interface that extends from a base interface found in the file');
  }

  // Find the class that extends from a base class
  for (const classDecl of classes) {
    if (
      classDecl.heritageClauses &&
      classDecl.heritageClauses.length > 0 &&
      classDecl.heritageClauses[0].token === ts.SyntaxKind.ExtendsKeyword &&
      classDecl.heritageClauses[0].types.length > 0
    ) {
      result.entityName = classDecl.name!.text;
      result.baseClassName = classDecl.heritageClauses[0].types[0].expression.getText(sourceFile);

      // Get the interface declaration
      const entityInterface = findInterface(interfaceName);

      if (entityInterface) {
        // Process class properties (looking for ones with '_' prefix)
        classDecl.members.forEach((member) => {
          if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name) && member.name.text.startsWith('_')) {
            const prefixedName = member.name.text;
            const propertyName = getPropertyNameWithoutPrefix(prefixedName);
            let propertyType = 'unknown';

            // If property has an explicit type annotation
            if (member.type) {
              const typeText = member.type.getText(sourceFile);

              // Check if it's an indexed access type (InterfaceName['propertyName'])
              if (typeText.includes('[')) {
                // Extract interface name and property name
                const parts = typeText.split('[');
                if (parts.length >= 2) {
                  const interfaceRef = parts[0].trim();
                  const extractedPropName = extractPropertyNameFromIndexedAccessType(typeText);

                  if (extractedPropName) {
                    // First check if we can find the interface
                    const referencedInterface = findInterface(interfaceRef);
                    if (referencedInterface) {
                      // Look up the actual type in the referenced interface
                      const actualType = findPropertyTypeInInterface(referencedInterface, extractedPropName);
                      if (actualType) {
                        propertyType = actualType;
                      } else {
                        propertyType = typeText; // Fallback to the original type expression
                      }
                    } else {
                      // If interface not found, try the main entity interface
                      const actualType = findPropertyTypeInInterface(entityInterface, extractedPropName);
                      if (actualType) {
                        propertyType = actualType;
                      } else {
                        propertyType = typeText; // Fallback to the original type expression
                      }
                    }
                  } else {
                    propertyType = typeText;
                  }
                } else {
                  propertyType = typeText;
                }
              } else {
                propertyType = typeText;
              }
            } else {
              // If no explicit type, try to find it in the interface
              const interfacePropertyType = findPropertyTypeInInterface(entityInterface, propertyName);
              if (interfacePropertyType) {
                propertyType = interfacePropertyType;
              }
            }

            result.properties.push({
              name: propertyName,
              type: propertyType,
              isRelationship: false,
              isOptional: false,
              isArray: false,
            });
          }
        });
      } else {
        console.warn(`Interface ${interfaceName} not found in the file`);
      }

      break;
    }
  }

  if (!result.entityName) {
    throw new Error('No entity class that extends from a base class found in the file');
  }

  if (result.baseClassName === 'BaseTaggedEntity') {
    // Only add Tenant if it's not in the omitted properties
    if (!omittedProperties.has('tenantId')) {
      result.properties.push({
        name: 'Tenant',
        type: 'Entity.Tenant',
        isRelationship: true,
        isOptional: false,
        isArray: false,
      });
    }

    // Only add Tags if it's not in the omitted properties
    if (!omittedProperties.has('tags')) {
      result.properties.push({
        name: 'Tags',
        type: 'Entity.Tag[]',
        isRelationship: true,
        isOptional: false,
        isArray: true,
      });
    }
  }

  if (result.baseClassName === 'BaseTenantEntity') {
    // Only add Tenant if it's not in the omitted properties
    if (!omittedProperties.has('tenantId')) {
      result.properties.push({
        name: 'Tenant',
        type: 'Entity.Tenant',
        isRelationship: true,
        isOptional: false,
        isArray: false,
      });
    }
  }

  // Filter out properties that were omitted in the interface extension
  result.properties = result.properties.filter((prop) => !Array.from(omittedProperties).some((x) => x.includes(prop.name.toLocaleLowerCase())));

  // Process property types to determine if they are optional or arrays
  result.properties = result.properties.map((prop) => {
    const isOptional = prop.type.includes('null') || prop.type.includes('[]') || prop.type.includes('Array');
    const isArray = prop.type.includes('[]') || prop.type.includes('Array');
    const isRelationship = prop.type.includes('Entity');

    let cleanType = prop.type;

    // Remove null and clean up type
    if (isOptional) {
      cleanType = cleanType
        .replace(/\s*\|\s*null/g, '')
        .replace(/null\s*\|\s*/g, '')
        .trim();
    }

    // Remove array brackets
    if (isArray) {
      cleanType = cleanType
        .replace(/\[\]/g, '')
        .replace(/Array<(.*)>/g, '$1')
        .trim();
    }

    return {
      ...prop,
      type: cleanType,
      isOptional,
      isArray,
      isRelationship,
    };
  });

  return result;
}

function printEntityMetadata(metadata: EntityMetadata): void {
  console.log(`Entity Name: ${metadata.entityName}`);
  console.log(`Base Class: ${metadata.baseClassName}`);
  console.log(`Interface Name: ${metadata.interfaceName}`);

  console.log('\nProperties:');
  metadata.properties.forEach((prop) => {
    console.log(`- ${prop.name}: ${prop.type}`);
  });
}

// Pretty print to JSON
function printJsonMetadata(metadata: EntityMetadata): void {
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
    const metadata = parseEntityFile(filePath);

    if (jsonOutput) {
      printJsonMetadata(metadata);
    } else {
      printEntityMetadata(metadata);
    }
  } catch (error) {
    console.error('Error parsing file:', error);
    process.exit(1);
  }
}

export { parseEntityFile };
export type { EntityMetadata };
