/**
 * Library inference for a bucket path (TASK-1023). Found in the live proof: an HF snapshot whose
 * `config.json` carries no `architectures` but ships top-level torch weights AND an `onnx/` export
 * was read as `onnxruntime` + `onnx/model.onnx` — the services load that snapshot with transformers.
 */
import { describe, expect, it } from 'vitest';
import { AiModelFormat } from '@arcaai/domains';
import { formatFor } from '../hub-preview.util';
import { localLibraryFor, primaryObjectFor } from '../local-model-preview';

const f = (...keys: string[]) => keys.map((key) => ({ key, size: 1 }));

describe('localLibraryFor', () => {
  it('top-level config.json + torch weights is transformers even without `architectures`, beside an onnx/ export', () => {
    const files = f('config.json', 'model.safetensors', 'pytorch_model.bin', 'onnx/model.onnx', 'tokenizer.json');
    expect(localLibraryFor(files, {})).toBe('transformers');
    expect(primaryObjectFor('transformers', files, null)).toBeNull();
  });

  it('an ONNX-only folder is still onnxruntime', () => {
    expect(localLibraryFor(f('model.onnx', 'config.json'), {})).toBe('onnxruntime');
  });

  it('torch weights with no config.json at all stay undecided (not transformers)', () => {
    expect(localLibraryFor(f('model.safetensors'), null)).toBeNull();
  });

  it('nested torch weights do not make a folder transformers', () => {
    expect(localLibraryFor(f('config.json', 'sub/model.safetensors'), {})).toBeNull();
  });
});

describe('formatFor (shared with the Hub preview)', () => {
  const paths = (...keys: string[]) => keys.map((path) => ({ path }));

  it('a transformers model with an onnx/ export is SAFETENSOR, not ONNX', () => {
    expect(formatFor('transformers', paths('config.json', 'model.safetensors', 'onnx/model.onnx'))).toBe(AiModelFormat.SAFETENSOR);
  });

  it('a transformers model with only .bin weights (plus onnx/) is PYTORCH', () => {
    expect(formatFor('transformers', paths('config.json', 'pytorch_model.bin', 'onnx/model.onnx'))).toBe(AiModelFormat.PYTORCH);
  });

  it('an onnxruntime model is ONNX', () => {
    expect(formatFor('onnxruntime', paths('model.onnx', 'model.safetensors'))).toBe(AiModelFormat.ONNX);
  });
});
