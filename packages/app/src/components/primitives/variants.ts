export type ButtonVariant =
  'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] shadow-[0_1px_2px_rgba(0,0,0,.14)]',
  secondary:
    'border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]',
  ghost:
    'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
  subtle:
    'bg-[var(--bg-raised)] text-[var(--text-primary)] hover:bg-[var(--bg-active)]',
  danger:
    'bg-[var(--danger)] text-white hover:brightness-108 shadow-[0_1px_2px_rgba(0,0,0,.14)]',
}

export const FIELD_BASE =
  'w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none disabled:opacity-50'
