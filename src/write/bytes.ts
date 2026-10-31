/**
 * ply's pack input and upload-pack frames take `Uint8Array<ArrayBuffer>`.
 * Encoders in this process allocate an ArrayBuffer. A SharedArrayBuffer view is copied so the
 * bytes handed to receive-pack are still an ArrayBuffer, with the same contents.
 */
export function arrayBufferBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy
}
