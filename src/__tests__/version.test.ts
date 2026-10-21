import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_VERSION } from '../version.js';

describe('PACKAGE_VERSION', () => {
  it('is the version in package.json, not a hardcoded default', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
