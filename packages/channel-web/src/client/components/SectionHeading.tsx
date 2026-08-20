/**
 * Shared section heading for the inline accordion areas (plan §8.1, §31).
 * Extracted so every expanded-channel section uses identical chrome instead of
 * four local copies (plan §38 Phase 7 cleanup).
 */
import type { ReactNode } from 'react';

export function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0,
        color: 'var(--dsw-alias-label-secondary)',
        marginBottom: 12,
      }}
    >
      <span>{title}</span>
      {action}
    </div>
  );
}

export default SectionHeading;
