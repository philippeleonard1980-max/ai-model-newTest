import type { MemoryOpSummary } from '@shared/types';

/**
 * Pure editing of Rin's memory file.
 *
 * Every function here takes the Markdown and returns new Markdown — no file
 * access — so the Electron shell and the Android shell run exactly the same
 * logic over whatever storage each platform provides.
 *
 * The file is plain Markdown with `## Section` headings, and each fact is a
 * bullet. Keeping that shape is deliberate: the user is invited to edit it by
 * hand, so it must never turn into a database.
 */

export interface MemoryEdit {
  markdown: string;
  summary: MemoryOpSummary;
  /** False when nothing matched, so callers can skip a pointless write. */
  changed: boolean;
}

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

/**
 * Splits on newlines while remembering whether the file used CRLF, so a file
 * the user last saved in a Windows editor does not silently get rewritten with
 * Unix endings the first time Rin touches it.
 */
function splitLines(markdown: string): { lines: string[]; eol: string } {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  return { lines: markdown.split(/\r?\n/), eol };
}

export function applyRemember(markdown: string, section: string, text: string): MemoryEdit {
  const { lines, eol } = splitLines(markdown);
  const target = findSection(parseSections(lines), section);
  const bullet = normaliseBullet(text);

  if (!target) {
    // Unknown section: append a new one rather than dropping the fact.
    const trimmed = [...lines];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.trim() === '') trimmed.pop();
    trimmed.push('', `## ${section.trim()}`, '', bullet, '');
    return {
      markdown: trimmed.join(eol),
      changed: true,
      summary: { op: 'remember', section: section.trim(), detail: text.trim() },
    };
  }

  // Append after the section's last non-empty line. Placeholders go, and blank
  // lines are trimmed from the ends only — squashing the interior too would
  // weld the user's own paragraphs together.
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
  return {
    markdown: rebuilt.join(eol),
    changed: true,
    summary: { op: 'remember', section: target.heading, detail: text.trim() },
  };
}

export function applyForget(markdown: string, match: string): MemoryEdit {
  const { lines, eol } = splitLines(markdown);
  const needle = match.trim().toLowerCase();
  const kept = lines.filter(
    (line) => !(line.trim().startsWith('-') && line.toLowerCase().includes(needle)),
  );
  const removed = lines.length - kept.length;
  return {
    markdown: removed > 0 ? kept.join(eol) : markdown,
    changed: removed > 0,
    summary: {
      op: 'forget',
      section: '',
      detail:
        removed > 0
          ? `removed ${removed} line(s) matching "${match.trim()}"`
          : `no line matched "${match.trim()}"`,
    },
  };
}

export function applyUpdate(markdown: string, match: string, replacement: string): MemoryEdit {
  const { lines, eol } = splitLines(markdown);
  const needle = match.trim().toLowerCase();
  let changed = 0;
  const next = lines.map((line) => {
    if (line.trim().startsWith('-') && line.toLowerCase().includes(needle)) {
      changed++;
      const indent = line.slice(0, line.indexOf('-'));
      return indent + normaliseBullet(replacement);
    }
    return line;
  });
  return {
    markdown: changed > 0 ? next.join(eol) : markdown,
    changed: changed > 0,
    summary: {
      op: 'update',
      section: '',
      detail:
        changed > 0
          ? `rewrote ${changed} line(s) to "${replacement.trim()}"`
          : `no line matched "${match.trim()}"`,
    },
  };
}

/** Dispatches a model tool call onto the editing functions above. */
export function applyMemoryTool(
  markdown: string,
  name: string,
  args: Record<string, unknown>,
): MemoryEdit {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  switch (name) {
    case 'remember':
      return applyRemember(markdown, str('section') || 'Notes', str('text'));
    case 'update_memory':
      return applyUpdate(markdown, str('match'), str('replacement'));
    case 'forget':
      return applyForget(markdown, str('match'));
    default:
      return {
        markdown,
        changed: false,
        summary: { op: 'remember', section: '', detail: `unknown tool "${name}"` },
      };
  }
}
