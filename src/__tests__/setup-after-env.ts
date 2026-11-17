/**
 * Removes the private bridge and UXP folders setup-env.ts made for this test file.
 */
import { rmSync } from 'node:fs';

afterAll(() => {
  const dirs: string[] = (globalThis as any).__pmcpJestDirs ?? [];
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
