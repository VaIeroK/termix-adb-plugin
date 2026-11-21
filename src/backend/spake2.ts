import { createHash, randomBytes } from "node:crypto";

/**
 * SPAKE2 over edwards25519 exactly as BoringSSL implements it
 * (crypto/curve25519/spake25519.cc), because that is what adbd pairs with.
 * Plain BigInt arithmetic: a pairing runs once per phone, so speed is
 * irrelevant and readable code wins.
 */

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

function mod(a: bigint, m = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function pow(base: bigint, exponent: bigint, m = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function inv(a: bigint): bigint {
  return pow(a, P - 2n);
}

/** Extended twisted Edwards coordinates. */
interface Point {
  x: bigint;
  y: bigint;
  z: bigint;
  t: bigint;
}

const IDENTITY: Point = { x: 0n, y: 1n, z: 1n, t: 0n };

function fromAffine(x: bigint, y: bigint): Point {
  return { x, y, z: 1n, t: mod(x * y) };
}

/** Unified addition, valid for every pair of points on the curve. */
function add(p: Point, q: Point): Point {
  const a = mod((p.y - p.x) * (q.y - q.x));
  const b = mod((p.y + p.x) * (q.y + q.x));
  const c = mod(2n * D * p.t * q.t);
  const d = mod(2n * p.z * q.z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return {
    x: mod(e * f),
    y: mod(g * h),
    z: mod(f * g),
    t: mod(e * h),
  };
}

function negate(p: Point): Point {
  return { x: mod(-p.x), y: p.y, z: p.z, t: mod(-p.t) };
}

/** scalar * point with the exact integer scalar (no reduction mod L). */
function multiply(point: Point, scalar: bigint): Point {
  let result = IDENTITY;
  let addend = point;
  let k = scalar;
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result;
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

function bigIntToLittleEndian(value: bigint, length: number): Buffer {
  const out = Buffer.alloc(length);
  let rest = value;
  for (let i = 0; i < length; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function encodePoint(point: Point): Buffer {
  const zInv = inv(point.z);
  const x = mod(point.x * zInv);
  const y = mod(point.y * zInv);
  const out = bigIntToLittleEndian(y, 32);
  if (x & 1n) out[31] |= 0x80;
  return out;
}

/** Returns null when the bytes are not a point on the curve. */
export function decodePoint(bytes: Uint8Array): Point | null {
  if (bytes.length !== 32) return null;
  const copy = Buffer.from(bytes);
  const sign = (copy[31] & 0x80) !== 0;
  copy[31] &= 0x7f;
  const y = littleEndianToBigInt(copy);
  if (y >= P) return null;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const check = mod(v * x * x);
  if (check !== mod(u)) {
    if (check !== mod(-u)) return null;
    x = mod(x * SQRT_M1);
  }
  if (x === 0n && sign) return null;
  if (Number(x & 1n) !== (sign ? 1 : 0)) x = mod(-x);
  return fromAffine(x, y);
}

const BASE = fromAffine(
  15112221349535400772501151409588531511454012693041857206046113283949847762202n,
  46316835694926478169428394003475163141307993866256225615783033603165251855960n,
);

// The two points the protocol masks with, as BoringSSL encodes them.
const POINT_N = decodeOrThrow(
  "10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778",
);
const POINT_M = decodeOrThrow(
  "5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e",
);

function decodeOrThrow(hex: string): Point {
  const point = decodePoint(Buffer.from(hex, "hex"));
  if (!point) throw new Error("Bad SPAKE2 constant");
  return point;
}

export type Spake2Role = "alice" | "bob";

export interface Spake2 {
  /** The 32 byte message to send to the peer. */
  message: Buffer;
  /** Combines the peer's message into the 64 byte shared key. */
  finish: (theirMessage: Buffer) => Buffer;
}

function lengthPrefixed(data: Uint8Array): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(data.length));
  return Buffer.concat([length, data]);
}

export interface Spake2Options {
  role: Spake2Role;
  myName: Buffer;
  theirName: Buffer;
  password: Buffer;
  /** Fixed ephemeral secret, for tests only. */
  entropy?: Buffer;
}

export function createSpake2(options: Spake2Options): Spake2 {
  const { role, myName, theirName, password } = options;
  const random = options.entropy ?? randomBytes(64);

  // The ephemeral scalar is a multiple of the cofactor so that it clears it.
  const privateScalar = (littleEndianToBigInt(random) % L) * 8n;
  const publicPoint = multiply(BASE, privateScalar);

  const passwordHash = createHash("sha512").update(password).digest();
  let passwordScalar = littleEndianToBigInt(passwordHash) % L;
  // BoringSSL adds multiples of the group order until the low three bits are
  // clear; that puts the mask in the prime order subgroup.
  let order = L;
  for (let bit = 1n; bit <= 4n; bit <<= 1n) {
    if (passwordScalar & bit) passwordScalar += order;
    order *= 2n;
  }

  const mine = role === "alice" ? POINT_M : POINT_N;
  const theirs = role === "alice" ? POINT_N : POINT_M;
  const message = encodePoint(add(publicPoint, multiply(mine, passwordScalar)));

  return {
    message,
    finish(theirMessage) {
      const theirPoint = decodePoint(theirMessage);
      if (!theirPoint) throw new Error("Bad SPAKE2 message");
      const unmasked = add(
        theirPoint,
        negate(multiply(theirs, passwordScalar)),
      );
      const shared = encodePoint(multiply(unmasked, privateScalar));
      const hash = createHash("sha512");
      const [first, second] =
        role === "alice"
          ? [
              [myName, theirName],
              [message, theirMessage],
            ]
          : [
              [theirName, myName],
              [theirMessage, message],
            ];
      for (const part of [...first, ...second]) {
        hash.update(lengthPrefixed(part));
      }
      hash.update(lengthPrefixed(shared));
      hash.update(lengthPrefixed(passwordHash));
      return hash.digest();
    },
  };
}

export { BASE as BASE_POINT, L as GROUP_ORDER };
