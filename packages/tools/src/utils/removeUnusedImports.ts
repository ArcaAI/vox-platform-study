import { SourceFile, SyntaxKind } from 'ts-morph';

export function removeUnusedImports(sourceFile: SourceFile) {
    const importDeclarations = sourceFile.getImportDeclarations();
    importDeclarations.forEach((importDeclaration) => {
        // Get named imports
        const namedImports = importDeclaration.getNamedImports();

        // Check each named import if it's used in the source file
        namedImports.forEach((namedImport) => {
            const importName = namedImport.getName();
            console.log('importName:', importName);

            // Check if the named import is used in the source file
            const isUsed = sourceFile
                .getDescendantsOfKind(SyntaxKind.Identifier)
                .some((identifier) => identifier.getText() === importName);

            // If the named import is not used, remove it
            if (!isUsed) {
                console.log('removing unsued import 1:', importName);
                namedImport.remove();
            }
        });

        // If the import declaration has no named imports left, remove it
        if (importDeclaration.getNamedImports().length === 0) {
            console.log('removing unsued import: 2');

            importDeclaration.remove();
        }
    });
}

export default removeUnusedImports;
