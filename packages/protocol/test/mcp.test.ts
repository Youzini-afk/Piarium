import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parsePiMcpConfigCatalog,
  PiMcpConfigValidationError,
} from "../src/index.js";

const catalog = () => ({
  servers: [
    {
      disabled: false,
      name: "docs",
      sourceIds: ["user", "project"],
      transport: { kind: "http", url: "https://docs.example/mcp" },
    },
    {
      disabled: false,
      name: "discovered",
      sourceIds: [],
      transport: { kind: "inherited" },
    },
  ],
  sources: [
    {
      displayPath: "~/.config/mcp/mcp.json",
      id: "user",
      order: 0,
      scope: "user",
      serverNames: ["docs"],
      target: { format: "jsonc", path: ".config/mcp/mcp.json", root: "home" },
    },
    {
      displayPath: ".pi/mcp.json",
      id: "project",
      order: 1,
      scope: "project",
      serverNames: ["docs"],
      target: { format: "jsonc", path: ".pi/mcp.json", root: "project" },
    },
  ],
  version: 1,
});

describe("MCP config catalog protocol", () => {
  it("accepts effective servers without editable native provenance", () => {
    assert.deepEqual(parsePiMcpConfigCatalog(catalog()), catalog());
  });

  it("rejects credentials and inconsistent provenance at the protocol boundary", () => {
    assert.throws(
      () => parsePiMcpConfigCatalog({
        ...catalog(),
        servers: [{
          disabled: false,
          name: "docs",
          sourceIds: ["user"],
          transport: { kind: "http", url: "https://secret:password@docs.example/mcp" },
        }],
      }),
      (error: unknown) => error instanceof PiMcpConfigValidationError
        && /user information/.test(error.message),
    );
    assert.throws(
      () => parsePiMcpConfigCatalog({
        ...catalog(),
        servers: [{
          disabled: false,
          name: "docs",
          sourceIds: ["user"],
          transport: { kind: "http", url: "https://docs.example/mcp?token=secret" },
        }],
      }),
      (error: unknown) => error instanceof PiMcpConfigValidationError
        && /query or fragment/.test(error.message),
    );
    assert.throws(
      () => parsePiMcpConfigCatalog({
        ...catalog(),
        servers: [{
          disabled: false,
          name: "docs",
          sourceIds: ["user"],
          transport: { kind: "http", url: "file:///private/config" },
        }],
      }),
      (error: unknown) => error instanceof PiMcpConfigValidationError
        && /http or https/.test(error.message),
    );
    assert.throws(
      () => parsePiMcpConfigCatalog({
        ...catalog(),
        servers: [{
          disabled: false,
          name: "docs",
          sourceIds: ["user"],
          transport: { kind: "inherited" },
        }],
      }),
      /does not list contributing source project|project.*references unknown server/,
    );
  });

  it("projects documented fields and rejects duplicate identities", () => {
    const input = catalog() as ReturnType<typeof catalog> & { privateState?: string };
    input.privateState = "must-not-cross";
    (input.servers[0] as Record<string, unknown>).oauthToken = "must-not-cross";
    const parsed = parsePiMcpConfigCatalog(input);
    assert.equal("privateState" in parsed, false);
    assert.equal("oauthToken" in parsed.servers[0]!, false);

    const duplicate = catalog();
    duplicate.sources[1]!.id = duplicate.sources[0]!.id;
    assert.throws(() => parsePiMcpConfigCatalog(duplicate), /source ids must not contain duplicates/);
  });
});
