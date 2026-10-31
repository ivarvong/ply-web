// GET /v1/read asks for a blob. A tree at that path is a different operation (GET /v1/tree), not a missing path.

const DIRECTORY_READ = / is a directory$/;

export function isDirectoryRead(err: { code?: string; message?: string } | null | undefined): boolean {
  return err?.code === 'not_found' && typeof err.message === 'string' && DIRECTORY_READ.test(err.message);
}

export function directoryReadMessage(message: string): string {
  return `${message}; list it with GET /v1/tree`;
}
