// @ts-nocheck
import { fileURLToPath } from 'node:url';

export const PIARIUM_LSP_FIXTURE_SERVER_PATH = fileURLToPath(new URL('./fixture-server.js', import.meta.url));
export const PIARIUM_LSP_TYPESCRIPT_SERVER_PATH = fileURLToPath(new URL('./typescript-server.js', import.meta.url));
