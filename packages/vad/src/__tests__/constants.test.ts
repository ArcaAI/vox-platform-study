/**
 * @arcaai/vad - constants tests
 *
 * Covers pinning CDN paths to a single version constant per dependency,
 * matching the installed package version.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  VAD_WEB_VERSION,
  ORT_WEB_VERSION,
  DEFAULT_BASE_ASSET_PATH,
  DEFAULT_ONNX_WASM_BASE_PATH,
} from '../constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgJsonPath = resolve(here, '..', '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const installedVadWebRange = pkg.dependencies?.['@ricky0123/vad-web'] ?? '';
const installedOrtRange = pkg.devDependencies?.['onnxruntime-web'] ?? '';

const stripRange = (range: string): string => range.replace(/^[\^~]/, '');

describe('VAD constants', () => {
  it('VAD_WEB_VERSION matches @ricky0123/vad-web in package.json', () => {
    expect(installedVadWebRange).not.toBe('');
    expect(VAD_WEB_VERSION).toBe(stripRange(installedVadWebRange));
  });

  it('ORT_WEB_VERSION matches onnxruntime-web in package.json', () => {
    expect(installedOrtRange).not.toBe('');
    expect(ORT_WEB_VERSION).toBe(stripRange(installedOrtRange));
  });

  it('DEFAULT_BASE_ASSET_PATH interpolates VAD_WEB_VERSION', () => {
    expect(DEFAULT_BASE_ASSET_PATH).toContain(`@ricky0123/vad-web@${VAD_WEB_VERSION}/`);
  });

  it('DEFAULT_ONNX_WASM_BASE_PATH interpolates ORT_WEB_VERSION', () => {
    expect(DEFAULT_ONNX_WASM_BASE_PATH).toContain(`onnxruntime-web@${ORT_WEB_VERSION}/`);
  });

  it('CDN paths end with a trailing slash', () => {
    expect(DEFAULT_BASE_ASSET_PATH.endsWith('/')).toBe(true);
    expect(DEFAULT_ONNX_WASM_BASE_PATH.endsWith('/')).toBe(true);
  });
});
