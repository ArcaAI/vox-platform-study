/**
 * The engine inventory (TASK-890 §3.12).
 *
 * The rail IS the inventory: an operator scanning it should see WHICH engines
 * this platform can serve from. Ollama and llama.cpp were probed by the
 * readiness sweep and by `admin/ai-models/discovery` but had no screen, so a
 * down Ollama was visible only as a missing row somewhere else.
 *
 * These tests hold the three sides together — the descriptor, the rail entry
 * and the route — because a descriptor with no rail entry is invisible and a
 * rail entry with no route is a 404.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_ENTRIES } from '@/shared/navigation/nav-config';
import { ENGINE_DESCRIPTORS } from '../engine-meta';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../app/(console)/(global)');

describe('ENGINE_DESCRIPTORS', () => {
  it('covers all four self-hosted engines the platform probes', () => {
    expect(Object.keys(ENGINE_DESCRIPTORS).sort()).toEqual(['llama-cpp', 'lm-studio', 'ollama', 'vllm']);
  });

  it('gives every engine the copy the screen needs — including why it is normally unreachable', () => {
    for (const [provider, descriptor] of Object.entries(ENGINE_DESCRIPTORS)) {
      expect(descriptor.provider, provider).toBe(provider);
      expect(descriptor.route, provider).toBe(`/ai-services/${provider}`);
      expect(descriptor.title, provider).toBeTruthy();
      expect(descriptor.summary, provider).toBeTruthy();
      expect(descriptor.listingSurface, provider).toBeTruthy();
      expect(descriptor.notDeployedNote, provider).toBeTruthy();
      expect(descriptor.artifactPrefix, provider).toBe(`${provider}/`);
      // The lifecycle omission is shared and must never be dropped: an operator
      // who cannot find a start/stop button is owed the reason it is absent.
      expect(descriptor.omissions.length, provider).toBeGreaterThan(0);
    }
  });
});

describe('engine screens are reachable', () => {
  it('has a tier-10-19 rail entry for every engine', () => {
    for (const descriptor of Object.values(ENGINE_DESCRIPTORS)) {
      const entry = NAV_ENTRIES.find((candidate) => candidate.route === descriptor.route);
      expect(entry, `${descriptor.route} has no rail entry`).toBeDefined();
      expect(entry!.tier, descriptor.route).toBe('10-19');
      expect(entry!.implemented, descriptor.route).toBe(true);
      expect(entry!.required, descriptor.route).toEqual([['manage', 'all']]);
    }
  });

  it('has a page and a skeleton behind every rail entry', () => {
    for (const descriptor of Object.values(ENGINE_DESCRIPTORS)) {
      expect(existsSync(resolve(APP_DIR, `.${descriptor.route}/page.tsx`)), `${descriptor.route}/page.tsx`).toBe(true);
      expect(existsSync(resolve(APP_DIR, `.${descriptor.route}/loading.tsx`)), `${descriptor.route}/loading.tsx`).toBe(true);
    }
  });
});
