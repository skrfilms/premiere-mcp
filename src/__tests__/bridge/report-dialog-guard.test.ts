/**
 * The report-dialog guard must never act on anything but the named, OK-only report dialogs, and
 * must cost nothing when it is off or when a call returns quickly.
 */
import {
  REPORT_DIALOGS,
  dialogGuardEnabled,
  resetScreenLockCache,
  screenLocked,
  withReportDialogGuard,
} from '../../bridge/report-dialog-guard.js';

describe('report dialog guard', () => {
  const saved = process.env.PREMIERE_MCP_DIALOG_GUARD;
  afterEach(() => {
    if (saved === undefined) delete process.env.PREMIERE_MCP_DIALOG_GUARD;
    else process.env.PREMIERE_MCP_DIALOG_GUARD = saved;
  });

  it('targets only the measured informational dialogs', () => {
    expect(REPORT_DIALOGS).toEqual(['AAF Export Log', 'Translation Report']);
  });

  it('is off when PREMIERE_MCP_DIALOG_GUARD=0', () => {
    process.env.PREMIERE_MCP_DIALOG_GUARD = '0';
    expect(dialogGuardEnabled()).toBe(false);
  });

  it('returns a fast call untouched, having dismissed nothing', async () => {
    const { result, guard } = await withReportDialogGuard(async () => 42);
    expect(result).toBe(42);
    expect(guard.dismissed).toEqual([]);
  });

  it('propagates a failure from the guarded call', async () => {
    await expect(
      withReportDialogGuard(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('keeps guarding while any call is in flight, not just the first', async () => {
    let releaseA: () => void = () => {};
    const a = withReportDialogGuard(
      () =>
        new Promise<string>((res) => {
          releaseA = () => res('a');
        }),
    );
    const b = withReportDialogGuard(async () => 'b');
    await expect(b).resolves.toMatchObject({ result: 'b' });
    releaseA();
    await expect(a).resolves.toMatchObject({ result: 'a' });
  });
});

describe('screenLocked', () => {
  const LOCKED = '<dict><key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/></dict>';
  const UNLOCKED = '<dict><key>kCGSSessionOnConsoleKey</key><true/></dict>';
  const saved = process.env.PREMIERE_MCP_LOCK_CHECK;
  beforeEach(() => {
    delete process.env.PREMIERE_MCP_LOCK_CHECK;
    resetScreenLockCache();
  });
  afterAll(() => {
    process.env.PREMIERE_MCP_LOCK_CHECK = saved;
    resetScreenLockCache();
  });
  const onMac = process.platform === 'darwin' ? it : it.skip;

  onMac('reads the lock flag from ioreg', () => {
    expect(screenLocked(1, () => LOCKED)).toBe(true);
    resetScreenLockCache();
    expect(screenLocked(1, () => UNLOCKED)).toBe(false);
  });

  onMac('treats an unreadable ioreg as unlocked rather than refusing everything', () => {
    expect(
      screenLocked(1, () => {
        throw new Error('ioreg missing');
      }),
    ).toBe(false);
  });

  onMac('caches for five seconds', () => {
    expect(screenLocked(1000, () => LOCKED)).toBe(true);
    expect(screenLocked(4000, () => UNLOCKED)).toBe(true);
    expect(screenLocked(7000, () => UNLOCKED)).toBe(false);
  });

  it('is off with PREMIERE_MCP_LOCK_CHECK=0', () => {
    process.env.PREMIERE_MCP_LOCK_CHECK = '0';
    expect(screenLocked(1, () => LOCKED)).toBe(false);
  });
});
