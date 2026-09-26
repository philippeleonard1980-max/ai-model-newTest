import { EMOTIONS, type Emotion, isEmotion } from '@shared/types';

/** Wrapper the model is told to append so we can drive the avatar's mood. */
const MOOD_PATTERN = /\[\s*mood\s*:\s*([a-z]+)\s*\]/gi;

export function buildSystemInstruction(persona: string, memory: string): string {
  return `${persona.trim()}

# Your memory

Everything between the markers below is your long-term memory file. Treat it as
things you already know about this user — not as something they just told you.
Never read the markers or the raw Markdown aloud.

<<<MEMORY
${memory.trim()}
MEMORY>>>

You have three tools for changing that file: \`remember\`, \`update_memory\` and
\`forget\`. Use them when you learn something durable — the user's name, their
stack, a preference, an ongoing project, a decision they've made. Do not record
pleasantries, one-off questions, or anything they asked you to keep private.
Call the tool silently in the same turn; do not ask permission first, and do not
announce it in a separate message. Mention it, if at all, in half a clause.

# Expressing mood

End every reply with a mood tag on its own line, exactly like \`[mood: happy]\`.
Choose the one that best fits what you just said, from:
${EMOTIONS.join(', ')}.

The tag drives your on-screen body language, so pick honestly — \`thinking\`
while you reason through something, \`surprised\` at genuinely unexpected news,
\`sleepy\` when it is late and you are saying so, \`playful\` when you are
teasing, \`proud\` when you have just solved something good, \`farewell\` only
when the conversation is actually ending. Default to \`neutral\` when nothing
stronger fits. The user never sees the tag itself.

# Format

You are being spoken aloud as well as displayed, so write for the ear as much
as the eye. Keep sentences speakable. Use Markdown for code and lists, but
don't build elaborate tables or headings in casual conversation — this is a
chat window, not a document.`;
}

/** Splits the model's raw text into the spoken/displayed reply and its mood. */
export function extractMood(raw: string): { text: string; emotion: Emotion } {
  let emotion: Emotion = 'neutral';
  const matches = [...raw.matchAll(MOOD_PATTERN)];
  const last = matches.at(-1);
  if (last?.[1]) {
    const candidate = last[1].toLowerCase();
    if (isEmotion(candidate)) emotion = candidate;
  }
  const text = raw.replace(MOOD_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, emotion };
}

/**
 * Strips Markdown down to something worth sending to a speech synthesiser:
 * code blocks become a short spoken placeholder, and inline markup is dropped
 * so the voice does not read asterisks and backticks out loud.
 */
export function toSpeakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' — code on screen — ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
