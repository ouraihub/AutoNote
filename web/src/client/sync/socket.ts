export interface SyncSocket {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send(data: string): void
  close(): void
}

export interface SocketFactory {
  create(): SyncSocket
}

export const browserSocketFactory: SocketFactory = {
  create() {
    const url = new URL('/api/sync/ws', globalThis.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return new globalThis.WebSocket(url)
  },
}
