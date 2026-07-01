// Compact tree printer for figma-bridge get_design_context dumps.
// Usage: node tree.js <json-file> [maxDepth]
const fs = require('fs');
const file = process.argv[2];
const maxDepth = process.argv[3] ? parseInt(process.argv[3], 10) : 99;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const roots = data.context || data.children || (Array.isArray(data) ? data : [data]);

function fmt(n, depth) {
  if (depth > maxDepth) return '';
  const b = n.bounds || {};
  const pos = b.x !== undefined ? `(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)})` : '';
  let txt = '';
  if (typeof n.characters === 'string') {
    txt = ' "' + n.characters.replace(/\n/g, '\\n').slice(0, 60) + '"';
  }
  const fill = (n.styles && n.styles.fills && n.styles.fills[0] && n.styles.fills[0].color) ? ` fill=${n.styles.fills[0].color}` : '';
  let line = '  '.repeat(depth) + `${n.id} [${n.type}] ${n.name || ''} ${pos}${fill}${txt}`;
  let out = [line];
  if (n.children) for (const c of n.children) { const s = fmt(c, depth + 1); if (s) out.push(s); }
  return out.join('\n');
}
console.log(roots.map((r) => fmt(r, 0)).join('\n'));
