import typescript from 'rollup-plugin-typescript2';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import { terser } from 'rollup-plugin-terser';
import obfuscator from 'rollup-plugin-obfuscator';
import json from '@rollup/plugin-json';
import externals from 'rollup-plugin-node-externals';
import babel from '@rollup/plugin-babel';
import nodeGlobals from 'rollup-plugin-node-globals';
import nodeBuiltins from 'rollup-plugin-node-builtins';


/**
 * Creates a base Rollup configuration for TypeScript projects
 * @param {Object} options - Configuration options
 * @param {string|Object} options.input - Entry point(s) for the bundle
 * @param {string} options.outDir - Output directory for the bundle
 * @param {boolean} [options.minify=true] - Whether to minify the output
 * @param {boolean} [options.obfuscate=true] - Whether to obfuscate the output
 * @param {boolean} [options.isDev=false] - Whether in development mode
 * @param {boolean} [options.preserveModules=false] - Whether to preserve module structure
 * @param {Array<string>} [options.externals=[]] - Additional external dependencies
 * @returns {import('rollup').RollupOptions}
 */
export function createConfig({
  input,
  outDir,
  minify = true,
  obfuscate = true,
  sourceMap = true,
  externals: externalDeps = [],
  isDev = process.env.NODE_ENV === 'development',
  preserveModules = false,
  preserveModulesRoot = null,
}) {
  const plugins = [
    externals({
      deps: true,
      devDeps: false,
      peerDeps: true
    }),
    nodeResolve({
      preferBuiltins: true,
      extensions: ['.ts', '.js', '.mjs', '.json'],
      moduleDirectories: ['node_modules'],
    }),
    commonjs({
      transformMixedEsModules: true,
      ignore: [/formidable/],
    }),
    json(),
    replace({
      preventAssignment: true,
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')
    }),
    typescript({
      tsconfig: './tsconfig.json',
      clean: true,
      sourceMap,
    }),
    babel({
      babelHelpers: 'bundled',
      extensions: ['.ts', '.js'],
      exclude: 'node_modules/**'
    }),
    nodeBuiltins(),
    nodeGlobals(),
  ];

  if (minify && !isDev) {
    plugins.push(
      terser({
        format: {
          comments: false,
        },
        compress: {
          drop_console: true,
          drop_debugger: true,
        },
      })
    );
  }

  if (obfuscate && !isDev) {
    plugins.push(
      obfuscator({
        global: true,
        options: {
          compact: true,
          controlFlowFlattening: true,
          controlFlowFlatteningThreshold: 0.5,
          deadCodeInjection: true,
          deadCodeInjectionThreshold: 0.3,
          debugProtection: true,
          // debugProtectionInterval: true,
          // disableConsoleOutput: true,
          identifierNamesGenerator: 'hexadecimal',
          // log: false,
          numbersToExpressions: true,
          renameGlobals: false,
          selfDefending: true,
          simplify: true,
          splitStrings: true,
          splitStringsChunkLength: 10,
          stringArray: true,
          stringArrayCallsTransform: true,
          stringArrayEncoding: ['rc4'],
          stringArrayIndexShift: true,
          stringArrayRotate: true,
          stringArrayShuffle: true,
          stringArrayWrappersCount: 5,
          stringArrayWrappersChainedCalls: true,
          stringArrayWrappersParametersMaxCount: 5,
          stringArrayWrappersType: 'function',
          stringArrayThreshold: 0.8,
          transformObjectKeys: true,
          unicodeEscapeSequence: false
        }
      })
    );
  }

  const outputConfig = {
    dir: outDir,
    format: "cjs",
    sourcemap: isDev ? true : sourceMap,
    exports: "named",
  };

  if (preserveModules) {
    outputConfig.preserveModules = true;
    if (preserveModulesRoot) {
      outputConfig.preserveModulesRoot = preserveModulesRoot;
    }
  }

  return {
    input,
    output: outputConfig,
    external: [
      // Common externals
      'express',
      'winston',
      'cors',
      'helmet',
      'body-parser',
      'crypto',
      'fs',
      'path',
      'multer',
      'morgan',
      'swagger-ui-express',
      'socket.io',
      // Add any external dependencies that shouldn't be bundled
      /^@prisma\/client$/,
      /^decimal\.js$/,
      /^dotenv$/,
      /^formidable$/,
      /formidable/,
      /node_modules/,
      ...externalDeps,
    ],
    plugins,
    onwarn: (warning, warn) => {
      // Skip circular dependency warnings
      if (warning.code === 'CIRCULAR_DEPENDENCY') return;
      warn(warning);
    }
  };
}

/**
 * Helper to generate entry points from directories
 * @param {string} srcDir - Source directory
 * @returns {Object} - Entry points object
 */
export function createEntriesFromDirectories(srcDir) {
  const fs = require('fs');
  const path = require('path');
  const entries = {};

  // Add main entry point if it exists
  const mainIndex = path.join(srcDir, 'index.ts');
  if (fs.existsSync(mainIndex)) {
    entries['index'] = mainIndex;
  }

  // Get all directories in the source directory
  const directories = fs.readdirSync(srcDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  // Add directories with index.ts as entry points
  directories.forEach(dir => {
    const indexFile = path.join(srcDir, dir, 'index.ts');
    if (fs.existsSync(indexFile)) {
      entries[`${dir}/index`] = indexFile;
    }
  });

  return entries;
}