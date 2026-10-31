export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return new Response(
    JSON.stringify({
      error: { code, message, ...(details === undefined ? {} : { details }) },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    },
  )
}

export function revokeAttachment(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}
