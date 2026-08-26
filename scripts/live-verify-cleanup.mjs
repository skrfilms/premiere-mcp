/**
 * Restore the scratch fixture to its committed shape after scripts/live-verify-honesty.mjs.
 *
 * The fixture is exactly two sequences, `fixture_seq_a` and `fixture_seq_b`; everything else in the
 * project was created by a harness run (recovery snapshots and rolled-back copies). Rather than
 * pattern-matching harness names, this keeps an explicit ALLOWLIST of the two and deletes the rest,
 * so a harness sequence with an unexpected name cannot slip through.
 *
 * Not a duplicate of scripts/reset-scratch.mjs. That one rebuilds the whole fixture from synthesised
 * media and is the right tool when the project is unrecognisable; this one is the cheap in-place
 * restore between verifier runs, and it needs no ffmpeg and no re-import.
 *
 * Nothing here saves the project. The .prproj on disk was never written by the harness, so the point
 * is only to leave Premiere's in-memory state matching disk — a dirty project throws a save prompt
 * at the next piece of unattended automation.
 *
 * DELETES SEQUENCES. The scratch guard is the only thing between this allowlist and a real cut, so
 * it runs before the first delete and exits rather than warning.
 *
 * Usage:
 *   node scripts/live-verify-cleanup.mjs
 */
import { PremiereProBridge } from '../dist/bridge/index.js';
import { PremiereProTools } from '../dist/tools/index.js';
import { requireScratchProject, assertStillScratch } from './lib/require-scratch-project.mjs';

const KEEP = ['fixture_seq_a', 'fixture_seq_b'];
const MARKER_PREFIX = 'harness-drift-probe';

const bridge = new PremiereProBridge();
const tools = new PremiereProTools(bridge);
await bridge.initialize();

try {
  const pinned = await requireScratchProject(bridge, 'live-verify-cleanup');

  const { sequences = [] } = await tools.executeTool('list_sequences', {});
  const doomed = sequences.filter((s) => !KEEP.includes(s.name));
  console.log(`${sequences.length} sequences; keeping ${KEEP.length}, deleting ${doomed.length}:`);
  doomed.forEach((s) => console.log('  - ' + s.name));

  for (const s of doomed) {
    // Re-pinned before EVERY delete, not once at startup. delete_sequence takes an id but resolves it
    // within whichever project is ACTIVE, and the startup check cannot speak for a project that
    // became active afterwards. A round trip per delete is nothing against deleting a real cut.
    await assertStillScratch(bridge, pinned, 'live-verify-cleanup');
    const r = await tools.executeTool('delete_sequence', { sequenceId: s.id });
    console.log(`  delete_sequence ${s.name}: success=${r.success} verified=${r.verified}${r.error ? ' error=' + r.error : ''}`);
  }

  // The two survivors still carry markers the harness added.
  const swept = await bridge.executeScript(`
    (function(){
      try {
        var removed = [];
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
          var s = app.project.sequences[i];
          var doomedM = [];
          var m = s.markers.getFirstMarker();
          while (m) {
            if (m.name.indexOf(${JSON.stringify(MARKER_PREFIX)}) === 0) doomedM.push(m);
            m = s.markers.getNextMarker(m);
          }
          for (var j = 0; j < doomedM.length; j++) {
            removed.push(s.name + ' / ' + doomedM[j].name);
            s.markers.deleteMarker(doomedM[j]);
          }
        }
        return JSON.stringify({ ok: true, removed: removed });
      } catch (e) { return JSON.stringify({ ok: false, error: e.toString() }); }
    })()
  `);
  console.log('markers removed: ' + JSON.stringify(swept));

  const after = await bridge.executeScript(`
    (function(){
      var out = [];
      for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var s = app.project.sequences[i];
        var ms = []; var m = s.markers.getFirstMarker();
        while (m) { ms.push(m.name); m = s.markers.getNextMarker(m); }
        out.push({ name: s.name, markers: ms });
      }
      return JSON.stringify({ n: out.length, seqs: out });
    })()
  `);
  console.log('\nfinal state: ' + JSON.stringify(after, null, 1));

  // Report, do not assume. A delete_sequence that returned verified:false leaves the fixture dirty,
  // and the next verifier run would then pick a harness leftover as its target.
  const restored = after && after.n === KEEP.length;
  if (!restored) {
    console.error(`\nNOT fully restored: ${after && after.n} sequences remain, expected ${KEEP.length}. ` +
      'Rebuild from scratch with: node scripts/reset-scratch.mjs');
    process.exit(1);
  }
  console.log('\nfixture restored to its committed shape.');
} catch (e) {
  console.error('CLEANUP ERROR: ' + ((e && e.stack) || e));
  process.exitCode = 2;
} finally {
  await bridge.cleanup();
}
