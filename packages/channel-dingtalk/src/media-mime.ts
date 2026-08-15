/**
 * Minimal raster-image MIME sniffing for media bytes downloaded from the
 * DingTalk download API.
 *
 * This is NOT a platform protocol: it is a local content-sniffing helper so
 * the Harness `saveImage()` seam receives a valid raster `ImageMediaType`
 * (the message-converter only commits an image when a raster MIME is known).
 * The official connector does the same thing (ext derives from the response
 * content-type); here we sniff magic bytes because the shared transport
 * returns raw bytes without headers.
 */

/** Raster MIME sniffed from the leading magic bytes, if recognized. */
export function sniffImageMime(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (data.byteLength < 8) return undefined;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  // GIF: 'GIF8'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif';
  // WebP: 'RIFF' .... 'WEBP'
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}
