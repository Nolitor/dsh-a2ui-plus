import * as React from 'react'

/** JSX factory shared by every client module (classic runtime, no `react/jsx-runtime` import). */
export const h = React.createElement

/** Fragment alias for the JSX pragma. */
export const Fragment = React.Fragment

export type { React }
