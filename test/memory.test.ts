import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetFromMemory,
  readMemory,
  rememberInMemory,
  updateInMemory,
  writeMemory,
} from '../src/main/store/documents';

const BASE = `# Rin's memory

## About the user

_Nothing yet._

## Preferences

_How you like things done._

## Projects

- Shipping the fox app.
`;

beforeEach(() => {
  writeMemory(BASE);
});

describe('rememberInMemory', () => {
  it('adds a bullet under an existing section', () => {
    rememberInMemory('About the user', 'The user is called Sam.');
    const { markdown } = readMemory();
    expect(markdown).toContain('- The user is called Sam.');
    expect(markdown.indexOf('- The user is called Sam.')).toBeGreaterThan(
      markdown.indexOf('## About the user'),
    );
    expect(markdown.indexOf('- The user is called Sam.')).toBeLessThan(
      markdown.indexOf('## Preferences'),
    );
  });

  it('clears the italic placeholder it replaces', () => {
    rememberInMemory('About the user', 'The user is called Sam.');
    expect(readMemory().markdown).not.toContain('_Nothing yet._');
  });

  it('leaves other sections untouched', () => {
    rememberInMemory('About the user', 'Likes strong coffee.');
    const { markdown } = readMemory();
    expect(markdown).toContain('_How you like things done._');
    expect(markdown).toContain('- Shipping the fox app.');
  });

  it('matches section names case-insensitively', () => {
    rememberInMemory('projects', 'Also writing docs.');
    const { markdown } = readMemory();
    expect(markdown).toContain('- Also writing docs.');
    expect(markdown.match(/## Projects/g)).toHaveLength(1);
  });

  it('creates a new section rather than losing an unknown one', () => {
    rememberInMemory('Pets', 'Has a cat called Mochi.');
    const { markdown } = readMemory();
    expect(markdown).toContain('## Pets');
    expect(markdown).toContain('- Has a cat called Mochi.');
  });

  it('normalises text that already looks like a bullet', () => {
    rememberInMemory('Projects', '- Already bulleted.');
    expect(readMemory().markdown).toContain('- Already bulleted.');
    expect(readMemory().markdown).not.toContain('- - Already bulleted.');
  });

  it('appends rather than overwriting an existing entry', () => {
    rememberInMemory('Projects', 'Second project.');
    const { markdown } = readMemory();
    expect(markdown).toContain('- Shipping the fox app.');
    expect(markdown).toContain('- Second project.');
  });
});

describe('updateInMemory', () => {
  it('rewrites the matching bullet', () => {
    updateInMemory('Shipping the fox', 'Shipped the fox app.');
    const { markdown } = readMemory();
    expect(markdown).toContain('- Shipped the fox app.');
    expect(markdown).not.toContain('- Shipping the fox app.');
  });

  it('reports when nothing matched and changes nothing', () => {
    const before = readMemory().markdown;
    const summary = updateInMemory('nonexistent', 'whatever');
    expect(summary.detail).toMatch(/no line matched/);
    expect(readMemory().markdown).toBe(before);
  });

  it('does not touch headings that contain the same words', () => {
    updateInMemory('Projects', 'Renamed.');
    expect(readMemory().markdown).toContain('## Projects');
  });
});

describe('forgetFromMemory', () => {
  it('removes the matching bullet', () => {
    forgetFromMemory('fox app');
    expect(readMemory().markdown).not.toContain('- Shipping the fox app.');
  });

  it('keeps the section heading behind', () => {
    forgetFromMemory('fox app');
    expect(readMemory().markdown).toContain('## Projects');
  });

  it('reports when nothing matched', () => {
    expect(forgetFromMemory('nothing here').detail).toMatch(/no line matched/);
  });

  it('is case-insensitive', () => {
    forgetFromMemory('SHIPPING THE FOX');
    expect(readMemory().markdown).not.toContain('- Shipping the fox app.');
  });
});

describe('round trip', () => {
  it('survives remember then forget back to the original shape', () => {
    rememberInMemory('Projects', 'Temporary note.');
    expect(readMemory().markdown).toContain('- Temporary note.');
    forgetFromMemory('Temporary note.');
    const { markdown } = readMemory();
    expect(markdown).not.toContain('Temporary note.');
    expect(markdown).toContain('- Shipping the fox app.');
  });

  it('keeps the file parseable as Markdown headings', () => {
    rememberInMemory('About the user', 'Sam.');
    rememberInMemory('Pets', 'Mochi.');
    const headings = readMemory().markdown.match(/^## .+$/gm) ?? [];
    expect(headings).toContain('## About the user');
    expect(headings).toContain('## Pets');
    expect(new Set(headings).size).toBe(headings.length);
  });
});
