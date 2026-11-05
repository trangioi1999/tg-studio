import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders bold, lists and inline code', () => {
    const html = renderMarkdown('Dùng **Angular 21**:\n\n- một\n- `hai`');
    expect(html).toContain('<strong>Angular 21</strong>');
    expect(html).toContain('<li>một</li>');
    expect(html).toContain('<code>hai</code>');
  });

  it('keeps fenced code as a code block', () => {
    expect(renderMarkdown('```ts\nconst a = 1;\n```')).toContain('<pre><code class="language-ts">const a = 1;');
  });
});
