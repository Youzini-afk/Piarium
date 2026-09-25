// These declarations are runtime inputs to tsserver, not developer-only package types.
// electron-builder otherwise drops .d.ts even inside the prebuilt language artifact.
module.exports = (file) => /\/dist\/builtin-packages\/typescript-language\/runtime\/typescript\/lib\/[^/]+\.d\.ts$/.test(
  file.replace(/\\/g, '/'),
);
