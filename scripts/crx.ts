/**
 * CRX3: the file Chrome installs, written and read here.
 *
 * A `.crx` is the extension's zip with a header in front of it:
 *
 *   "Cr24" | uint32 version (3) | uint32 header length | header | the zip
 *
 * and the header is a small protobuf (`CrxFileHeader`) carrying the publisher's
 * public key, a signature, and the 16-byte id the extension will have. The
 * signature is over
 *
 *   "CRX3 SignedData\0" | uint32 length of the signed header data | that data | the zip
 *
 * so it covers the archive byte for byte, which is what makes a crx a *signed*
 * archive rather than a zip with a name. The extension's id is the first 16 bytes
 * of the SHA-256 of the public key, one letter per nibble - the same id the
 * browser shows, and the same one an unpacked copy of the same key gets.
 *
 * Written by hand rather than with a packer dependency for the usual reason: it
 * is sixty lines, it is the build's job to be reproducible, and the format is
 * small enough to read. `tests/extension.test.ts` packs with Chromium's own
 * `--pack-extension` and verifies the result with the reader below, which is what
 * keeps this honest about a format no one here controls.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signWith,
  verify as verifyWith,
  type KeyObject,
} from 'node:crypto';
import fs from 'node:fs';

/** A private key, and where it came from (for the build's own log line). */
export interface SigningKey {
  privateKey: KeyObject;
  source: string;
  created: boolean;
}

/** What a packed crx is, plus the two facts about it worth printing. */
export interface PackedCrx {
  crx: Buffer;
  /** The extension id this key gives: the browser will show this one. */
  extensionId: string;
  /** The public half, base64 DER, as the manifest's `key` field wants it. */
  publicKey: string;
}

export interface CrxParts {
  version: number;
  header: Buffer;
  zip: Buffer;
  signedHeaderData: Buffer;
  publicKey: Buffer;
  signature: Buffer;
}

export interface VerifiedCrx {
  ok: boolean;
  extensionId: string;
  zip: Buffer;
  version: number;
}

/** One length-delimited protobuf field, as `fields` reads it back. */
interface ProtobufField {
  tag: number;
  wire: number;
  value: Buffer;
}

/** The letters an extension id is spelled with: one per nibble, `a` for zero. */
const ID_LETTERS = 'abcdefghijklmnop';

/** The signature context, NUL included: fifteen characters and a terminator. */
const CONTEXT = Buffer.from('CRX3 SignedData\u0000', 'binary');

/** A protobuf varint. */
function varint(value: number): Buffer {
  const bytes = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/** A length-delimited protobuf field: the wire type the whole header uses. */
function field(tag: number, value: Buffer): Buffer {
  return Buffer.concat([varint((tag << 3) | 2), varint(value.length), value]);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

/** Every field of a protobuf message, length-delimited ones being all we write. */
function fields(message: Buffer): ProtobufField[] {
  const found: ProtobufField[] = [];
  let at = 0;
  while (at < message.length) {
    const read = () => {
      let value = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = message[at++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      } while (byte & 0x80);
      return value;
    };
    const tag = read();
    const length = read();
    found.push({ tag: tag >> 3, wire: tag & 7, value: message.subarray(at, at + length) });
    at += length;
  }
  return found;
}

/** The extension id of a public key: 16 bytes of SHA-256, a letter per nibble. */
export function extensionId(publicKeyDer: Buffer): string {
  const digest = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
  let id = '';
  for (const byte of digest) id += ID_LETTERS[byte >> 4] + ID_LETTERS[byte & 0x0f];
  return id;
}

/**
 * The key to sign with.
 *
 * `where` is where the key should come from: a path to a PEM file (made if it is
 * not there yet, so that the *next* build has the same extension id), or the PEM
 * itself. With nothing named, a key is made for this build alone - which is fine
 * for looking at the artifact and wrong for giving it to anyone, because a new id
 * is a reader with no remembered positions (see `ext/src/lib/history.ts`).
 */
export function signingKey(where: string | null = null): SigningKey {
  const value = typeof where === 'string' && where.trim() !== '' ? where.trim() : null;
  if (value && value.includes('BEGIN')) {
    return { privateKey: createPrivateKey(value), source: 'the key it was given', created: false };
  }
  if (value) {
    if (fs.existsSync(value)) return { privateKey: createPrivateKey(fs.readFileSync(value, 'utf8')), source: value, created: false };
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(value, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    return { privateKey, source: `${value} (made now)`, created: true };
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, source: 'made for this build', created: false };
}

/**
 * Pack a zip as a signed crx. The zip is the archive as it will be installed:
 * the same bytes, which is what the signature is about.
 */
export function packCrx(zip: Buffer, privateKey: KeyObject): PackedCrx {
  const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const crxId = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId);
  const signature = signWith('sha256', Buffer.concat([CONTEXT, uint32(signedHeaderData.length), signedHeaderData, zip]), privateKey);
  const proof = Buffer.concat([field(1, publicKeyDer), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);
  return {
    crx: Buffer.concat([Buffer.from('Cr24'), uint32(3), uint32(header.length), header, zip]),
    extensionId: extensionId(publicKeyDer),
    publicKey: publicKeyDer.toString('base64'),
  };
}

/** The parts of a crx: its header, its archive, and what the header says. */
export function readCrx(buffer: Buffer): CrxParts {
  if (buffer.subarray(0, 4).toString('binary') !== 'Cr24') throw new Error('not a crx: no Cr24 magic');
  const version = buffer.readUInt32LE(4);
  const length = buffer.readUInt32LE(8);
  const header = buffer.subarray(12, 12 + length);
  const zip = buffer.subarray(12 + length);
  const proofs = fields(header).filter((item) => item.tag === 2);
  const signed = fields(header).find((item) => item.tag === 10000);
  const proof = proofs.length ? fields(proofs[0].value) : [];
  return {
    version,
    header,
    zip,
    signedHeaderData: signed?.value ?? Buffer.alloc(0),
    publicKey: proof[0]?.value ?? Buffer.alloc(0),
    signature: proof[1]?.value ?? Buffer.alloc(0),
  };
}

/**
 * Check a crx's signature, the way the browser does before installing it.
 *
 * Anything that can read the file can lie about it being right, so this
 * reconstructs the signed bytes from the file itself and hands them to OpenSSL:
 * a crx this accepts is a crx whose signature is over its own contents and its
 * own header, in Chrome's layout - which is the property that matters.
 */
export function verifyCrx(buffer: Buffer): VerifiedCrx {
  const crx = readCrx(buffer);
  const signed = Buffer.concat([CONTEXT, uint32(crx.signedHeaderData.length), crx.signedHeaderData, crx.zip]);
  const key = createPublicKey({ key: crx.publicKey, format: 'der', type: 'spki' });
  const ok = crx.version === 3 && crx.signature.length > 0 && verifyWith('sha256', signed, key, crx.signature);
  return { ok, extensionId: extensionId(crx.publicKey), zip: crx.zip, version: crx.version };
}
