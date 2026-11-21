/**
 * Magic-byte signatures for the file types accepted as proof uploads.
 *
 * The multipart `Content-Type` is client-controlled, so it can lie: a renamed
 * executable could arrive as `image/png`. We check the first bytes of the file
 * against the declared type before anything is written to disk. The extension
 * a file is stored with still comes from `EXTENSIONS` in the proof route, never
 * from the uploaded filename.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from('%PDF-', 'latin1');

function startsWith(header: Buffer, magic: Buffer): boolean {
  return header.length >= magic.length && header.subarray(0, magic.length).equals(magic);
}

/** All the header bytes we ever need to read (WebP needs the most). */
export const HEADER_BYTES = 12;

/**
 * Returns the mimetype the header actually belongs to, or `null` when the
 * bytes do not match any accepted format. `header` only needs to hold the
 * first `HEADER_BYTES` bytes of the file.
 */
export function detectMimeType(header: Buffer): string | null {
  if (startsWith(header, JPEG)) return 'image/jpeg';
  if (startsWith(header, PNG)) return 'image/png';
  if (startsWith(header, PDF)) return 'application/pdf';

  // WebP is a RIFF container: 'RIFF' + 4-byte size + 'WEBP'. The size varies,
  // so compare the leading and trailing tags around it.
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString('latin1') === 'RIFF' &&
    header.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}
