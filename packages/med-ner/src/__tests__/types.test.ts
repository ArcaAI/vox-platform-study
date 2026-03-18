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
  it('should have default model mapping', () => {
    expect(MODEL_MAP['default']).toBe('Xenova/bert-base-NER');
  });

  it('should have biomedical model mapping', () => {
    expect(MODEL_MAP['biomedical']).toBe('Kushtrim/bert-base-cased-biomedical-ner');
  });

  it('should have clinical model mapping', () => {
    expect(MODEL_MAP['clinical']).toBe('samrawal/bert-base-uncased_clinical-ner');
  });
});

describe('DEFAULT_MED_NER_OPTIONS', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_MED_NER_OPTIONS.model).toBe('default');
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
