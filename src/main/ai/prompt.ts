/**
 * Re-export of the shared prompt builder. The logic lives in core/prompt so the
 * desktop and Android shells send Rin the same instructions.
 */
export { buildSystemInstruction, extractMood, toSpeakableText } from '../../core/prompt.js';
