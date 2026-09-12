/**
 * Types for `crx.mjs`, the crx packer the build and the tests share. The module
 * stays JavaScript so the build script can import it with no build step.
 */

/** A private key, and where it came from (for the build's own log line). */
export interface SigningKey {
  privateKey: import('node:crypto').KeyObject;
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

/**
 * The key to sign with: a path (made if it is not there yet, so that the next
 * build has the same extension id), the PEM itself, or nothing at all - in which
 * case a key is made for this build alone.
 */
export declare function signingKey(where?: string | null): SigningKey;

/** The extension id of a public key: 16 bytes of SHA-256, a letter per nibble. */
export declare function extensionId(publicKeyDer: Buffer): string;

/** Pack a zip as a signed crx. The zip is the archive as it will be installed. */
export declare function packCrx(zip: Buffer, privateKey: import('node:crypto').KeyObject): PackedCrx;

/** The parts of a crx: its header, its archive, and what the header says. */
export declare function readCrx(buffer: Buffer): CrxParts;

/** Check a crx's signature, the way the browser does before installing it. */
export declare function verifyCrx(buffer: Buffer): VerifiedCrx;
