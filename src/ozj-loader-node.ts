// src/ozj-loader.ts
//  Loads OZJ (JPEG in a container) and OZT → dataURL PNG

import sharp from 'sharp';
import { decodeTga } from '@lunapaint/tga-codec';

export async function convertOzjToBuffer(buf: ArrayBuffer): Promise<{ buffer: Buffer, width: number, height: number }> {
  const u8   = new Uint8Array(buf);
  const size = u8.length;

  /* ── 1️⃣  Search for JPEG marker (SOI = FF D8 FF) ─────────────── */
  let jpgStart = -1;
  for (let i = 20; i < Math.min(30, size - 2); i++) {
    if (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) {
      jpgStart = i;
      break;
    }
  }

  if (jpgStart !== -1) {                // ← we have a JPEG ⇒ OZJ
    return ozjToPng(buf, jpgStart);
  }

  /* ── 2️⃣  Try as OZT (RGBA 32 b) ──────────────────────── */
  const view = new DataView(buf);
  if (size < 22) throw new Error('File too small for OZT');

  // FIX: Offset 16 as in C# (HEADER_SIZE = 16)
  const nx    = view.getInt16(16, true);
  const ny    = view.getInt16(18, true);
  const depth = view.getUint8(20);

  const expectedSize = 22 + nx * ny * 4;
  const looksLikeOzt =
      nx > 0 && ny > 0 &&
      nx <= 1024 && ny <= 1024 &&
      depth === 32 &&
      expectedSize <= size;

  if (!looksLikeOzt) throw new Error('Unsupported OZ? file');

  return await oztToPng(buf, nx, ny);
}

/* ----------------------------------------------------------------
 *  OZJ  (JPEG + optional vertical flip)
 * -------------------------------------------------------------- */
async function ozjToPng(buf: ArrayBuffer, jpgStart: number): Promise<{ buffer: Buffer, width: number, height: number }> {
  const view = new DataView(buf);
  const isTopDownSort = view.getUint8(17) !== 0;
  const jpegBuf = buf.slice(jpgStart);

  try {
    const img = sharp(jpegBuf);
    // if (!isTopDownSort) {
    //   img = img.flip();
    // }
    const rawBuffer = await img.ensureAlpha().raw().toBuffer();
    const metadata = await img.metadata();
    return { buffer: rawBuffer, width: metadata.width!, height: metadata.height! };
  } catch (error) {
    console.error('OZJ decode error:', error);
    throw new Error(`Failed to decode JPEG: ${error}`);
  }
}

/* ----------------------------------------------------------------
 *  OZT  (raw BGRA, bottom-up) → PNG
 * -------------------------------------------------------------- */
async function oztToPng(buf: ArrayBuffer, nx: number, ny: number): Promise<{ buffer: Buffer, width: number, height: number }> {
  const src = new Uint8Array(buf);
  let offset = 22;                   // HEADER(16) + nx/ny/depth/u1(6)

  const rgba = new Uint8Array(nx * ny * 4);

  for (let y = 0; y < ny; y++) {
    const dstRowStart = y * nx * 4; // top-down
    for (let x = 0; x < nx; x++) {
      const b = src[offset++];          // B
      const g = src[offset++];          // G
      const r = src[offset++];          // R
      const a = src[offset++];          // A

      const i = dstRowStart + x * 4;
      rgba[i] = r;                   // R
      rgba[i + 1] = g;                   // G
      rgba[i + 2] = b;                   // B
      rgba[i + 3] = a;                   // A
    }
  }

  return { buffer: Buffer.from(rgba), width: nx, height: ny };
}

//----------------------------------------------------------
//  TGA → buffer
//----------------------------------------------------------
export async function convertTgaToBuffer(tgaBuffer: ArrayBuffer): Promise<{ buffer: Buffer, width: number, height: number }> {
  const tga = await decodeTga(new Uint8Array(tgaBuffer));
  const { width, height, data } = tga.image;

  return { buffer: Buffer.from(data), width, height };
}

export async function convertTgaToDataUrl(buf: ArrayBuffer): Promise<string> {
  const { buffer, width, height } = await convertTgaToBuffer(buf);
  const pngBuffer = await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return 'data:image/png;base64,' + pngBuffer.toString('base64');
}

export async function convertOzjToDataUrl(buf: ArrayBuffer): Promise<string> {
  const { buffer, width, height } = await convertOzjToBuffer(buf);
  const pngBuffer = await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return 'data:image/png;base64,' + pngBuffer.toString('base64');
}