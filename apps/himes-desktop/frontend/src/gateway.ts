import { Call, Events } from '@wailsio/runtime'

export type JsonObject = Record<string, unknown>

/** The Go service owns the socket and keeps the token in process memory. */
export const gateway = {
  connectLocal: (): Promise<void> =>
    Call.ByName('main.GatewayService.ConnectLocal') as Promise<void>,
  connect: (url: string, token: string): Promise<void> =>
    Call.ByName('main.GatewayService.Connect', url, token) as Promise<void>,
  disconnect: (): Promise<void> =>
    Call.ByName('main.GatewayService.Disconnect') as Promise<void>,
  request: async (method: string, params: JsonObject = {}): Promise<JsonObject> => {
    const envelope = await Call.ByName('main.GatewayService.Call', method, params) as JsonObject
    if (envelope.error) {
      const detail = envelope.error as { message?: string }
      throw new Error(detail.message || `${method} failed`)
    }
    return (envelope.result ?? {}) as JsonObject
  },
  onEvent: (fn: (event: JsonObject) => void): (() => void) =>
    Events.On('gateway:event', ({ data }) => fn(data as JsonObject)),
  onStatus: (fn: (status: string) => void): (() => void) =>
    Events.On('gateway:status', ({ data }) => fn(String(data))),
}
