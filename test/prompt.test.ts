import { describe, expect, it } from 'vitest';
import { buildSystemInstruction, extractMood, toSpeakableText } from '../src/main/ai/prompt';

describe('extractMood', () => {
  it('pulls the mood tag off the end and removes it from the text', () => {
    const { text, emotion } = extractMood('Found it — a typo in the config.\n\n[mood: proud]');
    expect(emotion).toBe('proud');
    expect(text).toBe('Found it — a typo in the config.');
  });

  it('accepts loose spacing and casing', () => {
    expect(extractMood('hi [Mood:  Playful ]').emotion).toBe('playful');
  });

  it('falls back to neutral when the tag is missing', () => {
    const { text, emotion } = extractMood('No tag here.');
    expect(emotion).toBe('neutral');
    expect(text).toBe('No tag here.');
  });

  it('falls back to neutral when the tag is not a known emotion', () => {
    expect(extractMood('hm [mood: incandescent]').emotion).toBe('neutral');
  });

  it('uses the last tag and strips every one of them', () => {
    const { text, emotion } = extractMood('[mood: sad] middle [mood: happy]');
    expect(emotion).toBe('happy');
    expect(text).toBe('middle');
  });
});

describe('toSpeakableText', () => {
  it('replaces fenced code with a spoken placeholder', () => {
    const spoken = toSpeakableText('Run this:\n\n```sh\nnpm run build\n```\n\nThen retry.');
    expect(spoken).not.toContain('npm run build');
    expect(spoken).toContain('code on screen');
  });

  it('drops inline markup but keeps the words', () => {
    expect(toSpeakableText('**bold** and _soft_ and `code`')).toBe('bold and soft and code');
  });

  it('keeps link text and drops the target', () => {
    expect(toSpeakableText('see [the docs](https://example.com)')).toBe('see the docs');
  });

  it('flattens headings and bullets', () => {
    expect(toSpeakableText('## Title\n\n- one\n- two')).toBe('Title\n\none\ntwo');
  });
});

describe('buildSystemInstruction', () => {
  it('embeds the persona and the memory between markers', () => {
    const instruction = buildSystemInstruction('You are Rin.', '- The user is called Sam.');
    expect(instruction).toContain('You are Rin.');
    expect(instruction).toContain('<<<MEMORY');
    expect(instruction).toContain('- The user is called Sam.');
    expect(instruction).toContain('MEMORY>>>');
  });

  it('lists the mood vocabulary so the tag is answerable', () => {
    const instruction = buildSystemInstruction('p', 'm');
    expect(instruction).toContain('[mood: happy]');
    expect(instruction).toContain('thinking');
    expect(instruction).toContain('farewell');
  });
});
