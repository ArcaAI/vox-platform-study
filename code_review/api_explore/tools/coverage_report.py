#!/usr/bin/env python3
"""Summarise Vitest V8 coverage-final.json into module/file tables."""
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path('/Users/apple/repos/VOX/review/api_explore')
COV = json.loads((ROOT / 'coverage/coverage-final.json').read_text())


def pct(covered, total):
    return 100.0 if total == 0 else round(covered * 100.0 / total, 2)


def file_stats(entry):
    s = entry.get('s', {})
    f = entry.get('f', {})
    b = entry.get('b', {})
    stmts = (sum(1 for v in s.values() if v > 0), len(s))
    funcs = (sum(1 for v in f.values() if v > 0), len(f))
    # V8 branch map: each key -> array of hit counts
    bt = sum(len(v) for v in b.values())
    bc = sum(1 for v in b.values() for n in v if n > 0)
    lines = entry.get('statementMap', {})
    # approximate line coverage from statements
    return {
        'statements': stmts, 'functions': funcs, 'branches': (bc, bt),
        'lines': stmts,
    }


rows = []
for path, entry in COV.items():
    rel = path.split('/apps/api/')[-1] if '/apps/api/' in path else path
    st = file_stats(entry)
    rows.append({
        'path': rel,
        'stmts': pct(*st['statements']),
        'branches': pct(*st['branches']),
        'functions': pct(*st['functions']),
        'lines': pct(*st['lines']),
        'stmt_covered': st['statements'][0],
        'stmt_total': st['statements'][1],
    })

mod = defaultdict(lambda: {'n': 0, 's': 0, 'st': 0, 'b': 0, 'bt': 0, 'f': 0, 'ft': 0})
for r in rows:
    if '/modules/' in r['path']:
        key = r['path'].split('/modules/')[1].split('/')[0]
    elif r['path'].startswith('src/'):
        parts = r['path'].split('/')
        key = parts[1] if len(parts) > 2 else 'src/(root)'
    else:
        key = '(outside src)'
    m = mod[key]
    m['n'] += 1
    m['s'] += r['stmt_covered']
    m['st'] += r['stmt_total']
    m['b'] += int(r['branches'] / 100 * 0)  # placeholder; branch totals recomputed below

# Recompute module percentages directly from coverage entries.
mod = defaultdict(lambda: {'files': 0, 's': 0, 'st': 0, 'bc': 0, 'bt': 0, 'fc': 0, 'ft': 0})
for path, entry in COV.items():
    rel = path.split('/apps/api/')[-1] if '/apps/api/' in path else path
    if '/modules/' in rel:
        key = rel.split('/modules/')[1].split('/')[0]
    elif rel.startswith('src/'):
        parts = rel.split('/')
        key = parts[1] if len(parts) > 2 else 'src/(root)'
    else:
        key = '(outside src)'
    st = file_stats(entry)
    m = mod[key]
    m['files'] += 1
    m['s'] += st['statements'][0]; m['st'] += st['statements'][1]
    m['bc'] += st['branches'][0]; m['bt'] += st['branches'][1]
    m['fc'] += st['functions'][0]; m['ft'] += st['functions'][1]

tot_s = sum(m['s'] for m in mod.values()); tot_st = sum(m['st'] for m in mod.values())
tot_bc = sum(m['bc'] for m in mod.values()); tot_bt = sum(m['bt'] for m in mod.values())
tot_fc = sum(m['fc'] for m in mod.values()); tot_ft = sum(m['ft'] for m in mod.values())

lines = ['# Coverage by area (Vitest/V8)', '',
         'Command: `pnpm --filter @arcaai/api exec vitest run --coverage --coverage.reportsDirectory=../review/api_explore/coverage` (run from repo root; date 2026-10-23).', '',
         f'**Overall:** statements {pct(tot_s, tot_st)}% ({tot_s}/{tot_st}) · branches {pct(tot_bc, tot_bt)}% ({tot_bc}/{tot_bt}) · functions {pct(tot_fc, tot_ft)}% ({tot_fc}/{tot_ft}) · files {len(rows)}', '',
         '| Area | Files | Statements | Branches | Functions |', '|---|---:|---:|---:|---:|']
for key in sorted(mod):
    m = mod[key]
    lines.append(f"| `{key}` | {m['files']} | {pct(m['s'], m['st'])}% | {pct(m['bc'], m['bt'])}% | {pct(m['fc'], m['ft'])}% |")

lines += ['', '## Lowest-coverage files (≤60% statements, ≥20 statements)', '',
          '| File | Statements | Branches | Functions | Uncovered |', '|---|---:|---:|---:|---:|']
low = sorted([r for r in rows if r['stmts'] <= 60 and r['stmt_total'] >= 20], key=lambda r: r['stmts'])
for r in low[:80]:
    lines.append(f"| `{r['path']}` | {r['stmts']}% | {r['branches']}% | {r['functions']}% | {r['stmt_total'] - r['stmt_covered']}/{r['stmt_total']} |")

lines += ['', '## Highest-coverage large files (≥90%, ≥50 statements)', '']
for r in sorted([r for r in rows if r['stmts'] >= 90 and r['stmt_total'] >= 50], key=lambda r: -r['stmt_total'])[:30]:
    lines.append(f"- `{r['path']}` — {r['stmts']}% ({r['stmt_total']} statements)")

(ROOT / 'docs').mkdir(exist_ok=True)
(ROOT / 'docs/06a-COVERAGE-BY-AREA.md').write_text('\n'.join(lines))
json.dump({'rows': rows, 'modules': {k: {'files': v['files'], 'statements': pct(v['s'], v['st']), 'branches': pct(v['bc'], v['bt']), 'functions': pct(v['fc'], v['ft'])} for k, v in mod.items()}}, open(ROOT / 'inventory/coverage-summary.json', 'w'), indent=1)
print('files', len(rows), 'modules', len(mod))
print('lowest', len(low))
print('\n'.join(lines[:18]))
