const ARCH_ALIASES = new Map([
  ['x64', 'x64'],
  ['amd64', 'x64'],
  ['x86_64', 'x64'],
  ['arm64', 'arm64'],
  ['aarch64', 'arm64'],
]);

const normalizeKernelArchitecture = (value) => {
  const normalized = ARCH_ALIASES.get(String(value || '').trim().toLowerCase());
  if (!normalized) throw new Error(`Unsupported kernel architecture ${JSON.stringify(value)}; expected x64 or arm64.`);
  return normalized;
};

const defaultKernelTargetTriple = (platform, architecture) => {
  const arch = normalizeKernelArchitecture(architecture);
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  throw new Error(`Unsupported kernel target platform ${JSON.stringify(platform)}.`);
};

const detectKernelBinaryIdentity = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20) throw new Error('Kernel binary is truncated.');
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    if (bytes.length < 0x40) throw new Error('PE kernel binary is truncated.');
    const header = bytes.readUInt32LE(0x3c);
    if (header + 6 > bytes.length || bytes.toString('binary', header, header + 4) !== 'PE\0\0') throw new Error('Kernel PE header is invalid.');
    const machine = bytes.readUInt16LE(header + 4);
    if (machine === 0x8664) return { platform: 'win32', arch: 'x64', format: 'pe' };
    if (machine === 0xaa64) return { platform: 'win32', arch: 'arm64', format: 'pe' };
    throw new Error(`Unsupported PE kernel machine 0x${machine.toString(16)}.`);
  }
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    const littleEndian = bytes[5] === 1;
    const machine = littleEndian ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
    if (machine === 62) return { platform: 'linux', arch: 'x64', format: 'elf' };
    if (machine === 183) return { platform: 'linux', arch: 'arm64', format: 'elf' };
    throw new Error(`Unsupported ELF kernel machine ${machine}.`);
  }
  const magic = bytes.readUInt32LE(0);
  if (magic === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    if (cpu === 0x01000007) return { platform: 'darwin', arch: 'x64', format: 'macho' };
    if (cpu === 0x0100000c) return { platform: 'darwin', arch: 'arm64', format: 'macho' };
    throw new Error(`Unsupported Mach-O kernel CPU 0x${cpu.toString(16)}.`);
  }
  throw new Error('Kernel binary format is not PE, ELF, or 64-bit Mach-O.');
};

module.exports = {
  defaultKernelTargetTriple,
  detectKernelBinaryIdentity,
  normalizeKernelArchitecture,
};
