// RateCache: cache-enabled named entrypoint (cloudflare.config.ts) for the rate limiter's one document. Reached only over
// ctx.exports from the front door. A HIT is served by Workers Cache and never runs this code.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { counterOf, type CounterEnv } from './stub.ts';
import { serveDoc } from './doc.ts';

export class RateCache extends WorkerEntrypoint<CounterEnv> {
  override async fetch(req: Request): Promise<Response> {
    return serveDoc(req, counterOf(this.env, this.ctx));
  }
}
