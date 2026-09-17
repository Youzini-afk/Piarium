const fs = require('node:fs');
const path = require('node:path');

// onnxruntime-node loads bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node.
// Its npm package also carries other targets, which must not enter our native installer.
module.exports = function pruneOnnxRuntime(unpackedNodeModulesPath, platform, architecture) {
  const root = path.join(unpackedNodeModulesPath, 'onnxruntime-node', 'bin', 'napi-v6');
  const target = path.join(root, platform, architecture);
  const binding = path.join(target, 'onnxruntime_binding.node');
  if (!fs.statSync(binding, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Missing target ONNX runtime binding: ${binding}`);
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const platformPath = path.join(root, entry.name);
    if (entry.name !== platform) {
      fs.rmSync(platformPath, { recursive: true });
      continue;
    }
    for (const arch of fs.readdirSync(platformPath, { withFileTypes: true })) {
      if (arch.isDirectory() && arch.name !== architecture) {
        fs.rmSync(path.join(platformPath, arch.name), { recursive: true });
      }
    }
  }
};
