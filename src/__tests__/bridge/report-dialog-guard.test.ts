/**
 * The report-dialog guard must never act on anything but the named, OK-only report dialogs, and
 * must cost nothing when it is off or when a call returns quickly.
 */
import { REPORT_DIALOGS, dialogGuardEnabled, withReportDialogGuard } from '../../bridge/report-dialog-guard.js';

describe('report dialog guard', () => {
  const saved = process.env.PREMIERE_MCP_DIALOG_GUARD;
  afterEach(() => { if (saved === undefined) delete process.env.PREMIERE_MCP_DIALOG_GUARD; else process.env.PREMIERE_MCP_DIALOG_GUARD = saved; });

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
    await expect(withReportDialogGuard(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
