import { describe, expect, test } from 'bun:test';
import type { PackageDescriptor } from '@piarium/protocol';
import { isPiMcpAdapterInstalled } from './mcp-availability';

const entry = (input: Partial<PackageDescriptor>): PackageDescriptor => ({
  installed: false,
  name: 'example',
  scope: 'global',
  source: 'npm:example',
  structured: false,
  ...input,
});

describe('MCP settings package availability', () => {
  test('requires the current target package entry to be installed', () => {
    expect(isPiMcpAdapterInstalled([
      entry({ installed: false, name: 'pi-mcp-adapter', source: 'npm:pi-mcp-adapter' }),
    ])).toBe(false);
    expect(isPiMcpAdapterInstalled([
      entry({ installed: true, name: 'pi-mcp-adapter', source: 'npm:pi-mcp-adapter@2' }),
    ])).toBe(true);
    expect(isPiMcpAdapterInstalled([
      entry({ installed: false, name: 'pi-mcp-adapter', scope: 'global', source: 'npm:pi-mcp-adapter' }),
      entry({ installed: true, name: 'pi-mcp-adapter', scope: 'project', source: 'https://github.com/Youzini-afk/pi-mcp-adapter.git' }),
    ])).toBe(true);
    expect(isPiMcpAdapterInstalled([])).toBe(false);
  });
});
