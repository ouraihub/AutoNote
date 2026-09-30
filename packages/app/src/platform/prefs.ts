export type PrefValue = null | boolean | number | string | readonly PrefValue[] | { readonly [key: string]: PrefValue }

export interface PrefsStore {
  load(key: string): Promise<unknown>
  save(key: string, value: PrefValue): Promise<void>
  remove(key: string): Promise<void>
}
