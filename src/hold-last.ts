// GET /v1/read streams a blob under a Content-Length. ply's blob stream hashes each chunk and passes it on at once, and
// checks the hash (and the pack trailer) only when the source ends. So the last byte of the declared length reached the
// client before the blob was verified, and the response body was still open while that check ran: the client had a
// complete response, finished, and the runtime recorded the invocation as `canceled` (8% of reads on version 0024944c,
// 2026-10-31). A failed check could not truncate the response either: every byte had been sent.
//
// holdLastChunk passes every chunk but the latest on, and releases the latest only when the source closes, which is
// after the blob verified. The final bytes and the end of the body leave together; a verification failure errors the
// stream with the last chunk still held, so the client sees a body short of its Content-Length.

export function holdLastChunk(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let held: Uint8Array | null = null;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      if (chunk.byteLength === 0) return;
      if (held) ctl.enqueue(held);
      held = chunk;
    },
    flush(ctl) {
      if (held) ctl.enqueue(held);
      held = null;
    },
  }));
}
