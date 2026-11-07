// WAV helpers: wrap Gemini's raw PCM in a playable WAV file, and read the length
// of an uploaded WAV from its header.

/** Sample rate from a mime type like "audio/L16;codec=pcm;rate=24000". */
export function sampleRateFromMime(mime: string, fallback: number): number {
  const m = mime.match(/rate=(\d+)/i);
  return m ? Number(m[1]) : fallback;
}

/** 16-bit little-endian PCM -> WAV (RIFF) file. */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export const isWav = (buf: Buffer) => buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';

/** Duration in seconds from a WAV header, or null if it can't be read. */
export function wavDurationSec(buf: Buffer): number | null {
  if (!isWav(buf)) return null;
  let byteRate: number | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= buf.length) byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      // Streaming recorders sometimes write 0 or 0xFFFFFFFF; fall back to the bytes present.
      const dataSize = size === 0 || size === 0xffffffff ? buf.length - offset - 8 : size;
      return dataSize / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}
