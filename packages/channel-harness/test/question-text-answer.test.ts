import { describe, expect, it } from 'vitest';
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types';
import { parseQuestionTextAnswer } from '../src/interactions/question-text-answer.ts';
import { packageManagerQuestion } from './question-test-utils.ts';

const multiQuestion: AskUserQuestionItem = {
  ...packageManagerQuestion,
  multiSelect: true,
};

describe('parseQuestionTextAnswer', () => {
  it('maps a numeric single-select answer to the option at that index', () => {
    expect(parseQuestionTextAnswer(packageManagerQuestion, '1')).toEqual({
      kind: 'selected',
      labels: ['npm (推荐)'],
    });
    expect(parseQuestionTextAnswer(packageManagerQuestion, '3')).toEqual({
      kind: 'selected',
      labels: ['yarn'],
    });
  });

  it('matches an exact option label', () => {
    expect(parseQuestionTextAnswer(packageManagerQuestion, 'pnpm')).toEqual({
      kind: 'selected',
      labels: ['pnpm'],
    });
  });

  it('treats unmatched non-empty text as a custom answer', () => {
    expect(parseQuestionTextAnswer(packageManagerQuestion, 'bun')).toEqual({
      kind: 'custom',
      text: 'bun',
    });
    expect(parseQuestionTextAnswer(packageManagerQuestion, '2 3')).toEqual({
      kind: 'custom',
      text: '2 3',
    });
  });

  it('returns skip for 跳过 and 跳过本题', () => {
    expect(parseQuestionTextAnswer(packageManagerQuestion, '跳过')).toEqual({ kind: 'skip' });
    expect(parseQuestionTextAnswer(packageManagerQuestion, '跳过本题')).toEqual({ kind: 'skip' });
  });

  it('returns invalid for empty input', () => {
    expect(parseQuestionTextAnswer(packageManagerQuestion, '')).toEqual({
      kind: 'invalid',
      reason: 'empty',
    });
    expect(parseQuestionTextAnswer(packageManagerQuestion, '   ')).toEqual({
      kind: 'invalid',
      reason: 'empty',
    });
  });

  it('parses a comma-separated multi-select answer', () => {
    expect(parseQuestionTextAnswer(multiQuestion, '1,3')).toEqual({
      kind: 'selected',
      labels: ['npm (推荐)', 'yarn'],
    });
  });

  it('parses a full-width comma multi-select answer', () => {
    expect(parseQuestionTextAnswer(multiQuestion, '1，3')).toEqual({
      kind: 'selected',
      labels: ['npm (推荐)', 'yarn'],
    });
  });

  it('parses a whitespace-separated multi-select answer', () => {
    expect(parseQuestionTextAnswer(multiQuestion, '1 3')).toEqual({
      kind: 'selected',
      labels: ['npm (推荐)', 'yarn'],
    });
  });

  it('dedupes repeated indices and keeps options order', () => {
    expect(parseQuestionTextAnswer(multiQuestion, '3,1,3')).toEqual({
      kind: 'selected',
      labels: ['npm (推荐)', 'yarn'],
    });
    expect(parseQuestionTextAnswer(multiQuestion, '3,2,1')).toEqual({
      kind: 'selected',
      labels: ['npm (推荐)', 'pnpm', 'yarn'],
    });
  });

  it('returns invalid option-out-of-range for out-of-range multi-select indices', () => {
    expect(parseQuestionTextAnswer(multiQuestion, '0')).toEqual({
      kind: 'invalid',
      reason: 'option-out-of-range',
    });
    expect(parseQuestionTextAnswer(multiQuestion, '9')).toEqual({
      kind: 'invalid',
      reason: 'option-out-of-range',
    });
    expect(parseQuestionTextAnswer(multiQuestion, '1,99')).toEqual({
      kind: 'invalid',
      reason: 'option-out-of-range',
    });
  });

  it('accepts a single exact label as a multi-select selection', () => {
    expect(parseQuestionTextAnswer(multiQuestion, 'pnpm')).toEqual({
      kind: 'selected',
      labels: ['pnpm'],
    });
  });

  it('treats unmatched ordinary multi-select text as custom', () => {
    expect(parseQuestionTextAnswer(multiQuestion, 'bun')).toEqual({
      kind: 'custom',
      text: 'bun',
    });
  });
});