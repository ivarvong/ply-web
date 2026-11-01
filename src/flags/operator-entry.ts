// Default export of ply-flag-operator. It is not mounted on ply.
// `cf deploy --mode flag-operator` is the upload. A normal deploy stays on ply.
import { chainGet } from '../absent.ts';
import { handleOperator, type OperatorEnv } from './operator.ts';
import type { TracingLike } from './telemetry.ts';

type OperatorContext = {
  readonly tracing: TracingLike | null;
};

/** The host may omit tracing. A missing field and an explicit null are both null. */
function tracingOf(ctx: OperatorContext): TracingLike | null {
  const found = chainGet(ctx, 'tracing');
  if (found.tag === 'none') return null;
  return found.value as TracingLike;
}

const operator = {
  async fetch(request: Request, env: OperatorEnv, ctx: OperatorContext): Promise<Response> {
    const tracing = tracingOf(ctx);
    return handleOperator(request, env, {
      tracing,
      clock: () => performance.now(),
      log: line => console.log(line),
    });
  },
};

export default operator;
