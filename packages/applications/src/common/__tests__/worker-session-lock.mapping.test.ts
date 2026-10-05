import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Each BullMQ processor declares the restore categories it conflicts with (the tables it writes).
 * Pinned from source so a processor cannot silently drift back to "blocks on every restore".
 */
const SERVICES = join(__dirname, '../../services');
const MAPPING: [string, string, string][] = [
  ['knowledge/ingest-knowledge-document.processor.ts', "['CONFIG_CONTENT']", 'KnowledgeDocument / KnowledgeChunk'],
  ['directory-sync/directory-sync.processor.ts', "['USERS_ACCESS']", 'User / FederatedIdentity / role rows'],
  ['consultation/jobs/processors/pre-summary.processor.ts', "['CLINICAL']", 'ContextItem / summaries'],
  ['dna-writing-style/dna-writing-style.processor.ts', "['CLINICAL']", 'DnaWritingStyleReport'],
  ['gate-edit-mining/gate-edit-mining.processor.ts', "['CLINICAL']", 'ContextItem'],
  ['consultation/fact-ledger/fact-ledger.processor.ts', "['CLINICAL']", 'ContextItem (FACT_LEDGER / ENCOUNTER_RECAP)'],
];

describe('postponed BullMQ processors declare the categories they conflict with', () => {
  it.each(MAPPING)('%s → %s (%s)', (file, declared) => {
    const source = readFileSync(join(SERVICES, file), 'utf8');
    const calls = source.match(/postponeIfTenantLocked\(this\.tenantLock,[^;]*\);/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0].endsWith(`${declared});`)).toBe(true);
  });
});
