/// <reference types="vite/client" />

export const CLIENT_DATABASE_NAME = import.meta.env.MODE === 'demo' ? 'autonote-demo' : 'autonote'
export const IS_DEMO_MODE = import.meta.env.MODE === 'demo'

export function createClientId(randomUuid: () => string = () => crypto.randomUUID()): string {
  return randomUuid()
}

export const CLIENT_ID = createClientId()
