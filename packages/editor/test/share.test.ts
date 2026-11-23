import { describe, expect, test } from 'vitest';
import { decodeShare, encodeShare } from '../src/share';

async function deflate(data: Uint8Array<ArrayBuffer>) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  void w.write(data);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

describe('share links', () => {
  test('a source with non-ASCII text survives the round trip, with or without the leading #', async () => {
    const src = 'process Prüfung {\n  start\n}\n'.repeat(80);
    const e = await encodeShare(src);
    if (!e.ok) throw new Error('expected ok');
    expect(e.hash.startsWith('src=')).toBe(true);
    for (const h of [e.hash, '#' + e.hash]) {
      expect(await decodeShare(h)).toEqual({ ok: true, source: src });
    }
  });

  test('a source that does not compress below 8,000 characters is refused as too long', async () => {
    let seed = 1;
    const noise = Array.from({ length: 12000 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff; // eslint-disable-line no-bitwise
      return String.fromCharCode(33 + (seed % 90));
    }).join('');
    expect(await encodeShare(noise)).toEqual({ ok: false, reason: 'too-long' });
  });

  test('a hash that inflates past 200 KB is refused as too large', async () => {
    const big = await deflate(new Uint8Array(300 * 1024).fill(97));
    const hash = 'src=' + Buffer.from(big).toString('base64url');
    expect(await decodeShare(hash)).toEqual({ ok: false, reason: 'too-large' });
  });

  test('a malformed hash is reported, never thrown', async () => {
    expect(await decodeShare('src=%%%')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await decodeShare('src=AAAA')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await decodeShare('src=')).toEqual({ ok: false, reason: 'invalid' });
    expect(await decodeShare('')).toEqual({ ok: false, reason: 'absent' });
    expect(await decodeShare('#other=1')).toEqual({
      ok: false,
      reason: 'absent',
    });
  });
});
