// One request, four stages. parse, authorize, and execute return a Result.
// respond is the only place that turns a Result into an HTTP status.
// A throw is an unexpected state of that request: the edge answers it and records the error kind.

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type Stage = 'parse' | 'authorize' | 'execute';

export type UnexpectedFailure = {
  readonly kind: 'unexpected';
  readonly stage: Stage;
  readonly name: string;
};

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isUnexpected<E>(error: E | UnexpectedFailure): error is UnexpectedFailure {
  return !!error && typeof error === 'object' && 'kind' in error && error.kind === 'unexpected';
}

export type HttpReply = {
  readonly status: number;
  readonly body: BodyInit | null;
  readonly headers: Headers;
};

export function httpReply(status: number, body: BodyInit | null, headers: Headers): HttpReply {
  return { status, body, headers };
}

export function responseOf(reply: HttpReply): Response {
  return new Response(reply.body, { status: reply.status, headers: reply.headers });
}

type Stages<P, A, X, E> = {
  parse: () => Promise<Result<P, E>> | Result<P, E>;
  authorize: (parsed: P) => Promise<Result<A, E>> | Result<A, E>;
  execute: (authorized: A) => Promise<Result<X, E>> | Result<X, E>;
};

function thrownName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'Error';
}

function assertStage(stage: Stage): Stage {
  switch (stage) {
    case 'parse':
    case 'authorize':
    case 'execute':
      return stage;
    default:
      return assertNever(stage);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled variant ${JSON.stringify(value)}`);
}

/**
 * Run parse, then authorize, then execute. respond maps the Result to a Response.
 * A throw becomes `{ kind: 'unexpected' }` for this request only. The error message stays off the log.
 */
export async function runRequest<P, A, X, E>(
  stages: Stages<P, A, X, E>,
  respond: (result: Result<X, E | UnexpectedFailure>) => Promise<Response> | Response,
): Promise<Response> {
  let stage: Stage = 'parse';
  try {
    const parsed = await stages.parse();
    if (!parsed.ok) return await respond(parsed);
    stage = 'authorize';
    const authorized = await stages.authorize(parsed.value);
    if (!authorized.ok) return await respond(authorized);
    stage = 'execute';
    const executed = await stages.execute(authorized.value);
    return await respond(executed);
  } catch (error) {
    const failure: UnexpectedFailure = { kind: 'unexpected', stage: assertStage(stage), name: thrownName(error) };
    try {
      return await respond({ ok: false, error: failure });
    } catch {
      console.log(JSON.stringify({ msg: 'ply.request', error_kind: failure.kind, stage: failure.stage, error_name: failure.name }));
      return new Response('unexpected\n', {
        status: 500,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-ply-error-kind': failure.kind },
      });
    }
  }
}
