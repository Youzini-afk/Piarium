import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const schemaPath = path.join(root, 'kernel', 'protocol', 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const target = path.join(root, 'packages', 'web', 'application-host', 'lib', 'kernel', 'protocol.generated.ts');
const checkOnly = process.argv.includes('--check');
const methods = Object.keys(schema.methods).map((method) => `  | ${JSON.stringify(method)}`).join('\n');
const renderType = (type) => type === 'protocolVersion' ? 'typeof KERNEL_PROTOCOL_VERSION' : type;
const renderDto = (name, spec) => {
  const generic = spec.generic ? `<${spec.generic}>` : '';
  const extendsClause = spec.extends?.length ? ` extends ${spec.extends.join(', ')}` : '';
  const fields = Object.entries(spec.fields ?? {}).map(([field, descriptor]) => (
    `  ${field}${descriptor.optional ? '?' : ''}: ${renderType(descriptor.type)};`
  ));
  if (spec.index) fields.push(`  ${spec.index}`);
  return `export interface ${name}${generic}${extendsClause} {\n${fields.join('\n')}\n}`;
};
const generated = `/**
 * Generated from \`kernel/protocol/schema.json\`.
 * Do not hand-edit the wire shapes; run \`node scripts/generate-kernel-protocol.mjs\`.
 */

export const KERNEL_PROTOCOL_VERSION = ${schema.protocolVersion} as const;
export const KERNEL_PROTOCOL_SCHEMA = "piarium.kernel.v${schema.protocolVersion}" as const;

export type KernelMethod =
${methods};

${Object.entries(schema.dto ?? {}).map(([name, spec]) => renderDto(name, spec)).join('\n\n')}
`;
if (checkOnly) {
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (existing !== generated) {
    console.error(`Kernel protocol DTO is out of date: ${path.relative(root, target)}`);
    process.exit(1);
  }
  console.log(`Kernel protocol ${schema.protocolVersion} is up to date.`);
} else {
  fs.writeFileSync(target, generated);
  console.log(`Kernel protocol ${schema.protocolVersion} is generated at ${path.relative(root, target)}`);
}
