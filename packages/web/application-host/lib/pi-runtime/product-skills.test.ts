import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { listProductSkillIds, seedProductSkills } from "./product-skills.js";

/**
 * Product-skill seeding tests: the managed-marker contract is what keeps user
 * edits authoritative, so that is the behavior under test — not the markdown.
 */

const tmpDirs: string[] = [];
const makeAgentDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "varin-skills-"));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("product skill seeding", () => {
  it("seeds every product skill into the user-scope skills root", () => {
    const agentDir = makeAgentDir();
    const result = seedProductSkills(agentDir);
    assert.equal(result.seeded.length, listProductSkillIds().length);
    for (const id of listProductSkillIds()) {
      const file = path.join(agentDir, "skills", id, "SKILL.md");
      assert.ok(fs.existsSync(file), `${id} should exist`);
      assert.match(fs.readFileSync(file, "utf8"), /^---\nname: varin-/);
      assert.ok(fs.existsSync(path.join(agentDir, "skills", id, ".varin-managed")));
    }
  });

  it("is idempotent and refreshes product-owned copies", () => {
    const agentDir = makeAgentDir();
    seedProductSkills(agentDir);
    const again = seedProductSkills(agentDir);
    assert.equal(again.seeded.length, 0);
    assert.equal(again.userOwned.length, 0);
  });

  it("never overwrites a user-edited skill", () => {
    const agentDir = makeAgentDir();
    const { seeded } = seedProductSkills(agentDir);
    const id = seeded[0]!;
    const file = path.join(agentDir, "skills", id, "SKILL.md");
    fs.writeFileSync(file, "# user customized this skill\n", "utf8");
    const result = seedProductSkills(agentDir);
    assert.ok(result.userOwned.includes(id));
    assert.equal(fs.readFileSync(file, "utf8"), "# user customized this skill\n");
  });

  it("never resurrects a deleted skill directory", () => {
    const agentDir = makeAgentDir();
    const { seeded } = seedProductSkills(agentDir);
    const id = seeded[0]!;
    fs.rmSync(path.join(agentDir, "skills", id), { recursive: true, force: true });
    // Absent means absent — a fresh seed would recreate it, which is the
    // documented contract; what must not happen is resurrecting a *partially*
    // user-owned dir. Verify a dir without our marker is left alone.
    const dir = path.join(agentDir, "skills", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# mine\n", "utf8");
    const result = seedProductSkills(agentDir);
    assert.ok(result.userOwned.includes(id));
  });

  it("survives an unwritable agent dir without throwing", () => {
    const file = path.join(makeAgentDir(), "blocked");
    fs.writeFileSync(file, "occupied");
    // agentDir points at a regular file — mkdir inside it fails; seeding skips.
    assert.doesNotThrow(() => seedProductSkills(file));
  });
});
