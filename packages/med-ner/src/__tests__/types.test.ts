/**
 * @arcaai/med-ner - Types Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  MedicalEntityType,
  LABEL_TO_ENTITY_TYPE,
  MODEL_MAP,
  DEFAULT_MED_NER_OPTIONS,
  MedNERError,
  MedNERErrorCode,
} from '../types/index.js';

describe('MedicalEntityType', () => {
  it('should have all expected entity types', () => {
    expect(MedicalEntityType.DISEASE).toBe('DISEASE');
    expect(MedicalEntityType.MEDICATION).toBe('MEDICATION');
    expect(MedicalEntityType.PROCEDURE).toBe('PROCEDURE');
    expect(MedicalEntityType.ANATOMY).toBe('ANATOMY');
    expect(MedicalEntityType.LAB_VALUE).toBe('LAB_VALUE');
    expect(MedicalEntityType.SYMPTOM).toBe('SYMPTOM');
    expect(MedicalEntityType.DOSAGE).toBe('DOSAGE');
    expect(MedicalEntityType.FREQUENCY).toBe('FREQUENCY');
    expect(MedicalEntityType.DURATION).toBe('DURATION');
    expect(MedicalEntityType.GENE).toBe('GENE');
    expect(MedicalEntityType.CHEMICAL).toBe('CHEMICAL');
    expect(MedicalEntityType.OTHER).toBe('OTHER');
  });

  it('should have correct number of entity types', () => {
    const typeCount = Object.keys(MedicalEntityType).length;
    expect(typeCount).toBe(12);
  });
});

describe('LABEL_TO_ENTITY_TYPE', () => {
  it('should map disease labels correctly', () => {
    expect(LABEL_TO_ENTITY_TYPE['DISEASE']).toBe(MedicalEntityType.DISEASE);
    expect(LABEL_TO_ENTITY_TYPE['Disease']).toBe(MedicalEntityType.DISEASE);
    expect(LABEL_TO_ENTITY_TYPE['B-Disease']).toBe(MedicalEntityType.DISEASE);
    expect(LABEL_TO_ENTITY_TYPE['I-Disease']).toBe(MedicalEntityType.DISEASE);
  });

  it('should map medication labels correctly', () => {
    expect(LABEL_TO_ENTITY_TYPE['MEDICATION']).toBe(MedicalEntityType.MEDICATION);
    expect(LABEL_TO_ENTITY_TYPE['DRUG']).toBe(MedicalEntityType.MEDICATION);
    expect(LABEL_TO_ENTITY_TYPE['B-Drug']).toBe(MedicalEntityType.MEDICATION);
    expect(LABEL_TO_ENTITY_TYPE['I-Drug']).toBe(MedicalEntityType.MEDICATION);
  });

  it('should map anatomy labels correctly', () => {
    expect(LABEL_TO_ENTITY_TYPE['ANATOMY']).toBe(MedicalEntityType.ANATOMY);
    expect(LABEL_TO_ENTITY_TYPE['B-Body_Part']).toBe(MedicalEntityType.ANATOMY);
  });

  it('should map symptom labels correctly', () => {
    expect(LABEL_TO_ENTITY_TYPE['SYMPTOM']).toBe(MedicalEntityType.SYMPTOM);
    expect(LABEL_TO_ENTITY_TYPE['B-Sign_symptom']).toBe(MedicalEntityType.SYMPTOM);
  });

  it('should map gene labels correctly', () => {
    expect(LABEL_TO_ENTITY_TYPE['GENE']).toBe(MedicalEntityType.GENE);
    expect(LABEL_TO_ENTITY_TYPE['PROTEIN']).toBe(MedicalEntityType.GENE);
  });

  it('should map unknown labels to OTHER', () => {
    expect(LABEL_TO_ENTITY_TYPE['O']).toBe(MedicalEntityType.OTHER);
    expect(LABEL_TO_ENTITY_TYPE['MISC']).toBe(MedicalEntityType.OTHER);
  });
});

describe('MODEL_MAP', () => {
  it('should have default model mapping with pinned revision', () => {
    expect(MODEL_MAP['default']).toEqual({
      id: 'Xenova/bert-base-NER',
      revision: '24c7e5aba9ae350923357a6f0b92571be34037ec',
    });
  });

  it('should have biomedical model mapping with pinned revision', () => {
    expect(MODEL_MAP['biomedical']).toEqual({
      id: 'Kushtrim/bert-base-cased-biomedical-ner',
      revision: '52d842d49d18b95bc7ce6d78e95367ce94004c49',
    });
  });

  it('should have clinical model mapping with pinned revision', () => {
    expect(MODEL_MAP['clinical']).toEqual({
      id: 'samrawal/bert-base-uncased_clinical-ner',
      revision: '5db48a44e7e04d9b0e95b8209c0e4b0f4c29cc6d',
    });
  });

  it('should pin every preset to a 40-char hex commit SHA', () => {
    const shaRegex = /^[0-9a-f]{40}$/;
    for (const [name, ref] of Object.entries(MODEL_MAP)) {
      expect(typeof ref.id, `${name}.id`).toBe('string');
      expect(ref.id.length, `${name}.id`).toBeGreaterThan(0);
      expect(ref.revision, `${name}.revision`).toMatch(shaRegex);
    }
  });
});

describe('DEFAULT_MED_NER_OPTIONS', () => {
  it('should have correct default values', () => {
    // Phase 0 (0.8) / SOTA gap review D7 — the default preset must be
    // the medical model ('clinical'), not the generic Xenova/bert-base-NER
    // ('default' preset is still selectable explicitly, just no longer the
    // fallback when no model is specified).
    expect(DEFAULT_MED_NER_OPTIONS.model).toBe('clinical');
    expect(DEFAULT_MED_NER_OPTIONS.threshold).toBe(0.5);
    expect(DEFAULT_MED_NER_OPTIONS.mergeAdjacent).toBe(true);
    expect(DEFAULT_MED_NER_OPTIONS.mergeOverlapping).toBe(true);
    expect(DEFAULT_MED_NER_OPTIONS.maxLength).toBe(512);
    expect(DEFAULT_MED_NER_OPTIONS.chunkOverlap).toBe(50);
    expect(DEFAULT_MED_NER_OPTIONS.enableStats).toBe(false);
    expect(DEFAULT_MED_NER_OPTIONS.statsInterval).toBe(1000);
  });
});

describe('MedNERError', () => {
  it('should create error with code and message', () => {
    const error = new MedNERError(
      MedNERErrorCode.MODEL_LOAD_FAILED,
      'Failed to load model'
    );

    expect(error.code).toBe(MedNERErrorCode.MODEL_LOAD_FAILED);
    expect(error.message).toBe('Failed to load model');
    expect(error.name).toBe('MedNERError');
    expect(error.cause).toBeUndefined();
  });

  it('should create error with cause', () => {
    const cause = new Error('Network error');
    const error = new MedNERError(
      MedNERErrorCode.NETWORK_ERROR,
      'Failed to download model',
      cause
    );

    expect(error.code).toBe(MedNERErrorCode.NETWORK_ERROR);
    expect(error.message).toBe('Failed to download model');
    expect(error.cause).toBe(cause);
  });

  it('should have all error codes', () => {
    expect(MedNERErrorCode.MODEL_LOAD_FAILED).toBe('MODEL_LOAD_FAILED');
    expect(MedNERErrorCode.MODEL_NOT_FOUND).toBe('MODEL_NOT_FOUND');
    expect(MedNERErrorCode.PROCESSING_ERROR).toBe('PROCESSING_ERROR');
    expect(MedNERErrorCode.NOT_SUPPORTED).toBe('NOT_SUPPORTED');
    expect(MedNERErrorCode.INVALID_CONFIG).toBe('INVALID_CONFIG');
    expect(MedNERErrorCode.NOT_INITIALIZED).toBe('NOT_INITIALIZED');
    expect(MedNERErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
    expect(MedNERErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
  });
});
