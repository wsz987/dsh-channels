/**
 * Low-key repository entry pinned at the bottom of the Channels panel.
 *
 * The label is the product name plus the installed bundle version (taken
 * from the host's update-check projection and omitted when that check is
 * unavailable). Three plain external links — repository, README docs and
 * the issue tracker — opened in a new tab with the same `target`/`rel`
 * convention as `OfficialDocsLink`. No new runtime dependency.
 */
export const REPOSITORY_URL = 'https://github.com/wsz987/dsh-channels';
export const REPOSITORY_README_URL = 'https://github.com/wsz987/dsh-channels#readme';
export const REPOSITORY_ISSUES_URL = 'https://github.com/wsz987/dsh-channels/issues';

const anchorStyle = {
  color: 'var(--dsw-alias-label-primary-bluish)',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
} as const;

export interface RepoFooterProps {
  t: (key: string) => string;
  /** Installed bundle version from the update-check DTO; omitted gracefully. */
  version?: string;
}

export function RepoFooter({ t, version }: RepoFooterProps) {
  const label = version ? `dsh-channels ${version}` : 'dsh-channels';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 10,
        paddingTop: 10,
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
      }}
      data-testid="repo-footer"
    >
      <span>{label}</span>
      <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" style={anchorStyle}>
        {t('repoFooterRepo')} ↗
      </a>
      <a href={REPOSITORY_README_URL} target="_blank" rel="noopener noreferrer" style={anchorStyle}>
        {t('repoFooterDocs')} ↗
      </a>
      <a href={REPOSITORY_ISSUES_URL} target="_blank" rel="noopener noreferrer" style={anchorStyle}>
        {t('repoFooterIssue')} ↗
      </a>
    </div>
  );
}

export default RepoFooter;
