// GET /v1/read asks for a blob. A tree at that path is a different operation (GET /v1/tree), not a missing path.

import { chainGet } from './absent.ts';

const DIRECTORY_READ = / is a directory$/;

export function isDirectoryRead(err: unknown): boolean {
  const code = chainGet(err, 'code');
  const message = chainGet(err, 'message');
  return code.tag === 'some' && code.value === 'not_found' && message.tag === 'some' && typeof message.value === 'string' && DIRECTORY_READ.test(message.value);
}

export function directoryReadMessage(message: string): string {
  return `${message}; list it with GET /v1/tree`;
}
