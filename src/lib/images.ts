import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Dependency-free proof thumbnails.
 *
 * PNG is decoded and resized in-process with `node:zlib`; that is the format
 * most proof photos are converted to and it works on every host. JPEG and WebP
 * need a full codec, which we deliberately do not add as an npm dependency
 * (the security check blocks packages with install scripts). When an image
 * tool is already present on the host we use it, otherwise those uploads keep
 * their original as the thumbnail URL. Thumbnail generation is always best
 * effort: a broken image never fails the proof upload.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const THUMBNAIL_MAX = 256;
const MAX_INPUT_PIXELS = 20_000_000;

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Bounds-safe byte read (the project compiles with noUncheckedIndexedAccess). */
const at = (buffer: ArrayLike<number>, index: number): number => buffer[index] ?? 0;

export function imageKind(bytes: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = (at(CRC_TABLE, (c ^ byte) & 0xff) ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decodes an 8-bit non-interlaced PNG, box-downscales it and re-encodes it. */
export function pngThumbnail(input: Buffer, max = THUMBNAIL_MAX): Buffer | null {
  if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let palette = Buffer.alloc(0);
  let transparency = Buffer.alloc(0);

  for (let off = 8; off + 12 <= input.length;) {
    const length = input.readUInt32BE(off);
    const type = input.toString('ascii', off + 4, off + 8);
    if (off + 12 + length > input.length) return null;
    const data = input.subarray(off + 8, off + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = at(data, 8);
      colorType = at(data, 9);
      if (at(data, 10) !== 0 || at(data, 11) !== 0 || at(data, 12) !== 0) return null;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + length;
  }

  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (
    !channels ||
    !width ||
    !height ||
    bitDepth !== 8 ||
    width * height > MAX_INPUT_PIXELS ||
    !idat.length
  ) {
    return null;
  }

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (inflated.length < height * (stride + 1)) return null;

  const scanlines = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = at(inflated, pos++);
    for (let x = 0; x < stride; x++) {
      const raw = at(inflated, pos++);
      const a = x >= channels ? at(scanlines, y * stride + x - channels) : 0;
      const b = y > 0 ? at(scanlines, (y - 1) * stride + x) : 0;
      const c = x >= channels && y > 0 ? at(scanlines, (y - 1) * stride + x - channels) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + a;
          break;
        case 2:
          value = raw + b;
          break;
        case 3:
          value = raw + ((a + b) >> 1);
          break;
        case 4:
          value = raw + paeth(a, b, c);
          break;
        default:
          return null;
      }
      scanlines[y * stride + x] = value & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    switch (colorType) {
      case 0:
        r = g = b = at(scanlines, i);
        break;
      case 2:
        r = at(scanlines, i * 3);
        g = at(scanlines, i * 3 + 1);
        b = at(scanlines, i * 3 + 2);
        break;
      case 3: {
        const index = at(scanlines, i);
        if (index * 3 + 2 >= palette.length) return null;
        r = at(palette, index * 3);
        g = at(palette, index * 3 + 1);
        b = at(palette, index * 3 + 2);
        if (index < transparency.length) a = at(transparency, index);
        break;
      }
      case 4:
        r = g = b = at(scanlines, i * 2);
        a = at(scanlines, i * 2 + 1);
        break;
      case 6:
        r = at(scanlines, i * 4);
        g = at(scanlines, i * 4 + 1);
        b = at(scanlines, i * 4 + 2);
        a = at(scanlines, i * 4 + 3);
        break;
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }

  const scale = Math.min(1, max / width, max / height);
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const small = Buffer.alloc(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * height) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * width) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          r += at(rgba, i);
          g += at(rgba, i + 1);
          b += at(rgba, i + 2);
          a += at(rgba, i + 3);
          n++;
        }
      }
      const o = (ty * tw + tx) * 4;
      small[o] = Math.round(r / n);
      small[o + 1] = Math.round(g / n);
      small[o + 2] = Math.round(b / n);
      small[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(tw, th, small);
}

/** Uses a host image tool when one exists; returns null when it does not. */
async function toolThumbnail(
  input: Buffer,
  kind: 'jpeg' | 'webp',
  max: number,
): Promise<Buffer | null> {
  const dir = mkdtempSync(join(tmpdir(), 'aidline-thumb-'));
  try {
    const source = join(dir, `source.${kind === 'jpeg' ? 'jpg' : 'webp'}`);
    const target = join(dir, 'thumb.png');
    await writeFile(source, input);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        source,
        '-vf',
        `scale=${max}:${max}:force_original_aspect_ratio=decrease`,
        '-frames:v',
        '1',
        target,
      ],
      { timeout: 10_000 },
    );
    return await readFile(target);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Returns PNG thumbnail bytes for an image, or null when a thumbnail cannot be
 * produced (unsupported format, corrupt data or no available codec).
 */
export async function createThumbnail(bytes: Buffer, max = THUMBNAIL_MAX): Promise<Buffer | null> {
  const kind = imageKind(bytes);
  if (kind === 'png') return pngThumbnail(bytes, max);
  if (kind === 'jpeg' || kind === 'webp') return toolThumbnail(bytes, kind, max);
  return null;
}
