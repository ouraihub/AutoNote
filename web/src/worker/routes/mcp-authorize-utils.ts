export function logoMark(): string {
  return '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect \
x="2.5" y="2.5" width="27" height="27" rx="8.5"></rect><path \
d="M16 8.2c2.7 3.5 5.4 6.3 5.4 9.3a5.4 5.4 0 1 1-10.8 \
0c0-3 2.7-5.8 5.4-9.3z"></path></svg>'
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  )
}
