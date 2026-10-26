import { parse } from "acorn";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expandedToolNames, executeExpandedTool } from "../../tools/expanded";
import { PremiereProTools } from "../../tools/index";
import { seedArgs } from "../helpers/schema-args";

/**
 * The expanded tools are emitted as ExtendScript from TypeScript template
 * literals. A backslash escape written for the *ExtendScript* string is
 * consumed by the *template literal* first, so `\"` reaches the host as a bare
 * `"` and silently terminates the message string it was meant to protect.
 *
 * That failure is invisible to `tsc` — the template literal is still a valid
 * TypeScript string — and it does not break one tool, it breaks every tool in
 * the file, because they all share one generated script. It reaches the host as
 * a generic "ExtendScript execution failed via CEP evalScript()".
 *
 * So parse what is actually emitted, for every tool, rather than trusting that
 * the TypeScript compiled.
 */
describe("generated ExtendScript is syntactically valid", () => {
  // Some fuzzed tools (e.g. consolidate_and_transfer) write files relative to
  // the process cwd when seeded with a bare relative path. Drive the whole sweep
  // from a throwaway temp dir so nothing lands in the repo root (an "x/" was
  // leaking here because this sweep — unlike the injection/undefined ones —
  // never chdir'd away).
  let originalCwd: string;
  let scratchCwd: string;
  beforeAll(() => {
    originalCwd = process.cwd();
    scratchCwd = mkdtempSync(join(tmpdir(), "skry-genscript-"));
    process.chdir(scratchCwd);
  });
  afterAll(() => {
    process.chdir(originalCwd);
    try { rmSync(scratchCwd, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const capture = async (name: string): Promise<string> => {
    let script = "";
    const bridge = {
      executeScript: async (source: string) => {
        script = source;
        return { success: true, data: {} };
      },
    };
    try {
      await executeExpandedTool(bridge as any, name, {});
    } catch {
      // A tool may reject on missing arguments before it emits anything. That
      // is not what this suite is about — an empty capture is handled below.
    }
    return script;
  };

  /**
   * Parsed as ES3, which is what ExtendScript is — not as modern JavaScript.
   *
   * This used `new Function`, which compiles under whatever V8 the test runner
   * ships. That accepts a great deal ExtendScript will not, including a raw
   * U+2028 inside a string literal — the precise failure
   * a U+2028 in a generated string literal produces, so the guard could not catch
   * the bug it was written for. Verified: V8 accepts raw U+2028, U+2029, `const`
   * and ES5 getters; acorn in ES3 mode rejects all four.
   *
   * Not exhaustive — acorn's ES3 mode still tolerates reserved words as property
   * names and trailing commas, both of which ES3 forbids. It is a strict
   * improvement, not a complete ES3 conformance check.
   */
  const parses = (source: string): void => {
    // allowReturnOutsideFunction mirrors the bridge, which wraps these bodies in
    // an IIFE before they reach the host.
    parse(source, { ecmaVersion: 3, allowReturnOutsideFunction: true });
  };

  it.each([...expandedToolNames])("%s", async (name) => {
    const script = await capture(name);

    // A handful of tools are implemented in TypeScript rather than as generated
    // ExtendScript. They emit nothing through the bridge and have nothing to
    // parse; the shared-script tools are the ones this guard exists for.
    if (script.length === 0) return;

    expect(() => parses(script)).not.toThrow();
  });

  it("covers the shared generated script", async () => {
    // If the capture shim silently stopped working, every case above would pass
    // vacuously. Pin that the bulk of the catalog really is being parsed.
    const captured = await Promise.all(
      [...expandedToolNames].map((n) => capture(n)),
    );
    expect(captured.filter((s) => s.length > 0).length).toBeGreaterThan(100);
  });

  it("rejects an escape that collapses before it reaches the host", async () => {
    // Pin the specific regression: a double-quoted ExtendScript string whose
    // quotes were written as \" in the template literal. Guards the seven QE
    // fail() messages that took down all 171 tools.
    const script = await capture("add_tracks");
    expect(script).toContain("Could not address sequence '");
    expect(script).not.toContain('Could not address sequence "" +');
  });

  describe('lookup helpers signal "not found" with null', () => {
    /**
     * findClip() and markerCollectionForTool() used to return fail(seqErr) when
     * the caller's sequenceId could not be resolved. fail() returns a JSON
     * string, and a string is truthy, so every downstream
     * `if (!x) return fail(...)` guard was dead code: callers went straight on
     * to read .clip or .getFirstMarker off a string.
     *
     * Proven against a live 26.0.2 host before the fix:
     *   get_sequence_markers_by_type({sequenceId: 'NOPE'})
     *     -> {success: true, data: {count: 0, markers: []}}
     *   rename_clip({sequenceId: 'NOPE', ...})
     *     -> {success: false, error: 'undefined is not an object'}
     * The first is the dangerous one: a bogus id answered "this sequence has no
     * markers" with success: true.
     */
    const helperBody = (script, name) => {
      const start = script.indexOf('function ' + name + '(');
      expect(start).toBeGreaterThan(-1);
      return script.slice(start, start + 400);
    };

    it.each(['findClip', 'markerCollectionForTool'])(
      '%s returns null rather than a fail() string',
      async (helper) => {
        const script = await capture('get_clip_markers');
        const body = helperBody(script, helper);

        expect(body).toContain('pendingSequenceError = seqErr; return null;');
        expect(body).not.toContain('if (seqErr) return fail(seqErr);');
      },
    );

    it('reports the sequence error rather than the generic message', async () => {
      const script = await capture('get_clip_markers');

      expect(script).toContain('return fail(pendingSequenceError || "Marker collection unavailable")');
      expect(script).not.toContain('return fail("Marker collection unavailable")');
    });

    it('prefers the sequence error at every clip lookup guard', async () => {
      const script = await capture('rename_clip');

      expect(script).toContain('return fail(pendingSequenceError || "Clip not found")');
      expect(script).not.toContain('return fail("Clip not found")');
    });
  });

  describe("delete_project_item actually deletes and verifies", () => {
    /**
     * Proven against a live 26.3.2 host: the old handler called
     * deleteBin() on a footage clip (ProjectItemType 1). deleteBin() only
     * removes bins, so on a clip it returns without throwing and deletes
     * nothing — yet the handler reported {deleted:true}. Reproduced live:
     * deleteBin() on the clip left it in the project (oldDeleteBinNoOp:true),
     * while moveBin()+deleteBin() through a temp bin removed it (deleted:true,
     * confirmed by a post-delete re-scan).
     */
    it("routes clips through a temp bin and re-scans before claiming success", async () => {
      const script = await capture("delete_project_item");
      // the fixed path
      expect(script).toContain("deleteProjectItemRobust");
      expect(script).toContain("moveBin");
      expect(script).toContain("itemStillPresent");
      // success is gated on the item being gone, and the honest failure exists
      expect(script).toContain("verified: true");
      expect(script).toContain("Premiere did not remove");
    });

    it("delete_multiple_project_items fails closed when nothing was deleted", async () => {
      const script = await capture("delete_multiple_project_items");
      expect(script).toContain("deleteProjectItemRobust");
      expect(script).toContain("No items were deleted");
    });
  });

  describe("setComponentProperty verifies the value actually applied", () => {
    /**
     * The helper read `after = prop.getValue()` but returned {ok:true}
     * unconditionally, so every set_clip_* tool routing through it (scale,
     * position, rotation, opacity, blend mode, effect property) reported
     * success even on a silent no-op. Verified live on 26.3.2 that Scale/
     * Position/Rotation/Opacity read back exactly as requested, so a tolerant
     * compare is a real gate, not a source of false failures.
     */
    it("gates ok on a tolerant compare of the readback to the request", async () => {
      const script = await capture("set_clip_scale");
      expect(script).toContain("valuesMatch");
      expect(script).toContain("did not apply the requested value");
      expect(script).toContain("verified: true");
    });
  });

  describe("setSelection verifies each clip's selection flipped", () => {
    it("re-reads isSelected() and fails closed when nothing changed", async () => {
      const script = await capture("select_all_clips");
      expect(script).toContain("clip.isSelected()");
      expect(script).toContain("Selection state did not change");
    });
  });

  describe("Batch B: expanded.ts mutators verify their readback", () => {
    /**
     * TrackItem has neither isEnabled() nor setEnabled() on 26.x -- both threw a
     * ReferenceError, so select_disabled_clips selected nothing, batch_enable_disable
     * silently no-op'd, and clipInfo.enabled was never populated. Enable state is the
     * `disabled` boolean property (verified live). Every mutator below now re-reads
     * the state it just wrote and fails closed when it did not change.
     */
    it("select_disabled_clips reads clip.disabled, not the nonexistent isEnabled()", async () => {
      const script = await capture("select_disabled_clips");
      expect(script).toContain("clip.disabled === true");
      expect(script).not.toContain("!clip.isEnabled()");
    });

    it("batch_enable_disable sets clip.disabled and confirms the readback", async () => {
      const script = await capture("batch_enable_disable");
      expect(script).toContain(".disabled = !enableValue");
      expect(script).toContain("did not change the enabled state of any clip");
      expect(script).not.toContain(".setEnabled(");
    });

    it("clipInfo.enabled derives from clip.disabled rather than isEnabled()", async () => {
      const script = await capture("get_full_clip_info");
      expect(script).toContain("item.enabled = !clip.disabled");
    });

    it("set_target_track / rename_track verify then fail closed", async () => {
      const setTarget = await capture("set_target_track");
      expect(setTarget).toContain("targetTrack.isTargeted()");
      expect(setTarget).toContain("did not change the track targeting");
      const renameTrack = await capture("rename_track");
      expect(renameTrack).toContain("did not rename the track");
    });

    it("set_offline / detach_proxy confirm the state actually flipped", async () => {
      const offline = await capture("set_offline");
      expect(offline).toContain("offlineItem.isOffline()");
      expect(offline).toContain("did not take");
      const detach = await capture("detach_proxy");
      expect(detach).toContain("proxyItem.hasProxy()");
      expect(detach).toContain("did not detach the proxy");
    });

    it("ripple_delete / remove_selected_clips gate on a dropped clip count", async () => {
      const ripple = await capture("ripple_delete");
      expect(ripple).toContain("did not remove the clip");
      const removeSel = await capture("remove_selected_clips");
      expect(removeSel).toContain("timeline clip count did not drop");
    });

    it("set_clip_speed_qe / set_clip_start_time / set_zero_point verify the value", async () => {
      const speed = await capture("set_clip_speed_qe");
      expect(speed).toContain("did not apply the requested speed");
      const startTime = await capture("set_clip_start_time");
      expect(startTime).toContain("did not move the clip start");
      const zero = await capture("set_zero_point");
      expect(zero).toContain("did not move the zero point");
    });

    it("razor_all_tracks / batch_rename_clips / rename_clip / overwrite_clip verify", async () => {
      const razor = await capture("razor_all_tracks");
      expect(razor).toContain("cutsMade");
      const batchRename = await capture("batch_rename_clips");
      expect(batchRename).toContain("did not rename any clip");
      const renameClip = await capture("rename_clip");
      expect(renameClip).toContain("did not rename the clip");
      const overwrite = await capture("overwrite_clip");
      expect(overwrite).toContain("is not the clip covering");
    });
  });

  describe("Batch C: index.ts mutators verify their readback", () => {
    /**
     * Same fake-success class as Batch B, on the TypeScript-defined index.ts handlers:
     * a mutating call followed by success:true with no state re-read. Each captured
     * script below now re-reads what it wrote (readback compare, count diff, or
     * File.exists) and fails closed on a silent no-op. Driven through the local
     * schema-seeded capture path, since these tools each carry their own zod schema.
     */
    const captureLocal = async (name: string): Promise<string> => {
      const probe = new PremiereProTools({
        executeScript: async () => ({ success: true }),
      } as never);
      const tool = probe.getAvailableTools().find((t) => t.name === name);
      if (!tool) return "";
      let script = "";
      const tools = new PremiereProTools({
        executeScript: async (s: string) => { script = s; return { success: true }; },
      } as never);
      try {
        await tools.executeTool(name, seedArgs(tool as never));
      } catch {
        // schema rejection / early return before emit -> empty capture, asserted below
      }
      return script;
    };

    it("set_clip_properties re-reads getValue() rather than trusting setValue()", async () => {
      const script = await captureLocal("set_clip_properties");
      expect(script).toContain("readback mismatch or missing");
      expect(script).toContain("done.opacity = (Math.abs");
    });

    it("set_clip_properties_batch verifies each clip's readback", async () => {
      const script = await captureLocal("set_clip_properties_batch");
      expect(script).toContain("readback mismatch or missing");
      expect(script).toContain("r.verified");
    });

    it("add_audio_keyframes confirms each key landed via keyExistsAtTime/getValueAtKey", async () => {
      const script = await captureLocal("add_audio_keyframes");
      expect(script).toContain("keyExistsAtTime");
      expect(script).toContain("getValueAtKey");
      expect(script).toContain("did not verify");
    });

    it("update_marker re-reads the written attributes and fails closed on mismatch", async () => {
      const script = await captureLocal("update_marker");
      expect(script).toContain("did not apply on readback");
    });

    it("export_as_fcp_xml / export_aaf gate on File.exists", async () => {
      const fcp = await captureLocal("export_as_fcp_xml");
      expect(fcp).toContain("xmlFile.exists");
      expect(fcp).toContain("no file exists at");
      const aaf = await captureLocal("export_aaf");
      expect(aaf).toContain("aafFile.exists");
      expect(aaf).toContain("no file exists at");
    });

    it("set_sequence_in_out_points verifies via getInPointAsTime/getOutPointAsTime", async () => {
      const script = await captureLocal("set_sequence_in_out_points");
      expect(script).toContain("getInPointAsTime");
      expect(script).toContain("getOutPointAsTime");
    });

    it("enable_disable_clip / duplicate_clip / replace_clip verify or fail closed", async () => {
      const enable = await captureLocal("enable_disable_clip");
      expect(enable).toContain("nowEnabled");
      const dup = await captureLocal("duplicate_clip");
      expect(dup).toContain("duplicateSourceInSeconds");
      const replace = await captureLocal("replace_clip");
      expect(replace).toContain("nodeId");
    });

    it("mute_track / lock_track / set_color_label gate on the readback", async () => {
      const mute = await captureLocal("mute_track");
      expect(mute).toContain("isMuted()");
      expect(mute).toContain("did not change the track mute state");
      const lock = await captureLocal("lock_track");
      expect(lock).toContain("isLocked");
      const color = await captureLocal("set_color_label");
      expect(color).toContain("getColorLabel");
    });

    it("set_playhead_position / add_keyframe / remove_keyframe verify", async () => {
      const playhead = await captureLocal("set_playhead_position");
      expect(playhead).toContain("getPlayerPosition");
      const addKf = await captureLocal("add_keyframe");
      expect(addKf).toContain("keyExistsAtTime");
      const rmKf = await captureLocal("remove_keyframe");
      expect(rmKf).toContain("keyExistsAtTime");
    });

    it("reverse_clip / refresh_media honestly report verified:false", async () => {
      const rev = await captureLocal("reverse_clip");
      expect(rev).toContain("verified: false");
      const refresh = await captureLocal("refresh_media");
      expect(refresh).toContain("verified: false");
    });

    it("save_project_as gates on the written file existing", async () => {
      const save = await captureLocal("save_project_as");
      expect(save).toContain(".exists");
    });
  });

  describe("qeSequenceFor falls back only to the right sequence", () => {
    /**
     * qe.project.getSequenceAt() does not expose every sequence: one made by
     * duplicate_sequence and never opened in a timeline is invisible to it even
     * while it is active. Verified against 26.0.2 — getActiveSequence() returns
     * a working handle for exactly that sequence, guid and addTracks included —
     * so refusing without trying it gave up work the host can do.
     *
     * The guid check is what keeps this from re-becoming the original bug,
     * where a tool resolved one sequence and then mutated whichever was active.
     */
    it("verifies the guid before using the active sequence", async () => {
      const script = await capture("add_tracks");

      expect(script).toContain("qe.project.getActiveSequence()");
      expect(script).toContain(
        "String(activeCandidate.guid) === String(seq.sequenceID)",
      );
    });

    it("tries the indexed scan before the active sequence", async () => {
      const script = await capture("add_tracks");
      // Scoped to the helper body: the same call appears in prose elsewhere in
      // the generated script, and a whole-script indexOf finds the comment.
      const start = script.indexOf("function qeSequenceFor(");
      const body = script.slice(start, script.indexOf("\n    }", start));
      const scan = body.indexOf("qe.project.getSequenceAt(qi)");
      const fallback = body.indexOf("qe.project.getActiveSequence()");

      expect(scan).toBeGreaterThan(-1);
      expect(fallback).toBeGreaterThan(scan);
    });
  });

  describe("the 112 tools declared in index.ts", () => {
    /**
     * This suite only ever parsed expanded.ts. A collapsing \\" escape injected
     * into an index.ts generated script -- the exact failure this file
     * exists to catch -- and all tests stayed green, because those scripts were
     * never captured.
     *
     * They cannot be driven the same way: each tool has its own zod schema, so a
     * no-arg call is usually rejected before a script is generated. Filling
     * plausible arguments from the schema gets most of them to emit.
     */
    const localScripts = async (): Promise<Array<[string, string]>> => {
      const captured: Array<[string, string]> = [];
      const expanded = new Set<string>([...expandedToolNames]);
      const probe = new PremiereProTools({
        executeScript: async () => ({ success: true }),
      } as never);

      for (const tool of probe.getAvailableTools()) {
        if (expanded.has(tool.name)) continue;
        let script = "";
        const tools = new PremiereProTools({
          executeScript: async (s: string) => { script = s; return { success: true }; },
        } as never);
        try {
          await tools.executeTool(tool.name, seedArgs(tool as never));
        } catch {
          // Schema rejections and handlers that never reach the bridge are fine;
          // an empty capture is skipped below.
        }
        if (script) captured.push([tool.name, script]);
      }
      return captured;
    };

    it("emits a parseable script for every tool that generates one", async () => {
      const captured = await localScripts();
      const broken: string[] = [];

      for (const [name, script] of captured) {
        try {
          parses(script);
        } catch (error) {
          broken.push(`${name}: ${(error as Error).message}`);
        }
      }

      expect(broken).toEqual([]);
      // Captures and parses every local tool; the default limit is not enough.
    }, 120_000);

    it("actually captures a meaningful number of them", async () => {
      // Without this, a broken capture would make the parse check pass vacuously
      // -- which is exactly how the expanded-only version hid the gap.
      //
      // This used to build arguments by dispatching on `_def.typeName`, which is
      // undefined in this zod build, so every field became the string "x" and any
      // tool with a numeric parameter was rejected before emitting. It reached 36
      // of the 112 local tools and the floor was calibrated to that broken number.
      // Seeding from the schema reaches 77.
      const captured = await localScripts();

      expect(captured.length).toBeGreaterThanOrEqual(70);
    }, 120_000);
  });

  describe("the parser itself", () => {
    /**
     * Pins the upgrade from `new Function` to acorn's ES3 mode. Without this the
     * suite could quietly regress to a modern-JavaScript parser and keep passing
     * while missing the failures it exists to catch.
     */
    const LS = "\u2028";

    it("rejects a raw U+2028 inside a string literal", () => {
      // ExtendScript is ES3, where a line terminator inside a string literal is a
      // syntax error. V8 accepts it (ES2019 made it legal), so the old check could
      // not catch a U+2028 smuggled into a generated string literal.
      expect(() => parses(`var a = "x${LS}y";`)).toThrow();
    });

    it("rejects syntax that only exists after ES3", () => {
      expect(() => parses("const a = 1;")).toThrow();
      expect(() => parses("var o = { get x() { return 1; } };")).toThrow();
    });

    it("still accepts the ES3 the generator actually emits", () => {
      expect(() => parses('var a = 1; function f(){ return "ok"; } f();')).not.toThrow();
      expect(() => parses('return JSON.stringify({ ok: true });')).not.toThrow();
    });
  });
});
