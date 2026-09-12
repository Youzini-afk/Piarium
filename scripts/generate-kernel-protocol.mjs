import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const schemaPath = path.join(root, 'kernel', 'protocol', 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const target = path.join(root, 'packages', 'web', 'application-host', 'lib', 'kernel', 'protocol.generated.ts');
const checkOnly = process.argv.includes('--check');
const methods = Object.keys(schema.methods).map((method) => `  | ${JSON.stringify(method)}`).join('\n');
const methodParams = schema.methodParams ?? {};
const renderType = (type) => type === 'protocolVersion' ? 'typeof KERNEL_PROTOCOL_VERSION' : type;
const renderDto = (name, spec) => {
  if (spec.raw) return spec.raw;
  const generic = spec.generic ? `<${spec.generic}>` : '';
  const extendsClause = spec.extends?.length ? ` extends ${spec.extends.join(', ')}` : '';
  const fields = Object.entries(spec.fields ?? {}).map(([field, descriptor]) => (
    `  ${field}${descriptor.optional ? '?' : ''}: ${renderType(descriptor.type)};`
  ));
  if (spec.index) fields.push(`  ${spec.index}`);
  return `export interface ${name}${generic}${extendsClause} {\n${fields.join('\n')}\n}`;
};
const renderRequestUnion = () => {
  const requests = Object.entries(methodParams).map(([method, paramsType]) => `  | {\n      v: typeof KERNEL_PROTOCOL_VERSION;\n      kind: "request";\n      id: string;\n      method: ${JSON.stringify(method)};\n      params: ${paramsType};\n      epoch?: string;\n      grantId?: string;\n    }`);
  requests.push(`  | { v: typeof KERNEL_PROTOCOL_VERSION; kind: "cancel"; id: string; epoch?: string; grantId?: string; }`);
  requests.push(`  | { v: typeof KERNEL_PROTOCOL_VERSION; kind: "data"; id: string; streamId: string; sequence: number; bytesBase64: string; epoch: string; grantId: string; }`);
  return `export type KernelRequest =\n${requests.join('\n')};`;
};
const renderMethodParams = () => `export type KernelMethodParams = {\n${Object.entries(methodParams).map(([method, paramsType]) => `  ${JSON.stringify(method)}: ${paramsType};`).join('\n')}\n};`;
const dtoEntries = Object.entries(schema.dto ?? {}).filter(([name]) => !(schema.requestUnion && name === 'KernelRequest'));
const generated = `/**
 * Generated from \`kernel/protocol/schema.json\`.
 * Do not hand-edit the wire shapes; run \`node scripts/generate-kernel-protocol.mjs\`.
 */

export const KERNEL_PROTOCOL_VERSION = ${schema.protocolVersion} as const;
export const KERNEL_PROTOCOL_SCHEMA = "piarium.kernel.v${schema.protocolVersion}" as const;

export type KernelMethod =
${methods};

${dtoEntries.map(([name, spec]) => renderDto(name, spec)).join('\n\n')}

${renderMethodParams()}

${schema.requestUnion ? renderRequestUnion() : ''}
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
