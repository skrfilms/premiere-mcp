/**
 * Re-ask the running Premiere host the four claims a mock cannot answer.
 *
 * A green unit suite is not evidence for any of these. The active-target bug is the proof:
 * `resolveActiveSequence` was a CONSTANT in the test fake, so the bug was inexpressible there and
 * shipped behind 1300 passing tests. Each claim below is therefore re-asked of the real host.
 *
 *   b   two live servers can share one panel and neither auth token is erased
 *   b2  the OTHER server's token is still honoured while this one is live
 *   c   a batch export where every item failed reports success:false
 *   d   an OMF export that produced no file — or found a stale one — refuses to claim success
 *   a0  a transaction naming a sequence that is not active is refused before anything is touched
 *   a   the transaction's edit landed in the NAMED sequence and nowhere else
 *
 * Runs with PREMIERE_MCP_TRANSPORT=file so this process never binds a socket and never publishes
 * bridge-endpoint.json — the panel keeps its existing connection to whichever server owns it, and
 * this harness reaches Premiere purely by file IPC. That is also what makes it a genuine TWO-SERVER
 * test: a second live server appears in the same directory and both must stay authorized.
 *
 * MUTATING. It adds markers to the fixture sequences and leaves recovery/rollback copies behind.
 * Run scripts/live-verify-cleanup.mjs afterwards. The scratch guard is not optional politeness:
 * claim (a) writes a marker into a sequence chosen by the harness.
 *
 * Usage:
 *   node scripts/live-verify-honesty.mjs
 */
import { PremiereProBridge } from '../dist/bridge/index.js';
import { PremiereProTools } from '../dist/tools/index.js';
import { bridgeTempDirForDocs } from '../dist/resources/index.js';
import { requireScratchProject } from './lib/require-scratch-project.mjs';
import fs from 'node:fs';
import path from 'node:path';

// The file channel is the point of this harness, not a fallback — see the header.
process.env.PREMIERE_MCP_TRANSPORT = 'file';

// Tools run in-process, and persistPrefToFile (src/tools/index.ts) reads this on every call. A
// harness has no business making a change to the user's global Premiere prefs that survives a
// force-quit, so it is refused here before any tool can run.
process.env.PREMIERE_MCP_NO_PREFS_WRITE = '1';

// Same derivation the setup resource documents and the panel defaults to, rather than a literal
// '/tmp/premiere-mcp-bridge' that makes this harness unrunnable on Windows.
const DIR = process.env.PREMIERE_TEMP_DIR || bridgeTempDirForDocs(process.platform, process.env);
const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}\n`);
}

function sessionFiles() {
  return fs.readdirSync(DIR).filter((n) => n.indexOf('auth-session-') === 0);
}

const before = sessionFiles();
console.log(`bridge directory: ${DIR}`);
console.log(`session token files before this harness starts: ${before.length}\n${before.map((f) => '  ' + path.join(DIR, f)).join('\n')}\n`);

const bridge = new PremiereProBridge();
const tools = new PremiereProTools(bridge);
await bridge.initialize();

try {
  await requireScratchProject(bridge, 'live-verify-honesty');

  // ---- (b) two servers, one panel ---------------------------------------------------------------
  const during = sessionFiles();
  const mine = during.filter((f) => !before.includes(f));
  const ping = await bridge.executeScript('return JSON.stringify({v: app.version});');
  const theirsStillThere = before.every((f) => during.includes(f));
  record(
    'b) two live servers share one panel; neither token is erased',
    mine.length === 1 && theirsStillThere && !!ping.v,
    `this harness published ${mine.length} new session file, the pre-existing ${before.length} survived, ` +
      `and the panel executed this server's script (Premiere ${ping.v}). ` +
      `Accepted tokens now: ${during.length}.`,
  );

  // Prove the OTHER server's credential is still honoured, not just present on disk: replay a
  // command signed with its token straight through the file channel.
  const otherFile = before[0];
  if (otherFile) {
    const otherToken = JSON.parse(fs.readFileSync(path.join(DIR, otherFile), 'utf8')).token;
    const id = 'harness-other-' + Date.now();
    // An IIFE, not a bare top-level `return` — ExtendScript rejects the latter, and an execution
    // error would be indistinguishable here from a refusal if the assertion were sloppy.
    const cmd = { id, script: '(function(){ return JSON.stringify({ok:true}); })()', timeoutMs: 15000, token: otherToken, timestamp: new Date().toISOString() };
    fs.writeFileSync(path.join(DIR, `.tmp-${id}.json`), JSON.stringify(cmd));
    fs.renameSync(path.join(DIR, `.tmp-${id}.json`), path.join(DIR, `command-${id}.json`));
    let raw = null;
    for (let i = 0; i < 40 && !raw; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const p = path.join(DIR, `response-${id}.json`);
      if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    record(
      "b2) the OTHER server's token is still accepted while this one is live",
      !!(raw && raw.success),
      raw ? `panel answered its token: ${JSON.stringify(raw)}` : 'no response within 20s',
    );
  } else {
    console.log('SKIP  b2) no other live server was present, so there is no second token to replay.\n');
  }

  // ---- (c) batch honesty ------------------------------------------------------------------------
  const batch = await tools.executeTool('batch_export_sequences', {
    sequenceIds: ['no-such-sequence-1', 'no-such-sequence-2'],
    outputDir: path.join(DIR, 'harness-out'),
    presetPath: path.join(DIR, 'nonexistent-preset.epr'),
  });
  console.log('batch_export_sequences full result: ' + JSON.stringify(batch) + '\n');
  record(
    'c) a batch where every item failed reports success:false',
    batch.success === false && batch.batchStatus === 'failed',
    `success=${batch.success} batchStatus=${batch.batchStatus} summary=${JSON.stringify(batch.batchSummary)}`,
  );

  // ---- (d) OMF refuses to congratulate itself ---------------------------------------------------
  const omfPath = path.join(DIR, 'harness-nothing-writes-here.omf');
  try { fs.unlinkSync(omfPath); } catch { /* fine */ }
  const omf = await tools.executeTool('export_omf_with_settings', { outputPath: omfPath });
  record(
    'd) OMF export with no file produced reports success:false',
    omf.success === false && !fs.existsSync(omfPath),
    `success=${omf.success} verified=${omf.verified} fallbackUsed=${omf.fallbackUsed} error=${String(omf.error).slice(0, 180)}`,
  );

  // Same tool, stale-file case: the trap an existsSync-only check would fall into.
  fs.writeFileSync(omfPath, 'left over from an earlier export');
  const stale = await tools.executeTool('export_omf_with_settings', { outputPath: omfPath });
  record(
    'd2) a stale file at the output path is not credited as this export',
    stale.success === false && stale.fileExisted === true,
    `success=${stale.success} fileExisted=${stale.fileExisted}`,
  );
  try { fs.unlinkSync(omfPath); } catch { /* fine */ }

  // ---- (a) active-target drift ------------------------------------------------------------------
  const seqs = await tools.executeTool('list_sequences', {});
  console.log('sequences: ' + JSON.stringify(seqs.sequences || seqs));
  const list = seqs.sequences || [];
  const active = await tools.executeTool('get_active_sequence', {});
  console.log('active before transaction: ' + JSON.stringify(active.sequence || active) + '\n');
  // Target the sequence that is NOT currently active, then open it — two separate checks.
  //
  // First, naming a non-active sequence must be REFUSED outright: the transaction snapshots the
  // active sequence, so proceeding would run steps against something it never snapshotted.
  // Second, once it IS active, the transaction must survive its own snapshot clone stealing
  // ACTIVE out from under the plan — the original bug, where every step edited the snapshot while
  // each tool honestly reported verified:true for the sequence it had touched.
  // Restricted to the two real fixtures: earlier runs leave `[recovery] …` and `… (rolled back …)`
  // sequences in the project, and targeting one of those makes the audit meaningless.
  const fixtures = list.filter((s) => /^fixture_seq_[ab]$/.test(s.name));
  const target = fixtures.find((s) => s.name !== (active.sequence?.name || active.name)) || fixtures[0];
  if (!target) {
    record(
      'a) transaction lands in the NAMED sequence',
      false,
      `needed the two fixture sequences; found ${list.length} sequences, ${fixtures.length} of them fixtures. ` +
        'Run: node scripts/reset-scratch.mjs',
    );
  } else {
    const targetId = target.sequenceID || target.id;
    const refused = await tools.executeTool('transact_sequence_edits', {
      sequenceId: targetId,
      label: 'harness-nonactive-probe',
      steps: [{ tool: 'add_marker', args: { time: 1.0, name: 'should-never-exist' } }],
      onFailure: 'rollback', rollbackStrategy: 'restore_copy', unverifiableStep: 'fail',
      allowPartialRollback: false, keepCheckpointOnCommit: false, dryRun: false,
    });
    record(
      'a0) naming a sequence that is not active is refused before anything is touched',
      refused.committed === false && /not the active sequence/.test(String(refused.error)),
      `committed=${refused.committed} projectStateNow=${JSON.stringify(refused.projectStateNow)}`,
    );

    const opened = await tools.executeTool('set_active_sequence', { sequenceId: targetId });
    console.log(`set_active_sequence -> ${JSON.stringify(opened)}\n`);

    // Unique per run: a fixed label makes a previous run's marker read as this run's stray copy.
    const label = 'harness-drift-probe-' + Date.now();
    const tx = await tools.executeTool('transact_sequence_edits', {
      sequenceId: targetId,
      label,
      steps: [{ tool: 'add_marker', args: { time: 1.0, name: label, comment: 'live drift probe' } }],
      onFailure: 'rollback',
      rollbackStrategy: 'restore_copy',
      unverifiableStep: 'fail',
      allowPartialRollback: false,
      keepCheckpointOnCommit: false,
      dryRun: false,
    });
    console.log('transaction result: ' + JSON.stringify({
      committed: tx.committed, verifiedEndToEnd: tx.verifiedEndToEnd, rolledBack: tx.rolledBack,
      projectStateNow: tx.projectStateNow, error: tx.error,
    }) + '\n');

    // The only check that can catch a wrong-target bug: ask the NAMED sequence, by name, what it holds.
    const audit = await bridge.executeScript(`
      try {
        var out = [];
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
          var s = app.project.sequences[i];
          var names = [];
          var m = s.markers.getFirstMarker();
          while (m) { names.push(m.name); m = s.markers.getNextMarker(m); }
          out.push({ name: s.name, markers: names });
        }
        return JSON.stringify({ ok: true, sequences: out, active: app.project.activeSequence.name });
      } catch (e) { return JSON.stringify({ ok: false, error: e.toString() }); }
    `);
    console.log('marker audit: ' + JSON.stringify(audit) + '\n');
    const named = (audit.sequences || []).find((s) => s.name === target.name);
    const elsewhere = (audit.sequences || []).filter((s) => s.name !== target.name && s.markers.includes(label));
    record(
      'a) the transaction edit landed in the NAMED sequence and nowhere else',
      !!named && named.markers.includes(label) && elsewhere.length === 0,
      `named sequence "${target.name}" markers=${JSON.stringify(named && named.markers)}; ` +
        `stray copies in: ${JSON.stringify(elsewhere.map((s) => s.name))}; active now=${audit.active}`,
    );
  }
} catch (e) {
  // Recorded as a failed claim rather than rethrown: `finally` below exits the process, so a
  // rethrow here would be swallowed and the run would report its tally as if nothing broke.
  console.error('HARNESS ERROR: ' + ((e && e.stack) || e));
  record('harness ran to completion', false, `threw: ${(e && e.message) || e}`);
} finally {
  await bridge.cleanup();
  const after = sessionFiles();
  const leaked = after.filter((f) => !before.includes(f));
  record(
    'cleanup) this harness retired only its own credential',
    leaked.length === 0 && before.every((f) => after.includes(f)),
    `left behind ${leaked.length} of its own; the pre-existing ${before.length} still present: ${before.every((f) => after.includes(f))}`,
  );
  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED: ' + failed.map((f) => f.name).join(', '));
  console.log('Fixture state is now dirty. Restore it with: node scripts/live-verify-cleanup.mjs');
  process.exit(failed.length ? 1 : 0);
}
