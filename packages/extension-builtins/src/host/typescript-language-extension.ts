import { defineLanguageProvider } from "@piarium/extension-sdk";

export default defineLanguageProvider((context) => ({
  providerId: "piarium.typescript-language",
  command: process.execPath,
  args: [context.assets.path("runtime/typescript-language-server.mjs"), "--stdio"],
  languageIds: ["javascript", "javascriptreact", "typescript", "typescriptreact"],
  initializationOptions: {
    tsserver: {
      fallbackPath: context.assets.path("runtime/typescript/lib/tsserver.js"),
    },
  },
}));
