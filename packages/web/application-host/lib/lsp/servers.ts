import { fileURLToPath } from 'node:url';

const runsFromTypeScriptSource = fileURLToPath(import.meta.url).endsWith('.ts');
const tsxLoader = runsFromTypeScriptSource && !process.versions.bun ? import.meta.resolve('tsx') : null;

const worker = (name: string) => {
  const path = fileURLToPath(new URL(`./${name}.${runsFromTypeScriptSource ? 'ts' : 'js'}`, import.meta.url));
  return {
    args: tsxLoader ? ['--import', tsxLoader, path] : [path],
    path,
  };
};

const fixtureServer = worker('fixture-server');
const typescriptServer = worker('typescript-server');

export const PIARIUM_LSP_FIXTURE_SERVER_PATH = fixtureServer.path;
export const PIARIUM_LSP_FIXTURE_SERVER_ARGS = fixtureServer.args;
export const PIARIUM_LSP_TYPESCRIPT_SERVER_PATH = typescriptServer.path;
export const PIARIUM_LSP_TYPESCRIPT_SERVER_ARGS = typescriptServer.args;
