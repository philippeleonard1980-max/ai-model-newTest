import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryPath, personaPath, resourcesDir } from './paths.js';
import { applyForget, applyRemember, applyUpdate } from '../../core/memory-doc.js';
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
 * Structured edits used by the model's memory tools. The editing rules live
 * in core/memory-doc so the Android shell applies exactly the same ones; this
 * layer only reads and writes the file.
 * ------------------------------------------------------------------ */

function edit(
  apply: (markdown: string) => { markdown: string; summary: MemoryOpSummary; changed: boolean },
): MemoryOpSummary {
  const result = apply(readMemory().markdown);
  if (result.changed) writeMemory(result.markdown);
  return result.summary;
}

export function rememberInMemory(section: string, text: string): MemoryOpSummary {
  return edit((markdown) => applyRemember(markdown, section, text));
}

export function forgetFromMemory(match: string): MemoryOpSummary {
  return edit((markdown) => applyForget(markdown, match));
}

export function updateInMemory(match: string, replacement: string): MemoryOpSummary {
  return edit((markdown) => applyUpdate(markdown, match, replacement));
}
