// The worker's call options are whatever `operation` accepts (auth, tracer, limits, quirks, fetch).
// ply's Transport and OperationOpts types are not re-exported from the package root, so they are
// recovered from the function that actually receives them.
import { operation } from 'ply'

export type CallOpts = Parameters<typeof operation>[2]
type OperationCtx = Parameters<Parameters<typeof operation>[3]>[0]
export type GitTransport = OperationCtx['t']
export type GitSpan = OperationCtx['root']
export type GitOutcome = OperationCtx['outcome']
