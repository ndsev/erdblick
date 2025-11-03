// shortId4.ts — zero-dependency, secure-context free (TypeScript)

/** Crockford Base32 alphabet (no I, L, O, U). */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Bitmask for 64-bit (BigInt). */
const MASK64 = 0xffff_ffff_ffff_ffffn;

/** Encode a 0..(2^20-1) number as 4 Crockford Base32 chars. */
function crockfordBase32_20bits(n: number): string {
    // Mask to be extra-safe if caller gives a wider number.
    n = n & 0x0f_ffff;
    const a = ALPHABET;
    // 20 bits => 4 groups of 5.
    return (
        a[(n >>> 15) & 31] +
        a[(n >>> 10) & 31] +
        a[(n >>> 5) & 31] +
        a[n & 31]
    );
}

/** Minimal UTF-8 encoder (avoids TextEncoder), with correct surrogate handling. */
function utf8Bytes(s: string): Uint8Array {
    // Worst-case 4 bytes per UTF-16 unit.
    const buf = new Uint8Array(s.length * 4);
    let o = 0;

    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);

        if (c < 0x80) {
            buf[o++] = c;
        } else if (c < 0x800) {
            buf[o++] = 0xc0 | (c >> 6);
            buf[o++] = 0x80 | (c & 0x3f);
        } else if (c >= 0xd800 && c <= 0xdbff) {
            // High surrogate
            const c2 = s.charCodeAt(i + 1);
            if ((c2 & 0xfc00) === 0xdc00) {
                // Valid low surrogate
                i++;
                const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
                buf[o++] = 0xf0 | (cp >> 18);
                buf[o++] = 0x80 | ((cp >> 12) & 0x3f);
                buf[o++] = 0x80 | ((cp >> 6) & 0x3f);
                buf[o++] = 0x80 | (cp & 0x3f);
            } else {
                // Lone high surrogate -> U+FFFD
                buf[o++] = 0xef; buf[o++] = 0xbf; buf[o++] = 0xbd;
            }
        } else if ((c & 0xfc00) === 0xdc00) {
            // Lone low surrogate -> U+FFFD
            buf[o++] = 0xef; buf[o++] = 0xbf; buf[o++] = 0xbd;
        } else {
            buf[o++] = 0xe0 | (c >> 12);
            buf[o++] = 0x80 | ((c >> 6) & 0x3f);
            buf[o++] = 0x80 | (c & 0x3f);
        }
    }

    return buf.subarray(0, o);
}

/** Left rotate for 64-bit BigInt. */
const ROTL = (x: bigint, n: number) =>
    ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;

/** Read 8 bytes little-endian as BigInt (out-of-bounds bytes treated as 0). */
function readLE64(b: Uint8Array, o: number): bigint {
    return (
        (BigInt(b[o] ?? 0)      ) |
        (BigInt(b[o + 1] ?? 0) << 8n) |
        (BigInt(b[o + 2] ?? 0) << 16n) |
        (BigInt(b[o + 3] ?? 0) << 24n) |
        (BigInt(b[o + 4] ?? 0) << 32n) |
        (BigInt(b[o + 5] ?? 0) << 40n) |
        (BigInt(b[o + 6] ?? 0) << 48n) |
        (BigInt(b[o + 7] ?? 0) << 56n)
    );
}

/** Derive a 128-bit SipHash key from an arbitrary string (simple XOR-fold). */
function deriveKey128(key: string): { k0: bigint; k1: bigint } {
    const k = new Uint8Array(16);
    const kb = utf8Bytes(key);
    for (let i = 0; i < kb.length; i++) k[i & 15] ^= kb[i];
    return { k0: readLE64(k, 0), k1: readLE64(k, 8) };
}

/** SipHash-2-4 (64-bit) keyed hash. */
function siphash24(msg: Uint8Array, k0: bigint, k1: bigint): bigint {
    let v0 = 0x736f6d6570736575n ^ k0;
    let v1 = 0x646f72616e646f6dn ^ k1;
    let v2 = 0x6c7967656e657261n ^ k0;
    let v3 = 0x7465646279746573n ^ k1;

    const round = () => {
        v0 = (v0 + v1) & MASK64; v1 = ROTL(v1, 13); v1 ^= v0; v0 = ROTL(v0, 32);
        v2 = (v2 + v3) & MASK64; v3 = ROTL(v3, 16); v3 ^= v2;
        v0 = (v0 + v3) & MASK64; v3 = ROTL(v3, 21); v3 ^= v0;
        v2 = (v2 + v1) & MASK64; v1 = ROTL(v1, 17); v1 ^= v2; v2 = ROTL(v2, 32);
    };

    // Process 8-byte blocks.
    let i = 0;
    const len = msg.length;
    while (i + 8 <= len) {
        const m = readLE64(msg, i);
        v3 ^= m; round(); round(); v0 ^= m;
        i += 8;
    }

    // Final block with length in top byte (SipHash spec).
    let b = BigInt(len) << 56n;
    let shift = 0n;
    while (i < len) {
        b |= BigInt(msg[i++]) << shift;
        shift += 8n;
    }

    v3 ^= b; round(); round(); v0 ^= b;
    v2 ^= 0xffn;
    // 4 finalization rounds.
    round(); round(); round(); round();

    return (v0 ^ v1 ^ v2 ^ v3) & MASK64;
}

/**
 * 4-char short ID (20 bits) using keyed SipHash-2-4.
 * - `key` is any string; keep it constant to keep IDs stable.
 * - Accepts string or pre-encoded bytes to avoid double work.
 * - For ~100–1000 items, collision risk is tiny (space size ≈ 1,048,576).
 */
export function shortId4(
    input: string | Uint8Array,
    key = "short-id-v1"
): string {
    const { k0, k1 } = deriveKey128(key);
    const bytes = typeof input === "string" ? utf8Bytes(input) : input;
    const h = siphash24(bytes, k0, k1);               // 64-bit BigInt
    const top20 = Number((h >> 44n) & 0x0f_ffffn);    // take top 20 bits
    return crockfordBase32_20bits(top20);
}

/**
 * 64-bit SipHash digest as 16-char lowercase hex.
 * - `key` is any string; keep it stable for consistent hashes.
 * - Accepts string or pre-encoded bytes to avoid double work.
 */
export function sipHash64Hex(
    input: string | Uint8Array,
    key = "style-hash-v1"
): string {
    const { k0, k1 } = deriveKey128(key);
    const bytes = typeof input === "string" ? utf8Bytes(input) : input;
    const h = siphash24(bytes, k0, k1); // 64-bit BigInt
    // Convert to fixed-width 16-hex chars (lowercase)
    return h.toString(16).padStart(16, "0");
}
