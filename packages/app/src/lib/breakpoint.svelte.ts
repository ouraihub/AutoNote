import { MediaQuery } from 'svelte/reactivity'

export type Breakpoint = 'desktop' | 'tablet' | 'mobile'

const wide = new MediaQuery('(min-width: 1180px)')
const medium = new MediaQuery('(min-width: 768px)')
const touchLandscape = new MediaQuery('(pointer: coarse) and (max-height: 600px) and (max-width: 1179px)')

export function breakpoint(): Breakpoint {
  return touchLandscape.current ? 'mobile' : wide.current ? 'desktop' : medium.current ? 'tablet' : 'mobile'
}
