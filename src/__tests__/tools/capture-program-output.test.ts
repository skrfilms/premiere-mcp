/**
 * capture_program_output: Wall 1 of the render-truth loop. Captures the actual
 * COMPOSITED Program Monitor frame (real rendered pixels) so a model can SEE what
 * an edit renders to, rather than trusting an API return value.
 *
 * These tests cover the deterministic contract: the capability probe shape, the
 * honest failure (with install guidance) when a real-time GPU/network tap is
 * forced but unavailable, and the render/export happy path with sequence + playhead
 * defaults resolved from the bridge. They do NOT drive a real Premiere frame export
 * (that needs a live host); a routing bridge stands in for the ExtendScript calls.
 */

import { tmpdir, platform } from 'node:os';
import { PremiereProTools } from '../../tools/index.js';

const noBridge = { executeScript: async () => ({ success: true }) } as never;

/**
 * A bridge that returns realistic parsed results by matching the generated
 * script's unique tokens, so the render/export path can run end-to-end without a
 * live Premiere: active-sequence resolve, playhead read, and frame export.
 */
function routingBridge(overrides: { exportSucceeds?: boolean } = {}): never {
  const exportSucceeds = overrides.exportSucceeds ?? true;
  return {
    executeScript: async (script: string) => {
      if (script.includes('getPlayerPosition')) {
        return { success: true, position: 2.5, ticks: '635040000000' };
      }
      if (script.includes('exportFramePNG') || script.includes('writtenPath')) {
        // Echo back the path the handler actually asked exportFrame to write, so
        // tests can assert on the resolved default (temp dir) path.
        const m = script.match(/var requestedPath = "([^"]*)"/);
        const requested = m ? m[1] : '/tmp/routed-frame.png';
        return exportSucceeds
          ? {
              success: true,
              message: 'Frame exported successfully',
              sequenceName: 'RoutedSeq',
              outputPath: requested,
              requestedPath: requested,
            }
          : { success: false, error: 'Frame export reported no error but wrote no file' };
      }
      if (script.includes('app.project.activeSequence')) {
        return { success: true, id: 'SEQ-ACTIVE-1', name: 'RoutedSeq' };
      }
      return { success: true };
    },
  } as never;
}

describe('capture_program_output — capability probe', () => {
  it('probeOnly reports the four taps with render always available', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('capture_program_output', { probeOnly: true });
    expect(result.success).toBe(true);
    expect(result.probeOnly).toBe(true);
    expect(Array.isArray(result.taps)).toBe(true);
    expect(result.taps.map((t: { tap: string }) => t.tap).sort()).toEqual([
      'ndi',
      'render',
      'spout',
      'syphon',
    ]);
    const render = result.taps.find((t: { tap: string }) => t.tap === 'render');
    expect(render.available).toBe(true);
    expect(render.audio).toBe(true);
    // With no receiver env set, the real-time taps are unavailable → render is recommended.
    expect(result.recommendedTap).toBe('render');
  });

  it('marks the wrong-OS GPU tap unavailable with an OS-specific reason', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('capture_program_output', { probeOnly: true });
    const syphon = result.taps.find((t: { tap: string }) => t.tap === 'syphon');
    const spout = result.taps.find((t: { tap: string }) => t.tap === 'spout');
    if (platform() === 'darwin') {
      expect(spout.available).toBe(false);
      expect(spout.reason).toMatch(/windows-only/i);
    } else if (platform() === 'win32') {
      expect(syphon.available).toBe(false);
      expect(syphon.reason).toMatch(/macos-only/i);
    } else {
      expect(syphon.available).toBe(false);
      expect(spout.available).toBe(false);
    }
  });

  it('honours a receiver env override in the probe', async () => {
    const OLD = process.env.PREMIERE_MCP_NDI_RECEIVER;
    process.env.PREMIERE_MCP_NDI_RECEIVER = 'ndi://program';
    try {
      const tools = new PremiereProTools(noBridge);
      const result = await tools.executeTool('capture_program_output', { probeOnly: true });
      const ndi = result.taps.find((t: { tap: string }) => t.tap === 'ndi');
      expect(ndi.available).toBe(true);
      expect(result.recommendedTap).toBe('ndi');
    } finally {
      if (OLD === undefined) delete process.env.PREMIERE_MCP_NDI_RECEIVER;
      else process.env.PREMIERE_MCP_NDI_RECEIVER = OLD;
    }
  });
});

describe('capture_program_output — forcing an unavailable tap', () => {
  it('fails with install guidance rather than silently using render/export', async () => {
    const OLD = process.env.PREMIERE_MCP_NDI_RECEIVER;
    delete process.env.PREMIERE_MCP_NDI_RECEIVER;
    try {
      const tools = new PremiereProTools(routingBridge());
      const result = await tools.executeTool('capture_program_output', { tap: 'ndi' });
      expect(result.success).toBe(false);
      expect(result.requestedTap).toBe('ndi');
      expect(String(result.error)).toMatch(/not available/i);
      expect(String(result.install)).toMatch(/NDI/i);
      // It must NOT have quietly captured via render/export.
      expect(result.tapUsed).toBeUndefined();
      expect(result.hint).toMatch(/render/);
    } finally {
      if (OLD === undefined) delete process.env.PREMIERE_MCP_NDI_RECEIVER;
      else process.env.PREMIERE_MCP_NDI_RECEIVER = OLD;
    }
  });
});

describe('capture_program_output — render/export tap', () => {
  it('captures via render/export, resolving active sequence and playhead defaults', async () => {
    const tools = new PremiereProTools(routingBridge());
    const result = await tools.executeTool('capture_program_output', {});
    expect(result.success).toBe(true);
    expect(result.tapUsed).toBe('render');
    expect(result.autoSelected).toBe(true);
    expect(result.sequenceId).toBe('SEQ-ACTIVE-1');
    expect(result.time).toBe(2.5); // defaulted from the playhead
    expect(result.audio).toBe(false); // render tap here returns a still, not a mix
    expect(String(result.outputPath)).toContain('premiere-program-SEQ-ACTIVE-1');
  });

  it('uses an explicit tap:"render" with a provided time and default temp output', async () => {
    const tools = new PremiereProTools(routingBridge());
    const result = await tools.executeTool('capture_program_output', {
      sequenceId: 'SEQ-XYZ',
      time: 10,
      tap: 'render',
    });
    expect(result.success).toBe(true);
    expect(result.tapUsed).toBe('render');
    expect(result.autoSelected).toBe(false);
    expect(result.sequenceId).toBe('SEQ-XYZ');
    expect(result.time).toBe(10);
  });

  it('reports failure honestly when the frame export writes nothing', async () => {
    const tools = new PremiereProTools(routingBridge({ exportSucceeds: false }));
    const result = await tools.executeTool('capture_program_output', {
      sequenceId: 'SEQ-XYZ',
      time: 1,
    });
    expect(result.success).toBe(false);
    expect(result.tapUsed).toBe('render');
    expect(String(result.error)).toMatch(/wrote no file|could not produce/i);
  });

  it('defaults the output path into the system temp dir', async () => {
    // A capture with no outputPath should never scatter a file at cwd: the
    // requested path we handed exportFrame lands under the OS temp dir and
    // carries the unique, non-clobbering "premiere-program-" prefix.
    const tools = new PremiereProTools(routingBridge());
    const result = await tools.executeTool('capture_program_output', {
      sequenceId: 'SEQ-XYZ',
      time: 0,
    });
    expect(result.success).toBe(true);
    const tempName = tmpdir()
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() as string;
    expect(String(result.requestedPath)).toContain('premiere-program-SEQ-XYZ');
    expect(String(result.requestedPath)).toContain(tempName);
  });
});
