/**
 * Byte helpers shared by the key protocol. Everything that is hashed, signed
 * or MACed is built from these, never from `JSON.stringify`, so the CLI, the
 * Worker and the app produce the same bytes.
 */

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Strict UTF-8 decoding (no replacement characters): rejects overlong forms,
 * surrogates and values above U+10FFFF. Written out because Hermes may lack
 * `TextDecoder`, and every platform must accept exactly the same bytes.
 */
export function fromUtf8(bytes: Uint8Array): string {
  const points: number[] = [];
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i] as number;
    const size =
      first < 0x80
        ? 1
        : first >= 0xc2 && first < 0xe0
          ? 2
          : first >= 0xe0 && first < 0xf0
            ? 3
            : first >= 0xf0 && first < 0xf5
              ? 4
              : 0;
    if (size === 0 || i + size > bytes.length) throw new TypeError('invalid UTF-8');
    let point = size === 1 ? first : first & (0xff >> (size + 1));
    for (let k = 1; k < size; k++) {
      const next = bytes[i + k] as number;
      if ((next & 0xc0) !== 0x80) throw new TypeError('invalid UTF-8');
      point = (point << 6) | (next & 0x3f);
    }
    const min = [0, 0, 0x80, 0x800, 0x10000][size] as number;
    if (point < min || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
      throw new TypeError('invalid UTF-8');
    points.push(point);
    i += size;
  }
  let out = '';
  for (let i = 0; i < points.length; i += 4096)
    out += String.fromCodePoint(...points.slice(i, i + 4096));
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Unsigned LEB128, as CPace uses for lengths (draft-irtf-cfrg-cpace, A.1). */
export function leb128(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid length');
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return Uint8Array.from(out);
}

export function prependLen(data: Uint8Array): Uint8Array {
  return concat(leb128(data.length), data);
}

/** Length-value concatenation: each part prefixed with its LEB128 length. */
export function lvCat(...parts: Uint8Array[]): Uint8Array {
  return concat(...parts.map(prependLen));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  // Constant time for equal lengths; lengths are public.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new TypeError('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url, the wire form of keys, shares and tags. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64[c & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  if (/[^A-Za-z0-9_-]/.test(text) || text.length % 4 === 1)
    throw new TypeError('invalid base64url');
  const values = Array.from(text, (ch) => B64.indexOf(ch));
  const out = new Uint8Array(Math.floor((values.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let j = 0;
  for (const v of values) {
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  // Canonical form only: leftover bits must be zero.
  if ((acc & ((1 << bits) - 1)) !== 0) throw new TypeError('non-canonical base64url');
  return out;
}
