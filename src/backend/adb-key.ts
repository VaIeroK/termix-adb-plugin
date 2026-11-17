import { createPublicKey, generateKeyPairSync } from "node:crypto";

/**
 * The RSA key a Termix server proves itself to Android devices with. adbd
 * stores the public half in its own layout (Android's RSAPublicKey struct:
 * modulus length in words, -1/n[0] mod 2^32, the modulus and R^2 mod n as
 * little endian words, then the exponent), base64 encoded.
 */

const WORDS = 64; // 2048 bits
const WORD_MASK = 0xffffffffn;

export interface AdbKey {
  privateKeyPem: string;
  /** Base64 of the struct plus a trailing comment, ready to send in AUTH. */
  publicKey: string;
}

function toBigInt(base64url: string): bigint {
  const bytes = Buffer.from(base64url, "base64url");
  return BigInt(`0x${bytes.toString("hex") || "0"}`);
}

function writeWords(target: Buffer, offset: number, value: bigint) {
  let rest = value;
  for (let i = 0; i < WORDS; i += 1) {
    target.writeUInt32LE(Number(rest & WORD_MASK), offset + i * 4);
    rest >>= 32n;
  }
}

/** -1 / n0 mod 2^32 by Newton iteration; n0 must be odd. */
function negativeInverse(n0: bigint): bigint {
  let inverse = 1n;
  for (let i = 0; i < 5; i += 1) {
    inverse = (inverse * (2n - n0 * inverse)) & WORD_MASK;
  }
  return (WORD_MASK + 1n - inverse) & WORD_MASK;
}

export function encodeAdbPublicKey(
  modulus: bigint,
  exponent: bigint,
  comment = "termix@adb",
): string {
  const struct = Buffer.alloc(4 + 4 + WORDS * 4 * 2 + 4);
  struct.writeUInt32LE(WORDS, 0);
  struct.writeUInt32LE(Number(negativeInverse(modulus & WORD_MASK)), 4);
  writeWords(struct, 8, modulus);
  writeWords(struct, 8 + WORDS * 4, (1n << BigInt(WORDS * 64)) % modulus);
  struct.writeUInt32LE(Number(exponent), 8 + WORDS * 8);
  return `${struct.toString("base64")} ${comment}`;
}

export function adbPublicKeyFromPem(privateKeyPem: string): string {
  const jwk = createPublicKey(privateKeyPem).export({ format: "jwk" });
  if (!jwk.n || !jwk.e) throw new Error("Not an RSA key");
  const modulus = toBigInt(jwk.n);
  if (modulus.toString(2).length !== WORDS * 32) {
    throw new Error("The ADB key must be a 2048 bit RSA key");
  }
  return encodeAdbPublicKey(modulus, toBigInt(jwk.e));
}

export function generateAdbKey(): AdbKey {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: WORDS * 32,
    publicExponent: 65537,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    privateKeyPem: privateKey,
    publicKey: adbPublicKeyFromPem(privateKey),
  };
}

export function adbKeyFromPem(privateKeyPem: string): AdbKey {
  return { privateKeyPem, publicKey: adbPublicKeyFromPem(privateKeyPem) };
}
