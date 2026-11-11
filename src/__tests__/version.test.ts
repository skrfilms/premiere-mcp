import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_VERSION } from '../version.js';

describe('PACKAGE_VERSION', () => {
  it('is the version in package.json, not a hardcoded default', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});

describe('server.json (MCP registry entry)', () => {
  const read = (f: string) => JSON.parse(readFileSync(join(process.cwd(), f), 'utf8'));
  it('names the same server and version as package.json, so a release cannot publish a mismatch', () => {
    const pkg = read('package.json');
    const server = read('server.json');
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([
      expect.objectContaining({ registryType: 'npm', identifier: pkg.name, version: pkg.version }),
    ]);
    // The registry rejects descriptions over 100 characters.
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
