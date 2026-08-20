export function OfficialDocsLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        flex: 'none',
        fontSize: 12,
        fontWeight: 400,
        letterSpacing: 0,
        color: 'var(--dsw-alias-label-primary-bluish)',
        textDecoration: 'none',
      }}
      data-testid="official-docs-link"
    >
      {label} ↗
    </a>
  );
}

export default OfficialDocsLink;
