// Markdown rendering: marked + DOMPurify. Code fences render with a harness
// style banner (language label + copy button); everything else keeps plain
// GFM. The sanitizer runs after rendering, so only our own markup survives.

import { marked } from 'marked'
import DOMPurify from 'dompurify'

let configured = false

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function configure(): void {
  if (configured) return
  configured = true
  marked.setOptions({ gfm: true, breaks: false })
}

export function renderMarkdown(text: string): string {
  configure()
  const html = marked.parse(text, { async: false }) as string
  // Post-process: give each fenced code block its banner + copy affordance.
  const withBanners = html.replace(
    /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_m, lang: string | undefined, code: string) => {
      const label = lang && lang !== 'undefined' ? lang : 'text'
      return (
        `<div class="md-codeBlock" data-md-code>` +
        `<div class="md-codeBanner"><span>${escapeHtml(label)}</span>` +
        `<button type="button" class="md-copy" data-md-copy>copy</button></div>` +
        `<pre><code class="${lang ? `language-${escapeHtml(lang)}` : ''}">${code}</code></pre>` +
        `</div>`
      )
    },
  )
  return DOMPurify.sanitize(withBanners, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input'],
  })
}
