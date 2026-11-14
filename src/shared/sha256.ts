/** The SHA-256 of bytes, or of text as UTF-8, in hex. */
export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).toHex();
}
