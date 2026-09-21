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

const fixtureAdapter = worker('fixture-adapter');
const nodeAdapter = worker('node-adapter');
const fixtureTests = worker('fixture-tests');

export const VARIN_DAP_FIXTURE_ADAPTER_PATH = fixtureAdapter.path;
export const VARIN_DAP_FIXTURE_ADAPTER_ARGS = fixtureAdapter.args;
export const VARIN_NODE_DAP_ADAPTER_PATH = nodeAdapter.path;
export const VARIN_NODE_DAP_ADAPTER_ARGS = nodeAdapter.args;
export const VARIN_TEST_FIXTURE_PROVIDER_PATH = fixtureTests.path;
export const VARIN_TEST_FIXTURE_PROVIDER_ARGS = fixtureTests.args;
