#!/usr/bin/env node
/**
 * Live smoke sweep — exercises the tool catalogue against a running Premiere host.
 *
 * The catalogue grew from 309 to ~600 tools largely through generated code. The unit
 * suites prove those tools EMIT parseable ExtendScript with no undefined identifiers;
 * they cannot prove the host accepts the calls. This sweep closes that gap by actually
 * invoking tools and recording what the host said.
 *
 * Tools are split into three tiers, and the tier assignment is the safety mechanism:
 *
 *   READ   - observational. Invoked with best-effort arguments. A failure here is a real
 *            defect (bad signature, wrong property name, ES3 violation the parser missed).
 *   MUTATE - changes the project. NOT invoked by default; --mutate opts in, and only ever
 *            against a scratch project.
 *   SKIP   - never invoked by this harness, for one of three reasons recorded per tool:
 *            (a) destructive/irreversible, (b) known to open a BLOCKING native dialog
 *            that hangs the CEP bridge (the newColorMatte/newBlackVideo family cost us
 *            several bridge restarts), (c) long-running or reaches an external service.
 *
 * SKIP is not "assumed working". Skipped tools are reported as untested, by name and
 * reason, so the summary never overstates coverage.
 *
 * Usage:
 *   PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/live-smoke-sweep.mjs
 *   PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/live-smoke-sweep.mjs --mutate
 */
// The catalogue this harness measures is decided by PREMIERE_MCP_PROFILE, which the tools module
// reads AT IMPORT TIME — so the default has to be set before that import, which is why these two
// are dynamic. Left to its own devices the server defaults to the `core` profile: 104 of 647 tools.
// A sweep that quietly measures a sixth of the catalogue and reports "real coverage 32.7%" is the
// exact failure this harness exists to prevent, so breadth is the default here and a narrower
// profile has to be asked for out loud.
if (!process.env.PREMIERE_MCP_PROFILE) process.env.PREMIERE_MCP_PROFILE = 'all';
// The sweep runs tools in-process, so this is read by the very handler that would otherwise rewrite
// Adobe's prefs file (persistPrefToFile in src/tools/index.ts checks it on every call). Those prefs
// are the user's, global to every project on the machine, and outlive the scratch fixture; a sweep
// has no business making a change to them that survives a force-quit. Set unconditionally, before
// any tool can run, so no SKIP-list omission can reach that file.
process.env.PREMIERE_MCP_NO_PREFS_WRITE = '1';
const { PremiereProBridge } = await import('../dist/bridge/index.js');
const { PremiereProTools } = await import('../dist/tools/index.js');
import { writeFileSync } from 'node:fs';
import { requireScratchProject, checkStillScratch, needsScratchRecheck } from './lib/require-scratch-project.mjs';
import { collectEnvironment, recordSweep } from './lib/verification-ledger.mjs';
import { buildContext, synthesizeArgs } from './lib/synthesize-args.mjs';
import { ensureHealthy, trackOwnCommands } from './lib/host-recovery.mjs';

const ALLOW_MUTATE = process.argv.includes('--mutate');
/**
 * Let the harness clear a wedge by pressing Escape and, failing that, relaunching Premiere.
 * OFF by default because the underlying probe is only valid when this process is the panel's
 * only client — see the long note in main(). Use it for unattended runs, not while an agent is
 * driving the same bridge.
 */
const ALLOW_RECOVER = process.argv.includes('--recover');

/** How long one tool gets before the harness gives up on it and records a failure. */
const TOOL_TIMEOUT_MS = 25_000;
/**
 * Per-tool budgets for calls that legitimately outlive TOOL_TIMEOUT_MS. Empty for now: export_aaf
 * looked slow on 2026-10-25, but it was blocked on its "AAF Export Log" modal, which the server's
 * report-dialog guard now dismisses (it finishes in ~3.5s).
 */
const SLOW_TOOL_TIMEOUT_MS = {};

/**
 * The panel's own words when it rejects a call because a PREVIOUS script is still outstanding.
 * The same message continues: "Nothing was run for this command", which is what makes this
 * rejection safe to treat as "never executed" rather than as a failure of the tool named.
 */
const WEDGE_REJECTION = /already executing command ([0-9a-f-]{36})/i;
const REPORT_PATH = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/tmp/live-smoke-report.json';

/** Never invoked. Each entry carries the reason it is unsafe for an unattended sweep. */
const SKIP = {
  // (b) BLOCKING NATIVE DIALOG — these hang the CEP bridge until a human dismisses them.
  //     Learned the hard way: newColorMatte opened a colour picker + name prompt and the
  //     bridge had to be restarted.
  countdown_leader: 'dialog: newUniversalCountingLeader prompts',
  create_adjustment_layer_at: 'dialog: newTransparentVideo prompts',
  import_edl: 'dialog: EDL import prompts for sequence/source media',
  import_mogrt: 'dialog risk + writes to project',
  import_mogrt_from_library: 'dialog risk + writes to project',
  create_bars_and_tone: 'dialog: newBarsAndTone prompts',

  // (a) DESTRUCTIVE / IRREVERSIBLE
  close_project: 'closes the project out from under the sweep',
  delete_sequence: 'destructive',
  delete_project_item: 'destructive',
  delete_multiple_project_items: 'destructive',
  delete_bin: 'destructive',
  delete_track: 'destructive',
  delete_empty_tracks: 'destructive (removes tracks)',
  delete_preview_files: 'destructive (throws away renders)',
  remove_from_timeline: 'destructive',
  remove_selected_clips: 'destructive',
  remove_all_effects: 'destructive',
  remove_all_effects_qe: 'destructive',
  remove_effect: 'destructive',
  remove_effect_by_name: 'destructive',
  remove_effect_at_index: 'destructive',
  remove_mogrt_clip: 'destructive',
  remove_time_remap: 'destructive',
  remove_keyframe: 'destructive',
  remove_keyframe_range: 'destructive',
  remove_srt_cue: 'destructive to file',
  ripple_delete: 'destructive',
  set_offline: 'breaks media links',
  relink_media: 'rewrites media links',
  batch_relink_by_pattern: 'rewrites media links in bulk',
  batch_relink_by_prefix: 'rewrites media links in bulk',
  detach_proxy: 'mutates proxy attachment',
  manage_proxies: 'mutates proxy attachment',
  consolidate_and_transfer: 'copies media on disk',
  archive_master: 'copies media on disk',
  save_project_as: 'writes a new project file',
  batch_replace_clips: 'destructive swap',
  replace_clip: 'destructive swap',
  replace_clip_media: 'destructive swap',
  unnest_sequence: 'destructive restructure',
  nest_clips: 'destructive restructure',
  nest_all_v1_clips: 'destructive restructure',

  // (a) STATE CONFUSION — would invalidate the sweep's own assumptions mid-run
  undo: 'rewinds the sweep',
  redo: 'replays unknown state',
  multiple_undo: 'rewinds the sweep',
  open_project: 'swaps the project mid-sweep',
  open_fcp_xml: 'swaps/creates project state',
  open_fcp_xml_project: 'swaps/creates project state',
  import_project_items: 'mutates project structure',
  set_active_sequence: 'moves the target out from under later probes',
  set_workspace: 'rearranges the UI',
  restore_recovery_checkpoint: 'replaces sequence state',
  create_project: 'opens a second project and makes it active, escaping the scratch guard',

  // (a) USER STATE OUTSIDE THE PROJECT — survives the scratch fixture being thrown away
  set_autosave_settings: 'rewrites the user\'s global Auto Save preferences',
  write_clipboard: 'overwrites the user\'s system clipboard',

  // (c) EXTERNAL SERVICE / CLOUD — reaches Creative Cloud or a team production
  convert_project_to_production: 'mutates Creative Cloud production state',
  create_production_qe: 'creates cloud production',
  share_production: 'publishes to team',
  sync_production: 'syncs to server',
  resolve_conflict: 'mutates shared production',

  // (c) LONG-RUNNING — minutes, or launches AME
  transcribe_to_srt: 'long-running ML transcription',
  stabilize_clip: 'long-running warp analysis',
  auto_reframe_sequence: 'long-running, creates sequences',
  speed_ramp_bake: 'long ffmpeg render',
  bake_speed_change: 'long ffmpeg render',
  scene_edit_detection: 'long-running analysis',
  detect_scene_edits: 'long-running analysis',
  start_batch_encode: 'launches AME',
  add_to_render_queue: 'launches AME',
  start_encode_and_monitor: 'launches AME',
  encode_file: 'launches AME',
  encode_project_item: 'launches AME',
  batch_export_sequences: 'launches AME repeatedly',
  render_sequence_previews: 'long render',
  render_audio: 'long render',
  export_with_burn_ins: 'long render + mutates then restores effects',
  export_per_marker_range: 'many long exports',
  export_per_marker_segments: 'many long exports',

  // (a) PLAYBACK — starts audio/video playing on the user's machine
  play_timeline: 'starts playback',
  play_source_monitor: 'starts playback',
  play_in_to_out: 'starts playback',

  // arbitrary code execution / recursion — tested separately and deliberately
  execute_extendscript: 'arbitrary code; tested separately',
  evaluate_expression: 'arbitrary code; tested separately',
  batch_execute: 'arbitrary code; tested separately',
  honesty_selftest: 'would recurse into this sweep',
};

/** Read-only if it only observes. Anything not matched here and not skipped is MUTATE. */
function isReadOnly(name) {
  return (
    /^(get|list|is|has|find|search|count|probe|verify|inspect|reflect|read|detect|api|qe_sequence_info|caption_qc_report|srt_diff|slowmo_quality_report|safe_area_check|timeline_fingerprint|timecode_to_frames|frames_to_timecode|extract_palette|broadcast_safe_check|audio_peaks_report|loudness_report|effect_stack_report|shot_status_report|channel_remap_report|todo_marker_report|project_media_report|mogrt_params_report|multicam_info|production_sync_status|chapter_markers_to_youtube|cut_list_csv|vfx_pull_list|delivery_qc|change_list_report|diff_sequences|lint_timeline|ping)/.test(name) &&
    !/^(get_?)?(set|delete|remove|clear)/.test(name)
  );
}

const line = (s) => process.stdout.write(s + '\n');

async function main() {
  const bridge = new PremiereProBridge();
  await bridge.initialize();
  const tools = new PremiereProTools(bridge);
  // Installed before the first command goes out, so every id this process publishes is known. A
  // BUSY verdict naming one of them is this sweep's own wedge, which recovery may clear; any other
  // id is somebody else's work, which it must not touch.
  const ownsCommand = trackOwnCommands(bridge);

  // Confirm we are pointed at a scratch project before anything else runs. Via the shared helper,
  // not the inline copy this used to carry: that copy was missing 'fixture', so it refused a
  // project the other three harnesses accept, and nothing would have caught the divergence.
  // The pinned path is kept: a startup check says nothing about where mutation four hundred lands.
  const pinned = await requireScratchProject(bridge, 'live-smoke-sweep');
  const version = await bridge.executeScript('return JSON.stringify({ version: String(app.version) });');
  line(`host: Premiere ${version.version}`);
  line(`tool profile: ${process.env.PREMIERE_MCP_PROFILE}`);
  line(`mutating tools: ${ALLOW_MUTATE ? 'ENABLED (--mutate)' : 'disabled'}`);
  line(`wedge recovery: ${ALLOW_RECOVER ? 'ENABLED (--recover)' : 'disabled (abort on a wedge instead)'}`);
  line('');

  // Real ids/paths/names so tools get arguments the host can actually resolve, built by reading
  // the fixture rather than by pattern-matching parameter names. The eight-regex version this
  // replaced could not name a bin, a marker guid, an installed transition, or a file on disk, so
  // 93 tools bounced off our own validator and were filed as `skipped_args` — counted as "not
  // looked at", which was honest but was also two thirds of the breadth we could defend.
  const ctx = await buildContext(bridge);
  line(`context: seq=${ctx.sequenceId} tracks=${ctx.videoTracks} clips=${ctx.clips.length} items=${ctx.itemIds.length} markers=${ctx.markers.length}`);
  line(`side fixtures: ${ctx.files.outDir}`);
  if (ctx.raw?.error) line(`context WARNING: ${ctx.raw.error}`);
  line('');

  const catalogue = tools.getAvailableTools();
  const results = { pass: [], fail: [], skipped: [], noArgs: [], wedged: [], mutateDeferred: [], abortedAfter: null, scratchDrift: null };
  /** name -> the tool's own `verified` field, for tools that report one. Fed to the ledger. */
  const verifiedFlag = new Map();

  // A tool that opens a modal dialog wedges the ExtendScript engine until the modal is cleared,
  // and every later call is then rejected before it runs. Recovering from that is a solved
  // problem in this repo — scripts/lib/host-recovery.mjs probes the engine, clears a modal with
  // Escape, and relaunches only as a fallback — but this harness was not using it. It carried its
  // own heartbeat/wall-clock guard instead, and that guard could not fire:
  //
  //   It waited for WEDGE_MS (40s) of OBSERVED processing, on the assumption that a wedge makes
  //   calls HANG. A wedged panel does the opposite — it rejects each call instantly — so all 647
  //   tools burned through in well under 40s and the abort never triggered. The 2026-08-31 mutate
  //   run recorded 393 failures, 347 of which were this rejection, for tools that never executed.
  //
  // It also could not have named the culprit if it had fired: the rejection cites the command id
  // of an EARLIER script, so `lastInvoked` at abort time is the first victim, not the cause.
  //
  // Both problems go away by using the shared recovery guard after every call, exactly as
  // coverage-sweep.mjs does, so a wedge is attributed to the tool that caused it and cleared
  // before the next one runs. This is the second time an inline copy of a shared helper in this
  // file has diverged from the real one (see requireScratchProject above); prefer ./lib.
  const recoveryState = { recoveries: [], maxRecoveries: 6, probeTimeoutMs: 12_000, ownsCommand, pinned };
  /** Host calls since the scratch project was last re-pinned. */
  let callsSinceScratchCheck = 0;

  // ---------------------------------------------------------------------------------------------
  // WHY THIS DOES NOT PROBE THE ENGINE BY DEFAULT.
  //
  // probeEngine() (scripts/engine-sentinel.mjs) writes a command file into PREMIERE_TEMP_DIR and
  // waits for the panel to answer THAT file. It is only a valid probe when this process is the
  // panel's only client. When an MCP server is also attached to the same directory — i.e. whenever
  // an agent is driving Premiere in the same session, which is the normal case here — the two race
  // for the response, the sentinel sees "consumed but never answered", and reported ENGINE_DEAD for
  // a host that is perfectly healthy. (It now names that case RESPONSE_LOST, and recovery refuses
  // to act on it, but the probe still cannot tell you anything useful while another client races.)
  //
  // Measured on 2026-08-31: a pre-flight probeEngine() returned ENGINE_DEAD while the live MCP
  // session was answering ping and honesty_selftest normally, and the recovery it triggered
  // force-quit Premiere and relaunched it on the wrong scratch project. A false ENGINE_DEAD is
  // worse than no probe at all, because recovery acts on it destructively.
  //
  // So detection here uses the two signals that cost nothing and cannot be raced:
  //   1. the heartbeat FILE, which the panel writes and no client consumes; and
  //   2. the panel's own rejection message, which names the outstanding command id.
  // Sentinel-based recovery is still available, behind --recover, for an unattended run where
  // this process really is the only client.
  // ---------------------------------------------------------------------------------------------
  const heartbeatPath = `${process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge'}/bridge-heartbeat.json`;
  const { readFileSync } = await import('node:fs');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Read-only view of the panel beacon. null when it is missing or unparseable. */
  function heartbeat() {
    try {
      const hb = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
      return { ...hb, ageMs: Date.now() - Number(hb.ts) };
    } catch { return null; }
  }

  // PRE-FLIGHT. The 16:47:39Z run on 2026-08-31 started one minute after the 16:46:15Z run and
  // inherited its still-outstanding host command, so from its second tool onward the panel
  // rejected everything. A sweep that begins against a busy panel measures the panel, not the
  // catalogue — so wait for idle, and refuse rather than produce a run that proves nothing.
  const PREFLIGHT_WAIT_MS = 60_000;
  const waitedUntil = Date.now() + PREFLIGHT_WAIT_MS;
  let hb = heartbeat();
  while (hb && hb.ageMs < 10_000 && hb.isProcessing && Date.now() < waitedUntil) {
    line(`pre-flight: panel is busy on ${hb.currentCommandId} (queue ${hb.queueLength}) — waiting`);
    await sleep(3000);
    hb = heartbeat();
  }
  if (!hb || hb.ageMs >= 10_000) {
    line('');
    line(`!! REFUSING TO START: no fresh panel heartbeat (${hb ? `${hb.ageMs}ms stale` : 'file missing'}).`);
    line('!! The CEP panel is not running. Open Window > Extensions > MCP Bridge (CEP) and start it.');
    process.exit(1);
  }
  if (hb.isProcessing) {
    line('');
    line(`!! REFUSING TO START: the panel has been busy on ${hb.currentCommandId} for >${PREFLIGHT_WAIT_MS / 1000}s.`);
    line('!! Every tool would be rejected unrun, so the whole run would describe the wedge.');
    line('!! Clear the modal in Premiere (or restart the panel), then re-run.');
    process.exit(1);
  }
  line('pre-flight: panel is live and idle');
  line('');

  for (const tool of catalogue) {
    const name = tool.name;

    if (SKIP[name]) { results.skipped.push({ name, reason: SKIP[name] }); continue; }

    const readOnly = isReadOnly(name);
    if (!readOnly && !ALLOW_MUTATE) { results.mutateDeferred.push(name); continue; }

    // Build arguments and check them against the tool's OWN schema before spending a host round
    // trip. A candidate our validator would reject never reaches Premiere, so recording it as a
    // failure would blame the tool for the harness's gap; it is filed as skipped_args naming the
    // keys we could not build.
    const synth = synthesizeArgs(tool, ctx);
    if (!synth.ok) {
      results.noArgs.push({ name, error: String(synth.error ?? 'unsynthesisable').slice(0, 140) });
      process.stdout.write('·');
      continue;
    }
    const args = synth.args;
    /**
     * File one result for this tool. Split out so the wedge rejection is classified identically
     * whether the bridge reported it as a failed result or threw it.
     */
    const record = (err) => {
      const wedge = WEDGE_REJECTION.exec(err);
      if (wedge) {
        // The panel rejected this before running it. Blaming the tool would be a fabricated
        // failure, so record what actually happened and whose command was in the way.
        results.wedged.push({ name, error: err.slice(0, 240), blockingCommandId: wedge[1] });
        process.stdout.write('W');
        return;
      }
      // Missing-required-argument is the harness's shortcoming, not the tool's.
      if (/Invalid arguments|expected .*received undefined|required/i.test(err)) {
        results.noArgs.push({ name, error: err.slice(0, 140) });
        process.stdout.write('·');
        return;
      }
      results.fail.push({ name, error: err.slice(0, 240) });
      process.stdout.write('F');
    };

    try {
      const r = await Promise.race([
        tools.executeTool(name, args),
        new Promise((_, rej) => { const ms = SLOW_TOOL_TIMEOUT_MS[name] ?? TOOL_TIMEOUT_MS; setTimeout(() => rej(new Error(`harness timeout ${ms / 1000}s`)), ms); }),
      ]);
      if (r && r.success === false) {
        record(String(r.error ?? 'unknown'));
      } else {
        results.pass.push(name);
        if (r && typeof r.verified === 'boolean') verifiedFlag.set(name, r.verified);
        process.stdout.write('.');
      }
    } catch (e) {
      record(String(e.message));
    }

    // A wedge is not hypothetical any more: the rejection above tells us the panel is stuck on a
    // specific command. Escalate only then, so the common case costs nothing and the sentinel is
    // never spawned into a race it cannot win (see the pre-flight note above).
    const stuck = results.wedged.length && results.wedged[results.wedged.length - 1].name === name;
    /** Set when the host was Escaped or relaunched, either of which can change the active project. */
    let hostDisturbed = false;
    if (stuck) {
      // Give the panel a moment to drain on its own. Plenty of legitimate host calls outlive one
      // tool's turn — the 16:46:15Z run took exactly one such rejection (diff_sequences) and
      // recovered without help, so treating the first rejection as fatal would throw away a
      // perfectly good run.
      let drained = false;
      for (let i = 0; i < 5 && !drained; i++) {
        await sleep(2000);
        const now = heartbeat();
        drained = Boolean(now && now.ageMs < 10_000 && !now.isProcessing);
      }
      if (drained) {
        process.stdout.write('~');
      } else {
        // Still stuck. Something is holding the engine, and every remaining tool would be rejected
        // unrun — which is precisely the 347-fabricated-failures outcome this rewrite exists to
        // prevent. Recovery can clear a modal with Escape, but it spawns the sentinel, so it stays
        // opt-in; without it, stop and say so.
        if (!ALLOW_RECOVER) {
          const blocking = results.wedged[results.wedged.length - 1].blockingCommandId;
          line('');
          line(`!! ABORTED: the panel is wedged on command ${blocking} and is not draining.`);
          line(`!! The last tool to actually reach the host was: ${name}`);
          line('!! Clear the modal in Premiere and re-run, or pass --recover to let the harness');
          line('!! Escape/relaunch it — only safe when no MCP client is attached to the bridge.');
          results.abortedAfter = name;
          break;
        }

        const health = await ensureHealthy(name, recoveryState);
        if (!health.ok) {
          line('');
          line(`!! ABORTED after ${name}: ${health.error ?? health.verdict?.state}`);
          line('!! Stopping rather than thrashing Premiere. Remaining tools are recorded as unexercised.');
          results.abortedAfter = name;
          break;
        }
        process.stdout.write(`[WEDGED-BY:${name}]`);
        hostDisturbed = Boolean(health.clearedModal || health.recovery);
      }
    }

    // RE-PIN THE TARGET. requireScratchProject only speaks for the moment it ran; tools that omit a
    // target act on whichever project is ACTIVE, and a project-opening tool, an Escape that lands on
    // the wrong dialog, or a relaunch can all change that. So the pin is re-checked every few calls,
    // straight after anything whose name says it touches projects, and after every recovery. A
    // failed check stops the run here — with the report and ledger still written — because every
    // later call could land on a project nobody cleared for mutation.
    callsSinceScratchCheck++;
    if (hostDisturbed || needsScratchRecheck(name, callsSinceScratchCheck)) {
      const pin = await checkStillScratch(bridge, pinned);
      if (!pin.ok) {
        line('');
        line(`!! ABORTED after ${name}: the scratch project is no longer the target.`);
        line(`!! ${pin.reason}`);
        line('!! Nothing further was run. Check Premiere by hand before saving anything.');
        results.abortedAfter = name;
        results.scratchDrift = pin.reason;
        break;
      }
      callsSinceScratchCheck = 0;
    }
  }

  line('');
  line('');
  line('================ LIVE SMOKE SWEEP ================');
  line(`catalogue:            ${catalogue.length}`);
  line(`invoked & passed:     ${results.pass.length}`);
  line(`invoked & FAILED:     ${results.fail.length}`);
  line(`skipped (unsafe):     ${results.skipped.length}  <- NOT tested`);
  line(`skipped (needs args): ${results.noArgs.length}  <- NOT tested`);
  line(`rejected (wedged):    ${results.wedged.length}  <- NOT tested, nothing ran`);
  if (!ALLOW_MUTATE) line(`deferred (mutating):  ${results.mutateDeferred.length}  <- NOT tested`);
  const attempted = results.pass.length + results.fail.length;
  line('');
  line(`real coverage: ${attempted}/${catalogue.length} tools actually executed (${((attempted / catalogue.length) * 100).toFixed(1)}%)`);

  if (results.fail.length) {
    line('');
    line('--- FAILURES (real defects) ---');
    for (const f of results.fail) line(`  ${f.name}\n      ${f.error}`);
  }

  // Surfaced separately and never as failures. If this list is long, the run is not evidence
  // about those tools — it is evidence that something wedged the panel and stayed wedged.
  if (results.wedged.length) {
    const blockers = [...new Set(results.wedged.map((w) => w.blockingCommandId))];
    line('');
    line(`--- REJECTED BY A WEDGED PANEL (${results.wedged.length} tools, nothing ran) ---`);
    line(`  outstanding command id(s) in the way: ${blockers.join(', ')}`);
    line(`  ${results.wedged.map((w) => w.name).join(', ')}`);
    if (recoveryState.recoveries.length) {
      line('  tools that wedged the host this run:');
      for (const r of recoveryState.recoveries) line(`    ${r.culprit} -> ${r.verdictBefore}, recovered=${r.recovered}`);
    }
  }

  writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));
  line('');
  line(`full report: ${REPORT_PATH}`);

  // Record the run in the repo's ledger. The /tmp report above is for this run's operator;
  // this is the durable claim, and docs/LIVE-VERIFICATION.md is generated from it. An aborted
  // sweep is still recorded — it covered fewer tools, which is a fact, not a reason to file
  // nothing. Only the tools this run actually reached are written; anything untouched stays
  // absent, and absence is reported as "never exercised live".
  const ledgerTools = [
    ...results.pass.map((name) => {
      const rec = { name, outcome: 'pass' };
      if (verifiedFlag.has(name)) rec.verified = verifiedFlag.get(name);
      return rec;
    }),
    ...results.fail.map((f) => ({ name: f.name, outcome: 'fail', detail: f.error })),
    ...results.noArgs.map((f) => ({ name: f.name, outcome: 'skipped_args', detail: f.error })),
    ...results.skipped.map((f) => ({ name: f.name, outcome: 'skipped_unsafe', detail: f.reason })),
    ...results.wedged.map((f) => ({
      name: f.name,
      outcome: 'skipped_wedged',
      detail: `nothing ran: panel was executing ${f.blockingCommandId}`,
    })),
    ...results.mutateDeferred.map((name) => ({ name, outcome: 'deferred_mutating' })),
  ];
  const environment = await collectEnvironment({
    tools,
    harness: 'live-smoke-sweep',
    mode: ALLOW_MUTATE ? 'mutate' : 'read-only',
  });
  const ledgerPath = recordSweep({ environment, tools: ledgerTools });
  line(`ledger entry:  ${ledgerPath}`);
  line('regenerate the summary with: npm run verify:report');
  process.exit(0);
}

main().catch((e) => { console.error('sweep aborted:', e.message); process.exit(1); });
