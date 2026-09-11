/**
 * Encode observed command/cwd text before it enters Zone 2 or keeper material.
 * The original text stays readable; markup and C0 controls cannot close tags
 * or start a new instruction block.
 */
export function encodeHarnessObservationText(value: string): string {
  let encoded = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "<") {
      encoded += "\\x3c";
      continue;
    }
    if (char === ">") {
      encoded += "\\x3e";
      continue;
    }
    if (code === 127 || (code < 32 && char !== "\t")) {
      encoded += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    encoded += char;
  }
  return encoded;
}
