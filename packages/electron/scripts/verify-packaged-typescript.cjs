const path = require('node:path');

const libraryEntry = process.argv[2];
if (!libraryEntry) throw new Error('Pass the packaged TypeScript library entry.');
const ts = require(path.resolve(libraryEntry));
const filename = path.join(path.dirname(path.resolve(libraryEntry)), 'varin-runtime-library-smoke.ts');
const source = [
  'const values: string[] = ["packaged"];',
  'const lengths = values.map((value) => value.toUpperCase().length);',
  'const result: Promise<number> = Promise.resolve(lengths[0]!);',
  'export { result };',
].join('\n');
const options = { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, types: [] };
const host = ts.createCompilerHost(options);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (file, languageVersion, ...rest) => path.resolve(file) === filename
  ? ts.createSourceFile(file, source, languageVersion, true)
  : getSourceFile(file, languageVersion, ...rest);
const program = ts.createProgram([filename], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  throw new Error(`Packaged TypeScript runtime libraries are incomplete: ${diagnostics.map((item) => (
    `TS${item.code}: ${ts.flattenDiagnosticMessageText(item.messageText, ' ')}`
  )).join('; ')}`);
}
console.log('[electron] verified Array, String and Promise with the packaged TypeScript standard library');
