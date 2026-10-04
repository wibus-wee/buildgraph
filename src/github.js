export function repositoryPath(repository) {
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split('/')[1] === '.' ||
    repository.split('/')[1] === '..'
  ) {
    throw new Error('repository must be owner/name');
  }
  return `/repos/${repository}`;
}

export function positiveId(value, label) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${label} must be one positive integer`);
  return Number(value);
}

/** GitHub.com only. Never retry a POST whose delivery may already have succeeded. */
export function githubApi(token, fetcher = fetch) {
  if (!token) throw new Error('token is required for cross-run GitHub API access');
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetcher(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Response bodies can echo inputs; diagnostics deliberately exclude them.
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (HTTP ${response.status})`);
    if (response.status === 204) return null;
    return response.json();
  };
}
