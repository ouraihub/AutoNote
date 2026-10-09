export const ORGANIZER_COLORS = [
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#65a30d',
  '#059669',
  '#0891b2',
  '#4f46e5',
  '#9333ea',
  '#db2777',
  '#64748b',
] as const

export type OrganizerColor = (typeof ORGANIZER_COLORS)[number]

export const ORGANIZER_COLOR_NAMES: Record<OrganizerColor, string> = {
  '#dc2626': 'red',
  '#ea580c': 'orange',
  '#ca8a04': 'yellow',
  '#65a30d': 'lime',
  '#059669': 'emerald',
  '#0891b2': 'cyan',
  '#4f46e5': 'indigo',
  '#9333ea': 'purple',
  '#db2777': 'pink',
  '#64748b': 'slate',
}

export function isOrganizerColor(value: unknown): value is OrganizerColor {
  return typeof value === 'string' && (ORGANIZER_COLORS as readonly string[]).includes(value)
}

export function organizerColorOrNull(value: unknown): OrganizerColor | null {
  return isOrganizerColor(value) ? value : null
}
