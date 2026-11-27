/**
 * Inline Markdown for `Text` components.
 *
 * A2UI's `Text` documents "simple Markdown formatting … without HTML, images,
 * or links", so this renders emphasis, inline code and line breaks into React
 * elements. It builds nodes directly (never `dangerouslySetInnerHTML`), so model
 * output cannot inject markup or script.
 */
import { Fragment, h } from './h.js'

const TOKEN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/gu

function renderInline(text: string, keyPrefix: string): Array<ReturnType<typeof h> | string> {
  const out: Array<ReturnType<typeof h> | string> = []
  let index = 0
  let part = 0
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0
    if (start > index) out.push(text.slice(index, start))
    const token = match[0]
    if (token.startsWith('**')) out.push(h('strong', { key: `${keyPrefix}-b${part}` }, token.slice(2, -2)))
    else if (token.startsWith('`')) out.push(h('code', { key: `${keyPrefix}-c${part}` }, token.slice(1, -1)))
    else out.push(h('em', { key: `${keyPrefix}-i${part}` }, token.slice(1, -1)))
    index = start + token.length
    part += 1
  }
  if (index < text.length) out.push(text.slice(index))
  return out
}

/**
 * Render a text block.
 * @param text already-resolved text.
 * @param variant `body` or `caption`.
 * @param idPrefix stable prefix for React keys.
 */
export function renderText(text: string, variant: 'body' | 'caption', idPrefix: string, ariaLabel?: string): ReturnType<typeof h> {
  const lines = text.split('\n')
  const children: Array<ReturnType<typeof h> | string> = []
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) children.push(h('br', { key: `${idPrefix}-br${lineIndex}` }))
    children.push(h(Fragment, { key: `${idPrefix}-l${lineIndex}` }, ...renderInline(line, `${idPrefix}-${lineIndex}`)))
  })
  return h(
    'p',
    {
      className: variant === 'caption' ? 'a2ui-text a2ui-text-caption' : 'a2ui-text',
      ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
    },
    ...children,
  )
}
