import type { LlmFailure } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';

const PROVIDER_FAILURE_BODY_SCHEMA = z.object({
  message: z.string().trim().min(1),
});

/**
 * Project a Harness terminal failure into text that is safe to send through a
 * channel. This preserves the Harness rc.2 client behaviour: provider AUTH
 * diagnostics are not user-facing because they can contain credential data.
 */
export function displayChannelFailure(failure: LlmFailure): string {
  if (failure.code === 'AUTH') {
    return 'API key is invalid';
  }

  if (failure.code === 'QUOTA') {
    const providerMessage = providerFailureMessage(failure.message);
    if (providerMessage) return providerMessage;
  }

  return failure.message || 'Model request failed';
}

/**
 * Some provider errors arrive as a status prefix followed by a JSON body, for
 * example `429: {"type":"GoUsageLimitError","message":"..."}`. Prefer the
 * body message so channel users see the actionable provider explanation.
 */
function providerFailureMessage(text: string): string | undefined {
  const bodyStart = text.indexOf('{');
  if (bodyStart < 0) return undefined;

  try {
    const parsed = PROVIDER_FAILURE_BODY_SCHEMA.safeParse(
      JSON.parse(text.slice(bodyStart)),
    );
    return parsed.success ? parsed.data.message : undefined;
  } catch {
    return undefined;
  }
}

/** A distinct channel notice for a failed Harness turn. */
export function formatChannelTurnFailure(failure: LlmFailure): string {
  return `⚠️ 本轮运行失败\n\n${displayChannelFailure(failure)}`;
}
