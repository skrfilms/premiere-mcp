#!/usr/bin/env node
/**
 * Read-only live verification of the Tier-1 / footage-index tools against a
 * running CEP bridge + Premiere host. Drives the freshly-built dist so it
 * exercises tools the long-lived MCP server (started earlier) does not yet
 * expose. Touches NOTHING in the open project: only read-only host tools plus
 * captures/indexes that write to a temp dir.
 */
import { PremiereProBridge } from '../dist/bridge/index.js';
import { PremiereProTools } from '../dist/tools/index.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PREMIERE_TEMP_DIR = process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge';

const bridge = new PremiereProBridge();
const tools = new PremiereProTools(bridge);

const line = (s) => process.stdout.write(s + '\n');
const show = (label, obj) => line(`\n=== ${label} ===\n` + JSON.stringify(obj, null, 2));

async function main() {
  await bridge.initialize();

  // 1. Capabilities with a live connection check + local-backend self-probe.
  const caps = await tools.executeTool('get_capabilities', { checkConnection: true, probeLocalTools: true });
  show('get_capabilities(checkConnection, probeLocalTools)', {
    liveConnection: caps.liveConnection,
    cep: caps.bridge?.cep,
    localBackends: caps.localBackends?.summary,
    deps: caps.localBackends?.dependencies?.map((d) => ({ name: d.name, available: d.available })),
    catalogTools: caps.catalog?.toolsInFullCatalog,
  });

  // 2. Which sequences exist — pick targets for lint/diff (read-only).
  const info = await tools.executeTool('get_project_info', {});
  const seqs = await tools.executeTool('list_sequences', {});
  const list = seqs.sequences || seqs.data?.sequences || [];
  line(`\nProject: ${info.name} | sequences: ${list.length} | active: ${info.activeSequence?.name}`);

  // 3. lint_timeline on the active sequence (read-only QC).
  const lint = await tools.executeTool('lint_timeline', {});
  show('lint_timeline(active)', {
    success: lint.success,
    sequence: lint.sequence?.name ?? lint.sequenceName,
    issueCount: lint.issueCount ?? lint.issues?.length,
    issues: (lint.issues || []).slice(0, 8),
    note: lint.note,
  });

  // 4. diff_sequences between the first two sequences (read-only).
  if (list.length >= 2) {
    const a = list[0].id || list[0].sequenceId;
    const b = list[1].id || list[1].sequenceId;
    const diff = await tools.executeTool('diff_sequences', { sequenceIdA: a, sequenceIdB: b });
    show('diff_sequences(seq0, seq1)', {
      success: diff.success,
      identical: diff.identical,
      changeCount: diff.changeCount,
      counts: diff.counts,
      note: diff.note,
    });
  } else {
    line('\n(skipping diff_sequences — need two sequences)');
  }

  // 5. capture_program_output — probe taps, then a real composited frame to tmp.
  const probe = await tools.executeTool('capture_program_output', { probeOnly: true });
  show('capture_program_output(probeOnly)', probe);

  const capDir = await fs.mkdtemp(join(tmpdir(), 'premiere-mcp-capture-'));
  const capPath = join(capDir, 'program.png');
  const cap = await tools.executeTool('capture_program_output', { outputPath: capPath });
  let capBytes = null;
  try { capBytes = (await fs.stat(capPath)).size; } catch { /* not written */ }
  show('capture_program_output(real)', { success: cap.success, tap: cap.tap, outputPath: cap.outputPath, error: cap.error, bytesOnDisk: capBytes });

  line('\n=== live verification complete ===');
}

main().then(() => process.exit(0)).catch((e) => { console.error('LIVE VERIFY ERROR:', e); process.exit(1); });
