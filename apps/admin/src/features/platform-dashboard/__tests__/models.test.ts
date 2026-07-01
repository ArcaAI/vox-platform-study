import { describe, expect, it } from 'vitest';
import { PLATFORM_MODELS } from '../models';

describe('platform models inventory (frame 11)', () => {
    it('is the grounded 6-model list in display order', () => {
        expect(PLATFORM_MODELS.map((m) => m.id)).toEqual([
            'whisper-large-v3-turbo',
            'silero-vad-v5',
            'gemma-4-e4b',
            'granite-guardian-4.1-8b',
            'Medical-NER',
            'symps-disease-bert',
        ]);
    });

    it('has unique ids', () => {
        const ids = PLATFORM_MODELS.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('maps each model to a known host service', () => {
        const byId = Object.fromEntries(PLATFORM_MODELS.map((m) => [m.id, m.service]));
        expect(byId['whisper-large-v3-turbo']).toBe('STT');
        expect(byId['silero-vad-v5']).toBe('STT');
        expect(byId['gemma-4-e4b']).toBe('SMR');
        expect(byId['granite-guardian-4.1-8b']).toBe('Guardrail');
        expect(byId['Medical-NER']).toBe('NLP');
        expect(byId['symps-disease-bert']).toBe('NLP');
    });

    it('only references real platform services', () => {
        const known = new Set(['STT', 'SMR', 'Guardrail', 'NLP']);
        expect(PLATFORM_MODELS.every((m) => known.has(m.service))).toBe(true);
    });
});
