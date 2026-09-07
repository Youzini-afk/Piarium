import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { languageIdForPath } from "../src/index.js";

describe("languageIdForPath", () => {
  it("maps the on-demand grammar extensions used by language distribution", () => {
    assert.equal(languageIdForPath("app.py"), "python");
    assert.equal(languageIdForPath("main.rs"), "rust");
    assert.equal(languageIdForPath("svc.go"), "go");
    assert.equal(languageIdForPath("Main.java"), "java");
    assert.equal(languageIdForPath("box.c"), "c");
    assert.equal(languageIdForPath("box.cpp"), "cpp");
    assert.equal(languageIdForPath("box.cc"), "cpp");
    assert.equal(languageIdForPath("Program.cs"), "csharp");
    assert.equal(languageIdForPath("Main.kt"), "kotlin");
    assert.equal(languageIdForPath("App.swift"), "swift");
    assert.equal(languageIdForPath("gem.rb"), "ruby");
    assert.equal(languageIdForPath("index.php"), "php");
    assert.equal(languageIdForPath("setup.sh"), "shellscript");
    assert.equal(languageIdForPath("Cargo.toml"), "toml");
    assert.equal(languageIdForPath("notes.md"), "markdown");
  });
});
