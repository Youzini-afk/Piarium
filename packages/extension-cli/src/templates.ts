export const INIT_TEMPLATES = ["surface", "shell", "editor", "view", "language", "debug", "test"] as const;
export type InitTemplate = (typeof INIT_TEMPLATES)[number];

export const isInitTemplate = (value: string): value is InitTemplate => (
  (INIT_TEMPLATES as readonly string[]).includes(value)
);

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const packageJson = (options: {
  extraDependencies?: Record<string, string>;
  extraEntrypoints?: Record<string, { source: string }>;
  extraPublishedFiles?: string[];
  id: string;
  name: string;
}): string => json({
  name: options.id,
  version: "0.1.0",
  private: false,
  type: "module",
  description: `${options.name} Piarium extension`,
  files: ["dist", ...(options.extraPublishedFiles ?? []), "piarium.extension.json"],
  scripts: {
    build: "piarium-extension build",
    check: "piarium-extension check",
    test: "piarium-extension test",
  },
  dependencies: {
    "@piarium/extension-contract": "0.2.0",
    "@piarium/extension-sdk": "0.2.0",
    ...options.extraDependencies,
  },
  devDependencies: {
    "@piarium/extension-cli": "0.2.0",
    typescript: "^5.9.0",
  },
  piarium: {
    build: {
      entrypoints: options.extraEntrypoints,
    },
  },
  engines: { node: ">=22.19.0" },
});

const tsconfig = (): string => json({
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src/**/*.ts"],
});

const readme = (options: { name: string; summary: string }): string => `# ${options.name}

${options.summary}

This package extends the Piarium Surface or Host. It is not a Pi package.

## Commands

\`\`\`sh
npx piarium-extension check
npx piarium-extension build
npx piarium-extension test
\`\`\`

Import \`@piarium/extension-sdk\` and \`@piarium/extension-contract\` only. Do not import Piarium's React product UI.
`;

const brokeredHostFiles = (options: {
  capability: string;
  description: string;
  hostSource: string;
  id: string;
  name: string;
  runtimeFiles?: Record<string, string>;
  summary: string;
}): Record<string, string> => ({
  "piarium.extension.json": json({
    $schema: "https://raw.githubusercontent.com/Youzini-afk/Piarium/main/packages/extension-contract/schema/piarium.extension.schema.json",
    schemaVersion: 1,
    id: options.id,
    version: "0.1.0",
    displayName: options.name,
    metadata: { description: options.description },
    engines: { piarium: "*" },
    capabilities: { host: [options.capability] },
    entrypoints: {
      host: { file: "dist/host.cjs", mode: "brokered", activation: ["workspace-match"] },
    },
  }),
  "package.json": packageJson({
    id: options.id,
    name: options.name,
    extraEntrypoints: { host: { source: "src/host.ts" } },
    ...(options.runtimeFiles ? { extraPublishedFiles: ["runtime"] } : {}),
  }),
  "tsconfig.json": tsconfig(),
  "src/host.ts": options.hostSource,
  ...options.runtimeFiles,
  "README.md": readme({
    name: options.name,
    summary: options.summary,
  }),
});

const languageServerRuntime = `const documents = new Map();
let buffer = Buffer.alloc(0);

const send = (message) => {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([
    Buffer.from(\`Content-Length: \${payload.length}\\r\\n\\r\\n\`, "utf8"),
    payload,
  ]));
};

const positionToOffset = (text, position) => {
  const lines = text.split("\\n");
  let offset = 0;
  for (let line = 0; line < Math.min(position?.line ?? 0, lines.length - 1); line += 1) {
    offset += lines[line].length + 1;
  }
  return Math.min(offset + Math.max(0, position?.character ?? 0), text.length);
};

const applyChanges = (content, changes) => {
  let next = content;
  for (const change of changes) {
    if (!change.range) {
      next = change.text ?? next;
      continue;
    }
    const from = positionToOffset(next, change.range.start);
    const to = positionToOffset(next, change.range.end);
    next = \`\${next.slice(0, from)}\${change.text ?? ""}\${next.slice(to)}\`;
  }
  return next;
};

const respond = (id, result) => send({ jsonrpc: "2.0", id, result });

const handle = async (message) => {
  if (message.method === "initialize" && message.id !== undefined) {
    respond(message.id, { capabilities: { hoverProvider: true, textDocumentSync: 2 } });
    return;
  }
  if (message.method === "shutdown" && message.id !== undefined) {
    respond(message.id, null);
    return;
  }
  if (message.method === "textDocument/hover" && message.id !== undefined) {
    respond(message.id, { contents: { kind: "markdown", value: "Piarium language provider" } });
    return;
  }
  if (message.method === "textDocument/didOpen") {
    documents.set(message.params?.textDocument?.uri, message.params?.textDocument?.text ?? "");
    return;
  }
  if (message.method === "textDocument/didChange") {
    const uri = message.params?.textDocument?.uri;
    documents.set(uri, applyChanges(documents.get(uri) ?? "", message.params?.contentChanges ?? []));
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) respond(message.id, null);
};

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"));
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    void handle(JSON.parse(body));
  }
});
`;

const debugAdapterRuntime = `let buffer = Buffer.alloc(0);
let nextSeq = 1;
let program = "";
let breakpoints = [];

const send = (message) => {
  const payload = Buffer.from(JSON.stringify({ seq: nextSeq++, ...message }), "utf8");
  process.stdout.write(Buffer.concat([
    Buffer.from(\`Content-Length: \${payload.length}\\r\\n\\r\\n\`, "utf8"),
    payload,
  ]));
};
const event = (name, body = {}) => send({ type: "event", event: name, body });
const respond = (request, body = {}) => send({
  type: "response",
  request_seq: request.seq,
  success: true,
  command: request.command,
  body,
});

const handle = (request) => {
  const args = request.arguments ?? {};
  if (request.command === "initialize") {
    respond(request, { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true });
    event("initialized");
    return;
  }
  if (request.command === "launch") { program = args.program ?? ""; respond(request); return; }
  if (request.command === "setBreakpoints") {
    breakpoints = (args.breakpoints ?? []).map(({ line }) => ({ line, verified: true }));
    respond(request, { breakpoints });
    return;
  }
  if (request.command === "configurationDone") {
    respond(request);
    event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
    return;
  }
  if (request.command === "threads") { respond(request, { threads: [{ id: 1, name: "main" }] }); return; }
  if (request.command === "stackTrace") {
    respond(request, { stackFrames: [{ id: 1, name: "main", line: breakpoints[0]?.line ?? 1, column: 1, source: { path: program } }], totalFrames: 1 });
    return;
  }
  if (request.command === "scopes") { respond(request, { scopes: [{ name: "Locals", variablesReference: 1, expensive: false }] }); return; }
  if (request.command === "variables") { respond(request, { variables: [] }); return; }
  if (request.command === "evaluate") { respond(request, { result: String(args.expression ?? "undefined"), variablesReference: 0 }); return; }
  if (["continue", "next", "stepIn", "stepOut"].includes(request.command)) {
    respond(request, { allThreadsContinued: true });
    event("terminated");
    return;
  }
  if (request.command === "pause") { respond(request); event("stopped", { reason: "pause", threadId: 1, allThreadsStopped: true }); return; }
  if (request.command === "disconnect" || request.command === "terminate") {
    respond(request);
    setImmediate(() => process.exit(0));
    return;
  }
  respond(request);
};

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"));
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
`;

export const createInitFiles = (options: {
  id: string;
  name: string;
  template: InitTemplate;
}): Record<string, string> => {
  const surfaceEntrypointId = `${options.id}.surface`;
  if (options.template === "language") {
    return brokeredHostFiles({
      id: options.id,
      name: options.name,
      capability: "workspace.language",
      description: `${options.name} language provider`,
      hostSource: `import { defineLanguageProvider } from "@piarium/extension-sdk";\n\nexport default defineLanguageProvider((context) => ({\n  providerId: ${JSON.stringify(`${options.id}.markdown`)},\n  command: process.execPath,\n  args: [context.assets.path("runtime/language-server.mjs")],\n  languageIds: ["markdown"],\n}));\n`,
      runtimeFiles: { "runtime/language-server.mjs": languageServerRuntime },
      summary: "A brokered Host language provider. The Application Host spawns the server; this extension never starts a debugger or language process in the renderer.",
    });
  }
  if (options.template === "debug") {
    return brokeredHostFiles({
      id: options.id,
      name: options.name,
      capability: "workspace.debug",
      description: `${options.name} debug adapter`,
      hostSource: `import { defineDebugAdapter } from "@piarium/extension-sdk";\n\nexport default defineDebugAdapter((context) => ({\n  adapterId: ${JSON.stringify(`${options.id}.node`)},\n  command: process.execPath,\n  args: [context.assets.path("runtime/debug-adapter.mjs")],\n  languageIds: ["javascript"],\n}));\n`,
      runtimeFiles: { "runtime/debug-adapter.mjs": debugAdapterRuntime },
      summary: "A brokered Host debug adapter. The Application Host spawns the DAP process; this extension never starts a debugger in the renderer.",
    });
  }
  if (options.template === "test") {
    return brokeredHostFiles({
      id: options.id,
      name: options.name,
      capability: "workspace.test",
      description: `${options.name} test provider`,
      hostSource: `import { defineTestProvider } from "@piarium/extension-sdk";\n\nexport default defineTestProvider({\n  providerId: ${JSON.stringify(`${options.id}.node-test`)},\n  kind: "node-test",\n});\n`,
      summary: "A brokered Host test provider. The Application Host spawns the test adapter; this extension never starts a test runner in the renderer.",
    });
  }

  const contribution = options.template === "shell"
    ? {
      id: `${options.id}.shell`,
      kind: "shell",
      data: {
        contract: "piarium-workbench-shell/v1",
        seams: {
          desktop: { replacementTargets: [], slots: [] },
          web: { replacementTargets: [], slots: [] },
        },
      },
      replacement: { target: "workbench.shell" },
      title: options.name,
    }
    : options.template === "editor"
      ? {
        id: `${options.id}.editor`,
        kind: "editor",
        placement: { slot: "workbench.editor.actions" },
        title: options.name,
      }
      : options.template === "view"
        ? {
          id: `${options.id}.view`,
          kind: "view",
          placement: { slot: "workbench.primary-sidebar.views", order: 40 },
          title: options.name,
        }
        : {
          id: `${options.id}.surface.page`,
          kind: "page",
          title: options.name,
        };

  const source = options.template === "shell"
    ? `import { defineShellMount, defineSurfaceExtension, type PiariumManagedSurfaceContext } from "@piarium/extension-sdk";\nimport { PIARIUM_WORKBENCH_REPLACEMENT_TARGETS, PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT } from "@piarium/extension-contract";\n\nexport default defineSurfaceExtension((context: PiariumManagedSurfaceContext) => {\n  context.contribute({\n    id: ${JSON.stringify(contribution.id)},\n    kind: "shell",\n    contractVersion: 1,\n    data: {\n      contract: PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT,\n      seams: {\n        desktop: { replacementTargets: [], slots: [] },\n        web: { replacementTargets: [], slots: [] },\n      },\n    },\n    supports: ["desktop", "web"],\n    title: ${JSON.stringify(options.name)},\n    replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },\n  }, defineShellMount((container) => {\n    container.replaceChildren();\n    const root = container.ownerDocument.createElement("main");\n    root.textContent = ${JSON.stringify(options.name)};\n    container.append(root);\n    return () => { container.replaceChildren(); };\n  }));\n});\n`
    : options.template === "editor"
      ? `import { defineEditorMount, defineSurfaceExtension, type PiariumManagedSurfaceContext } from "@piarium/extension-sdk";\n\nexport default defineSurfaceExtension((context: PiariumManagedSurfaceContext) => {\n  context.contribute({\n    id: ${JSON.stringify(contribution.id)},\n    kind: "editor",\n    contractVersion: 1,\n    data: { languageIds: ["markdown"], priority: 60 },\n    supports: ["desktop", "web"],\n    title: ${JSON.stringify(options.name)},\n  }, defineEditorMount((container, mount) => {\n    const textarea = container.ownerDocument.createElement("textarea");\n    textarea.setAttribute("aria-label", ${JSON.stringify(options.name)});\n    textarea.style.cssText = "width:100%;height:100%;resize:none;border:0;padding:12px;background:transparent;color:inherit;font:inherit";\n    const render = () => {\n      const snapshot = mount.props.document.getSnapshot();\n      if (textarea.value !== snapshot.content) textarea.value = snapshot.content;\n      textarea.readOnly = snapshot.status !== "ready";\n    };\n    const onInput = () => {\n      const snapshot = mount.props.document.getSnapshot();\n      const next = textarea.value;\n      let from = 0;\n      while (from < snapshot.content.length && from < next.length && snapshot.content[from] === next[from]) from += 1;\n      let previousTo = snapshot.content.length;\n      let nextTo = next.length;\n      while (previousTo > from && nextTo > from && snapshot.content[previousTo - 1] === next[nextTo - 1]) {\n        previousTo -= 1;\n        nextTo -= 1;\n      }\n      void mount.props.document.applyEdits([{ from, to: previousTo, insert: next.slice(from, nextTo) }], snapshot.documentVersion).then((result) => {\n        if (mount.signal.aborted) return;\n        switch (result.status) {\n          case "applied":\n            delete textarea.dataset.piariumEditStatus;\n            return;\n          case "stale":\n          case "conflict":\n          case "invalid-range":\n          case "overlapping-ranges":\n          case "unsupported":\n            textarea.dataset.piariumEditStatus = result.status;\n            render();\n            return;\n        }\n      });\n    };\n    const onKeyDown = (event: KeyboardEvent) => {\n      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;\n      event.preventDefault();\n      const version = mount.props.document.getSnapshot().documentVersion;\n      void mount.props.document.save(version).then((result) => {\n        if (mount.signal.aborted) return;\n        if (result.status !== "updated") textarea.dataset.piariumEditStatus = result.status;\n        render();\n      });\n    };\n    textarea.addEventListener("input", onInput);\n    textarea.addEventListener("keydown", onKeyDown);\n    const unsubscribe = mount.props.document.subscribe(render);\n    container.replaceChildren(textarea);\n    render();\n    return () => {\n      unsubscribe();\n      textarea.removeEventListener("input", onInput);\n      textarea.removeEventListener("keydown", onKeyDown);\n      container.replaceChildren();\n    };\n  }));\n});\n`
      : options.template === "view"
        ? `import { defineViewMount, defineSurfaceExtension, type PiariumManagedSurfaceContext } from "@piarium/extension-sdk";\nimport { PIARIUM_WORKBENCH_SLOTS } from "@piarium/extension-contract";\n\nexport default defineSurfaceExtension((context: PiariumManagedSurfaceContext) => {\n  context.contribute({\n    id: ${JSON.stringify(contribution.id)},\n    kind: "view",\n    contractVersion: 1,\n    data: {},\n    supports: ["desktop", "web"],\n    title: ${JSON.stringify(options.name)},\n    placement: { slot: PIARIUM_WORKBENCH_SLOTS.primarySidebarViews, order: 40 },\n  }, defineViewMount((container) => {\n    container.textContent = ${JSON.stringify(options.name)};\n    return () => { container.replaceChildren(); };\n  }));\n});\n`
        : `import type { PiariumExtensionStaticContribution } from "@piarium/extension-contract";\nimport { defineSurfaceExtension, type PiariumManagedSurfaceContext } from "@piarium/extension-sdk";\n\nconst contribution: PiariumExtensionStaticContribution = {\n  id: ${JSON.stringify(contribution.id)},\n  kind: "page",\n  contractVersion: 1,\n  data: {},\n  supports: ["desktop", "mobile", "vscode", "web"],\n  title: ${JSON.stringify(options.name)},\n};\n\nexport default defineSurfaceExtension((context: PiariumManagedSurfaceContext) => {\n  context.contribute(contribution, {\n    render: () => undefined,\n  });\n});\n`;

  return {
    "piarium.extension.json": json({
      $schema: "https://raw.githubusercontent.com/Youzini-afk/Piarium/main/packages/extension-contract/schema/piarium.extension.schema.json",
      schemaVersion: 1,
      id: options.id,
      version: "0.1.0",
      displayName: options.name,
      metadata: { description: `${options.name} Piarium extension` },
      engines: { piarium: "*" },
      entrypoints: {
        surfaces: [{
          id: surfaceEntrypointId,
          file: "dist/surface.cjs",
          mode: "managed",
          supports: options.template === "surface" ? ["desktop", "mobile", "vscode", "web"] : ["desktop", "web"],
        }],
      },
    }),
    "package.json": packageJson({
      id: options.id,
      name: options.name,
      extraEntrypoints: { [surfaceEntrypointId]: { source: "src/surface.ts" } },
    }),
    "tsconfig.json": tsconfig(),
    "src/surface.ts": source,
    "README.md": readme({
      name: options.name,
      summary: options.template === "shell"
        ? "A framework-neutral Shell replacement. Core still owns documents, terminals, and sessions; this package only draws the workbench chrome."
        : options.template === "editor"
          ? "A custom resource editor contribution. Document buffers stay in Piarium DocumentsAPI."
          : options.template === "view"
            ? "A sidebar view contribution placed through a public workbench slot."
            : "A managed Surface extension for Piarium.",
    }),
  };
};
