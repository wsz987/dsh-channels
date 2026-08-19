/**
 * Shared section heading for the inline accordion areas (plan §8.1, §31).
 * Extracted so every expanded-channel section uses identical chrome instead of
 * four local copies (plan §38 Phase 7 cleanup).
 */
export function SectionHeading({ title }: { title: string }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.4,
        color: 'var(--dsw-alias-label-secondary)',
        marginBottom: 12,
      }}
    >
      {title}
    </div>
  );
}

export default SectionHeading;
