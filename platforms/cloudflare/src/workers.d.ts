/**
 * The slice of the Workers runtime API this platform uses, declared by hand.
 *
 * Why not @cloudflare/workers-types: the repository type checks every package in one program whose root tsconfig
 * loads the DOM library for apps/web. The Workers types redeclare DOM globals (Request, Response, WebSocket) and
 * conflict with it, and adding them globally would let browser code type check against Workers-only APIs. So the
 * Workers-only names live inside the ambient `cloudflare:workers` module as types (erased at build time), the DOM
 * declarations serve the APIs both runtimes share, and no global is added or widened.
 *
 * Signatures follow https://developers.cloudflare.com/durable-objects/api/ and the hibernation API in
 * https://developers.cloudflare.com/durable-objects/best-practices/websockets/.
 */
declare module "cloudflare:workers" {
  export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>
    put<T>(key: string, value: T): Promise<void>
    deleteAll(): Promise<void>
    getAlarm(): Promise<number | null>
    setAlarm(scheduledTime: number): Promise<void>
    deleteAlarm(): Promise<void>
  }

  /** A server-side WebSocket accepted with `acceptWebSocket`; its attachment survives hibernation (at most 2,048 bytes). */
  export interface HibernatableWebSocket extends WebSocket {
    serializeAttachment(value: unknown): void
    deserializeAttachment(): unknown
  }

  export interface DurableObjectState {
    readonly storage: DurableObjectStorage
    acceptWebSocket(socket: HibernatableWebSocket, tags?: ReadonlyArray<string>): void
    getWebSockets(tag?: string): Array<HibernatableWebSocket>
  }

  export abstract class DurableObject<Environment = unknown> {
    protected readonly ctx: DurableObjectState
    protected readonly env: Environment
    constructor(ctx: DurableObjectState, env: Environment)
    fetch?(request: Request): Promise<Response>
    alarm?(): Promise<void>
    webSocketMessage?(socket: HibernatableWebSocket, message: string | ArrayBuffer): Promise<void>
    webSocketClose?(socket: HibernatableWebSocket, code: number, reason: string, wasClean: boolean): Promise<void>
    webSocketError?(socket: HibernatableWebSocket, error: unknown): Promise<void>
  }

  // Type-only names below; the runtime provides the values through bindings and globals.

  export interface DurableObjectId {
    readonly name?: string
  }

  export interface DurableObjectStub {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>
  }

  export interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId
    get(id: DurableObjectId): DurableObjectStub
  }

  /** A service binding such as the static assets binding. */
  export interface Fetcher {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>
  }

  /** The global `WebSocketPair` constructor: index 0 goes to the client in the 101 response, index 1 stays in the object. */
  export interface WebSocketPairConstructor {
    new (): { readonly 0: WebSocket; readonly 1: HibernatableWebSocket }
  }

  /** `ResponseInit` plus the Workers-only `webSocket` field of a 101 upgrade response. */
  export interface UpgradeResponseInit extends ResponseInit {
    readonly webSocket: WebSocket
  }
}
