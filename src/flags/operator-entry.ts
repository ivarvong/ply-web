// Default export of ply-flag-operator. It is not mounted on ply.
// `cf deploy --mode flag-operator` is the upload. A normal deploy stays on ply.
import { handleOperator, type OperatorEnv } from './operator.ts';
import type { TracingLike } from './telemetry.ts';

type OperatorContext = {
  readonly tracing?: TracingLike | null;
};

const operator = {
  async fetch(request: Request, env: OperatorEnv, ctx: OperatorContext): Promise<Response> {
    const tracing = ctx.tracing ?? null;
    return handleOperator(request, env, {
      tracing,
      clock: () => performance.now(),
      log: line => console.log(line),
    });
  },
};

export default operator;
