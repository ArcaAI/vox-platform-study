import ts from 'typescript';

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
};

/**
 * Type-checks a snippet of generated TypeScript source in-memory (no temp
 * files, no child process). Backs the "generated types compile against a
 * fixture schema" gate (TDD list item 1).
 */
export function typeCheckSource(source: string, fileName = 'generated.ts'): readonly ts.Diagnostic[] {
  const host = ts.createCompilerHost(COMPILER_OPTIONS);

  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (name === fileName) {
      return ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
    }
    return originalGetSourceFile(name, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  host.readFile = (name) => (name === fileName ? source : ts.sys.readFile(name));

  const program = ts.createProgram([fileName], COMPILER_OPTIONS, host);
  return ts.getPreEmitDiagnostics(program);
}

export function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      if (diagnostic.file && diagnostic.start !== undefined) {
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return `${diagnostic.file.fileName}:${line + 1}:${character + 1} — ${message}`;
      }
      return message;
    })
    .join('\n');
}
