const MAX_ENCODED = 8000;
const MAX_DECODED = 200 * 1024;

export type EncodeResult =
  { ok: true; hash: string } | { ok: false; reason: 'too-long' };
export type DecodeResult =
  | { ok: true; source: string }
  | { ok: false; reason: 'absent' | 'invalid' | 'too-large' };

// Browser-safe (no Buffer): chunked to keep String.fromCharCode arguments small.
function toB64Url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000)
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const fromB64Url = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );

async function pipe(
  data: Uint8Array<ArrayBuffer>,
  t: CompressionStream | DecompressionStream,
  cap = Infinity,
) {
  const w = t.writable.getWriter();
  // Errors surface on the readable side; avoid unhandled rejections here.
  w.write(data).catch(() => {});
  w.close().catch(() => {});
  const reader = (t.readable as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) (out.set(c, o), (o += c.length));
  return out;
}

/** `src=` + base64url(deflate-raw(UTF-8)), without the leading `#`. */
export async function encodeShare(source: string): Promise<EncodeResult> {
  const z = await pipe(
    new TextEncoder().encode(source),
    new CompressionStream('deflate-raw'),
  );
  const payload = toB64Url(z!);
  if (payload.length > MAX_ENCODED) return { ok: false, reason: 'too-long' };
  return { ok: true, hash: `src=${payload}` };
}

/** The hash is untrusted input: never throws, stops inflating past 200 KB. */
export async function decodeShare(hash: string): Promise<DecodeResult> {
  const m = /^#?src=(.*)$/.exec(hash);
  if (!m) return { ok: false, reason: 'absent' };
  if (!m[1] || m[1].length > MAX_ENCODED || !/^[A-Za-z0-9_-]+$/.test(m[1]))
    return { ok: false, reason: 'invalid' };
  try {
    const out = await pipe(
      fromB64Url(m[1]),
      new DecompressionStream('deflate-raw'),
      MAX_DECODED,
    );
    if (!out) return { ok: false, reason: 'too-large' };
    return {
      ok: true,
      source: new TextDecoder('utf-8', { fatal: true }).decode(out),
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
