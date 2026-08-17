import { describe, expect, it } from 'vitest';
import { mimeHintFromFilename, normalizeMimeHint } from '../src/media/mime-hint.js';

describe('cross-channel MIME hints', () => {
  it('normalizes parameterized content types and rejects generic binary hints', () => {
    expect(normalizeMimeHint(' Image/JPEG; charset=binary ')).toBe('image/jpeg');
    expect(normalizeMimeHint('application/octet-stream')).toBeUndefined();
    expect(normalizeMimeHint('binary/octet-stream')).toBeUndefined();
  });

  it('uses the maintained MIME database for filenames and platform paths', () => {
    expect(mimeHintFromFilename('photos/file_42.jpg')).toBe('image/jpeg');
    expect(mimeHintFromFilename('report.docx?download=1')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(mimeHintFromFilename('unknown.channel-asset')).toBeUndefined();
  });
});
