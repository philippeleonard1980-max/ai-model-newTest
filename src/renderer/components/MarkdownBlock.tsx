import type { JSX } from 'react';
import { useMemo } from 'react';
import { marked } from 'marked';

/**
 * Renders Markdown for display. The content comes from Gemini or from the
 * user's own memory file, so it is not trusted blindly: raw HTML is disabled
 * in the parser and the result is scrubbed of scriptable attributes before it
 * reaches `dangerouslySetInnerHTML`.
 */
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE',
  'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'SPAN',
]);

function sanitize(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;

  const walk = (node: Element): void => {
    for (const child of [...node.children]) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        const isSafeHref =
          name === 'href' && (value.startsWith('https://') || value.startsWith('http://'));
        if (!isSafeHref) child.removeAttribute(attribute.name);
      }
      if (child.tagName === 'A') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noreferrer noopener');
      }
      walk(child);
    }
  };
  walk(template.content as unknown as Element);
  return template.innerHTML;
}

export function MarkdownBlock({ markdown }: { markdown: string }): JSX.Element {
  const html = useMemo(() => {
    const parsed = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
    return sanitize(parsed);
  }, [markdown]);

  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
