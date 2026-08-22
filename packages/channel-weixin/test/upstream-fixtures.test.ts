/**
 * Tencent 2.4.6 raw protocol captures are deliberately separate from legacy
 * Channel Contract fixtures. This test locks the upstream wire corpus and its
 * sanitization boundary without pretending raw iLink payloads are mapped
 * events.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveFixturesDir } from '@wsz987/channel-testkit';
import { z } from 'zod';
import { buildSendMediaPayload } from '../src/media/send-media.js';
import {
  getUploadUrlRequestSchema,
  getUpdatesResponseSchema,
  qrStatusResponseSchema,
  sendMessageResponseSchema,
  sendMessageRequestSchema,
} from '../src/ilink/schema.js';

const ROOT = join(resolveFixturesDir(), 'upstream', 'weixin', '2.4.6');
const EXPECTED_FIXTURES = [
  'auth/binded-redirect.json',
  'auth/need-verify-code.json',
  'platform-errors/send-ret-nonzero.json',
  'platform-errors/stale-token--14.json',
  'raw-inbound/file.json',
  'raw-inbound/quoted-text.json',
  'raw-inbound/text.json',
  'raw-inbound/tool-call-result.json',
  'raw-inbound/tool-call-start.json',
  'raw-inbound/video.json',
  'raw-inbound/voice-silk.json',
  'upload-send-expected-shape/file.json',
  'upload-send-expected-shape/image.json',
  'upload-send-expected-shape/tool-progress.json',
  'upload-send-expected-shape/video.json',
].sort();

function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsonFiles(path);
    return entry.isFile() && entry.name.endsWith('.json') ? [path] : [];
  });
}

function parseFixture<T>(file: string, schema: z.ZodType<T>): T {
  const parsedJson: unknown = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(`fixture ${file} failed schema validation: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

describe('Tencent Weixin 2.4.6 upstream fixtures', () => {
  const metadataSchema = z.object({
    schemaVersion: z.literal(1),
    package: z.string(),
    version: z.string(),
    commit: z.string(),
    repository: z.string(),
    sourcePaths: z.array(z.string()),
    sanitization: z.object({
      containsLiveTraffic: z.boolean(),
      containsCredentials: z.boolean(),
      containsSignedUrls: z.boolean(),
      identifierConvention: z.string(),
    }),
    verification: z.object({
      outboundImageAesKeyEncoding: z.string(),
      manifestPin: z.string(),
    }),
  });
  const mediaFixtureSchema = z.object({
    getuploadurl: getUploadUrlRequestSchema,
    sendmessage: sendMessageRequestSchema,
  });
  const toolProgressFixtureSchema = z.object({
    toolCallStart: sendMessageRequestSchema,
    toolCallResult: sendMessageRequestSchema,
  });
  const metadata = parseFixture('source-metadata.json', metadataSchema);
  const fixtures = jsonFiles(ROOT)
    .filter((path) => !path.endsWith('source-metadata.json'))
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'))
    .sort();

  it('pins the source package and commit without claiming live verification', () => {
    expect(metadata).toMatchObject({
      package: '@tencent-weixin/openclaw-weixin',
      version: '2.4.6',
      commit: 'cef0bfc390393f716903e16d50408118047f87e0',
      repository: 'Tencent/openclaw-weixin',
    });
    expect(metadata.verification).toMatchObject({ manifestPin: 'not verified by these offline fixtures' });
  });

  it('contains the complete Phase 0 compatibility corpus', () => {
    expect(fixtures).toEqual(EXPECTED_FIXTURES);
  });

  it('contains valid JSON and no live URLs or credentials', () => {
    for (const file of ['source-metadata.json', ...fixtures]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch (error) {
        throw new Error(`invalid JSON fixture ${file}`, { cause: error });
      }
      const schema = file === 'source-metadata.json'
        ? metadataSchema
        : file.startsWith('auth/')
          ? qrStatusResponseSchema
          : file === 'platform-errors/send-ret-nonzero.json'
            ? sendMessageResponseSchema
            : file === 'platform-errors/stale-token--14.json' || file.startsWith('raw-inbound/')
              ? getUpdatesResponseSchema
              : file.endsWith('tool-progress.json')
                ? toolProgressFixtureSchema
                : mediaFixtureSchema;
      const validated = schema.safeParse(parsedJson);
      expect(validated.success, validated.success ? undefined : z.prettifyError(validated.error)).toBe(true);
      expect(text).not.toMatch(/https?:\/\//i);
      expect(text).not.toMatch(/\bBearer\s+/i);
      expect(text).not.toMatch(/(?:real|live)[-_ ]?(?:token|secret|credential)/i);
    }
  });

  it('keeps protocol source paths as metadata, not copied source content', () => {
    const sourcePaths = metadata.sourcePaths;
    expect(Array.isArray(sourcePaths)).toBe(true);
    expect(sourcePaths).toEqual([
      'src/api/types.ts',
      'src/cdn/upload.ts',
      'src/messaging/send.ts',
      'src/messaging/reply-progress-sender.ts',
    ]);
    expect(statSync(ROOT).isDirectory()).toBe(true);
  });

  it.each(['image', 'file', 'video'] as const)('matches the %s payload builder output', (kind) => {
    const fixture = parseFixture(`upload-send-expected-shape/${kind}.json`, mediaFixtureSchema);
    const expected = fixture.sendmessage;
    const expectedMessage = expected.msg!;
    const built = sendMessageRequestSchema.parse(buildSendMediaPayload({
      kind,
      to: expectedMessage.to_user_id!,
      media: expectedMessage.item_list![0]![`${kind}_item`].media,
      fileSize: fixture.getuploadurl.rawsize,
      fileSizeCiphertext: fixture.getuploadurl.filesize,
      fileName: expectedMessage.item_list![0]!.file_item?.file_name,
      contextToken: expectedMessage.context_token,
      runId: expectedMessage.run_id,
    }));
    built.msg!.client_id = expectedMessage.client_id;
    expect(built).toEqual(expected);
  });
});
