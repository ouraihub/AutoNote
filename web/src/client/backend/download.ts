interface SaveHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>
}
type SavePicker = (options: { suggestedName: string }) => Promise<SaveHandle>
const saveFilePicker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker
export async function saveDownload(response: Response, fallbackName: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  const disposition = response.headers.get('Content-Disposition')
  const match = disposition?.match(/filename="?([^";]+)"?/i)
  const name = match?.[1] ?? fallbackName
  if (saveFilePicker) {
    try {
      const handle = await saveFilePicker({ suggestedName: name })
      const writable = await handle.createWritable()
      await response.body?.pipeTo(writable, { signal })
      return !signal?.aborted
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return false
    }
  }
  if (signal?.aborted) return false
  const blob = await response.blob()
  if (signal?.aborted) return false
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return true


