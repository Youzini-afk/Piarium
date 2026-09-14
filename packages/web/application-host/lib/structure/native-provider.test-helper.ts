import { afterAll } from "vitest";
import { createNativeComputeTestHarness } from "../kernel/compute.test-helper.js";
import { createTreeSitterStructureProvider as createProvider, type TreeSitterStructureProviderOptions } from "./tree-sitter-provider.js";
const compute = createNativeComputeTestHarness();
afterAll(() => compute.dispose());
export const createTreeSitterStructureProvider = (options: TreeSitterStructureProviderOptions = {}) => createProvider({compute,...options});
