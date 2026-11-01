// Minimal types for the Workers runtime modules this viewer imports. tsconfig.json does not load the generated
// runtime types (`cf workers types`); these declarations cover only what rate.ts touches.
// A missing storage value is the global PlatformAbsent brand from src/absent.ts. The host still returns its own hole.
declare module 'cloudflare:workers' {
  export abstract class WorkerEntrypoint<Env = unknown> {
    ctx: unknown;
    env: Env;
    constructor(ctx: unknown, env: Env);
    fetch?(req: Request): Promise<Response>;
  }
  export abstract class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
  export interface DurableObjectState {
    storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  }
  export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | PlatformAbsent>;
    put<T>(key: string, value: T): Promise<void>;
    sql: SqlStorage;
  }
  export interface SqlStorage {
    exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
  }
  export type SqlValue = string | number | null | ArrayBuffer;
  export interface SqlCursor<T> {
    toArray(): T[];
    one(): T;
  }
}
