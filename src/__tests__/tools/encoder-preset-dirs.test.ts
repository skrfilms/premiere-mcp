/**
 * get_encoder_presets with no directories must look where AME actually saves
 * user presets: ~/Documents/Adobe/Adobe Media Encoder/<ver>/Presets on both
 * macOS and Windows. Scanning only ~/Library/Application Support/Adobe/Common/AME
 * returned nothing on a standard install, so presetName could never resolve.
 * Ported from upstream 5528abb.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';
import { PremiereProBridge } from '../../bridge/index.js';

jest.mock('../../bridge/index.js');
jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  return { ...actual, homedir: jest.fn(actual.homedir) };
});

describe('get_encoder_presets default directories', () => {
  it('discovers user presets under ~/Documents/Adobe/Adobe Media Encoder', async () => {
    const fakeHome = await fs.mkdtemp(join(os.tmpdir(), 'premiere-home-test-'));
    const presetDir = join(
      fakeHome,
      'Documents',
      'Adobe',
      'Adobe Media Encoder',
      '26.0',
      'Presets',
    );
    await fs.mkdir(presetDir, { recursive: true });
    const presetPath = join(presetDir, 'Selects ProRes.epr');
    await fs.writeFile(
      presetPath,
      '<Preset><PresetName>Selects ProRes</PresetName></Preset>',
      'utf8',
    );
    (os.homedir as jest.Mock).mockReturnValue(fakeHome);

    try {
      const tools = new PremiereProTools(new PremiereProBridge() as jest.Mocked<PremiereProBridge>);
      const result = await tools.executeTool('get_encoder_presets', {});

      expect(result.success).toBe(true);
      expect(result.presets).toEqual([
        expect.objectContaining({ name: 'Selects ProRes', path: presetPath, ameVersion: '26.0' }),
      ]);
    } finally {
      (os.homedir as jest.Mock).mockRestore?.();
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });
});
