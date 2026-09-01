// @ts-nocheck
import { fileURLToPath } from 'node:url';

export const PIARIUM_DAP_FIXTURE_ADAPTER_PATH = fileURLToPath(new URL('./fixture-adapter.js', import.meta.url));
export const PIARIUM_NODE_DAP_ADAPTER_PATH = fileURLToPath(new URL('./node-adapter.js', import.meta.url));
export const PIARIUM_TEST_FIXTURE_PROVIDER_PATH = fileURLToPath(new URL('./fixture-tests.js', import.meta.url));
