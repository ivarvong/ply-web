/** Unreachable branch of a closed union. A new member fails typecheck until a caller names it. */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant ${JSON.stringify(value)}`);
}
