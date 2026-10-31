export function ensureResponseOk(response: Response): void {
  if (!response.ok) throw new Error(`Unexpected response status ${response.status}`)
}

export function jsonHeaders(): Headers {
  return new Headers({ 'content-type': 'application/json' })
}
