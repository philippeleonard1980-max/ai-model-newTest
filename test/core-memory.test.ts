import { describe, expect, it } from 'vitest';
import { applyForget, applyMemoryTool, applyRemember, applyUpdate } from '../src/core/memory-doc';

const BASE = ["# Rin's memory", '', '## Notes', '', '- Existing fact.', ''].join('\n');

describe('core memory editing is pure', () => {
  it('never mutates the input string', () => {
    const before = BASE;
    applyRemember(BASE, 'Notes', 'New fact.');
    applyForget(BASE, 'Existing');
    applyUpdate(BASE, 'Existing', 'Changed.');
    expect(BASE).toBe(before);
  });

  it('reports changed=false when nothing matched, so callers can skip the write', () => {
    expect(applyForget(BASE, 'nope').changed).toBe(false);
    expect(applyUpdate(BASE, 'nope', 'x').changed).toBe(false);
    expect(applyForget(BASE, 'nope').markdown).toBe(BASE);
  });

  it('reports changed=true on a real edit', () => {
    expect(applyRemember(BASE, 'Notes', 'New.').changed).toBe(true);
    expect(applyForget(BASE, 'Existing').changed).toBe(true);
  });
});

describe('line endings', () => {
  // This is a Windows app and the memory file is advertised as hand-editable,
  // so it will be opened in editors that save CRLF. Rewriting the whole file to
  // LF on Rin's first write would show up as a diff across every line.
  const crlf = BASE.replace(/\n/g, '\r\n');

  it('keeps CRLF files on CRLF', () => {
    const out = applyRemember(crlf, 'Notes', 'New fact.').markdown;
    expect(out).toContain('\r\n');
    expect(out.split('\r\n').length).toBeGreaterThan(3);
    // No stray lone-LF lines mixed in.
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps LF files on LF', () => {
    const out = applyRemember(BASE, 'Notes', 'New fact.').markdown;
    expect(out).not.toContain('\r');
  });

  it('finds and edits bullets in a CRLF file', () => {
    expect(applyForget(crlf, 'Existing').changed).toBe(true);
    expect(applyUpdate(crlf, 'Existing', 'Changed.').markdown).toContain('- Changed.');
  });
});

describe('applyMemoryTool dispatch', () => {
  it('routes each tool name to its editor', () => {
    expect(applyMemoryTool(BASE, 'remember', { section: 'Notes', text: 'A.' }).markdown).toContain(
      '- A.',
    );
    expect(applyMemoryTool(BASE, 'forget', { match: 'Existing' }).changed).toBe(true);
    expect(
      applyMemoryTool(BASE, 'update_memory', { match: 'Existing', replacement: 'B.' }).markdown,
    ).toContain('- B.');
  });

  it('defaults a missing section to Notes rather than dropping the fact', () => {
    const out = applyMemoryTool(BASE, 'remember', { text: 'Orphan.' });
    expect(out.markdown).toContain('- Orphan.');
  });

  it('survives a tool name it does not know without throwing or editing', () => {
    const out = applyMemoryTool(BASE, 'destroy_everything', {});
    expect(out.changed).toBe(false);
    expect(out.markdown).toBe(BASE);
    expect(out.summary.detail).toMatch(/unknown tool/);
  });

  it('ignores non-string arguments instead of stringifying them', () => {
    const out = applyMemoryTool(BASE, 'remember', { section: 42, text: null });
    expect(out.markdown).not.toContain('42');
    expect(out.markdown).not.toContain('null');
  });
});

describe('edge cases', () => {
  it('handles an empty file', () => {
    const out = applyRemember('', 'Notes', 'First.');
    expect(out.markdown).toContain('## Notes');
    expect(out.markdown).toContain('- First.');
  });

  it('handles a file with no headings at all', () => {
    const out = applyRemember('just some prose', 'Notes', 'Fact.');
    expect(out.markdown).toContain('just some prose');
    expect(out.markdown).toContain('## Notes');
  });

  it('appends to the last section without losing the trailing content', () => {
    const doc = ['## First', '', '- a', '', '## Last', '', '- b', ''].join('\n');
    const out = applyRemember(doc, 'Last', 'c').markdown;
    expect(out).toContain('- b');
    expect(out).toContain('- c');
    expect(out.indexOf('- b')).toBeLessThan(out.indexOf('- c'));
  });

  it('keeps unicode and emoji intact', () => {
    const out = applyRemember(BASE, 'Notes', 'Their name is 響狐リク 🦊').markdown;
    expect(out).toContain('響狐リク 🦊');
  });

  it('treats the match in forget/update as literal text, not a regex', () => {
    const doc = ['## Notes', '', '- a.b.c', '- axbxc', ''].join('\n');
    const out = applyForget(doc, 'a.b.c');
    expect(out.markdown).toContain('- axbxc');
    expect(out.markdown).not.toContain('- a.b.c');
  });
});
