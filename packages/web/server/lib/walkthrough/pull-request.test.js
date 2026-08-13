import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPullRequestDiff } from './pull-request.js';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+const added = true;
`;

describe('getPullRequestDiff', () => {
  let request;
  let getOctokitOrNull;
  let resolveGitHubRepoFromDirectory;
  let deps;

  beforeEach(() => {
    request = vi.fn().mockResolvedValue({ data: PATCH });
    getOctokitOrNull = vi.fn(() => ({ request }));
    // The resolver hands back a wrapper, not the repo. Reading `.owner` off the
    // wrapper made every repository look remote-less.
    resolveGitHubRepoFromDirectory = vi.fn().mockResolvedValue({
      repo: { owner: 'youzini-afk', repo: 'Piarium' },
      remoteUrl: 'git@github.com:Youzini-afk/Piarium.git',
    });
    deps = { getOctokitOrNull, resolveGitHubRepoFromDirectory };
  });

  it('requests the diff for the resolved repository', async () => {
    const result = await getPullRequestDiff('/repo', 2122, deps);

    expect(result.patch).toBe(PATCH);
    expect(result.meta).toEqual({ owner: 'youzini-afk', repo: 'Piarium', number: 2122 });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: 'youzini-afk',
      repo: 'Piarium',
      pull_number: 2122,
      headers: { accept: 'application/vnd.github.v3.diff' },
    });
  });

  it('reports a missing GitHub remote only when there really is none', async () => {
    resolveGitHubRepoFromDirectory.mockResolvedValue({ repo: null, remoteUrl: null });

    await expect(getPullRequestDiff('/repo', 2122, deps)).rejects.toMatchObject({
      code: 'no-github-remote',
      statusCode: 400,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('asks the user to connect GitHub before anything else', async () => {
    getOctokitOrNull.mockReturnValue(null);

    await expect(getPullRequestDiff('/repo', 2122, deps)).rejects.toMatchObject({
      code: 'github-not-connected',
      statusCode: 401,
    });
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
  });

  it('treats an empty diff as a missing pull request rather than an empty review', async () => {
    request.mockResolvedValue({ data: '   ' });

    await expect(getPullRequestDiff('/repo', 2122, deps)).rejects.toMatchObject({
      code: 'empty-diff',
      statusCode: 404,
    });
  });
});
