/**
 * Where the server writes scratch output (captured frames, generated presets, assets).
 *
 * Several tools defaulted their outputDir to a literal posix /tmp path. On Windows that resolves to
 * <current drive>:\tmp\..., which does not exist, so the render-truth tools that write there
 * failed on every Windows call. These follow the same platform rule as the bridge directory the
 * CEP panel polls (see bridgeTempDirForDocs in resources/index.ts, which delegates here), and an
 * explicit PREMIERE_TEMP_DIR wins, as it does for the bridge itself.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The bridge directory default for a platform/env pair, matching the panel's own fallback. */
export function defaultBridgeDir(
  platform: string,
  env: Record<string, string | undefined>,
): string {
  if (platform !== 'win32') return '/tmp/premiere-mcp-bridge';
  return `${env.TEMP || env.TMP || 'C:\\Temp'}\\premiere-mcp-bridge`;
}

/** The bridge directory this process uses: PREMIERE_TEMP_DIR, else the platform default. */
export function bridgeDir(): string {
  return process.env.PREMIERE_TEMP_DIR || defaultBridgeDir(process.platform, process.env);
}

/** Scratch output for generated frames, presets and assets; created if missing. */
export function generatedAssetsDir(): string {
  const dir = join(bridgeDir(), 'generated-assets');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* the tool reports the write failure itself */
  }
  return dir;
}
