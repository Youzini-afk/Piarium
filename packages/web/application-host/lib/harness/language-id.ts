const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  css: "css",
  html: "html",
  json: "json",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sh: "shellscript",
  bash: "shellscript",
};

export const languageIdForPath = (path: string): string | null => {
  const fileName = path.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (fileName === "dockerfile") return "dockerfile";
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
};
