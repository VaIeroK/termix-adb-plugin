import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";

/**
 * A self-signed certificate around the ADB RSA key. adbd never validates the
 * chain: it only compares the certificate's public key with the keys it has
 * paired, so the certificate just has to exist and carry that key. It mirrors
 * what AOSP's x509_generator.cpp produces (C=US, O=Android, CN=Adb, CA:TRUE).
 */

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  let length: Buffer;
  if (body.length < 0x80) length = Buffer.from([body.length]);
  else if (body.length < 0x100) length = Buffer.from([0x81, body.length]);
  else length = Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const set = (...parts: Buffer[]) => der(0x31, ...parts);
const octetString = (data: Buffer) => der(0x04, data);

function integer(value: Buffer): Buffer {
  let bytes = value;
  while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80)) {
    bytes = bytes.subarray(1);
  }
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
}

function oid(dotted: string): Buffer {
  const numbers = dotted.split(".").map(Number);
  const bytes = [numbers[0] * 40 + numbers[1]];
  for (const number of numbers.slice(2)) {
    const chunk = [number & 0x7f];
    let rest = number >> 7;
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return der(0x17, Buffer.from(text, "ascii"));
}

function generalizedTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text =
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return der(0x18, Buffer.from(text, "ascii"));
}

function time(date: Date): Buffer {
  return date.getUTCFullYear() < 2050 ? utcTime(date) : generalizedTime(date);
}

function nameEntry(typeOid: string, value: string): Buffer {
  const tag = typeOid === "2.5.4.6" ? 0x13 : 0x0c; // PrintableString / UTF8String
  return set(sequence(oid(typeOid), der(tag, Buffer.from(value, "utf8"))));
}

const SHA256_WITH_RSA = sequence(oid("1.2.840.113549.1.1.11"), der(0x05));

/** PEM certificate for the given PKCS#8 RSA private key. */
export function selfSignedCertificate(
  privateKeyPem: string,
  now: Date = new Date(),
): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const spki = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  // The subject key identifier is the SHA-1 of the key bits, inside the SPKI
  // as the last BIT STRING; for a 2048 bit RSA key that is the final 270 bytes.
  const keyBits = spki.subarray(spki.length - 270);
  const keyId = createHash("sha1").update(keyBits).digest();

  const name = sequence(
    nameEntry("2.5.4.6", "US"),
    nameEntry("2.5.4.10", "Android"),
    nameEntry("2.5.4.3", "Adb"),
  );
  const notAfter = new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000);

  const extensions = der(
    0xa3,
    sequence(
      sequence(
        oid("2.5.29.19"),
        der(0x01, Buffer.from([0xff])),
        octetString(sequence(der(0x01, Buffer.from([0xff])))),
      ),
      sequence(
        oid("2.5.29.15"),
        der(0x01, Buffer.from([0xff])),
        // digitalSignature, keyCertSign, cRLSign
        octetString(der(0x03, Buffer.from([0x01, 0x86]))),
      ),
      sequence(oid("2.5.29.14"), octetString(octetString(keyId))),
    ),
  );

  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(Buffer.from([1])),
    SHA256_WITH_RSA,
    name,
    sequence(time(now), time(notAfter)),
    name,
    spki,
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(
    tbs,
    SHA256_WITH_RSA,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const body = certificate
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}
