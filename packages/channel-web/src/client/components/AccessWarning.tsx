/**
 * Small inline danger warning banner (plan §39/§40: dmPolicy=open, or a group
 * senderPolicy=open) and informational warnings (readiness needs-owner /
 * missing-policy / invalid-policy). Uses the danger token family so it reads
 * as a warning, not a neutral hint.
 */
export interface AccessWarningProps {
  children: React.ReactNode;
  testId?: string;
}

export function AccessWarning({ children, testId }: AccessWarningProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-state-warn-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: '6px 10px',
      }}
      data-testid={testId}
    >
      <span aria-hidden="true" style={{ flex: 'none' }}>⚠</span>
      <span>{children}</span>
    </div>
  );
}

export default AccessWarning;
