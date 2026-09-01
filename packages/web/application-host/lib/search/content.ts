// @ts-nocheck
const CONTENT_SEARCH_EXCLUDED_GLOBS = [
  '!**/node_modules/**',
  '!**/.git/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/.next/**',
  '!**/.turbo/**',
  '!**/.cache/**',
  '!**/coverage/**',
];

const toResourceId = (root, absolutePath, pathModule) => {
  const relative = pathModule.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
    return null;
  }
  return relative.split(pathModule.sep).join('/');
};

const parseRipgrepMatch = (line, workspaceId, root, pathModule) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return null;
  }
  if (!payload || payload.type !== 'match' || !payload.data) return null;
  const absolutePath = typeof payload.data.path?.text === 'string' ? payload.data.path.text : '';
  if (!absolutePath) return null;
  const resourceId = toResourceId(root, absolutePath, pathModule);
  if (!resourceId) return null;
  const lineNumber = Number(payload.data.line_number);
  const lineText = typeof payload.data.lines?.text === 'string' ? payload.data.lines.text : '';
  const preview = lineText.replace(/\r?\n$/, '');
  const byteOffset = Array.isArray(payload.data.submatches) && payload.data.submatches[0]
    ? Number(payload.data.submatches[0].start)
    : 0;
  // ripgrep reports UTF-8 byte offsets while Monaco columns are UTF-16 code
  // units. Decode the matched line prefix so non-ASCII text lands on the exact
  // result instead of drifting right by its additional UTF-8 bytes.
  const column = Number.isFinite(byteOffset) && byteOffset > 0
    ? Buffer.from(lineText, 'utf8').subarray(0, byteOffset).toString('utf8').length + 1
    : 1;
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;
  return {
    resource: { workspaceId, resourceId },
    line: lineNumber,
    column: Number.isFinite(column) && column > 0 ? column : 1,
    preview,
  };
};

export const createWorkspaceContentSearch = ({
  documents,
  spawn,
  pathModule,
  env = process.env,
}) => {
  const searchContent = async (request, options = {}) => {
    const generation = options.generation;
    const signal = options.signal;
    const query = typeof request?.query === 'string' ? request.query : '';
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
    if (!workspaceId) {
      return { status: 'failure', generation, message: 'workspaceId is required' };
    }
    if (!query.trim()) {
      return { status: 'empty', generation };
    }
    if (signal?.aborted) {
      return { status: 'cancelled', generation };
    }

    let workspace;
    try {
      workspace = await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workspace search failed';
      return { status: 'failure', generation, message };
    }

    const maxResults = Number.isFinite(request?.maxResults) && request.maxResults > 0
      ? Math.floor(request.maxResults)
      : null;
    const args = [
      '--json',
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      ...CONTENT_SEARCH_EXCLUDED_GLOBS.flatMap((glob) => ['--glob', glob]),
    ];
    if (request?.includeHidden) args.push('--hidden');
    args.push('--', query.trim(), workspace.root);

    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn('rg', args, {
          cwd: workspace.root,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        const message = code === 'ENOENT'
          ? 'Workspace content search is unavailable because ripgrep is not installed on this host'
          : (error instanceof Error ? error.message : 'Failed to start content search');
        resolve({ status: 'failure', generation, message });
        return;
      }

      let settled = false;
      let stdoutBuffer = '';
      const hits = options.collect === false ? null : [];
      let hitCount = 0;
      const publish = (batch) => {
        if (batch.length === 0) return false;
        const remaining = maxResults === null ? batch.length : Math.max(0, maxResults - hitCount);
        const accepted = remaining >= batch.length ? batch : batch.slice(0, remaining);
        if (accepted.length === 0) return maxResults !== null && hitCount >= maxResults;
        hitCount += accepted.length;
        hits?.push(...accepted);
        const writable = options.onBatch?.(accepted);
        if (writable === false && typeof options.onDrain === 'function') {
          child.stdout.pause();
          void options.onDrain().then(() => {
            if (!settled && !signal?.aborted) child.stdout.resume();
          }).catch(onAbort);
        }
        return maxResults !== null && hitCount >= maxResults;
      };
      const ready = () => ({ status: 'ready', generation, hits: hits ?? [] });
      const finish = (result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => {
        try {
          child.kill();
        } catch {
          // Process may already have exited.
        }
        finish({ status: 'cancelled', generation });
      };

      child.on('error', (error) => {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        const message = code === 'ENOENT'
          ? 'Workspace content search is unavailable because ripgrep is not installed on this host'
          : (error instanceof Error ? error.message : 'Content search failed');
        finish({ status: 'failure', generation, message });
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        stdoutBuffer += chunk;
        const batch = [];
        let newline = stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          const hit = line ? parseRipgrepMatch(line, workspaceId, workspace.root, pathModule) : null;
          if (hit) batch.push(hit);
          newline = stdoutBuffer.indexOf('\n');
        }
        if (publish(batch)) {
          finish(ready());
          try {
            child.kill();
          } catch {
            // Process may have exited after emitting the final requested result.
          }
        }
      });
      child.stderr.on('data', () => {
        // Search diagnostics stay on the host. File bodies are not logged.
      });
      child.on('close', (code) => {
        if (settled) return;
        if (signal?.aborted) {
          finish({ status: 'cancelled', generation });
          return;
        }
        if (code !== 0 && code !== 1) {
          finish({ status: 'failure', generation, message: 'Content search failed' });
          return;
        }
        if (stdoutBuffer) {
          const hit = parseRipgrepMatch(stdoutBuffer, workspaceId, workspace.root, pathModule);
          if (hit) publish([hit]);
        }
        if (hitCount === 0) {
          finish({ status: 'empty', generation });
          return;
        }
        finish(ready());
      });

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };

  return { searchContent };
};
