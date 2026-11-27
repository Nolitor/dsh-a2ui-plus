/**
 * `FramePlayer` — a deterministic step animation for precomputed frames.
 *
 * The model supplies the frames (for example every step of a bubble sort); this
 * component owns playback. Nothing is executed and nothing is sent to the agent
 * while the animation runs, so a 200-step animation costs zero round trips.
 */
import * as React from 'react'
import { h } from './h.js'
import type { A2UIComponent } from '../shared/validate.js'
import { numberValue, text, type Scope } from './context.js'
import { LIMITS } from '../shared/limits.js'

interface FrameItem {
  label: string
  value: number
  state: string
}

interface Frame {
  label: string
  items: FrameItem[]
}

function readFrames(scope: Scope, component: A2UIComponent): Frame[] {
  const raw = Array.isArray(component.frames) ? component.frames.slice(0, LIMITS.maxFrames) : []
  return raw.map((entry, frameIndex) => {
    const record = (entry ?? {}) as Record<string, unknown>
    const items = Array.isArray(record.items) ? (record.items as Array<Record<string, unknown>>).slice(0, LIMITS.maxFrameItems) : []
    return {
      label: record.label === undefined ? `${scope.view.t('frame')} ${frameIndex + 1}` : text(scope, record.label),
      items: items.map((item, itemIndex) => ({
        label: item.label === undefined ? String(itemIndex + 1) : text(scope, item.label),
        value: numberValue(scope, item.value) ?? 0,
        state: typeof item.state === 'string' ? item.state : 'idle',
      })),
    }
  })
}

/** `FramePlayer` */
export function renderFramePlayer(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const frames = readFrames(scope, component)
  const mode = component.mode === 'list' ? 'list' : 'bars'
  const initialSpeed = Math.max(80, Math.min(3000, numberValue(scope, component.speed) ?? 420))
  const [index, setIndex] = React.useState(0)
  const [playing, setPlaying] = React.useState(component.autoplay === true)
  const [speed, setSpeed] = React.useState(initialSpeed)

  React.useEffect(() => {
    if (!playing) return undefined
    if (frames.length === 0) return undefined
    const timer = window.setInterval(() => {
      setIndex((previous) => {
        if (previous + 1 >= frames.length) {
          setPlaying(false)
          return previous
        }
        return previous + 1
      })
    }, speed)
    return () => window.clearInterval(timer)
  }, [playing, speed, frames.length])

  if (frames.length === 0) {
    return h('div', { className: 'a2ui-player' }, h('p', { className: 'a2ui-caption' }, view.t('chartEmpty')))
  }

  const frame = frames[Math.min(index, frames.length - 1)] as Frame
  const globalMax = Math.max(1, ...frames.flatMap((entry) => entry.items.map((item) => Math.abs(item.value))))
  const percent = frames.length <= 1 ? 100 : Math.round((index / (frames.length - 1)) * 100)

  const bars = h(
    'div',
    { className: 'a2ui-bars', role: 'img', 'aria-label': frame.items.map((item) => `${item.label}: ${item.value}`).join(', ') },
    ...frame.items.map((item, itemIndex) =>
      h(
        'div',
        {
          key: `b${itemIndex}`,
          className: `a2ui-bar a2ui-state-${item.state}`,
          style: { height: `${Math.max(3, (Math.abs(item.value) / globalMax) * 100)}%` },
          title: `${item.label}: ${item.value}`,
        },
        h('span', { className: 'a2ui-bar-value' }, String(item.value)),
      ),
    ),
  )

  const list = h(
    'div',
    { className: 'a2ui-frame-list', role: 'list', 'aria-label': frame.items.map((item) => `${item.label}: ${item.value}`).join(', ') },
    ...frame.items.map((item, itemIndex) =>
      h('span', { key: `l${itemIndex}`, role: 'listitem', className: `a2ui-cell a2ui-state-${item.state}` }, `${item.label} ${item.value}`),
    ),
  )

  return h(
    'div',
    { className: 'a2ui-player' },
    component.caption === undefined ? null : h('p', { className: 'a2ui-caption' }, text(scope, component.caption)),
    h(
      'div',
      { className: 'a2ui-player-bar' },
      h(
        'button',
        {
          type: 'button',
          className: 'a2ui-btn',
          onClick: () => {
            if (index + 1 >= frames.length) setIndex(0)
            setPlaying(!playing)
          },
          'aria-pressed': playing,
        },
        playing ? view.t('pause') : view.t('play'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'a2ui-btn',
          disabled: playing || index + 1 >= frames.length,
          onClick: () => setIndex(Math.min(index + 1, frames.length - 1)),
        },
        view.t('step'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'a2ui-btn a2ui-btn-borderless',
          disabled: playing || index === 0,
          onClick: () => setIndex(0),
        },
        view.t('reset'),
      ),
      h(
        'label',
        { className: 'a2ui-caption', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        view.t('speed'),
        h('input', {
          type: 'range',
          min: 120,
          max: 1600,
          step: 40,
          value: 1760 - speed,
          'aria-label': view.t('speed'),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSpeed(1760 - Number(event.target.value)),
          style: { width: '92px', accentColor: 'var(--dsw-alias-brand-primary)' },
        }),
      ),
      h('span', { className: 'a2ui-player-note' }, `${frame.label} · ${index + 1}/${frames.length} (${percent}%)`),
    ),
    h('div', { className: 'a2ui-progress' }, h('div', { className: 'a2ui-progress-track' }, h('div', { className: 'a2ui-progress-fill', style: { width: `${percent}%` } }))),
    mode === 'bars' ? bars : list,
  )
}

export function FramePlayerView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderFramePlayer(props.scope, props.component)
}
