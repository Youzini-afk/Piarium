import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineDocumentAuthorityContract } from './contract-fixtures.js';

defineDocumentAuthorityContract({ describe, it, expect, beforeEach, afterEach });
