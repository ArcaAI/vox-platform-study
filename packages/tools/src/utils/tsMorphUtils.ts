import { SourceFile } from 'ts-morph';
import { formatDtoName } from '.';

/**
 * Removes all decorators from classes, properties, and methods in a source file.
 *
 * @param sourceFile - The source file to process.
 */
export function stripDecoratorsFromSourceFile(sourceFile: SourceFile) {
  sourceFile.getClasses().forEach((classDeclaration) => {
    classDeclaration.getProperties().forEach((property) => {
      property.getDecorators().forEach((decorator) => decorator.remove());
    });
    classDeclaration.getMethods().forEach((method) => {
      method.getDecorators().forEach((decorator) => decorator.remove());
    });
  });
}

/**
 * Removes specified import declarations from a source file.
 *
 * @param sourceFile - The source file to process.
 * @param imports - An array of module specifiers to remove from the import declarations.
 */
export function removeSpecifiedImports(sourceFile: SourceFile, imports: string[]) {
  sourceFile.getImportDeclarations().forEach((importDeclaration) => {
    const moduleSpecifier = importDeclaration.getModuleSpecifierValue();
    if (imports.includes(moduleSpecifier)) {
      importDeclaration.remove();
    }
  });
}

/**
 * Updates import declarations in a source file by formatting the names of the named imports.
 *
 * @param sourceFile - The source file to process.
 */
export function updateImportDeclarations(sourceFile: SourceFile): void {
  const imports = sourceFile.getImportDeclarations();
  imports.forEach((imp) => {
    const namedImports = imp.getNamedImports();
    namedImports.forEach((namedImport) => {
      namedImport.replaceWithText(formatDtoName(namedImport.getName()));
    });
  });
}

/**
 * Updates the names of all enums in a source file by formatting them.
 *
 * @param sourceFile - The source file to process.
 * @returns A map of old enum names to new enum names.
 */
export function updateEnumNames(sourceFile: SourceFile): Map<string, string> {
  const nameChanges = new Map<string, string>();
  sourceFile.getEnums().forEach((cls) => {
    const className = cls.getName();
    if (className) {
      const newClassName = formatDtoName(className);

      if (newClassName !== className) {
        cls.rename(newClassName);
        nameChanges.set(className, newClassName);
      }
    }
  });
  return nameChanges;
}

/**
 * Updates the names of all classes in a source file by formatting them.
 *
 * @param sourceFile - The source file to process.
 * @returns A map of old class names to new class names.
 */
export function updateClassNames(sourceFile: SourceFile): Map<string, string> {
  const nameChanges = new Map<string, string>();
  sourceFile.getClasses().forEach((cls) => {
    const className = cls.getName();
    if (className) {
      const newClassName = formatDtoName(className);

      if (newClassName !== className) {
        cls.rename(newClassName);
        nameChanges.set(className, newClassName);
      }
    }
  });
  return nameChanges;
}

/**
 * Processes a type name, formatting it and handling union types.
 *
 * @param typeName - The type name to process.
 * @returns The formatted type name.
 */
export function processType(typeName: string) {
  if (typeName.includes('|')) {
    const unionTypes = typeName.split('|');
    return unionTypes.map((type) => formatDtoName(type.trim())).join(' | ');
  }
  return formatDtoName(typeName);
}

/**
 * Updates the property names of classes in a source file by formatting them.
 *
 * @param sourceFile - The source file to process.
 */
export function updateClassPropertyNames(sourceFile: SourceFile) {
  sourceFile.getClasses().forEach((cls) => {
    const baseClass = cls.getExtends();
    if (baseClass) {
      const baseClassName = baseClass.getText();
      baseClass.replaceWithText(formatDtoName(baseClassName));
      const baseEClassName = baseClass.getExpression().getText();
      baseClass.getExpression().replaceWithText(formatDtoName(baseEClassName));

      const typeArguments = baseClass.getTypeArguments();
      typeArguments.forEach((typeArgument) => {
        const typeArgumentText = typeArgument.getText();
        typeArgument.replaceWithText(formatDtoName(typeArgumentText));
      });
    }

    const typeChecker = sourceFile.getProject().getTypeChecker();

    cls.getProperties().forEach((property) => {
      const propertyType = property.getType();
      const propertyTypeNode = property.getTypeNode();

      let typeName = propertyTypeNode ? propertyTypeNode.getText() : typeChecker.getTypeAtLocation(property).getText();
      if (propertyType.isArray()) {
        const elementType = propertyType.getArrayElementType();
        const elementTypeName = elementType?.getSymbol()?.getName() || elementType?.getText();

        if (elementTypeName) {
          typeName = elementTypeName + '[]';
        }
      }
      typeName = processType(typeName);
      property.setType(formatDtoName(typeName));
    });
  });
}

/**
 * Updates import declarations in a source file based on provided mappings.
 *
 * @param sourceFile - The source file to process.
 * @param mappings - An array of mapping objects where each object contains a match function and a new module specifier.
 */
export function mapCommonImports(
  sourceFile: SourceFile,
  mappings: {
    match: (importPath: string) => boolean;
    newModuleSpecifier: string;
  }[],
): void {
  const imports = sourceFile.getImportDeclarations();
  imports.forEach((imp) => {
    const importFilePath = imp.getModuleSpecifier().getLiteralText();
    let newImportPath = importFilePath;

    // Check if the import path matches any of the provided mappings
    for (const mapping of mappings) {
      if (mapping.match(importFilePath)) {
        newImportPath = mapping.newModuleSpecifier;
        break;
      }
    }

    // Update the import module specifier
    imp.setModuleSpecifier(newImportPath);
  });
}

export function replaceImportPath(sourceFile: SourceFile, oldImportPath: string, newImportPath: string) {
  // Find the import declaration with the specified old import path
  const importDeclaration = sourceFile.getImportDeclaration(oldImportPath);

  if (importDeclaration) {
    // Replace the old import path with the new one
    importDeclaration.setModuleSpecifier(newImportPath);
  }
}

/**
 * Removes specified named imports from a source file.
 *
 * @param sourceFile - The source file to process.
 * @param namedImportsToRemove - An array of named imports to remove from the import declarations.
 */
export function removeSpecifiedNamedImports(sourceFile: SourceFile, namedImportsToRemove: string[]) {
  sourceFile.getImportDeclarations().forEach((importDeclaration) => {
    const namedImports = importDeclaration.getNamedImports();

    namedImports.forEach((namedImport) => {
      const importName = namedImport.getName();

      // If the named import is in the list to remove, remove it
      if (namedImportsToRemove.includes(importName)) {
        namedImport.remove();
      }
    });

    // If the import declaration has no named imports left, remove it
    if (importDeclaration.getNamedImports().length === 0) {
      importDeclaration.remove();
    }
  });
}
