/**
 * Destructive fallbacks that acted on an object the code could not identify.
 *
 * Both defects below are present in upstream main and were not introduced by any
 * of the fix work — they were found by an independent audit that executed the
 * generated scripts against a mock host.
 *
 * add_to_timeline: when the identity check could not find the clip it had just
 * placed, it fell back to `track.clips[numItems - 1]` — whatever happened to be
 * last on the track. It then reported that clip's id, name and times back as the
 * placement, AND used its start time to drive the linkAudio=false sweep, which
 * removes audio clips matching that time. So a placement that did nothing could
 * delete an unrelated audio clip and report success. Demonstrated on a mock host:
 * asked to place at t=30, placed nothing, reported a pre-existing clip at t=0, and
 * removed a voiceover from A1.
 *
 * create_bin / import_folder: a parentBinName that did not resolve fell through to
 * the project root, so the bin or import landed somewhere the caller never asked
 * for while the response echoed the parent name back as though it had been used.
 */

import { PremiereProBridge } from '../../bridge/index.js';
import { PremiereProTools } from '../../tools/index.js';
import { promises as fs } from 'fs';

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(), access: jest.fn(), readdir: jest.fn(),
    writeFile: jest.fn(), readFile: jest.fn(), unlink: jest.fn(),
    rename: jest.fn(), rm: jest.fn(),
  }
}));
jest.mock('node:crypto', () => ({
  randomUUID: jest.fn(() => 'test-uuid-1234'),
  // Bridge IPC auth mints a per-session token with randomBytes; a mock without it
  // throws before any assertion in this file can run.
  randomBytes: jest.fn(() => Buffer.from('ab'.repeat(32), 'hex')),
}));

describe('placement that cannot be confirmed', () => {
  const mockFs = fs as jest.Mocked<typeof fs>;
  // Written straight to the polled name here. Publishing via a scratch file and
  // a rename is a separate change to the transport and is not part of this one.
  const _commandPath = '/tmp/premiere-mcp-bridge-test/command-test-uuid-1234.json';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PREMIERE_TEMP_DIR = '/tmp/premiere-mcp-bridge-test';
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.access.mockRejectedValue(new Error('Not found'));
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue(JSON.stringify({ result: { ok: true } }));
  });
  afterEach(() => { delete process.env.PREMIERE_TEMP_DIR; });

  const emitted = async (): Promise<string> => {
    const bridge = new PremiereProBridge();
    await bridge.initialize();
    // Bridge IPC auth made initialize() itself write (the per-session auth token) and
    // unlink (the stale-command sweep). Those are setup, not the subject of these tests, so
    // the fs mocks are cleared here — otherwise every assertion about "the command write"
    // picks up the token instead, which is precisely how this suite went red.
    mockFs.writeFile.mockClear();
    mockFs.rename.mockClear();
    mockFs.unlink.mockClear();
    await bridge.addToTimeline('seq', 'item', 0, 30, false);
    const call = mockFs.writeFile.mock.calls.find(
      ([, payload]) => typeof payload === 'string' && payload.includes('"script"'),
    );
    return JSON.parse(call![1] as string).script as string;
  };

  it('never guesses at the last clip on the track', async () => {
    const script = await emitted();

    // The specific expression that made an unconfirmed placement destructive.
    expect(script).not.toContain('track.clips[track.clips.numItems - 1]');
  });

  it('fails instead of reporting a clip it did not place', async () => {
    const script = await emitted();

    expect(script).toContain('Placement could not be confirmed');
    expect(script).toContain('no linked audio was removed');
    // Asserting the message alone passes even with the fallback restored, since
    // the guard still exists below it and simply never runs. Pin the absence of
    // any assignment to placedClip after the identity search.
    expect(script).not.toMatch(/placedClip\s*=\s*track\.clips\[/);
  });

  it('reaches the audio sweep only through a confirmed clip', async () => {
    // The sweep keys off placedClip.start.seconds, so it must be unreachable
    // whenever placedClip could not be identified.
    const script = await emitted();
    const guard = script.indexOf('Placement could not be confirmed');
    const sweep = script.indexOf('unlinkedAudioRemoved');

    expect(guard).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(guard);
    // Ordering alone is not enough: with the fallback restored the guard still
    // precedes the sweep and simply never fires.
    expect(script).not.toMatch(/placedClip\s*=\s*track\.clips\[/);
  });


  describe('insertMode', () => {
    /**
     * The tool accepted insertMode, echoed it back in every response, and never
     * passed it on: placement was unconditionally track.overwriteClip(). A caller
     * asking to insert-and-shift had existing footage destroyed and was told the
     * opposite. Both methods exist on video and audio tracks in 26.0.2.
     */
    const scriptFor = async (mode?: string): Promise<string> => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ result: { ok: true } }));
      const bridge = new PremiereProBridge();
      await bridge.initialize();
      // Bridge IPC auth made initialize() itself write (the per-session auth token) and
      // unlink (the stale-command sweep). Those are setup, not the subject of these tests, so
      // the fs mocks are cleared here — otherwise every assertion about "the command write"
      // picks up the token instead, which is precisely how this suite went red.
      mockFs.writeFile.mockClear();
      mockFs.rename.mockClear();
      mockFs.unlink.mockClear();
      await bridge.addToTimeline('seq', 'item', 0, 1, true, undefined, undefined, mode);
      const call = mockFs.writeFile.mock.calls.find(
      ([, payload]) => typeof payload === 'string' && payload.includes('"script"'),
    );
      return JSON.parse(call![1] as string).script as string;
    };

    it('inserts when asked to insert', async () => {
      const script = await scriptFor('insert');

      expect(script).toContain('track.insertClip(projectItem,');
      expect(script).toContain('var requestedInsert = true;');
    });

    it('overwrites by default', async () => {
      const script = await scriptFor();

      expect(script).toContain('track.overwriteClip(projectItem,');
      expect(script).toContain('var requestedInsert = false;');
    });

    it('refuses rather than falling back to the destructive method', async () => {
      // Falling back to overwrite when insertClip is missing would delete the
      // footage the caller was trying to shift.
      const script = await scriptFor('insert');

      expect(script).toContain('typeof track.insertClip !== "function"');
      expect(script).toContain('Refusing rather than overwriting');
    });

    it('reports the mode actually used, not the mode requested', async () => {
      const script = await scriptFor('insert');

      expect(script).toContain('insertMode: "insert"');
    });
  });
});

describe('bins that do not resolve', () => {
  let tools: PremiereProTools;
  let bridge: { executeScript: jest.Mock };

  beforeEach(() => {
    bridge = { executeScript: jest.fn().mockResolvedValue({ success: true }) };
    tools = new PremiereProTools(bridge as any);
  });

  it('create_bin refuses a parent it cannot find', async () => {
    await tools.executeTool('create_bin', { name: 'B-Roll', parentBinName: 'Nope' });
    const script = bridge.executeScript.mock.calls[0][0] as string;

    expect(script).toContain('Parent bin not found');
    expect(script).not.toContain('|| app.project.rootItem;');
  });

  it('create_bin still allows an explicit root-level bin', async () => {
    await tools.executeTool('create_bin', { name: 'B-Roll' });
    const script = bridge.executeScript.mock.calls[0][0] as string;

    // With no parent named, the root default is correct and must survive. The
    // resolver emits one script for all cases and guards each lookup at runtime,
    // so the "not found" branches are present as dead text — assert on the guard
    // that keeps them from running instead of on their absence.
    expect(script).toContain('var parentBinName = null;');
    expect(script).toContain('var parentBin = app.project.rootItem;');
    expect(script).toContain('else if (parentBinName !== null)');
  });

  it('import_folder refuses a destination it cannot find', async () => {
    await tools.executeTool('import_folder', { folderPath: '/tmp/x', binName: 'Nope' });
    const script = bridge.executeScript.mock.calls[0][0] as string;

    expect(script).toContain('Nothing was imported.');
    expect(script).not.toContain('|| app.project.rootItem;');
  });

  /**
   * The destination resolver used to be a local one-level scan of
   * rootItem.children, so a bin nested inside another bin -- which is what
   * create_bin returns whenever a parent is named -- could not be reached at all.
   * These assert the import tools now go through the shared __resolveBin helper,
   * which handles id, "/"-separated path and deep name.
   */
  it('import_folder resolves the destination through the shared resolver, not a local one-level scan', async () => {
    await tools.executeTool('import_folder', { folderPath: '/tmp/x', binName: 'SC008_0710' });
    const script = bridge.executeScript.mock.calls[0][0] as string;

    expect(script).toContain('__resolveBin(');
    expect(script).not.toContain('function __binByName(');
  });

  it('import_folder accepts a bin nodeId', async () => {
    await tools.executeTool('import_folder', { folderPath: '/tmp/x', binId: '000f62fa' });
    const script = bridge.executeScript.mock.calls[0][0] as string;

    expect(script).toContain('__resolveBin("000f62fa", null)');
  });

  it('import_media targets the resolved bin instead of hardcoding the project root', async () => {
    // Goes through the real bridge method: the hardcoded root destination lived
    // in bridge.importMedia, not in the tool layer, which is why the tool layer's
    // binName looked wired up while every import landed at the root.
    const realBridge = new PremiereProBridge();
    const spy = jest.spyOn(realBridge, 'executeScript').mockResolvedValue({ success: true } as never);

    await realBridge.importMedia('/tmp/a.mp4', undefined, '000f62fa');
    const script = spy.mock.calls[0]![0] as string;

    expect(script).toContain('__resolveBin("000f62fa", null)');
    expect(script).toContain('importFiles([file.fsName], true, __destBin, false)');
    expect(script).not.toContain('importFiles([file.fsName], true, app.project.rootItem, false)');
  });

  it('import_media reports the bin it read back, not the bin it was asked for', async () => {
    const fake = {
      importMedia: async () => ({ success: true, id: 'X', binName: 'Root', treePath: '/Project/X.mp4' }),
      executeScript: async () => ({ success: true }),
    };
    const t = new PremiereProTools(fake as never);

    const result: any = await t.executeTool('import_media', { filePath: '/tmp/a.mp4', binName: 'SC008_0710' });

    expect(result.binName).toBe('Root');
    expect(result.treePath).toBe('/Project/X.mp4');
  });

  it('forwards binName and binId from the tool layer to the bridge', async () => {
    const received: unknown[] = [];
    const fake = {
      importMedia: async (...args: unknown[]) => { received.push(...args); return { success: true }; },
      executeScript: async () => ({ success: true }),
    };
    const t = new PremiereProTools(fake as never);

    await t.executeTool('import_media', { filePath: '/tmp/a.mp4', binName: 'Scenes/008', binId: '000f62fa' });

    expect(received).toEqual(['/tmp/a.mp4', 'Scenes/008', '000f62fa']);
  });
});

describe('the tool layer, not just the bridge', () => {
  /**
   * The insertMode tests above call bridge.addToTimeline directly, which is why a
   * tool layer that never forwarded the argument stayed invisible: the bridge did
   * the right thing with a value it was never given.
   */
  it('forwards insertMode from the tool to the bridge', async () => {
    let received: unknown = 'NOT PASSED';
    const fake = {
      addToTimeline: async (...args: unknown[]) => { received = args[7]; return { success: true }; },
      executeScript: async () => ({ success: true }),
    };
    const tools = new PremiereProTools(fake as never);

    await tools.executeTool('add_to_timeline', {
      sequenceId: 'S', projectItemId: 'P', trackIndex: 0, time: 1, insertMode: 'insert',
    });

    expect(received).toBe('insert');
  });

  it('does not report a mode the bridge was never told about', async () => {
    let received: unknown = 'NOT PASSED';
    const fake = {
      addToTimeline: async (...args: unknown[]) => { received = args[7]; return { success: true }; },
      executeScript: async () => ({ success: true }),
    };
    const tools = new PremiereProTools(fake as never);

    const result = await tools.executeTool('add_to_timeline', {
      sequenceId: 'S', projectItemId: 'P', trackIndex: 0, time: 1, insertMode: 'insert',
    });

    // Echoing insert while the bridge overwrites is the defect itself.
    expect(result.insertMode).toBe(received);
  });
});

describe('bins are resolved by walking, not by string key', () => {
  /**
   * ProjectItemCollection is index-only: children["Name"] returns undefined even
   * when a child of that name exists, verified against 26.0.2. Resolving that way
   * means a named parent never matches, so failing on a falsy result would turn
   * "created in the wrong place" into "never created at all".
   */
  let tools: PremiereProTools;
  let bridge: { executeScript: jest.Mock };

  beforeEach(() => {
    bridge = { executeScript: jest.fn().mockResolvedValue({ success: true }) };
    tools = new PremiereProTools(bridge as never);
  });

  // Both tools now resolve through the shared __resolveBin prelude helper, which
  // deep-walks with __binsByNameDeep. import_folder's old __binByName scanned
  // rootItem.children one level only, so a nested destination was unreachable.
  it('import_folder deep-walks children by name', async () => {
    await tools.executeTool('import_folder', { folderPath: '/tmp/x', binName: 'Footage' });
    const script = bridge.executeScript.mock.calls[0][0] as string;

    expect(script).toContain('__resolveBin(null, "Footage")');
    // Assert on the EMITTED script, not the template. `${JSON.stringify(` never
    // survives emission, so a not.toContain on it can never fail -- the same
    // source-versus-emitted confusion this change exists to fix.
    expect(script).not.toContain('children["Footage"]');
  });

  it('the prelude __resolveBin the import tools call deep-walks, and refuses an ambiguous name', async () => {
    // The mock-bridge scripts above are templates without the prelude, so the
    // resolver's own behaviour is asserted where it actually lives.
    const realBridge = new PremiereProBridge();
    const spy = jest.spyOn(realBridge, 'executeScript').mockResolvedValue({ success: true } as never);
    await realBridge.importMedia('/tmp/a.mp4', 'Footage');
    const emittedScript = spy.mock.calls[0]![0] as string;

    expect(emittedScript).toContain('__resolveBin(null, "Footage")');
    // The prelude is prepended by executeScript, so it is not in the spied
    // argument; assert the helper text itself off the exported prelude.
    const { EXTENDSCRIPT_HELPERS } = await import('../../bridge/index.js');
    expect(EXTENDSCRIPT_HELPERS).toContain('function __resolveBin(');
    expect(EXTENDSCRIPT_HELPERS).toContain('__binsByNameDeep(root, binName, [])');
    expect(EXTENDSCRIPT_HELPERS).toContain('is ambiguous (');
  });

  it('create_bin deep-walks children by name', async () => {
    await tools.executeTool('create_bin', { name: 'B-Roll', parentBinName: 'Footage' });
    const script = bridge.executeScript.mock.calls[0][0] as string;

    // The name arrives as data and the walk indexes children numerically; a
    // string-key lookup (children["Footage"]) would silently never match.
    expect(script).toContain('var parentBinName = "Footage";');
    expect(script).toContain('__binsByNameDeep(app.project.rootItem, parentBinName, [])');
    expect(script).not.toContain('children["Footage"]');
  });
});

describe('duplicate_sequence', () => {
  let tools: PremiereProTools;
  let bridge: { executeScript: jest.Mock };

  beforeEach(() => {
    bridge = { executeScript: jest.fn().mockResolvedValue({ success: true }) };
    tools = new PremiereProTools(bridge as never);
  });

  const scriptFor = async (args: Record<string, unknown>): Promise<string> => {
    await tools.executeTool('duplicate_sequence', args);
    return bridge.executeScript.mock.calls[0][0] as string;
  };

  it('will not mistake the open timeline for the copy', async () => {
    // clone() returns the clone's ProjectItem on current builds, so the code falls
    // back to the active sequence when it cannot resolve a Sequence. Taken
    // unconditionally that hands back the user's own timeline, which is then renamed
    // and, with clearContents, emptied -- and reported as success.
    const script = await scriptFor({ sequenceId: 'seq', newName: 'copy', clearContents: true });

    expect(script).toContain('var priorActiveId = null;');
    expect(script).toContain('activeCandidateId !== String(originalSeq.sequenceID)');
    expect(script).toContain('activeCandidateId !== priorActiveId');
  });

  it('refuses to clear anything when the copy cannot be identified', async () => {
    const script = await scriptFor({ sequenceId: 'seq', newName: 'copy', clearContents: true });

    expect(script).toContain('Nothing was cleared.');
    expect(script).toContain('cleared: false');
  });

  it('captures the prior active sequence before cloning, not after', async () => {
    // Reading it after clone() would record the clone itself, and the guard would
    // then accept the clone as proof that it is not the user's timeline.
    const script = await scriptFor({ sequenceId: 'seq', newName: 'copy' });
    const captured = script.indexOf('priorActiveId = app.project.activeSequence');
    const cloned = script.indexOf('originalSeq.clone()');

    expect(captured).toBeGreaterThan(-1);
    expect(cloned).toBeGreaterThan(captured);
  });
});
