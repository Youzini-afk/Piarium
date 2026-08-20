import { isPathWithinRoot } from '../workspace/path-safety.js';

const SKIP_NAMES = new Set(['node_modules', '.git', 'dist', 'out', '.piarium', 'coverage']);
const TEST_FILE = /\.(test|spec)\.(cjs|js|mjs)$/;

export const walkWorkspaceTestFiles = async ({
  root,
  fsPromises,
  pathModule,
  maxDepth = 8,
}) => {
  const found = [];
  const visit = async (directory, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = pathModule.join(directory, entry.name);
      if (!isPathWithinRoot(full, root, pathModule)) continue;
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !TEST_FILE.test(entry.name)) continue;
      found.push(pathModule.relative(root, full).split(pathModule.sep).join('/'));
    }
  };
  await visit(root, 0);
  found.sort();
  return found;
};
