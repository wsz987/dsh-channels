import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SILK_SAMPLE_RATE,
  SILK_ENCODE_TYPE,
  transcodeSilkVoice,
} from '../src/media/silk-transcode.js';

describe('transcodeSilkVoice', () => {
  it('passes non-SILK bytes through without loading a decoder', async () => {
    const raw = Buffer.from('mp3 bytes');
    let loads = 0;

    const result = await transcodeSilkVoice(raw, {
      encodeType: 7,
      loadModule: async () => {
        loads += 1;
        return {};
      },
    });

    expect(result).toEqual({ data: raw, mimeType: 'audio/silk', transcoded: false });
    expect(loads).toBe(0);
  });

  it('wraps decoded SILK PCM in a mono 16-bit WAV', async () => {
    let seenSampleRate: number | undefined;
    const result = await transcodeSilkVoice(Buffer.from('silk'), {
      encodeType: SILK_ENCODE_TYPE,
      sampleRate: 16_000,
      loadModule: async () => ({
        decode: async (_input: Buffer, sampleRate: number) => {
          seenSampleRate = sampleRate;
          return { data: new Uint8Array([1, 0, 2, 0]) };
        },
      }),
    });

    expect(seenSampleRate).toBe(16_000);
    expect(result.mimeType).toBe('audio/wav');
    expect(result.transcoded).toBe(true);
    expect(result.data.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(result.data.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(result.data.readUInt32LE(24)).toBe(16_000);
    expect(result.data.readUInt32LE(40)).toBe(4);
    expect([...result.data.subarray(44)]).toEqual([1, 0, 2, 0]);
  });

  it('uses the Weixin default sample rate when the wire value is invalid', async () => {
    let seenSampleRate: number | undefined;
    await transcodeSilkVoice(Buffer.from('silk'), {
      encodeType: SILK_ENCODE_TYPE,
      sampleRate: 0,
      loadModule: async () => ({
        decode: async (_input: Buffer, sampleRate: number) => {
          seenSampleRate = sampleRate;
          return { data: new Uint8Array() };
        },
      }),
    });

    expect(seenSampleRate).toBe(DEFAULT_SILK_SAMPLE_RATE);
  });

  it.each([
    ['the optional module is unavailable', async () => { throw new Error('module not found'); }],
    ['the module has no decoder', async () => ({})],
    ['the decoder rejects', async () => ({ decode: async () => { throw new Error('invalid silk'); } })],
  ])('returns the original SILK bytes when %s', async (_description, loadModule) => {
    const raw = Buffer.from('raw silk bytes');
    const result = await transcodeSilkVoice(raw, {
      encodeType: SILK_ENCODE_TYPE,
      loadModule,
    });

    expect(result).toEqual({ data: raw, mimeType: 'audio/silk', transcoded: false });
  });
});
