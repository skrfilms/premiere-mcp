/**
 * Two flavours of the same lie, both now fixed.
 *
 * A tool that loops used to end in a flat `success: true`, so a batch whose every item failed
 * reported exactly what a fully-working batch reported. And the OMF/AAF exporters answered
 * `success: true` because the call did not throw — never checking that a file arrived, and
 * claiming the caller's `outputPath` even when the zero-argument fallback (which takes no path)
 * was what actually ran.
 *
 * `success` is the field an agent branches on. These tests pin it to what happened.
 */

import { promises as fs } from 'node:fs';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PremiereProTools, summarizeBatch } from '../../tools/index.js';
import { PremiereProBridge } from '../../bridge/index.js';

jest.mock('../../bridge/index.js');

describe('summarizeBatch()', () => {
  const isOk = (n: number) => n > 0;

  it('reports an empty request honestly rather than as an error', () => {
    // Asking for zero items and getting zero is not a fault.
    const v = summarizeBatch([], isOk, 'thing(s)');
    expect(v).toEqual({
      success: true,
      batchStatus: 'empty',
      batchSummary: { requested: 0, succeeded: 0, failed: 0 },
    });
  });

  it('calls a batch where nothing worked a FAILURE', () => {
    const v = summarizeBatch([0, 0, 0], isOk, 'sequence export(s)');
    expect(v.success).toBe(false);
    expect(v.batchStatus).toBe('failed');
    expect(v.batchSummary).toEqual({ requested: 3, succeeded: 0, failed: 3 });
    expect(v.error).toContain('All 3 sequence export(s) failed');
    expect(v.warning).toBeUndefined();
  });

  it('calls a mixed batch a success that carries a warning, with the counts', () => {
    const v = summarizeBatch([1, 0, 1, 0, 1], isOk, 'text layer(s)');
    expect(v.success).toBe(true);
    expect(v.batchStatus).toBe('partial');
    expect(v.batchSummary).toEqual({ requested: 5, succeeded: 3, failed: 2 });
    expect(v.warning).toContain('2 of 5 text layer(s) failed');
    expect(v.error).toBeUndefined();
  });

  it('leaves a fully-successful batch unqualified', () => {
    const v = summarizeBatch([1, 2], isOk, 'graphic(s)');
    expect(v).toEqual({
      success: true,
      batchStatus: 'complete',
      batchSummary: { requested: 2, succeeded: 2, failed: 0 },
    });
  });

  // The whole point is that the three states read the same as evaluateTextInjectionResult's, so a
  // caller learns one vocabulary for the catalogue rather than one per tool.
  it('always carries a summary, whichever state it lands in', () => {
    for (const items of [[], [0], [0, 1], [1]]) {
      const v = summarizeBatch(items, isOk, 'item(s)');
      expect(v.batchSummary.requested).toBe(items.length);
      expect(v.batchSummary.succeeded + v.batchSummary.failed).toBe(items.length);
    }
  });
});

describe('honesty_selftest aggregate verdict', () => {
  let tools: PremiereProTools;
  let mockBridge: jest.Mocked<PremiereProBridge>;

  beforeEach(() => {
    mockBridge = new PremiereProBridge() as jest.Mocked<PremiereProBridge>;
    tools = new PremiereProTools(mockBridge);
    jest.clearAllMocks();
  });

  // A self-test named "honesty" reporting success:true while every probe failed was the least
  // defensible instance of the flat-true bug in the catalogue.
  it('fails when no probe passes', async () => {
    mockBridge.executeScript.mockRejectedValue(new Error('bridge down'));

    const result = await tools.executeTool('honesty_selftest', {});

    expect(result.passed).toBe(0);
    expect(result.success).toBe(false);
    expect(result.batchStatus).toBe('failed');
    expect(result.error).toContain('failed');
  });
});

describe('OMF/AAF export verification', () => {
  let tools: PremiereProTools;
  let mockBridge: jest.Mocked<PremiereProBridge>;
  let root: string;

  beforeEach(async () => {
    mockBridge = new PremiereProBridge() as jest.Mocked<PremiereProBridge>;
    tools = new PremiereProTools(mockBridge);
    jest.clearAllMocks();
    root = await fs.mkdtemp(join(tmpdir(), 'skry-interchange-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    ['export_omf_with_settings', 'OMF', 'out.omf'],
    ['export_aaf_with_settings', 'AAF', 'out.aaf'],
  ])('%s confirms success by the file, not by the call not throwing', async (tool, kind, name) => {
    const outputPath = join(root, name);
    mockBridge.executeScript.mockImplementation(async () => {
      writeFileSync(outputPath, 'pretend interchange payload');
      return { called: true, fallbackUsed: false };
    });

    const result = await tools.executeTool(tool, { outputPath });

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.kind).toBe(kind);
    expect(result.fileSizeBytes).toBe('pretend interchange payload'.length);
    expect(existsSync(outputPath)).toBe(true);
  });

  it.each([
    ['export_omf_with_settings', 'OMF', 'out.omf'],
    ['export_aaf_with_settings', 'AAF', 'out.aaf'],
  ])('%s fails when Premiere raises nothing but writes nothing', async (tool, kind, name) => {
    const outputPath = join(root, name);
    mockBridge.executeScript.mockResolvedValue({ called: true, fallbackUsed: false });

    const result = await tools.executeTool(tool, { outputPath });

    expect(result.success).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.error).toContain(outputPath);
    expect(result.error).toContain(`${kind} export does not report its own result`);
  });

  it('will not credit a stale file left by an earlier export', async () => {
    // Checking only existsSync afterwards would certify this file as the export's output — the same
    // assume-it-worked reasoning the fix exists to remove.
    const outputPath = join(root, 'out.omf');
    writeFileSync(outputPath, 'left over from yesterday');
    mockBridge.executeScript.mockResolvedValue({ called: true, fallbackUsed: false });

    const result = await tools.executeTool('export_omf_with_settings', { outputPath });

    expect(result.success).toBe(false);
    expect(result.fileExisted).toBe(true);
  });

  it('says so when the zero-argument fallback ran, because that form cannot honour the path', async () => {
    const outputPath = join(root, 'out.aaf');
    mockBridge.executeScript.mockResolvedValue({
      called: true,
      fallbackUsed: true,
      firstError: 'Error: bad argument list',
    });

    const result = await tools.executeTool('export_aaf_with_settings', { outputPath });

    expect(result.success).toBe(false);
    expect(result.fallbackUsed).toBe(true);
    expect(result.error).toContain('takes no path');
    expect(result.firstError).toBe('Error: bad argument list');
  });

  it('fails without touching the disk when neither call form ran', async () => {
    const outputPath = join(root, 'out.omf');
    mockBridge.executeScript.mockResolvedValue({
      called: false,
      error: 'Error: no active sequence',
      firstError: 'Error: bad argument list',
    });

    const result = await tools.executeTool('export_omf_with_settings', { outputPath });

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.error).toContain('no active sequence');
    expect(existsSync(outputPath)).toBe(false);
  });
});
