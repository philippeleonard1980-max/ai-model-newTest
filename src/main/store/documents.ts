import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryPath, personaPath, resourcesDir } from './paths.js';
import type { MemoryFile, MemoryOpSummary, PersonaFile } from '@shared/types';

function seedFrom(target: string, resourceName: string): void {
  if (existsSync(target)) return;
  const source = join(resourcesDir(), resourceName);
  if (existsSync(source)) copyFileSync(source, target);
  else writeFileSync(target, '', 'utf8');
}

export function readPersona(): PersonaFile {
  const path = personaPath();
  seedFrom(path, 'default-persona.md');
  const text = readFileSync(path, 'utf8');
  const defaultPath = join(resourcesDir(), 'default-persona.md');
  const isDefault = existsSync(defaultPath) && readFileSync(defaultPath, 'utf8') === text;
  return { text, path, isDefault };
}

export function writePersona(text: string): PersonaFile {
  writeFileSync(personaPath(), text, 'utf8');
  return readPersona();
}

export function resetPersona(): PersonaFile {
  const source = join(resourcesDir(), 'default-persona.md');
  return writePersona(existsSync(source) ? readFileSync(source, 'utf8') : '');
}

export function readMemory(): MemoryFile {
  const path = memoryPath();
  seedFrom(path, 'default-memory.md');
  return { markdown: readFileSync(path, 'utf8'), path };
}

export function writeMemory(markdown: string): MemoryFile {
  writeFileSync(memoryPath(), markdown, 'utf8');
  return readMemory();
}

/* ------------------------------------------------------------------ *
 * Structured edits, used by the model's memory tools.
 *
 * The file is plain Markdown with `## Section` headings. These helpers
 * operate on it as a list of bullet lines under a named heading, which keeps
 * the file readable and hand-editable rather than turning it into a database.
 * ------------------------------------------------------------------ */

interface Section {
  heading: string;
  /** Line index of the `## Heading` line. */
  start: number;
  /** Line index one past the last line belonging to this section. */
  end: number;
}

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^##\s+(.*\S)\s*$/.exec(lines[i] ?? '');
    if (!match) continue;
    if (sections.length > 0) sections[sections.length - 1]!.end = i;
    sections.push({ heading: match[1]!, start: i, end: lines.length });
  }
  return sections;
}

function findSection(sections: Section[], heading: string): Section | undefined {
  const want = heading.trim().toLowerCase();
  return sections.find((s) => s.heading.trim().toLowerCase() === want);
}

/** Placeholder italic lines seeded into the default file; removed on first write. */
function isPlaceholder(line: string): boolean {
  return /^_.*_$/.test(line.trim());
}

function normaliseBullet(text: string): string {
  const clean = text.trim().replace(/^[-*]\s+/, '');
  return `- ${clean}`;
}

export function rememberInMemory(section: string, text: string): MemoryOpSummary {
  const { markdown } = readMemory();
  const lines = markdown.split('\n');
  const sections = parseSections(lines);
  const target = findSection(sections, section);
  const bullet = normaliseBullet(text);

  if (!target) {
    // Unknown section: append a new one rather than dropping the fact.
    const trimmed = [...lines];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.trim() === '') trimmed.pop();
    trimmed.push('', `## ${section.trim()}`, '', bullet, '');
    writeMemory(trimmed.join('\n'));
    return { op: 'remember', section: section.trim(), detail: text.trim() };
  }

  // Append after the section's last non-empty line. Placeholders go, and blank
  // lines are trimmed from the ends only — squashing the interior too would weld
  // the user's own paragraphs together the first time Rin writes here.
  const body = lines.slice(target.start + 1, target.end).filter((l) => !isPlaceholder(l));
  while (body.length > 0 && body[0]!.trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
  const rebuilt = [
    ...lines.slice(0, target.start + 1),
    '',
    ...body,
    bullet,
    '',
    ...lines.slice(target.end),
  ];
  writeMemory(rebuilt.join('\n'));
  return { op: 'remember', section: target.heading, detail: text.trim() };
}

export function forgetFromMemory(match: string): MemoryOpSummary {
  const { markdown } = readMemory();
  const needle = match.trim().toLowerCase();
  const lines = markdown.split('\n');
  const kept = lines.filter(
    (line) => !(line.trim().startsWith('-') && line.toLowerCase().includes(needle)),
  );
  const removed = lines.length - kept.length;
  if (removed > 0) writeMemory(kept.join('\n'));
  return {
    op: 'forget',
    section: '',
    detail: removed > 0 ? `removed ${removed} line(s) matching "${match.trim()}"` : `no line matched "${match.trim()}"`,
  };
}

export function updateInMemory(match: string, replacement: string): MemoryOpSummary {
  const { markdown } = readMemory();
  const needle = match.trim().toLowerCase();
  const lines = markdown.split('\n');
  let changed = 0;
  const next = lines.map((line) => {
    if (line.trim().startsWith('-') && line.toLowerCase().includes(needle)) {
      changed++;
      const indent = line.slice(0, line.indexOf('-'));
      return indent + normaliseBullet(replacement);
    }
    return line;
  });
  if (changed > 0) writeMemory(next.join('\n'));
  return {
    op: 'update',
    section: '',
    detail:
      changed > 0
        ? `rewrote ${changed} line(s) to "${replacement.trim()}"`
        : `no line matched "${match.trim()}"`,
  };
}
