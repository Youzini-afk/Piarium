/**
 * Normalize Windows drive letter to uppercase.
 *
 * VS Code's `workspaceFolders[0].uri.fsPath` returns lowercase drive letters (e.g. `d:\...`),
 * while Node processes can return uppercase paths (e.g. `D:\...`). Normalize
 * them so workspace and Pi session directory keys match.
 */
export const normalizeWindowsDriveLetter = (p: string): string =>
  p.replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ':');
