import { LANGUAGE_VERSION, Language, MIN_COMPATIBLE_VERSION, Parser } from "web-tree-sitter";

export const GRAMMAR_MIN_ABI = MIN_COMPATIBLE_VERSION;
export const GRAMMAR_MAX_ABI = LANGUAGE_VERSION;

export function createGrammarAbiInspector(
  locateRuntime: (scriptName: string) => string,
): (bytes: Uint8Array) => Promise<number> {
  let ready: Promise<void> | null = null;
  return async (bytes) => {
    if (!ready) {
      ready = Parser.init({
        locateFile: (scriptName: string) => locateRuntime(scriptName.endsWith(".wasm") ? scriptName : "web-tree-sitter.wasm"),
      });
    }
    await ready;
    const language = await Language.load(bytes);
    return language.abiVersion;
  };
}
