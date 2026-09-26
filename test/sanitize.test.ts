// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, sanitizeHtml } from '../src/renderer/components/MarkdownBlock';

const FORBIDDEN_ELEMENTS =
  'script,iframe,svg,form,input,object,embed,style,link,meta,img,audio,video,canvas,button,select,textarea';

/**
 * Parses the sanitised output and asserts nothing live survived. Checking the
 * DOM rather than regex-matching the string matters: escaped text such as
 * `&lt;img onerror=…&gt;` inside a code block is inert, and a regex would flag
 * it as a leak.
 */
function assertInert(html: string): void {
  const host = document.createElement('div');
  host.innerHTML = html;
  expect(host.querySelector(FORBIDDEN_ELEMENTS), `forbidden element in: ${html}`).toBeNull();
  for (const element of host.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      expect(attribute.name.toLowerCase().startsWith('on'), `event handler in: ${html}`).toBe(false);
      if (attribute.name.toLowerCase() === 'href') {
        expect(attribute.value.trim().toLowerCase()).toMatch(/^https?:\/\//);
      }
    }
  }
}

describe('sanitizeHtml — nested content', () => {
  // Every one of these leaked before the walk was made depth-first: unwrapping
  // a disallowed element hoisted its children into a list that had already been
  // iterated, so they were never inspected.
  const nested: Array<[string, string]> = [
    ['img inside a div', '<div><img src=x onerror=alert(1)></div>'],
    ['img two levels deep', '<section><div><img src=x onerror=alert(1)></div></section>'],
    ['script inside a div', '<div><script>alert(1)</script></div>'],
    ['iframe inside a div', '<div><iframe src="javascript:alert(1)"></iframe></div>'],
    ['svg inside a div', '<div><svg onload=alert(1)></svg></div>'],
    ['javascript: link inside a div', '<div><a href="javascript:alert(1)">x</a></div>'],
    ['form inside a div', '<div><form action=//evil><input name=p></form></div>'],
    ['handler on a deeply nested allowed tag', '<div><div><p onclick=alert(1)>hi</p></div></div>'],
  ];

  for (const [label, html] of nested) {
    it(`strips ${label}`, () => {
      assertInert(sanitizeHtml(html));
    });
  }

  it('still strips the same things at the top level', () => {
    assertInert(sanitizeHtml('<img src=x onerror=alert(1)>'));
    assertInert(sanitizeHtml('<p><img src=x onerror=alert(1)></p>'));
  });

  it('drops script and style contents instead of exposing them as text', () => {
    expect(sanitizeHtml('<div><script>alert(1)</script></div>')).not.toContain('alert');
    expect(sanitizeHtml('<style>body{display:none}</style>')).not.toContain('display');
  });
});

describe('sanitizeHtml — keeps legitimate content', () => {
  it('preserves allowed formatting', () => {
    const out = sanitizeHtml('<p><strong>bold</strong> and <em>soft</em></p>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>soft</em>');
  });

  it('keeps the text of an unwrapped wrapper', () => {
    expect(sanitizeHtml('<div>kept</div>')).toContain('kept');
  });

  it('keeps http(s) links and hardens them', () => {
    const out = sanitizeHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer noopener"');
  });

  it('drops non-http link targets but keeps the label', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">label</a>');
    assertInert(out);
    expect(out).toContain('label');
  });

  it('strips every attribute that is not a safe href', () => {
    const out = sanitizeHtml('<p id="x" class="y" style="color:red" onmouseover="a()">t</p>');
    expect(out).toBe('<p>t</p>');
  });
});

describe('renderMarkdown', () => {
  it('renders ordinary Markdown', () => {
    const out = renderMarkdown('# Title\n\n- one\n- two');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<li>one</li>');
  });

  it('renders fenced code as escaped text, not live markup', () => {
    const out = renderMarkdown('```\n<img src=x onerror=alert(1)>\n```');
    expect(out).toContain('<pre>');
    // The angle brackets must stay escaped so the sample is shown, not run.
    expect(out).toContain('&lt;img');
    assertInert(out);
  });

  it('sanitises raw HTML embedded in Markdown, which marked passes through', () => {
    assertInert(renderMarkdown('text\n\n<div><img src=x onerror=alert(1)></div>'));
  });

  it('survives empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
});
