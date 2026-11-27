/**
 * DateTimeInput value conversion.
 *
 * The browser control speaks local wall-clock strings (`YYYY-MM-DD`,
 * `HH:MM`, `YYYY-MM-DDTHH:MM`) while the data model stores ISO 8601. Slicing the
 * stored string is wrong the moment an offset is involved, and inventing a date
 * for a bare time (`14:30`) breaks the round trip, so both directions are
 * explicit here and unit-tested.
 */

export type DateTimeKind = 'date' | 'time' | 'datetime-local'

/** The control kind a component asks for. */
export function dateTimeKind(enableDate: boolean, enableTime: boolean): DateTimeKind {
  if (enableDate && enableTime) return 'datetime-local'
  return enableDate ? 'date' : 'time'
}

interface WallClock {
  year: number
  month: string
  day: string
  hour: string
  minute: string
}

function wallClock(date: Date): WallClock {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    year: date.getFullYear(),
    month: pad(date.getMonth() + 1),
    day: pad(date.getDate()),
    hour: pad(date.getHours()),
    minute: pad(date.getMinutes()),
  }
}

/**
 * Stored value → control value.
 *
 * A `date` control is a *calendar* control: it reports the stored calendar date
 * and never shifts it through a time zone, so `2026-11-13` stays the 13th in
 * UTC-8 (converting the string through `Date` would show the 12th). An ISO
 * timestamp keeps the date it names, which also keeps values written by earlier
 * versions of this plugin round-tripping. A bare `HH:MM` stays literal. Only
 * `datetime-local` converts to local wall-clock time.
 */
export function toControlValue(stored: string, kind: DateTimeKind): string {
  if (stored === '') return ''
  if (kind === 'time' && /^\d{2}:\d{2}(:\d{2})?$/u.test(stored)) return stored.slice(0, 5)
  if (kind === 'date') {
    const calendar = /^(\d{4})-(\d{2})-(\d{2})/u.exec(stored)
    if (calendar !== null) return `${calendar[1]}-${calendar[2]}-${calendar[3]}`
    const date = new Date(stored)
    if (Number.isNaN(date.getTime())) return ''
    const clock = wallClock(date)
    return `${clock.year}-${clock.month}-${clock.day}`
  }
  const date = new Date(stored)
  if (Number.isNaN(date.getTime())) return kind === 'time' ? stored.slice(0, 5) : ''
  const clock = wallClock(date)
  if (kind === 'time') return `${clock.hour}:${clock.minute}`
  return `${clock.year}-${clock.month}-${clock.day}T${clock.hour}:${clock.minute}`
}

/**
 * Control value → stored value.
 * `date` uses UTC midnight to retain the original calendar date on the wire.
 * `datetime-local` uses the local zone, and `time` keeps the bare `HH:MM`.
 */
export function fromControlValue(value: string, kind: DateTimeKind): string {
  if (value === '') return ''
  if (kind === 'time') return /^\d{2}:\d{2}$/u.test(value) ? value : value.slice(0, 5)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}
