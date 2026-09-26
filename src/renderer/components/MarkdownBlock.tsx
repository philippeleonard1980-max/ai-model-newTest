import type { JSX } from 'react';
import { useMemo } from 'react';
import { marked } from 'marked';

/**
 * Renders Markdown for display. The content comes from Gemini or from the
 * user's own memory file, so it is not trusted.
 *
 * marked has had no `sanitize` option since v5, so raw HTML in the source
 * reaches the DOM and this scrubber is the only thing standing between it and
 * `dangerouslySetInnerHTML`. It works by allow-list: an element is kept only if
 * it is named in ALLOWED_TAGS, every attribute is dropped unless it is an
 * http(s) `href`, and nothing may carry an event handler.
 */

/** Elements kept as-is, once their attributes have been stripped. */
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE',
  'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'SPAN',
]);

/**
 * Elements removed with their contents, rather than unwrapped. Unwrapping these
 * would either surface their source as visible text (`script`, `style`) or keep
 * something interactive alive (`form` and its fields).
 */
const DROPPED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE',
  'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION',
  'LINK', 'META', 'BASE', 'AUDIO', 'VIDEO', 'SOURCE', 'IMG', 'CANVAS',
]);

function stripAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim().toLowerCase();
    const isSafeHref =
      name === 'href' && (value.startsWith('https://') || value.startsWith('http://'));
    if (!isSafeHref) element.removeAttribute(attribute.name);
  }
  if (element.tagName === 'A') {
    element.setAttribute('target', '_blank');
    element.setAttribute('rel', 'noreferrer noopener');
  }
}

export function sanitizeHtml(html: string, doc: Document = document): string {
  const template = doc.createElement('template');
  template.innerHTML = html;

  const walk = (node: ParentNode): void => {
    for (const child of [...node.children]) {
      // Depth first: clean the subtree *before* deciding what to do with the
      // element itself, so anything hoisted by an unwrap is already sanitised.
      // Cleaning afterwards would let one disallowed wrapper smuggle its
      // children past the filter entirely.
      walk(child);

      if (DROPPED_TAGS.has(child.tagName)) {
        child.remove();
        continue;
      }
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      stripAttributes(child);
    }
  };

  walk(template.content);
  return template.innerHTML;
}

export function renderMarkdown(markdown: string, doc?: Document): string {
  const parsed = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  return sanitizeHtml(parsed, doc);
}

export function MarkdownBlock({ markdown }: { markdown: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
