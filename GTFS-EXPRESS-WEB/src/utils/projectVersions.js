/** The last version whose zip the project keeps (the one "Reprendre" restores), or null. */
export const frozenVersionOf = (project) =>
  [...(project?.versions || [])].filter((v) => v?.zip?.sha256 && !v.zip.purged_at).sort((a, b) => (b.n ?? 0) - (a.n ?? 0))[0] || null;

/** Days the server keeps a project: the account's term once signed in, else the browser's. */
export const retentionDaysOf = (workspace, signedIn = false) => (signedIn && workspace?.account_retention_days ? workspace.account_retention_days : workspace?.retention_days ?? 30);
