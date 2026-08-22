/**
 * Best-effort SILK voice decoding.
 *
 * `silk-wasm` is intentionally loaded at runtime: voice conversion must not
 * make the Weixin adapter unavailable when the optional codec is absent.
 */

export const SILK_ENCODE_TYPE = 6;
export const DEFAULT_SILK_SAMPLE_RATE = 24_000;

export interface SilkWasmDecodedAudio {
  data: Uint8Array;
  duration?: number;
}

export type SilkDecoder = (
  input: Buffer,
  sampleRate: number,
) => Promise<SilkWasmDecodedAudio> | SilkWasmDecodedAudio;

export type SilkModuleLoader = () => Promise<unknown>;

export interface SilkTranscodeOptions {
  /** iLink `voice_item.encode_type`; only `6` is SILK. */
  encodeType?: number;
  /** iLink's sample rate when available; invalid values use the iLink default. */
  sampleRate?: number;
  /** Test seam for the optional `silk-wasm` module. */
  loadModule?: SilkModuleLoader;
}

export interface SilkTranscodeResult {
  data: Buffer;
  mimeType: 'audio/silk' | 'audio/wav';
  /** True only when a WAV container was produced from decoded PCM. */
  transcoded: boolean;
}

type SilkWasmModule = { decode?: unknown };

/**
 * Decode a SILK iLink voice message where possible.
 *
 * The raw bytes are deliberately returned for every optional-codec failure,
 * including a missing module or an unexpected decoder result. This keeps
 * inbound voice media available to downstream consumers without turning a
 * codec gap into an ingress failure.
 */
export async function transcodeSilkVoice(
  input: Buffer,
  options: SilkTranscodeOptions = {},
): Promise<SilkTranscodeResult> {
  if (options.encodeType !== SILK_ENCODE_TYPE) return rawSilk(input);

  try {
    const module = await (options.loadModule ?? loadSilkWasm)();
    const decode = getDecoder(module);
    if (!decode) return rawSilk(input);

    const decoded = await decode(input, normalizeSampleRate(options.sampleRate));
    if (!isDecodedAudio(decoded)) return rawSilk(input);

    return {
      data: pcmS16LeToWav(decoded.data, normalizeSampleRate(options.sampleRate)),
      mimeType: 'audio/wav',
      transcoded: true,
    };
  } catch {
    return rawSilk(input);
  }
}

/** Load the optional decoder without making TypeScript resolve it at build time. */
function loadSilkWasm(): Promise<unknown> {
  const specifier = 'silk-wasm';
  return import(specifier);
}

function getDecoder(module: unknown): SilkDecoder | undefined {
  if (!isSilkWasmModule(module) || typeof module.decode !== 'function') return undefined;
  return module.decode as SilkDecoder;
}

function isSilkWasmModule(value: unknown): value is SilkWasmModule {
  return typeof value === 'object' && value !== null;
}

function isDecodedAudio(value: unknown): value is SilkWasmDecodedAudio {
  return typeof value === 'object'
    && value !== null
    && 'data' in value
    && value.data instanceof Uint8Array;
}

function normalizeSampleRate(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_SILK_SAMPLE_RATE;
}

function rawSilk(data: Buffer): SilkTranscodeResult {
  return { data, mimeType: 'audio/silk', transcoded: false };
}

/** Wrap mono signed 16-bit little-endian PCM in a WAV container. */
function pcmS16LeToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const pcmBytes = pcm.byteLength;
  if (pcmBytes > 0xffff_ffff - 36) {
    throw new Error('SILK PCM payload is too large for a WAV container');
  }

  const wav = Buffer.allocUnsafe(44 + pcmBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // 16-bit mono
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcmBytes, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(wav, 44);
  return wav;
}
