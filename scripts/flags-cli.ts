// Operator CLI. The token is a mode 0600 file, never an argument and never printed.
// The URL is PLY_FLAG_OPERATOR_URL or --url. There is no default host.
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandRequest, operatorEndpoint, parseFlagArgs, type OperatorCommand } from '../src/flags/operator.ts';
import { redact } from './cd/redact.ts';
import { Secret } from './cd/secret.ts';

const OWNER_OTHERS = 0o077;
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const DEFAULT_TOKEN_NAME = '.ply-flag-token';

export const FLAGS_HELP = `flags get
flags rollout <flag> <basisPoints> --expected absent|<revision>
flags targeting <flag> --expected absent|<revision> [--allow a,b] [--deny c] [--rules <json>]

Reads FLAG_OPERATOR_TOKEN from FLAG_OPERATOR_TOKEN_FILE (default ~/.ply-flag-token, mode 0600).
The operator origin is PLY_FLAG_OPERATOR_URL or --url. There is no default host.
Exit 0 is ok or an absent ruleset. Exit 1 is conflict, unauthorized, unavailable, or any other HTTP failure. Exit 2 is usage.
`;

export type FlagsIo = {
  readonly fetch: typeof fetch;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly readToken: (path: string) => Promise<Secret>;
};

function tokenPath(env: Readonly<Record<string, string | undefined>>): string {
  return env.FLAG_OPERATOR_TOKEN_FILE && env.FLAG_OPERATOR_TOKEN_FILE.length > 0
    ? env.FLAG_OPERATOR_TOKEN_FILE
    : join(homedir(), DEFAULT_TOKEN_NAME);
}

/** Owner-only file. Errors name the path and never include the file contents. */
export async function readOperatorToken(path: string): Promise<Secret> {
  let mode = 0;
  try {
    mode = (await stat(path)).mode;
  } catch {
    throw new Error(`FLAG_OPERATOR_TOKEN_FILE ${path} cannot be read`);
  }
  if ((mode & OWNER_OTHERS) !== 0) throw new Error(`FLAG_OPERATOR_TOKEN_FILE ${path} must be mode 0600`);
  const text = (await readFile(path, 'utf8')).trim();
  if (!text) throw new Error(`FLAG_OPERATOR_TOKEN_FILE ${path} is empty`);
  return new Secret(text);
}

function conceal(text: string, token: Secret): string {
  const value = token.reveal();
  return redact(text.split(value).join('[redacted]'), [value]);
}

function exitFor(status: number, body: string): number {
  if (status !== 200) return EXIT_FAIL;
  try {
    const parsed = JSON.parse(body) as { kind?: unknown };
    if (parsed && typeof parsed === 'object' && (parsed.kind === 'ok' || parsed.kind === 'absent')) return EXIT_OK;
  } catch {
    return EXIT_FAIL;
  }
  return EXIT_FAIL;
}

async function send(command: OperatorCommand, origin: string, token: Secret, io: FlagsIo): Promise<number> {
  const request = commandRequest(command);
  const url = operatorEndpoint(origin, request.path);
  if (!url) {
    io.stderr('PLY_FLAG_OPERATOR_URL or --url must be an http(s) origin with no userinfo\n');
    return EXIT_USAGE;
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token.reveal()}` };
  if (request.body) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await io.fetch(url, {
      method: request.method,
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'operator request failed';
    io.stderr(`${conceal(message, token)}\n`);
    return EXIT_FAIL;
  }
  const text = await response.text();
  io.stdout(conceal(text, token));
  if (!text.endsWith('\n')) io.stdout('\n');
  return exitFor(response.status, text);
}

export async function runFlagsCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: FlagsIo = { fetch: globalThis.fetch, stdout: line => process.stdout.write(line), stderr: line => process.stderr.write(line), readToken: readOperatorToken },
): Promise<number> {
  const parsed = parseFlagArgs(argv);
  if (parsed.kind === 'help') {
    io.stdout(FLAGS_HELP);
    return EXIT_OK;
  }
  if (parsed.kind === 'error') {
    io.stderr(`${parsed.reason}\n`);
    return EXIT_USAGE;
  }
  const origin = parsed.url ?? env.PLY_FLAG_OPERATOR_URL ?? '';
  if (!origin) {
    io.stderr('set PLY_FLAG_OPERATOR_URL or pass --url; there is no default host\n');
    return EXIT_USAGE;
  }
  let token: Secret;
  try {
    token = await io.readToken(tokenPath(env));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'FLAG_OPERATOR_TOKEN_FILE cannot be read';
    io.stderr(`${message}\n`);
    return EXIT_USAGE;
  }
  return send(parsed.command, origin, token, io);
}

/** Test helper: write a token file and force mode 0600. Not used by the CLI itself. */
export async function writeOperatorTokenFile(path: string, value: string, mode: number): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, mode);
}
