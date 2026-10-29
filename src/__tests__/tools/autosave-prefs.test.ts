/**
 * set_autosave_settings writes to a REAL Adobe preferences file on disk.
 *
 * That is unusual for a tool in this server — almost everything else reaches Premiere only through
 * the bridge, so the worst a runaway test can do is talk to a stub. This one globs the user's home
 * directory for `Adobe Premiere Pro Prefs` and rewrites a tag in it, and `persistToPrefsFile`
 * defaults to true. A test written later that calls the tool with default arguments would destroy
 * the preferences of whatever Premiere install is on the machine running CI.
 *
 * The guard is a hard refusal keyed on the test runner, and this suite is what stops the refusal
 * from being deleted as "defensive noise". It asserts the live preference is still applied when the
 * file write is refused: refusing to persist must not mean refusing to act.
 */

import { PremiereProTools } from '../../tools/index.js';

/** Records what was asked of the host and answers as app.properties would. */
function fakeHost(store: Record<string, string>) {
  const scripts: string[] = [];
  return {
    scripts,
    transport: {
      executeScript: async (script: string) => {
        scripts.push(script);
        // Mimic getProperty/setProperty over `store` by reading the literals out of the script.
        const setMatch = /app\.properties\.setProperty\("([^"]+)","([^"]*)"\)/.exec(script);
        if (setMatch) {
          const [, key, value] = setMatch as unknown as [string, string, string];
          const before = store[key] ?? null;
          store[key] = value;
          return {
            success: true,
            verified: true,
            verifiedBy: 'app.properties.getProperty() readback',
            changed: before !== value,
            key,
            value,
            before,
            readback: value,
          };
        }
        const read: Record<string, string | null> = { success: true } as any;
        for (const key of Object.keys(store)) read[key] = store[key]!;
        return {
          success: true,
          enabled: store['BE.Prefs.AutoSave.DoSave'] ?? null,
          intervalMinutes: store['BE.Prefs.AutoSave.Interval'] ?? null,
          maxVersions: store['BE.Prefs.AutoSave.MaxProjectVersions'] ?? null,
          alsoSaveCurrentProject: store['BE.Prefs.AutoSave.AlsoSaveCurrentProject'] ?? null,
          saveToCloud: store['BE.Prefs.AutoSave.DoSaveToCloud'] ?? null,
          autoSaveFolder: store['BE.Prefs.ScratchDisks.FirstAutoSaveFolder'] ?? null,
        };
      },
    } as any,
  };
}

const DEFAULTS = {
  'BE.Prefs.AutoSave.DoSave': 'true',
  'BE.Prefs.AutoSave.Interval': '5',
  'BE.Prefs.AutoSave.MaxProjectVersions': '20',
  'BE.Prefs.AutoSave.AlsoSaveCurrentProject': 'false',
  'BE.Prefs.AutoSave.DoSaveToCloud': 'false',
  'BE.Prefs.ScratchDisks.FirstAutoSaveFolder': '/tmp/autosave',
};

describe('set_autosave_settings', () => {
  it('refuses to write the prefs file from a test runner, but still applies the live preference', async () => {
    const store = { ...DEFAULTS };
    const host = fakeHost(store);
    const tools = new PremiereProTools(host.transport);

    const result: any = await tools.executeTool('set_autosave_settings', { intervalMinutes: 10 });

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    const change = result.changes.find((c: any) => c.field === 'intervalMinutes');
    // The live write must still have happened — a refusal to persist is not a refusal to act.
    expect(change.liveApplied).toBe(true);
    expect(change.before).toBe('5');
    expect(change.readback).toBe('10');
    expect(store['BE.Prefs.AutoSave.Interval']).toBe('10');
    // ...and the file write must have been refused, by name.
    expect(change.prefsFile.persisted).toBe(false);
    expect(change.prefsFile.refused).toBe(true);
    expect(change.prefsFile.reason).toMatch(/test runner|PREMIERE_MCP_NO_PREFS_WRITE/);
  });

  it('names the exact preference keys rather than making the caller guess them', async () => {
    const store = { ...DEFAULTS };
    const tools = new PremiereProTools(fakeHost(store).transport);

    const result: any = await tools.executeTool('set_autosave_settings', {
      enabled: true,
      intervalMinutes: 10,
      maxVersions: 40,
      alsoSaveCurrentProject: true,
      saveToCloud: false,
    });

    expect(result.changes.map((c: any) => c.key).sort()).toEqual([
      'BE.Prefs.AutoSave.AlsoSaveCurrentProject',
      'BE.Prefs.AutoSave.DoSave',
      'BE.Prefs.AutoSave.DoSaveToCloud',
      'BE.Prefs.AutoSave.Interval',
      'BE.Prefs.AutoSave.MaxProjectVersions',
    ]);
    expect(store['BE.Prefs.AutoSave.MaxProjectVersions']).toBe('40');
  });

  it('refuses an empty call instead of reporting a successful no-op', async () => {
    const tools = new PremiereProTools(fakeHost({ ...DEFAULTS }).transport);
    const result: any = await tools.executeTool('set_autosave_settings', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No Auto Save setting/);
  });

  it('rejects an out-of-range interval at the schema layer, before the bridge is touched', async () => {
    const host = fakeHost({ ...DEFAULTS });
    const tools = new PremiereProTools(host.transport);
    const result: any = await tools.executeTool('set_autosave_settings', { intervalMinutes: 0 });
    expect(result.success).toBe(false);
    expect(host.scripts).toHaveLength(0);
  });

  it('always says whether the change survives a force-quit', async () => {
    const tools = new PremiereProTools(fakeHost({ ...DEFAULTS }).transport);
    const result: any = await tools.executeTool('set_autosave_settings', { intervalMinutes: 10 });
    // The whole point of the tool over a raw set_app_property call: a live write is not a durable
    // one, and the caller must not have to know that already to find out.
    expect(result.note).toMatch(/graceful quit/);
  });
});

describe('get_autosave_settings', () => {
  it('coerces the string preferences into typed values and reports the keys it read', async () => {
    const tools = new PremiereProTools(
      fakeHost({ ...DEFAULTS, 'BE.Prefs.AutoSave.Interval': '10' }).transport,
    );
    const result: any = await tools.executeTool('get_autosave_settings', {});
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.intervalMinutes).toBe(10);
    expect(result.maxVersions).toBe(20);
    expect(result.saveToCloud).toBe(false);
    expect(result.keys.intervalMinutes).toBe('BE.Prefs.AutoSave.Interval');
  });
});
