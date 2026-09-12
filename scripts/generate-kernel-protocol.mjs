import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const schemaPath = path.join(root, 'kernel', 'protocol', 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const target = path.join(root, 'packages', 'web', 'application-host', 'lib', 'kernel', 'protocol.generated.ts');
const source = fs.readFileSync(target, 'utf8');
const methods = Object.keys(schema.methods).map((method) => `  | ${JSON.stringify(method)}`).join('\n');
const generated = source
  .replace(/KERNEL_PROTOCOL_VERSION = \d+ as const;/u, `KERNEL_PROTOCOL_VERSION = ${schema.protocolVersion} as const;`)
  .replace(/export type KernelMethod =[\s\S]*?;\n\nexport interface KernelRequest/u, `export type KernelMethod =\n${methods};\n\nexport interface KernelRequest`);
if (generated === source && !source.includes(`KERNEL_PROTOCOL_VERSION = ${schema.protocolVersion} as const`)) {
  throw new Error('Kernel protocol schema and generated DTO are out of sync');
}
fs.writeFileSync(target, generated);
console.log(`Kernel protocol ${schema.protocolVersion} is generated at ${path.relative(root, target)}`);
