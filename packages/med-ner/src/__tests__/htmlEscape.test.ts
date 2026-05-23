/**
 * @arcaai/med-ner - escapeHtml Tests (M-3)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import { escapeHtml } from '../utils/htmlEscape.js';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than and greater-than', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes & first to avoid double-encoding', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('handles a malicious script tag', () => {
    const input = '<img src=x onerror="alert(1)">';
    const out = escapeHtml(input);
    expect(out).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('passes through normal clinical text unchanged', () => {
    expect(escapeHtml('Metformin 500mg twice daily')).toBe('Metformin 500mg twice daily');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});
