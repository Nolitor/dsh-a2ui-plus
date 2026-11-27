import * as React from 'react'
import { h } from './h.js'

/** Measure the data mark and tooltip in CSS pixels, including SVG scaling. */
export function ChartTooltip({ anchor, lines, viewport, viewportStartCorner }: {
  anchor: SVGGraphicsElement | HTMLElement | React.RefObject<SVGGraphicsElement>
  lines: string[]
  viewport?: HTMLElement
  viewportStartCorner?: HTMLElement
}): ReturnType<typeof h> {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const tip = ref.current
    const layer = tip?.parentElement
    const element = 'current' in anchor ? anchor.current : anchor
    if (!tip || !layer || !element) return
    const update = (): void => {
      const frame = layer.getBoundingClientRect()
      const mark = element.getBoundingClientRect()
      if (viewport !== undefined) {
        const clip = viewport.getBoundingClientRect()
        const x = (mark.left + mark.right) / 2
        const y = (mark.top + mark.bottom) / 2
        const boundary = viewportStartCorner?.getBoundingClientRect()
        const rtl = boundary !== undefined && viewport.ownerDocument.defaultView?.getComputedStyle(viewport).direction === 'rtl'
        const start = boundary !== undefined && !rtl ? Math.max(clip.left, boundary.right) : clip.left
        const end = boundary !== undefined && rtl ? Math.min(clip.right, boundary.left) : clip.right
        const top = Math.max(clip.top, boundary?.bottom ?? clip.top)
        if (x < start || x > end || y < top || y > clip.bottom) {
          tip.style.visibility = 'hidden'
          return
        }
      }
      const scaleX = frame.width > 0 && layer.clientWidth > 0 ? frame.width / layer.clientWidth : 1
      const scaleY = frame.height > 0 && layer.clientHeight > 0 ? frame.height / layer.clientHeight : 1
      const box = tip.getBoundingClientRect()
      const width = box.width / scaleX
      const height = box.height / scaleY
      const left = (mark.left - frame.left) / scaleX
      const right = (mark.right - frame.left) / scaleX
      const top = (mark.top - frame.top) / scaleY
      const bottom = (mark.bottom - frame.top) / scaleY
      const gap = 8
      const inset = 4
      const maxX = Math.max(inset, layer.clientWidth - width - inset)
      const maxY = Math.max(inset, layer.clientHeight - height - inset)

      let x: number
      let y = (top + bottom - height) / 2
      if (right + gap <= maxX) x = right + gap
      else if (left - gap - width >= inset) x = left - gap - width
      else {
        x = (left + right - width) / 2
        y = top - gap - height >= inset ? top - gap - height : bottom + gap
      }
      tip.style.left = `${Math.max(inset, Math.min(maxX, x))}px`
      tip.style.top = `${Math.max(inset, Math.min(maxY, y))}px`
      tip.style.visibility = 'visible'
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(layer)
    observer?.observe(element)
    observer?.observe(tip)
    if (viewport !== undefined) {
      observer?.observe(viewport)
      viewport.addEventListener('scroll', update, { passive: true })
    }
    return () => {
      observer?.disconnect()
      viewport?.removeEventListener('scroll', update)
    }
  }, [anchor, lines, viewport, viewportStartCorner])
  return h('div', { ref, className: 'a2ui-bar-tip', role: 'tooltip' },
    ...lines.map((line, index) => h('div', { key: index }, line)),
  )
}
