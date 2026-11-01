/**
 * MCP Tools for Adobe Premiere Pro
 *
 * This module provides tools that can be called by AI agents to perform
 * various video editing operations in Adobe Premiere Pro.
 */

import { z } from 'zod';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// The async API is the separate `promises as fs` import.
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
// Imported ONLY so get_capabilities can COUNT them. `resources: 13` and `prompts: 10` were
// hardcoded literals in this file describing sets that two other modules own, and the resource
// count had already drifted to 21 — the same defect as api_surface_report once publishing
// a hardcoded 600 against a 638-tool build. A count that cannot drift is one that is computed.
// Neither module imports tools/index.js (resources reaches only tools/profiles.js), so there is
// no cycle.
import { PremiereProResources } from '../resources/index.js';
import { PremiereProPrompts } from '../prompts/index.js';
import { executeExpandedTool, getExpandedTools, isExpandedTool } from './expanded.js';
import { applyProfile, resolveProfile, PROFILES, TASK_BUNDLES } from './profiles.js';
import { classifySelection, resolvePageSize, routerVerdict, type RouterVerdict } from './router.js';
import { findTools, type SearchableTool } from './search.js';
import { generateToolTypings, type TypingsTool, type JsonSchemaNode } from './typings.js';
import { annotationsFor } from './annotations.js';
import { describeCatalogueCost, type CatalogueCost } from './catalogue-cost.js';
import {
  RECOVERY_PREFIX,
  buildRecoveryCheckpointName,
  formatCheckpointTimestamp,
  isRecoveryCheckpointName,
  parseRecoveryCheckpointName,
  SEQUENCE_DESTRUCTIVE_TOOLS,
  autoCheckpointEnabled,
} from './recovery.js';
import { type TransactionExecutor, TRANSACTION_TOOL_NAME, runTransaction } from './transactions.js';
import { buildToolCatalogue } from './catalogue.js';
import { findNulByteArgument, summarizeBatch } from './domains/shared.js';
import type {
  AssembleProductSpotArgs,
  BuildBrandSpotArgs,
  ClipPlanStep,
  MotionStyle,
  ProjectFileEditArgs,
  ProjectFileInspectArgs,
} from './domains/shared.js';
import { ToolsBase } from './domains/base.js';
import { AssemblyTools } from './domains/assembly.js';
import { AudioTools } from './domains/audio.js';
import { CaptionTools } from './domains/caption.js';
import { ColorTools } from './domains/color.js';
import { EffectsTools } from './domains/effects.js';
import { ExportRenderTools } from './domains/export-render.js';
import { GraphicsTools } from './domains/graphics.js';
import { InterchangeTools } from './domains/interchange.js';
import { KeyframeTools } from './domains/keyframe.js';
import { MarkerTools } from './domains/marker.js';
import { MotionLayoutTools } from './domains/motion-layout.js';
import { MulticamTools } from './domains/multicam.js';
import { PlaybackTools } from './domains/playback.js';
import { ProjectMediaTools } from './domains/project-media.js';
import { ReviewDeliveryTools } from './domains/review-delivery.js';
import { SequenceTrackTools } from './domains/sequence-track.js';
import { SourceMonitorTools } from './domains/source-monitor.js';
import { SpeedTimeTools } from './domains/speed-time.js';
import { TrimmingTools } from './domains/trimming.js';

// MCPTool now lives in ./tool-types.js so the catalogue module can be typed without
// importing this class. Re-exported because expanded.ts and the tests import it from here.
export type { MCPTool } from './tool-types.js';
import type { MCPTool } from './tool-types.js';
import { runFf } from './ff-exec.js';
import {
  REPORT_DIALOG_TOOLS,
  REPORT_LINGER_MS,
  withReportDialogGuard,
} from '../bridge/report-dialog-guard.js';
import { generatedAssetsDir } from '../utils/scratch-paths.js';
import { runUxp, uxpAvailable } from '../bridge/uxp-channel.js';
import { recent as recentCalls } from './journal.js';
import { getJob, listJobs, startJob } from './jobs.js';
import { planSilenceCuts, toTimecode } from './silence.js';
import { findQuote, planStringout, wordsFromSrt, wordsFromWhisperJson } from './stringout.js';
import { decodeAudio, findOffset, SYNC_RATE } from './audio-sync.js';
import {
  captureScript,
  describeDiff,
  diffStates,
  revertScript,
  type TimelineState,
} from './timeline-state.js';
import { addNote, notesPathFor } from './project-notes.js';
import {
  folderOf,
  listCandidateFiles,
  parseVersioned,
  planVersionUp,
  type ProjectMedia,
} from './version-up.js';

// The header declarations and pure helpers moved to ./domains/shared.ts when this file was
// split into one class per tool domain. Re-exported here: they were part of this module's
// public surface before the split and the tests import them from it.
export {
  findNulByteArgument,
  evaluateTextInjectionResult,
  summarizeBatch,
} from './domains/shared.js';
export type { BatchVerdict } from './domains/shared.js';

/** Calls that are not edits of a sequence, or are about the tracking itself. */
const UNTRACKED_TOOLS = new Set([
  'revert_last_call',
  'what_changed',
  'undo',
  'start_job',
  'get_job',
  'list_jobs',
  'get_recent_calls',
  'find_tool',
  'activate_tools',
  'deactivate_tools',
  'get_project_notes',
  'add_project_note',
  'get_tool_typings',
]);

/** Advertised-tool count past which activate_tools warns (published selection guidance). */
const MENU_WARN_AT = 50;

/** Runs one tool. `args` are already validated against the tool's schema. */
type ToolHandler = (
  args: Record<string, any>,
  options?: { allowUnexposed?: boolean },
) => Promise<any>;

export class PremiereProTools extends ToolsBase {
  /**
   * Tools promoted into the advertised list at runtime by `activate_tools`.
   *
   * Session state, deliberately not persisted: an operator who restarts the server
   * should get exactly the profile they configured, not a surface some earlier agent
   * grew. Everything in here passed the same authority gate `call_tool` uses.
   */
  private activatedTools = new Set<string>();
  /** Notified when the advertised tool list changes, so the server can emit tools/list_changed. */
  private exposureListeners: Array<() => void> = [];

  /**
   * The locally-implemented tool catalogue, built ONCE per process.
   *
   * The literal below constructs several hundred Zod schemas, and it was re-evaluated on
   * every call. executeTool() calls it two to three times for a SINGLE tool call (the
   * getAvailableTools lookup, then the local-vs-expanded check), so the cost landed on
   * every real edit as well as on the sweeps: the injection-guard suite, which calls
   * executeTool once per tool x position x payload, spent the overwhelming majority of its
   * 25 minutes rebuilding this array and timed out on the Windows runner because of it.
   *
   * Caching is safe because the builder is pure: it reads no environment variable and no
   * instance state (`this` appears nowhere inside it), so the catalogue is byte-identical
   * for every instance in the process. Profile curation is deliberately NOT cached —
   * applyProfile() reads process.env on every call, so getAvailableTools() still reflects a
   * profile or exclusion set changed after startup, which several suites depend on.
   *
   * A fresh array is returned per call, not the cached one, so a caller that sorts or
   * splices its copy cannot corrupt the catalogue for everyone else. Copying ~640 object
   * references is free next to rebuilding ~640 schemas.
   */
  private static localToolsCache: MCPTool[] | null = null;

  /**
   * Every tool this build implements, before the active profile filters anything.
   *
   * Cached for the same reason getLocalTools is, and on the same terms: pure inputs, a fresh
   * array handed to each caller. This is the one the hot paths actually call.
   */
  private static registeredToolsCache: MCPTool[] | null = null;

  // One instance per tool domain. Each is a plain class on ToolsBase; this facade dispatches
  // tool calls to them by name and passes itself as their peers.
  readonly assembly: AssemblyTools = new AssemblyTools(this.bridge, this);
  readonly audio: AudioTools = new AudioTools(this.bridge, this);
  readonly caption: CaptionTools = new CaptionTools(this.bridge, this);
  readonly color: ColorTools = new ColorTools(this.bridge, this);
  readonly effects: EffectsTools = new EffectsTools(this.bridge, this);
  readonly exportRender: ExportRenderTools = new ExportRenderTools(this.bridge, this);
  readonly graphics: GraphicsTools = new GraphicsTools(this.bridge, this);
  readonly interchange: InterchangeTools = new InterchangeTools(this.bridge, this);
  readonly keyframe: KeyframeTools = new KeyframeTools(this.bridge, this);
  readonly marker: MarkerTools = new MarkerTools(this.bridge, this);
  readonly motionLayout: MotionLayoutTools = new MotionLayoutTools(this.bridge, this);
  readonly multicam: MulticamTools = new MulticamTools(this.bridge, this);
  readonly playback: PlaybackTools = new PlaybackTools(this.bridge, this);
  readonly projectMedia: ProjectMediaTools = new ProjectMediaTools(this.bridge, this);
  readonly reviewDelivery: ReviewDeliveryTools = new ReviewDeliveryTools(this.bridge, this);
  readonly sequenceTrack: SequenceTrackTools = new SequenceTrackTools(this.bridge, this);
  readonly sourceMonitor: SourceMonitorTools = new SourceMonitorTools(this.bridge, this);
  readonly speedTime: SpeedTimeTools = new SpeedTimeTools(this.bridge, this);
  readonly trimming: TrimmingTools = new TrimmingTools(this.bridge, this);

  /**
   * Subscribe to changes in the advertised tool list.
   *
   * A client that cached `tools/list` has no way to learn about an activation unless it
   * is told, so activation without this notification would produce tools the agent can
   * see in a result and still not call — the exact confusion the router exists to end.
   */
  onExposureChanged(listener: () => void): void {
    this.exposureListeners.push(listener);
  }

  private notifyExposureChanged(): void {
    for (const listener of this.exposureListeners) {
      try {
        listener();
      } catch (error) {
        // A notification failure must never fail the tool call that triggered it.
        this.logger.error('tools/list_changed listener threw:', error);
      }
    }
  }

  private getLocalTools(): MCPTool[] {
    PremiereProTools.localToolsCache ??= this.buildLocalTools();
    return [...PremiereProTools.localToolsCache];
  }

  /**
   * The locally-declared catalogue. The entries themselves live in
   * src/tools/catalogue.ts — they are pure data and reference no server state,
   * so keeping 2,700 lines of schema literals out of this class is free.
   */
  private buildLocalTools(): MCPTool[] {
    return buildToolCatalogue();
  }

  /**
   * The full catalogue before profile curation, as plain searchable records.
   * Kept separate from getAvailableTools() so find_tool can tell "this build does
   * not have that tool" apart from "the active profile hides it".
   */
  private getSearchableCatalogue(): SearchableTool[] {
    const localTools = this.getLocalTools();
    const all = [...localTools, ...getExpandedTools(new Set(localTools.map((tool) => tool.name)))];
    return all.map((tool) => {
      let parameters: string[] | undefined;
      // Zod object schemas expose their keys via .shape; anything else (or a
      // future schema type) simply reports no parameter list rather than throwing.
      try {
        const shape = (tool.inputSchema as any)?.shape;
        if (shape && typeof shape === 'object') parameters = Object.keys(shape);
      } catch {
        parameters = undefined;
      }
      // Built conditionally: `exactOptionalPropertyTypes` makes an explicit
      // `parameters: undefined` a type error against an optional property.
      return parameters
        ? { name: tool.name, description: tool.description, parameters }
        : { name: tool.name, description: tool.description };
    });
  }

  /**
   * Measure what the exposed catalogue actually costs a client in context.
   *
   * Serializes the same shape `tools/list` sends (name + description + JSON Schema +
   * annotations) so the figure reflects the real payload rather than a guess. Schema
   * conversion is best-effort per tool: a schema that will not serialize contributes
   * its name and description only, which under-counts rather than inventing a number.
   */
  measureCatalogueCost(exposed: MCPTool[] = this.getAvailableTools()): CatalogueCost {
    let chars = 0;
    for (const tool of exposed) {
      let schemaText = '{"type":"object"}';
      try {
        schemaText = JSON.stringify(z.toJSONSchema(tool.inputSchema as any, { io: 'input' }));
      } catch {
        // Leave the minimal placeholder; under-counting beats fabricating.
      }
      chars +=
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          annotations: annotationsFor(tool.name),
        }).length + schemaText.length;
    }
    return describeCatalogueCost(exposed.length, chars);
  }

  /** find_tool: rank the full catalogue against a keyword query. No host call. */
  private findTool(args: Record<string, any>): any {
    const exposed = new Set(this.getAvailableTools().map((tool) => tool.name));
    return findTools(this.getSearchableCatalogue(), exposed, {
      query: args.query,
      limit: args.limit,
      readOnly: args.readOnly,
      includeParameters: args.includeParameters,
      includeHidden: args.includeHidden,
    });
  }

  /**
   * TypeScript declarations for the catalogue.
   *
   * Mirrors the pattern Adobe's own MCP server uses (`getToolTypings`), for the same reason: with a
   * catalogue this size, a typed surface an agent can compile against is a better discovery
   * mechanism than prose. Reuses the exact JSON Schema conversion `tools/list` serves, so the
   * declarations cannot describe a shape the server would reject.
   */
  private getToolTypings(args: Record<string, any>): any {
    const includeHidden = args?.includeHidden !== false;
    const exposed = new Set(this.getAvailableTools().map((tool) => tool.name));
    const registered = this.getRegisteredTools();

    const source = includeHidden ? registered : registered.filter((tool) => exposed.has(tool.name));
    const typingsTools: TypingsTool[] = source.map((tool) => {
      let jsonSchema: JsonSchemaNode = { type: 'object', additionalProperties: true };
      try {
        // `unrepresentable: 'any'` matches the tools/list conversion; a schema zod cannot express
        // in JSON Schema degrades to a permissive object rather than throwing and losing the tool.
        jsonSchema = z.toJSONSchema(tool.inputSchema as any, {
          unrepresentable: 'any',
        }) as JsonSchemaNode;
      } catch {
        /* keep the permissive fallback */
      }
      return tool.description
        ? { name: tool.name, description: tool.description, jsonSchema }
        : { name: tool.name, jsonSchema };
    });

    const only: string[] | undefined =
      Array.isArray(args?.only) && args.only.length ? args.only : undefined;
    // A requested name that does not exist is reported rather than silently dropped, so a typo
    // does not look like a tool that was never built.
    const knownNames = new Set(registered.map((tool) => tool.name));
    const unknown = only ? only.filter((name) => !knownNames.has(name)) : [];

    const typings = generateToolTypings(typingsTools, {
      exposedNames: exposed,
      ...(only ? { only } : {}),
    });

    return {
      success: true,
      typings,
      language: 'typescript',
      toolsDeclared: only
        ? only.filter((name) => knownNames.has(name)).length
        : typingsTools.length,
      toolsRegistered: registered.length,
      toolsCallableUnderActiveProfile: exposed.size,
      ...(unknown.length
        ? {
            unknownToolNames: unknown,
            note: `${unknown.length} requested name(s) are not tools in this build; use find_tool to search the catalogue.`,
          }
        : {}),
    };
  }

  getRegisteredTools(): MCPTool[] {
    PremiereProTools.registeredToolsCache ??= (() => {
      const localTools = this.getLocalTools();
      return [...localTools, ...getExpandedTools(new Set(localTools.map((tool) => tool.name)))];
    })();
    return [...PremiereProTools.registeredToolsCache];
  }

  getAvailableTools(): MCPTool[] {
    // Curated by default (`core`). PREMIERE_MCP_PROFILE=all returns everything.
    // Anything the profile hides is still discoverable through find_tool, which reports
    // it as exposed:false with the reason rather than omitting it, and still callable
    // through call_tool unless an authority boundary refuses.
    const registered = this.getRegisteredTools();
    const exposed = applyProfile(registered);
    if (this.activatedTools.size === 0) return exposed;
    // Union with the session's activations, in catalogue order so the list stays stable.
    const exposedNames = new Set(exposed.map((tool) => tool.name));
    return registered.filter(
      (tool) => exposedNames.has(tool.name) || this.activatedTools.has(tool.name),
    );
  }

  /**
   * The router's gate for one target name: may this deployment reach it, and if not,
   * which setting refused. Shared by call_tool and activate_tools so a tool can never
   * be reachable by one route and refused by the other.
   */
  private routerGateFor(name: string): RouterVerdict {
    const registered = this.getRegisteredTools();
    return routerVerdict({
      name,
      registeredNames: new Set(registered.map((tool) => tool.name)),
      exposedNames: new Set(this.getAvailableTools().map((tool) => tool.name)),
      resolution: resolveProfile(registered.map((tool) => tool.name)),
    });
  }

  /**
   * call_tool: invoke any implemented tool by name, advertised or not.
   *
   * This is the context-cost fix. The profile decides what a client is TOLD about; this
   * decides what it can reach. The two are separated on purpose and the separation stops
   * dead at an authority boundary (see router.ts).
   */
  private async callTool(args: Record<string, any>): Promise<any> {
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!name) {
      return {
        success: false,
        error:
          'call_tool requires a tool name. Use find_tool({ query: "<keyword>" }) to search the catalogue.',
      };
    }

    const verdict = this.routerGateFor(name);
    if (!verdict.allowed) {
      // An unknown name gets the same ranked shortlist a direct miss would produce —
      // a refusal with no next step is where an agent starts guessing names.
      const exposedNames = new Set(this.getAvailableTools().map((tool) => tool.name));
      const suggestions =
        verdict.code === 'UNKNOWN_TOOL'
          ? findTools(this.getSearchableCatalogue(), exposedNames, {
              query: name.replace(/_/g, ' '),
              limit: 8,
            }).matches.map((m) => ({
              name: m.name,
              exposed: m.exposed,
              description: m.description,
            }))
          : [];
      return {
        success: false,
        error: verdict.reason,
        refusedBy: verdict.code,
        routed: { requested: name, invoked: false },
        ...(suggestions.length ? { didYouMean: suggestions } : {}),
      };
    }

    const target = this.getRegisteredTools().find((tool) => tool.name === name);
    if (!target) {
      // Unreachable: the gate already proved the name is registered. Kept so a future
      // refactor that breaks that invariant fails loudly instead of throwing a TypeError.
      return {
        success: false,
        error: `Tool '${name}' passed the router gate but is not in the registry. This is a server bug; please report it.`,
      };
    }

    const targetArgs: Record<string, any> =
      args.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : {};

    if (args.dryRun === true) {
      let jsonSchema: unknown = { type: 'object', additionalProperties: true };
      try {
        jsonSchema = z.toJSONSchema(target.inputSchema as any, { unrepresentable: 'any' });
      } catch {
        /* keep the permissive fallback rather than failing the dry run */
      }
      const parsed = target.inputSchema.safeParse(targetArgs);
      return {
        success: true,
        dryRun: true,
        invoked: false,
        tool: name,
        argumentsValid: parsed.success,
        ...(parsed.success ? {} : { validationError: String(parsed.error) }),
        inputSchema: jsonSchema,
        reachedPastProfile: verdict.reachedPastProfile,
        note: "dryRun validated the arguments against the target's real schema and made no Premiere request. Nothing was changed.",
      };
    }

    // Everything downstream — NUL guard, schema validation, auto-checkpoint, verification
    // — is the target tool's normal path. The router adds a gate, not a second code path,
    // so a tool cannot behave differently depending on how it was called.
    const result = await this.executeTool(name, targetArgs, { allowUnexposed: true });
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return {
        ...result,
        routed: { requested: name, invoked: true, reachedPastProfile: verdict.reachedPastProfile },
      };
    }
    return result;
  }

  /**
   * transact_sequence_edits: run a plan as an all-or-nothing edit against the
   * active sequence, rolling back to a snapshot on any failure.
   *
   * The orchestration lives in the pure runTransaction state machine; this method
   * only supplies the executor — a thin adapter that maps each of the eight things
   * the transaction needs onto an EXISTING verified handler, invoked through
   * executeTool so the snapshot/diff/restore inherit those handlers' fail-closed
   * read-backs. It generates no ExtendScript of its own. Every internal call uses
   * allowUnexposed so the machinery works regardless of which tools the active
   * profile advertises; the transaction tool itself is the authority gate, and the
   * classification layer (in transactions.ts) is what refuses unsafe steps.
   */
  private async transactSequenceEdits(args: Record<string, any>): Promise<any> {
    const run = (tool: string, toolArgs: Record<string, unknown>): Promise<any> =>
      this.executeTool(tool, toolArgs, { allowUnexposed: true });

    const executor: TransactionExecutor = {
      resolveActiveSequence: () => run('get_active_sequence', {}),
      fingerprint: (sequenceId?: string) =>
        run('timeline_fingerprint', sequenceId ? { sequenceId } : {}),
      createCheckpoint: (sequenceId: string, label: string) =>
        run('create_recovery_checkpoint', { sequenceId, label }),
      setActiveSequence: (sequenceId: string) => run('set_active_sequence', { sequenceId }),
      diffSequences: (sequenceIdA: string, sequenceIdB: string) =>
        run('diff_sequences', { sequenceIdA, sequenceIdB }),
      runTool: (tool: string, toolArgs: Record<string, unknown>) => run(tool, toolArgs ?? {}),
      restoreCheckpoint: (checkpointSequenceId: string, newName: string, setActive: boolean) =>
        run('restore_recovery_checkpoint', { checkpointSequenceId, newName, setActive }),
      deleteSequence: (sequenceId: string) => run('delete_sequence', { sequenceId }),
      renameProjectItem: (projectItemId: string, newName: string) =>
        run('rename_project_item', { projectItemId, newName }),
    };

    return runTransaction(executor, (args ?? {}) as never);
  }

  /** A task bundle by name: "task-grade", "grade" or "grading" all find task-grade; "core" works too. */
  private resolveBundle(raw: string): { name: string; tools: string[] } | { error: string } {
    const key = raw.trim().toLowerCase().replace(/\s+/g, '-');
    const names = ['core', ...Object.keys(TASK_BUNDLES)];
    // Loose names: a word of the bundle sharing its first four letters ("grading" -> grade).
    const near = (n: string) =>
      n.startsWith('task-') &&
      n
        .slice(5)
        .split('-')
        .some((w) =>
          key
            .split('-')
            .some((k) => k.length >= 4 && w.length >= 4 && k.slice(0, 4) === w.slice(0, 4)),
        );
    const hit =
      names.find((n) => n === key || n === `task-${key}`) ??
      (names.filter(near).length === 1 ? names.find(near) : undefined);
    if (!hit) return { error: `No bundle called '${raw}'.` };
    return { name: hit, tools: PROFILES[hit] ?? [] };
  }

  private bundleList(): Array<{ name: string; tools: number }> {
    return ['core', ...Object.keys(TASK_BUNDLES)].map((name) => ({
      name,
      tools: (PROFILES[name] ?? []).length,
    }));
  }

  /** activate_tools: promote hidden tools into the advertised list for this session. */
  private activateTools(args: Record<string, any>): any {
    const requested: string[] = [];
    if (Array.isArray(args?.names)) {
      for (const entry of args.names)
        if (typeof entry === 'string' && entry.trim()) requested.push(entry.trim());
    }

    if (typeof args?.query === 'string' && args.query.trim()) {
      const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 50);
      const exposedNames = new Set(this.getAvailableTools().map((tool) => tool.name));
      const matches = findTools(this.getSearchableCatalogue(), exposedNames, {
        query: args.query,
        limit,
      }).matches;
      for (const match of matches) if (!requested.includes(match.name)) requested.push(match.name);
    }

    const bundle =
      typeof args?.bundle === 'string' && args.bundle.trim()
        ? this.resolveBundle(args.bundle)
        : null;
    if (bundle && 'error' in bundle)
      return { success: false, error: bundle.error, bundles: this.bundleList() };
    if (bundle)
      for (const name of bundle.tools) if (!requested.includes(name)) requested.push(name);

    if (!requested.length) {
      return {
        success: false,
        error:
          'activate_tools requires names, a query, or a bundle. Use find_tool to search the catalogue first.',
        bundles: this.bundleList(),
      };
    }

    const activated: string[] = [];
    const alreadyExposed: string[] = [];
    const refused: Array<{ name: string; reason: string; refusedBy: string }> = [];

    for (const name of requested) {
      const verdict = this.routerGateFor(name);
      if (!verdict.allowed) {
        refused.push({
          name,
          reason: verdict.reason ?? 'refused',
          refusedBy: verdict.code ?? 'NOT_ROUTABLE',
        });
        continue;
      }
      if (!verdict.reachedPastProfile) {
        alreadyExposed.push(name);
        continue;
      }
      this.activatedTools.add(name);
      activated.push(name);
    }

    if (activated.length) this.notifyExposureChanged();

    const exposed = this.getAvailableTools();
    return {
      success: activated.length > 0 || alreadyExposed.length > 0,
      ...(bundle ? { bundle: bundle.name } : {}),
      activated,
      alreadyExposed,
      // Loading menus and never dropping them is the failure mode; say so when it starts.
      ...(exposed.length > MENU_WARN_AT
        ? {
            warning: `${exposed.length} tools are now advertised, past the ~${MENU_WARN_AT} where tool choice gets less reliable. Drop what this task no longer needs: deactivate_tools({ bundle }) or deactivate_tools({ all: true }).`,
          }
        : {}),
      ...(refused.length ? { refused } : {}),
      toolsNowAdvertised: exposed.length,
      activeThisSession: Array.from(this.activatedTools).sort(),
      // Growing the menu costs context. Report it rather than letting the agent discover
      // the bill later: this is the same number the startup advisory measures.
      contextCost: this.measureCatalogueCost(exposed),
      listChangedNotified: activated.length > 0,
      ...(activated.length
        ? {}
        : { note: 'Nothing was activated, so no tools/list_changed was sent.' }),
    };
  }

  /** deactivate_tools: shrink the advertised list back toward the configured profile. */
  private deactivateTools(args: Record<string, any>): any {
    if (args?.all === true) {
      const removed = Array.from(this.activatedTools).sort();
      this.activatedTools.clear();
      if (removed.length) this.notifyExposureChanged();
      const exposed = this.getAvailableTools();
      return {
        success: true,
        deactivated: removed,
        toolsNowAdvertised: exposed.length,
        contextCost: this.measureCatalogueCost(exposed),
        listChangedNotified: removed.length > 0,
      };
    }

    const names: string[] = Array.isArray(args?.names)
      ? args.names.filter(
          (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0,
        )
      : [];
    if (typeof args?.bundle === 'string' && args.bundle.trim()) {
      const bundle = this.resolveBundle(args.bundle);
      if ('error' in bundle)
        return { success: false, error: bundle.error, bundles: this.bundleList() };
      // Only what this session activated; a bundle tool the profile advertises stays.
      for (const name of bundle.tools)
        if (this.activatedTools.has(name) && !names.includes(name)) names.push(name);
      if (!names.length)
        return {
          success: true,
          deactivated: [],
          note: `Nothing from ${bundle.name} was activated this session.`,
          toolsNowAdvertised: this.getAvailableTools().length,
        };
    }
    if (!names.length) {
      return {
        success: false,
        error: 'deactivate_tools requires names, a bundle, or all:true to clear every activation.',
      };
    }

    const deactivated: string[] = [];
    const notActivated: string[] = [];
    for (const raw of names) {
      const name = raw.trim();
      if (this.activatedTools.delete(name)) deactivated.push(name);
      else notActivated.push(name);
    }
    if (deactivated.length) this.notifyExposureChanged();

    const exposed = this.getAvailableTools();
    return {
      success: deactivated.length > 0,
      deactivated,
      // A name the configured profile advertises is not an activation and cannot be
      // dropped here; saying so beats reporting a removal that did not happen.
      ...(notActivated.length
        ? {
            notActivated,
            note: 'These were not activated this session. A tool the configured profile advertises cannot be deactivated — change PREMIERE_MCP_PROFILE instead.',
          }
        : {}),
      toolsNowAdvertised: exposed.length,
      contextCost: this.measureCatalogueCost(exposed),
      listChangedNotified: deactivated.length > 0,
    };
  }

  /**
   * What each tool does, by name. One entry per tool in the catalogue (a test checks both
   * directions), so a tool cannot be advertised without a handler or handled without being
   * advertised. Arguments arrive already validated against the tool's schema.
   */
  private readonly handlers: Record<string, ToolHandler> = {
    // Discovery Tools
    list_project_items: async (args) => {
      return await this.projectMedia.listProjectItems(args.includeBins, args.includeMetadata, {
        limit: args.limit,
        offset: args.offset,
        nameContains: args.nameContains,
        type: args.type,
        binPath: args.binPath,
      });
    },
    list_sequences: async () => {
      return await this.sequenceTrack.listSequences();
    },
    list_sequence_tracks: async (args) => {
      return await this.sequenceTrack.listSequenceTracks(args.sequenceId);
    },
    get_project_info: async () => {
      return this.withProjectNotes(await this.projectMedia.getProjectInfo());
    },
    what_changed: async (args) => {
      return await this.whatChanged(args);
    },
    revert_last_call: async (args) => {
      return await this.revertLastCall(args);
    },
    get_project_notes: async () => {
      return await this.getProjectNotes();
    },
    add_project_note: async (args) => {
      return await this.addProjectNote(args);
    },
    verify_premiere_connection: async () => {
      return await this.verifyPremiereConnection();
    },
    get_capabilities: async (args) => {
      return await this.getCapabilities(args.checkConnection, args.probeLocalTools);
    },
    remove_silence: async (args) => {
      return await this.removeSilence(args);
    },
    sync_by_audio: async (args) => {
      return await this.syncByAudio(args);
    },
    stringout_from_transcript: async (args) => {
      return await this.stringoutFromTranscript(args);
    },
    look_at_cut: async (args) => {
      return await this.lookAtCut(args);
    },
    version_up_shots: async (args) => {
      const media: any = await this.bridge.executeScript(`
        try {
          var out = [];
          (function walk(it){ for (var i = 0; i < it.children.numItems; i++) { var c = it.children[i]; if (c.type === 2) { walk(c); continue; } var p = ''; try { p = String(c.getMediaPath()); } catch (e) {} if (p) out.push({ id: String(c.nodeId), name: String(c.name), path: p }); } })(app.project.rootItem);
          return JSON.stringify({ success: true, items: out });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
      if (!media?.success) return media;
      const filter = args.shotFilter ? String(args.shotFilter).toLowerCase() : '';
      const items = (media.items as ProjectMedia[]).filter(
        (m) =>
          !filter || m.name.toLowerCase().includes(filter) || m.path.toLowerCase().includes(filter),
      );
      const ownDirs = [
        ...new Set(
          items
            .filter((m) => parseVersioned(m.path.split(/[\\/]/).pop() ?? ''))
            .map((m) => folderOf(m.path)),
        ),
      ];
      const files = [
        ...listCandidateFiles(ownDirs, false),
        ...listCandidateFiles((args.renderDirs ?? []).map(String), args.recursive !== false),
      ];
      const plan = planVersionUp(items, files);
      if (args.dryRun === true)
        return {
          success: true,
          dryRun: true,
          toRelink: plan.relink,
          alreadyCurrent: plan.current.length,
          unversionedItems: plan.unversionedCount,
          foldersSearched: ownDirs.length + (args.renderDirs?.length ?? 0),
        };
      const applied: any[] = [];
      for (const p of plan.relink) {
        const r: any = await this.executeTool('replace_clip_media', {
          projectItemId: p.id,
          newFilePath: p.to,
        });
        const ok = r?.success !== false;
        applied.push({
          shot: p.shot,
          from: `v${p.fromVersion}`,
          to: `v${p.toVersion}`,
          item: r?.data?.item ?? p.name,
          ok,
          error: ok ? undefined : (r?.error ?? 'relink failed'),
        });
      }
      const failed = applied.filter((a) => !a.ok).length;
      return {
        success: failed === 0,
        relinked: applied.length - failed,
        failed,
        alreadyCurrent: plan.current.length,
        results: applied,
        note:
          applied.length === 0
            ? 'Every versioned shot is already on its newest version in the folders searched.'
            : 'Timeline clips keep their trims and effects; relinked media can render black for a moment while Premiere loads it.',
      };
    },
    where_used: async (args) => {
      return await this.bridge.executeScript(`
        try {
          var it = __findProjectItem(${JSON.stringify(String(args.projectItemId ?? ''))});
          if (!it) return JSON.stringify({ success: false, error: 'Project item not found' });
          var u = __usesOf(it, ${Math.max(1, Math.min(Number(args.limit) || 50, 500))});
          return JSON.stringify({ success: true, item: String(it.name), isBin: it.type === 2, usedCount: u.total, sequences: u.sequences, uses: u.uses, unused: u.total === 0 });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
    },
    get_recent_calls: async (args) => {
      return {
        success: true,
        calls: recentCalls({
          limit: args.limit,
          mutatingOnly: args.mutatingOnly,
          sinceSeconds: args.sinceSeconds,
        }),
        note: 'status "running" with no finishedAt means the call was still in Premiere when this was read, or the server stopped mid-call.',
      };
    },
    start_job: async (args, options) => {
      const target = String(args.tool ?? '');
      if (!target || target === 'start_job')
        return { success: false, error: 'tool is required and cannot be start_job.' };
      const job = startJob(target, () => this.executeTool(target, args.args ?? {}, options));
      return {
        success: true,
        jobId: job.jobId,
        tool: target,
        status: job.status,
        note: 'Poll get_job with this jobId.',
      };
    },
    get_job: async (args) => {
      const job = getJob(String(args.jobId ?? ''));
      return job
        ? { success: true, ...job }
        : {
            success: false,
            error:
              'No such job in this server process (jobs do not survive a server restart; get_recent_calls still shows whether the call finished).',
          };
    },
    list_jobs: async () => {
      return { success: true, jobs: listJobs() };
    },
    find_tool: async (args) => {
      return this.findTool(args);
    },
    get_tool_typings: async (args) => {
      return this.getToolTypings(args);
    },
    call_tool: async (args) => {
      return await this.callTool(args);
    },
    activate_tools: async (args) => {
      return this.activateTools(args);
    },
    deactivate_tools: async (args) => {
      return this.deactivateTools(args);
    },
    [TRANSACTION_TOOL_NAME]: async (args) => {
      return await this.transactSequenceEdits(args);
    },
    validate_project_for_export: async (args) => {
      return await this.exportRender.validateProjectForExport(
        args.sequenceId,
        args.outputPath,
        args.presetPath,
        args.requireNonEmptyTimeline,
        args.checkGaps,
      );
    },
    get_encoder_presets: async (args) => {
      return await this.exportRender.getEncoderPresets(args.directories);
    },
    build_motion_graphics_demo: async (args) => {
      return await this.graphics.buildMotionGraphicsDemo(args.sequenceName);
    },
    assemble_product_spot: async (args) => {
      return await this.assembleProductSpot(args as AssembleProductSpotArgs);
    },
    build_brand_spot_from_mogrt_and_assets: async (args) => {
      return await this.buildBrandSpotFromMogrtAndAssets(args as BuildBrandSpotArgs);
    },
    // Project Management
    create_project: async (args) => {
      return await this.projectMedia.createProject(args.name, args.location);
    },
    open_project: async (args) => {
      return await this.projectMedia.openProject(args.path);
    },
    save_project: async () => {
      return await this.projectMedia.saveProject();
    },
    save_project_as: async (args) => {
      return await this.projectMedia.saveProjectAs(args.name, args.location);
    },
    close_project: async (args) => {
      return await this.projectMedia.closeProject(
        args.saveFirst ?? false,
        args.closeIfLast ?? false,
      );
    },
    list_open_projects: async () => {
      return await this.projectMedia.listOpenProjects();
    },
    list_recent_projects: async (args) => {
      return this.projectMedia.listRecentProjects(args.limit ?? 10, args.excludeAutosave ?? true);
    },
    read_clipboard: async () => {
      return this.projectMedia.clipboardRead();
    },
    write_clipboard: async (args) => {
      return this.projectMedia.clipboardWrite(args.text);
    },
    get_sequence_render_status: async (args) => {
      return await this.exportRender.getSequenceRenderStatus(args.sequenceId);
    },
    render_sequence_previews: async (args) => {
      return await this.exportRender.renderSequencePreviews(
        args.sequenceId,
        args.renderAll ?? false,
      );
    },
    set_essential_sound_category: async (args) => {
      return await this.audio.setEssentialSoundCategory(args.projectItemId, args.category);
    },
    open_project_item_in_source: async (args) => {
      return await this.sourceMonitor.openProjectItemInSource(args.projectItemId, args.timecode);
    },
    // Navigation
    go_to_sequence_start: async (args) => {
      return await this.playback.goToSequenceStart(args.sequenceId);
    },
    go_to_sequence_end: async (args) => {
      return await this.playback.goToSequenceEnd(args.sequenceId);
    },
    go_to_in_point: async (args) => {
      return await this.playback.goToInPoint(args.sequenceId);
    },
    go_to_out_point: async (args) => {
      return await this.playback.goToOutPoint(args.sequenceId);
    },
    step_frames: async (args) => {
      return await this.playback.stepFrames(args.frames, args.sequenceId);
    },
    get_playback_state: async (args) => {
      return await this.playback.getPlaybackState(args.sequenceId);
    },
    // Trimming
    ripple_trim_in: async (args) => {
      return await this.trimming.rippleTrimIn(args.sequenceId, args.trackIndex, args.clipIndex);
    },
    ripple_trim_out: async (args) => {
      return await this.trimming.rippleTrimOut(args.sequenceId, args.trackIndex, args.clipIndex);
    },
    extend_edit: async (args) => {
      return await this.trimming.extendEdit(args.sequenceId, args.trackIndex, args.clipIndex);
    },
    nudge_clip: async (args) => {
      return await this.trimming.nudgeClip(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.frames,
      );
    },
    // J/L Cuts
    j_cut: async (args) => {
      return await this.audio.jCut(
        args.sequenceId,
        args.videoTrackIndex,
        args.clipIndex,
        args.frames,
      );
    },
    l_cut: async (args) => {
      return await this.audio.lCut(
        args.sequenceId,
        args.videoTrackIndex,
        args.clipIndex,
        args.frames,
      );
    },
    // 3-point edit
    three_point_edit: async (args) => {
      return await this.assembly.threePointEdit(
        args.projectItemId,
        args.sourceIn,
        args.sourceOut,
        args.sequenceTimecode,
        args.mode ?? 'overwrite',
        args.videoTrackIndex ?? 0,
        args.audioTrackIndex ?? 0,
      );
    },
    // Gaps & tracks
    close_gap_at: async (args) => {
      return await this.trimming.closeGapAt(args.timecode, args.sequenceId);
    },
    close_all_gaps: async (args) => {
      return await this.trimming.closeAllGaps(
        args.sequenceId,
        args.trackIndex,
        args.includeLeadingGap === true,
      );
    },
    delete_empty_tracks: async (args) => {
      return await this.sequenceTrack.deleteEmptyTracks(
        args.sequenceId,
        args.video ?? true,
        args.audio ?? true,
      );
    },
    // Selection
    get_sequence_selection: async (args) => {
      return await this.playback.getSequenceSelection(args.sequenceId);
    },
    set_sequence_selection: async (args) => {
      return await this.playback.setSequenceSelection(args.clips, args.sequenceId);
    },
    // Markers
    create_marker: async (args) => {
      return await this.marker.createMarker(
        args.timecode as number,
        args.name,
        args.comment,
        args.type,
        args.colorIndex,
        args.durationSeconds,
        args.sequenceId,
      );
    },
    // Batch 1: Lumetri
    lumetri_basic_set: async (args) => {
      return await this.color.lumetriBasicSet(args);
    },
    lumetri_creative_set: async (args) => {
      return await this.color.lumetriCreativeSet(args);
    },
    lumetri_vignette_set: async (args) => {
      return await this.color.lumetriVignetteSet(args);
    },
    lumetri_report: async (args) => {
      return await this.color.lumetriReport(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
      );
    },
    copy_grade: async (args) => {
      return await this.color.copyGrade(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0);
    },
    paste_grade_to_clips: async (args) => {
      return await this.color.pasteGradeToClips(args.gradeJson, args.targets, args.sequenceId);
    },
    auto_white_balance: async (args) => {
      return await this.color.autoWhiteBalance(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
      );
    },
    set_lut_interpolation: async (args) => {
      return await this.color.setLutInterpolation(args.method);
    },
    // Batch 2: Motion/Transform
    flip_horizontal: async (args) => {
      return await this.motionLayout.flipClip(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        'horizontal',
      );
    },
    flip_vertical: async (args) => {
      return await this.motionLayout.flipClip(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        'vertical',
      );
    },
    fade_in_video: async (args) => {
      return await this.motionLayout.fadeVideo(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        args.durationFrames,
        'in',
      );
    },
    fade_out_video: async (args) => {
      return await this.motionLayout.fadeVideo(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        args.durationFrames,
        'out',
      );
    },
    reset_transform: async (args) => {
      return await this.motionLayout.resetTransform(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
      );
    },
    match_transform: async (args) => {
      return await this.motionLayout.matchTransform(
        args.sequenceId,
        args.sourceTrackIndex,
        args.sourceClipIndex,
        args.targets,
      );
    },
    letterbox: async (args) => {
      return await this.motionLayout.applyLetterbox(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        args.aspect,
        args.cropPercent,
      );
    },
    ken_burns: async (args) => {
      return await this.motionLayout.kenBurns(args);
    },
    set_clip_scale_to_frame_size: async (args) => {
      return await this.motionLayout.setClipScaleToFrameSize(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        args.enabled ?? true,
      );
    },
    set_scale_to_frame_size_batch: async (args) => {
      return await this.motionLayout.setScaleToFrameSizeBatch(
        args.enabled ?? true,
        args.sequenceId,
        args.trackIndex,
        args.clipIds,
      );
    },
    // Batch 3: Audio
    fade_in_audio: async (args) => {
      return await this.audio.fadeAudio(
        args.sequenceId,
        args.audioTrackIndex ?? 0,
        args.clipIndex ?? 0,
        args.durationFrames,
        'in',
      );
    },
    fade_out_audio: async (args) => {
      return await this.audio.fadeAudio(
        args.sequenceId,
        args.audioTrackIndex ?? 0,
        args.clipIndex ?? 0,
        args.durationFrames,
        'out',
      );
    },
    set_clip_gain: async (args) => {
      return await this.audio.setClipGain(
        args.sequenceId,
        args.audioTrackIndex ?? 0,
        args.clipIndex ?? 0,
        args.gainDb,
      );
    },
    audio_crossfade_at_cut: async (args) => {
      return await this.audio.audioCrossfadeAtCut(
        args.sequenceId,
        args.audioTrackIndex ?? 0,
        args.clipIndex,
        args.durationFrames ?? 15,
      );
    },
    mute_clip_audio: async (args) => {
      return await this.audio.muteClipAudio(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        args.mute ?? true,
      );
    },
    loudness_report: async (args) => {
      return this.audio.loudnessReport(args.filePath);
    },
    normalize_clip_peaks: async (args) => {
      return await this.audio.normalizeClipPeaks(
        args.sequenceId,
        args.audioTrackIndex ?? 0,
        args.clipIndex ?? 0,
        args.targetDbfs ?? -1,
      );
    },
    // Batch 4: Export
    export_in_out_range: async (args) => {
      return await this.exportRender.exportInOutRange(
        args.outputPath,
        args.presetPath,
        args.sequenceId,
      );
    },
    list_all_encoder_presets: async (args) => {
      return this.exportRender.listAllEncoderPresets(args.format);
    },
    create_custom_export_preset: async (args) => {
      return this.exportRender.createCustomExportPreset(
        args.format,
        args.basePresetName,
        args.params,
        args.outputPresetPath,
      );
    },
    export_social_preset: async (args) => {
      return await this.exportRender.exportSocialPreset(
        args.outputPath,
        args.preset,
        args.sequenceId,
      );
    },
    export_audio_only: async (args) => {
      return await this.exportRender.exportAudioOnly(
        args.outputPath,
        args.format ?? 'wav',
        args.sequenceId,
      );
    },
    verify_export: async (args) => {
      return this.exportRender.verifyExport(
        args.filePath,
        args.expectedDurationSecs,
        args.expectedFps,
        args.expectedWidth,
        args.expectedHeight,
      );
    },
    // Batch 5: Batch & Metadata
    markers_to_csv: async (args) => {
      return await this.marker.markersToCsv(args.outputPath, args.sequenceId);
    },
    markers_from_csv: async (args) => {
      return await this.marker.markersFromCsv(args.csvPath, args.sequenceId);
    },
    add_metadata_schema_field: async (args) => {
      return await this.projectMedia.addMetadataSchemaField(
        args.columnId,
        args.displayName,
        args.type ?? 0,
      );
    },
    set_item_metadata: async (args) => {
      return await this.projectMedia.setItemMetadata(args.projectItemId, args.key, args.value);
    },
    get_item_metadata_columns: async (args) => {
      return await this.projectMedia.getItemMetadataColumns(args.projectItemId);
    },
    batch_set_label: async (args) => {
      return await this.projectMedia.batchSetLabel(args.projectItemIds, args.labelColor);
    },
    batch_rename_project_items: async (args) => {
      return await this.projectMedia.batchRenameProjectItems(args.renames);
    },
    // Batch 6: Review & Delivery
    assemble_review_reel: async (args) => {
      return await this.reviewDelivery.assembleReviewReel(
        args.sequenceIds,
        args.reelName,
        args.handles ?? 0,
      );
    },
    version_up_sequence: async (args) => {
      return await this.reviewDelivery.versionUpSequence(args.sequenceId, args.setActive ?? true);
    },
    shot_status_report: async () => {
      return await this.reviewDelivery.shotStatusReport();
    },
    notes_to_markers: async (args) => {
      return await this.reviewDelivery.notesToMarkers(
        args.notesPath,
        args.sequenceId,
        args.markerType ?? 'Comment',
        args.colorIndex,
      );
    },
    markers_to_notes: async (args) => {
      return await this.reviewDelivery.markersToNotes(
        args.outputPath,
        args.sequenceId,
        args.format ?? 'text',
      );
    },
    delivery_qc: async (args) => {
      return await this.reviewDelivery.deliveryQc(args.sequenceId);
    },
    // Batch 7: VFX & Interchange
    vfx_pull_list: async (args) => {
      return await this.interchange.vfxPullList(
        args.sequenceId,
        args.handles ?? 8,
        args.trackIndex ?? 0,
      );
    },
    cut_list_csv: async (args) => {
      return await this.interchange.cutListCsv(
        args.outputPath,
        args.sequenceId,
        args.trackIndex ?? 0,
      );
    },
    export_sequence_as_project: async (args) => {
      return await this.exportRender.exportSequenceAsProject(args.outputPath, args.sequenceId);
    },
    change_list_report: async (args) => {
      return await this.interchange.changeListReport(args.sequenceIdA, args.sequenceIdB);
    },
    get_item_treepath: async (args) => {
      return await this.projectMedia.getItemTreepath(args.projectItemId);
    },
    // Batch 8: MOGRT/Titles
    set_mogrt_text: async (args) => {
      return await this.graphics.setMogrtText(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        args.paramName,
        args.text,
      );
    },
    set_mogrt_param: async (args) => {
      return await this.graphics.setMogrtParam(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        args.paramName,
        args.value,
      );
    },
    mogrt_params_report: async (args) => {
      return await this.graphics.mogrtParamsReport(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
      );
    },
    timecode_burn_in: async (args) => {
      return await this.graphics.timecodeBurnIn(
        args.sequenceId,
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
      );
    },
    // Batch 9: QE + Productions
    get_renderer_names: async () => {
      return await this.exportRender.getRendererNames();
    },
    set_renderer: async (args) => {
      return await this.exportRender.setRenderer(args.rendererName);
    },
    sync_lock_track: async (args) => {
      return await this.interchange.syncLockTrack(
        args.sequenceId,
        args.trackType,
        args.trackIndex,
        args.locked,
      );
    },
    render_audio: async (args) => {
      return await this.audio.renderAudio(args.sequenceId);
    },
    get_production_list: async () => {
      return await this.interchange.getProductionList();
    },
    get_lumetri_preset_list: async (args) => {
      return await this.color.getLumetriPresetList(args.folder);
    },
    set_sequence_in_out_qe: async (args) => {
      return await this.sequenceTrack.setSequenceInOutQe(
        args.inPoint,
        args.outPoint,
        args.sequenceId,
      );
    },
    get_qe_sequence_props: async (args) => {
      return await this.sequenceTrack.getQeSequenceProps(args.sequenceId);
    },
    // Batch A: Navigation
    go_to_next_marker: async (args) => {
      return await this.playback.goToNextMarker(args.sequenceId);
    },
    go_to_prev_marker: async (args) => {
      return await this.playback.goToPrevMarker(args.sequenceId);
    },
    go_to_timecode: async (args) => {
      return await this.playback.goToTimecode(args.timecode, args.sequenceId);
    },
    play_in_to_out: async (args) => {
      return await this.playback.playInToOut(args.sequenceId);
    },
    get_edit_point_list: async (args) => {
      return await this.sequenceTrack.getEditPointList(args.sequenceId, args.videoOnly);
    },
    detect_settings_mismatch: async (args) => {
      return await this.sequenceTrack.detectSettingsMismatch(args.sequenceId);
    },
    count_tracks_used: async (args) => {
      return await this.sequenceTrack.countTracksUsed(args.sequenceId);
    },
    sequence_thumbnail_strip: async (args) => {
      return this.sequenceTrack.sequenceThumbnailStrip(
        args.filePath,
        args.count ?? 10,
        args.outputDir,
      );
    },
    // Batch B: QE clip ops
    set_clip_reverse: async (args) => {
      return await this.speedTime.setClipReverse(
        args.trackIndex,
        args.clipIndex,
        args.reverse,
        args.sequenceId,
      );
    },
    set_frame_blend_qe: async (args) => {
      return await this.motionLayout.setFrameBlendQe(
        args.trackIndex,
        args.clipIndex,
        args.enabled,
        args.sequenceId,
      );
    },
    set_time_interpolation_type: async (args) => {
      return await this.keyframe.setTimeInterpolationType(
        args.trackIndex,
        args.clipIndex,
        args.type,
        args.sequenceId,
      );
    },
    set_clip_border_color: async (args) => {
      return await this.color.setClipBorderColor(
        args.trackIndex,
        args.clipIndex,
        args.r,
        args.g,
        args.b,
        args.sequenceId,
      );
    },
    set_clip_border_width: async (args) => {
      return await this.motionLayout.setClipBorderWidth(
        args.trackIndex,
        args.clipIndex,
        args.width,
        args.sequenceId,
      );
    },
    rename_timeline_clip: async (args) => {
      return await this.projectMedia.renameTimelineClip(
        args.trackIndex,
        args.clipIndex,
        args.name,
        args.sequenceId,
      );
    },
    get_qe_component_params: async (args) => {
      return await this.getQeComponentParams(
        args.trackIndex,
        args.clipIndex,
        args.componentIndex,
        args.sequenceId,
      );
    },
    set_qe_component_param: async (args) => {
      return await this.setQeComponentParam(
        args.trackIndex,
        args.clipIndex,
        args.componentIndex,
        args.paramName,
        args.value,
        args.sequenceId,
      );
    },
    remove_effect_at_index: async (args) => {
      return await this.effects.removeEffectAtIndex(
        args.trackIndex,
        args.clipIndex,
        args.componentIndex,
        args.sequenceId,
      );
    },
    reorder_effects: async (args) => {
      return await this.effects.reorderEffects(
        args.trackIndex,
        args.clipIndex,
        args.newOrder,
        args.sequenceId,
      );
    },
    // Batch C: Audio
    apply_audio_effect_qe: async (args) => {
      return await this.audio.applyAudioEffectQe(
        args.trackIndex,
        args.clipIndex,
        args.effectName,
        args.audioTrack ?? true,
        args.sequenceId,
      );
    },
    denoise_clip: async (args) => {
      return await this.audio.denoiseClip(args.trackIndex, args.clipIndex, args.sequenceId);
    },
    list_audio_effects_on_clip: async (args) => {
      return await this.audio.listAudioEffectsOnClip(
        args.trackIndex,
        args.clipIndex,
        args.sequenceId,
      );
    },
    audio_peaks_report: async (args) => {
      return this.audio.audioPeaksReport(args.filePath);
    },
    apply_dynamics: async (args) => {
      return await this.applyDynamics(args.trackIndex, args.clipIndex, args.sequenceId);
    },
    set_track_volume_keyframes: async (args) => {
      return await this.audio.setTrackVolumeKeyframes(
        args.trackIndex,
        args.keyframes,
        args.sequenceId,
      );
    },
    // Batch D: Captions
    export_captions_to_srt: async (args) => {
      return await this.caption.exportCaptionsToSrt(args.outputPath, args.sequenceId);
    },
    caption_qc_report: async (args) => {
      return this.caption.captionQcReport(
        args.srtPath,
        args.maxCps ?? 17,
        args.maxLineLength ?? 42,
      );
    },
    caption_qc_fix: async (args) => {
      return this.caption.captionQcFix(
        args.srtPath,
        args.outputPath,
        args.maxCps ?? 17,
        args.minGapMs ?? 80,
      );
    },
    captions_from_transcript_json: async (args) => {
      return this.caption.captionsFromTranscriptJson(
        args.jsonPath,
        args.outputPath,
        args.maxCps ?? 17,
        args.maxLineLength ?? 42,
      );
    },
    srt_diff: async (args) => {
      return this.caption.srtDiff(args.srtPathA, args.srtPathB);
    },
    captions_to_markers: async (args) => {
      return await this.caption.captionsToMarkers(
        args.srtPath,
        args.sequenceId,
        args.markerType ?? 'Comment',
      );
    },
    // Batch E: Project lifecycle
    open_fcp_xml: async (args) => {
      return await this.interchange.openFcpXml(args.filePath, args.sequenceName);
    },
    get_project_stats: async () => {
      return await this.projectMedia.getProjectStats();
    },
    write_sidecar_file: async (args) => {
      return await this.writeSidecarFile(args.fileName, args.fileExtension, args.contents);
    },
    get_ea_login_status: async () => {
      return await this.getEaLoginStatus();
    },
    list_sequences_by_name: async (args) => {
      return await this.sequenceTrack.listSequencesByName(args.pattern);
    },
    // Batch F: Sequence utilities
    set_sequence_in_out_from_clips: async (args) => {
      return await this.sequenceTrack.setSequenceInOutFromClips(args.sequenceId);
    },
    get_bin_tree: async (args) => {
      return await this.projectMedia.getBinTree(args.includeItems ?? false);
    },
    find_clips_with_effect: async (args) => {
      return await this.effects.findClipsWithEffect(args.effectName);
    },
    effect_stack_report: async (args) => {
      return await this.effects.effectStackReport(args.trackIndex, args.clipIndex, args.sequenceId);
    },
    enable_disable_effect: async (args) => {
      return await this.effects.enableDisableEffect(
        args.trackIndex,
        args.clipIndex,
        args.effectName,
        args.enabled,
        args.sequenceId,
      );
    },
    batch_add_audio_crossfades: async (args) => {
      return await this.audio.batchAddAudioCrossfades(args.durationSeconds ?? 0.5, args.sequenceId);
    },
    flush_sequence_cache: async (args) => {
      return await this.sequenceTrack.flushSequenceCache(args.sequenceId);
    },
    set_render_preview_quality: async (args) => {
      return await this.exportRender.setRenderPreviewQuality(
        args.useMaxQuality,
        args.presetPath,
        args.width,
        args.height,
        args.sequenceId,
      );
    },
    // Batch G: Clip properties
    get_clip_color_space: async (args) => {
      return await this.color.getClipColorSpace(args.projectItemId);
    },
    set_clip_color_space: async (args) => {
      return await this.color.setClipColorSpace(args.projectItemId, args.colorSpaceName);
    },
    get_clip_info_extended: async (args) => {
      return await this.projectMedia.getClipInfoExtended(args.projectItemId);
    },
    batch_relink_by_pattern: async (args) => {
      return await this.projectMedia.batchRelinkByPattern(args.oldPrefix, args.newPrefix);
    },
    set_item_poster_frame: async (args) => {
      return await this.projectMedia.setItemPosterFrame(args.projectItemId, args.timeSecs);
    },
    // Batch H: Effects shortcuts
    blur_clip: async (args) => {
      return await this.effects.blurClip(
        args.trackIndex,
        args.clipIndex,
        args.amount,
        args.sequenceId,
      );
    },
    sharpen_clip: async (args) => {
      return await this.effects.sharpenClip(
        args.trackIndex,
        args.clipIndex,
        args.amount ?? 50,
        args.sequenceId,
      );
    },
    enable_disable_all_effects: async (args) => {
      return await this.effects.enableDisableAllEffects(
        args.trackIndex,
        args.clipIndex,
        args.enabled,
        args.sequenceId,
      );
    },
    remove_all_effects_qe: async (args) => {
      return await this.effects.removeAllEffectsQe(
        args.trackIndex,
        args.clipIndex,
        args.sequenceId,
      );
    },
    apply_lut_to_clip: async (args) => {
      return await this.color.applyLutToClip(
        args.trackIndex,
        args.clipIndex,
        args.lutPath,
        args.sequenceId,
        args.installIfMissing,
      );
    },
    list_effects_on_clip_qe: async (args) => {
      return await this.effects.listEffectsOnClipQe(
        args.trackIndex,
        args.clipIndex,
        args.sequenceId,
      );
    },
    timecode_to_frames: async (args) => {
      return await this.playback.timecodeToFrames(args.timecode, args.frameRate);
    },
    frames_to_timecode: async (args) => {
      return await this.playback.framesToTimecode(args.frames, args.frameRate);
    },
    // Media Management
    import_media: async (args) => {
      return await this.projectMedia.importMedia(args.filePath, args.binName, args.binId);
    },
    import_fcp_xml: async (args) => {
      return await this.interchange.importFcpXml(args.filePath);
    },
    import_edl: async (args) => {
      return await this.interchange.importEdl(args.filePath);
    },
    import_folder: async (args) => {
      return await this.projectMedia.importFolder(
        args.folderPath,
        args.binName,
        args.recursive,
        args.binId,
      );
    },
    create_bin: async (args) => {
      return await this.projectMedia.createBin(args.name, args.parentBinName, args.parentBinId);
    },
    // Sequence Management
    create_sequence: async (args) => {
      return await this.sequenceTrack.createSequence(args.name, args.presetPath, args.frameRate);
    },
    duplicate_sequence: async (args) => {
      return await this.sequenceTrack.duplicateSequence(
        args.sequenceId,
        args.newName,
        args.clearContents,
      );
    },
    create_recovery_checkpoint: async (args) => {
      return await this.createRecoveryCheckpoint(args.sequenceId, args.label);
    },
    list_recovery_checkpoints: async (args) => {
      return await this.listRecoveryCheckpoints(args.labelContains);
    },
    restore_recovery_checkpoint: async (args) => {
      return await this.restoreRecoveryCheckpoint(
        args.checkpointSequenceId,
        args.newName,
        args.setActive,
      );
    },
    delete_sequence: async (args) => {
      return await this.sequenceTrack.deleteSequence(args.sequenceId);
    },
    read_sequence_captions: async (args) => {
      return await this.caption.readSequenceCaptions(args.sequenceId);
    },
    read_srt: async (args) => {
      return await this.caption.readSrtFile(args.srtPath);
    },
    validate_srt: async (args) => {
      return await this.caption.validateSrtFile(args.srtPath);
    },
    write_srt: async (args) => {
      return await this.caption.writeSrtFile(args.srtPath, args.cues, args.allowInvalid);
    },
    update_srt_cue: async (args) => {
      return await this.caption.updateSrtCue(args.srtPath, args.index, {
        start: args.start,
        end: args.end,
        text: args.text,
      });
    },
    insert_srt_cue: async (args) => {
      return await this.caption.insertSrtCue(args.srtPath, args.start, args.end, args.text);
    },
    remove_srt_cue: async (args) => {
      return await this.caption.removeSrtCue(args.srtPath, args.index);
    },
    shift_srt_timing: async (args) => {
      return await this.caption.shiftSrtTiming(
        args.srtPath,
        args.offsetSeconds,
        args.scaleFactor,
        args.fromIndex,
        args.toIndex,
      );
    },
    rename_project_item: async (args) => {
      return await this.projectMedia.renameProjectItem(args.projectItemId, args.newName);
    },
    // Timeline Operations
    add_to_timeline: async (args) => {
      return await this.assembly.addToTimeline(
        args.sequenceId,
        args.projectItemId,
        args.trackIndex,
        args.time,
        args.insertMode,
        args.linkAudio,
        args.sourceInPoint,
        args.sourceOutPoint,
      );
    },
    add_to_timeline_batch: async (args) => {
      return await this.assembly.addToTimelineBatch(args.sequenceId, args.clips, args.mode);
    },
    remove_from_timeline: async (args) => {
      return await this.assembly.removeFromTimeline(args.clipId, args.sequenceId, args.deleteMode);
    },
    move_clip: async (args) => {
      return await this.moveClip(args.clipId, args.newTime);
    },
    trim_clip: async (args) => {
      return await this.trimming.trimClip(args.clipId, args.inPoint, args.outPoint, args.duration);
    },
    split_clip: async (args) => {
      return await this.assembly.splitClip(args.clipId, args.splitTime);
    },
    razor_timeline_at_time: async (args) => {
      return await this.assembly.razorTimelineAtTime(
        args.sequenceId,
        args.time,
        args.videoTrackIndices,
        args.audioTrackIndices,
      );
    },
    // Effects and Transitions
    apply_effect: async (args) => {
      return await this.effects.applyEffect(
        args.clipId,
        args.effectName,
        args.parameters,
        args.expectedMatchName,
      );
    },
    crop_clip: async (args) => {
      return await this.motionLayout.cropClip(args.clipId, {
        left: args.left,
        right: args.right,
        top: args.top,
        bottom: args.bottom,
        zoom: args.zoom,
        edgeFeather: args.edgeFeather,
      });
    },
    add_transition: async (args) => {
      const qeResult: any = await this.effects.addTransition(
        args.clipId1,
        args.clipId2,
        args.transitionName,
        args.duration,
      );
      if (qeResult?.success !== false || !uxpAvailable()) return qeResult;
      // The QE route failed or could not prove the edit; try UXP at the same cut.
      const cut: any = await this.bridge.executeScript(`
        try {
          var a = __findClip(${JSON.stringify(String(args.clipId1))});
          if (!a || a.trackType !== 'video') return JSON.stringify({ success: false });
          return JSON.stringify({ success: true, seq: String(a.sequenceId), track: a.trackIndex, cut: a.clip.end.seconds });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
      if (!cut?.success) return qeResult;
      const viaUxp: any = await this.effects.uxpTransitionAtCut(
        cut.seq,
        cut.track,
        cut.cut,
        args.transitionName,
        args.duration,
      );
      return viaUxp.success
        ? { ...viaUxp, qeAttempt: qeResult?.error ?? null }
        : { ...qeResult, uxpAttempt: viaUxp.error };
    },
    add_transition_to_clip: async (args) => {
      return await this.effects.addTransitionToClip(
        args.clipId,
        args.transitionName,
        args.position,
        args.duration,
      );
    },
    // Audio Analysis
    detect_silence: async (args) => {
      return await this.audio.detectSilence(
        args.mediaPath,
        args.projectItemId,
        args.noiseThresholdDb,
        args.minDurationSeconds,
      );
    },
    // Audio Operations
    adjust_audio_levels: async (args) => {
      return await this.audio.adjustAudioLevels(args.clipId, args.level);
    },
    add_audio_keyframes: async (args) => {
      return await this.audio.addAudioKeyframes(args.clipId, args.keyframes);
    },
    setup_ducking: async (args) => {
      return await this.audio.setupDucking(
        args.clipId,
        args.baseDb,
        args.duckingWindows,
        args.fadeSeconds,
        args.clipStartTime,
        args.clipEndTime,
      );
    },
    mute_track: async (args) => {
      return await this.audio.muteTrack(args.sequenceId, args.trackIndex, args.muted);
    },
    // Text and Graphics
    add_text_overlay: async (args) => {
      return await this.graphics.addTextOverlay(args);
    },
    // Color Correction
    color_correct: async (args) => {
      return await this.color.colorCorrect(args.clipId, args);
    },
    apply_lut: async (args) => {
      return await this.color.applyLut(
        args.clipId,
        args.lutPath,
        args.intensity,
        args.installIfMissing,
      );
    },
    // Export and Rendering
    export_sequence: async (args) => {
      return await this.exportRender.exportSequence({
        sequenceId: args.sequenceId,
        outputPath: args.outputPath,
        presetPath: args.presetPath,
        presetName: args.presetName,
        sourceRange: args.sourceRange,
        allowOverwrite: args.allowOverwrite,
        removeOnCompletion: args.removeOnCompletion,
        format: args.format,
        quality: args.quality,
        resolution: args.resolution,
      });
    },
    export_frame: async (args) => {
      return await this.exportRender.exportFrame(
        args.sequenceId,
        args.time,
        args.outputPath,
        args.format,
      );
    },
    // Markers
    add_marker: async (args) => {
      return await this.marker.addMarker(
        args.sequenceId,
        args.time,
        args.name,
        args.comment,
        args.color,
        args.duration,
      );
    },
    delete_marker: async (args) => {
      return await this.marker.deleteMarker(args.sequenceId, args.markerId);
    },
    update_marker: async (args) => {
      return await this.marker.updateMarker(args.sequenceId, args.markerId, args);
    },
    list_markers: async (args) => {
      return await this.marker.listMarkers(args.sequenceId);
    },
    // Track Management
    add_track: async (args) => {
      return await this.sequenceTrack.addTrack(args.sequenceId, args.trackType, args.position);
    },
    delete_track: async (args) => {
      return await this.sequenceTrack.deleteTrack(args.sequenceId, args.trackType, args.trackIndex);
    },
    lock_track: async (args) => {
      return await this.sequenceTrack.lockTrack(
        args.sequenceId,
        args.trackType,
        args.trackIndex,
        args.locked,
      );
    },
    toggle_track_visibility: async (args) => {
      return await this.sequenceTrack.toggleTrackVisibility(
        args.sequenceId,
        args.trackIndex,
        args.visible,
      );
    },
    link_audio_video: async (args) => {
      return await this.audio.linkAudioVideo(args.clipId, args.linked);
    },
    apply_audio_effect: async (args) => {
      return await this.audio.applyAudioEffect(args.clipId, args.effectName, args.parameters);
    },
    apply_audio_effect_to_all_clips: async (args) => {
      return await this.audio.applyAudioEffectToAllClips(
        args.sequenceId,
        args.effectName,
        args.parameters,
      );
    },
    // Nested Sequences
    unnest_sequence: async (args) => {
      return await this.sequenceTrack.unnestSequence(args.nestedSequenceClipId);
    },
    // Additional Clip Operations
    duplicate_clip: async (args) => {
      return await this.assembly.duplicateClip(args.clipId, args.offset);
    },
    reverse_clip: async (args) => {
      return await this.speedTime.reverseClip(args.clipId, args.maintainAudioPitch);
    },
    enable_disable_clip: async (args) => {
      return await this.projectMedia.enableDisableClip(args.clipId, args.enabled);
    },
    replace_clip: async (args) => {
      return await this.assembly.replaceClip(
        args.clipId,
        args.newProjectItemId,
        args.preserveEffects,
      );
    },
    // Project Settings
    get_sequence_settings: async (args) => {
      return await this.sequenceTrack.getSequenceSettings(args.sequenceId);
    },
    set_sequence_settings: async (args) => {
      return await this.sequenceTrack.setSequenceSettings(args.sequenceId, args.settings);
    },
    get_clip_properties: async (args) => {
      return await this.projectMedia.getClipProperties(args.clipId, args.sequenceId);
    },
    set_clip_properties: async (args) => {
      return await this.projectMedia.setClipProperties(args.clipId, args.properties);
    },
    set_clip_properties_batch: async (args) => {
      return await this.projectMedia.setClipPropertiesBatch(args.items);
    },
    // Render Queue
    add_to_render_queue: async (args) => {
      return await this.exportRender.addToRenderQueue({
        sequenceId: args.sequenceId,
        outputPath: args.outputPath,
        presetPath: args.presetPath,
        presetName: args.presetName,
        sourceRange: args.sourceRange,
        allowOverwrite: args.allowOverwrite,
        removeOnCompletion: args.removeOnCompletion,
        startImmediately: args.startImmediately,
      });
    },
    get_render_queue_status: async (args) => {
      return await this.exportRender.getRenderQueueStatus(args.outputPath);
    },
    // Advanced Features
    stabilize_clip: async (args) => {
      return await this.effects.stabilizeClip(args.clipId, args.method, args.smoothness);
    },
    speed_change: async (args) => {
      return await this.speedTime.speedChange(args.clipId, args.speed, args.maintainAudio);
    },
    // Playhead & Work Area
    get_playhead_position: async (args) => {
      return await this.playback.getPlayheadPosition(args.sequenceId);
    },
    set_playhead_position: async (args) => {
      return await this.playback.setPlayheadPosition(args.sequenceId, args.time);
    },
    get_selected_clips: async (args) => {
      return await this.getSelectedClips(args.sequenceId);
    },
    // Effect & Transition Discovery
    list_available_effects: async () => {
      return await this.effects.listAvailableEffects();
    },
    list_available_transitions: async () => {
      return await this.effects.listAvailableTransitions();
    },
    list_available_audio_effects: async () => {
      return await this.audio.listAvailableAudioEffects();
    },
    list_available_audio_transitions: async () => {
      return await this.audio.listAvailableAudioTransitions();
    },
    // Keyframes
    add_keyframe: async (args) => {
      return await this.keyframe.addKeyframe(
        args.clipId,
        args.componentName,
        args.paramName,
        args.time,
        args.value,
      );
    },
    remove_keyframe: async (args) => {
      return await this.keyframe.removeKeyframe(
        args.clipId,
        args.componentName,
        args.paramName,
        args.time,
      );
    },
    get_keyframes: async (args) => {
      return await this.keyframe.getKeyframes(args.clipId, args.componentName, args.paramName);
    },
    bake_keyframe_ease: async (args) => {
      return await this.keyframe.bakeKeyframeEase(args);
    },
    // Work Area
    set_work_area: async (args) => {
      return await this.playback.setWorkArea(args.sequenceId, args.inPoint, args.outPoint);
    },
    get_work_area: async (args) => {
      return await this.playback.getWorkArea(args.sequenceId);
    },
    // Final batches dispatch
    pip_layout: async (args) => {
      return await this.motionLayout.pipLayout(
        args.trackIndex,
        args.clipIndex,
        args.corner,
        args.sizePercent,
        args.sequenceId,
      );
    },
    grid_layout: async (args) => {
      return await this.motionLayout.gridLayout(args.clips, args.cols, args.sequenceId);
    },
    split_screen_layout: async (args) => {
      return await this.motionLayout.splitScreenLayout(
        args.clips,
        args.orientation,
        args.sequenceId,
      );
    },
    reset_motion_to_defaults: async (args) => {
      return await this.motionLayout.resetMotionToDefaults(
        args.trackIndex,
        args.clipIndex,
        args.sequenceId,
      );
    },
    align_clips_spatial: async (args) => {
      return await this.motionLayout.alignClipsSpatial(args.clips, args.alignment, args.sequenceId);
    },
    safe_area_check: async (args) => {
      return await this.motionLayout.safeAreaCheck(args.sequenceId);
    },
    set_clip_crop: async (args) => {
      return await this.motionLayout.setClipCrop(
        args.trackIndex,
        args.clipIndex,
        args.left,
        args.top,
        args.right,
        args.bottom,
        args.sequenceId,
      );
    },
    keyframe_zoom_in: async (args) => {
      return await this.keyframe.keyframeZoom(
        args.trackIndex,
        args.clipIndex,
        100,
        args.targetScale,
        args.sequenceId,
      );
    },
    keyframe_zoom_out: async (args) => {
      return await this.keyframe.keyframeZoom(
        args.trackIndex,
        args.clipIndex,
        args.startScale,
        100,
        args.sequenceId,
      );
    },
    toggle_uniform_scale: async (args) => {
      return await this.motionLayout.toggleUniformScale(
        args.trackIndex,
        args.clipIndex,
        args.uniformScale,
        args.sequenceId,
      );
    },
    distribute_clips_evenly: async (args) => {
      return await this.sequenceTrack.distributeClipsEvenly(
        args.trackIndex,
        args.clipIndices,
        args.startSecs,
        args.endSecs,
        args.sequenceId,
      );
    },
    rate_stretch_to_fill: async (args) => {
      return await this.speedTime.rateStretchToFill(
        args.trackIndex,
        args.clipIndex,
        args.targetDurationSecs,
        args.sequenceId,
      );
    },
    fit_clip_duration: async (args) => {
      return await this.speedTime.fitClipDuration(
        args.trackIndex,
        args.clipIndex,
        args.targetSeconds,
        args.method,
        args.sequenceId,
      );
    },
    verify_speed_duration: async (args) => {
      return await this.speedTime.verifySpeedDuration(
        args.trackIndex,
        args.clipIndex,
        args.expectedSpeedPercent,
        args.sequenceId,
      );
    },
    get_clip_speed_info: async (args) => {
      return await this.speedTime.getClipSpeedInfo(
        args.trackIndex,
        args.clipIndex,
        args.sequenceId,
      );
    },
    remove_time_remap: async (args) => {
      return await this.speedTime.removeTimeRemap(args.trackIndex, args.clipIndex, args.sequenceId);
    },
    slowmo_quality_report: async (args) => {
      return this.speedTime.slowmoQualityReport(args.sourceFps, args.targetSpeedPercent);
    },
    speed_ramp_bake: async (args) => {
      return await this.speedTime.speedRampBake(
        args.trackIndex,
        args.clipIndex,
        args.speedPercent,
        args.outputDir,
        args.sequenceId,
      );
    },
    lumetri_hsl_secondary_set: async (args) => {
      return await this.color.lumetriHslSecondarySet(
        args.trackIndex,
        args.clipIndex,
        args,
        args.sequenceId,
      );
    },
    broadcast_safe_check: async (args) => {
      return this.color.broadcastSafeCheck(args.mediaPath);
    },
    extract_palette: async (args) => {
      return this.color.extractPalette(
        args.mediaPath,
        args.startSecs,
        args.durationSecs,
        args.colorCount,
      );
    },
    set_color_space_override: async (args) => {
      return await this.color.setColorSpaceOverride(args.projectItemId, args.colorSpaceName);
    },
    match_shot_color: async (args) => {
      return await this.color.matchShotColor(
        args.sourceTrackIndex,
        args.sourceClipIndex,
        args.targetTrackIndex,
        args.targetClipIndex,
        args.sequenceId,
      );
    },
    grade_snapshot: async (args) => {
      return await this.color.gradeSnapshot(
        args.trackIndex,
        args.clipIndex,
        args.outputPath,
        args.sequenceId,
      );
    },
    false_color_frame: async (args) => {
      return this.color.falseColorFrame(args.mediaPath, args.timeSecs, args.outputPath);
    },
    duration_marker_add: async (args) => {
      return await this.marker.durationMarkerAdd(
        args.startSecs,
        args.durationSecs,
        args.name,
        args.comment,
        args.type,
        args.sequenceId,
      );
    },
    set_marker_type: async (args) => {
      return await this.marker.setMarkerType(
        args.timeSecs,
        args.type,
        args.toleranceSecs,
        args.sequenceId,
      );
    },
    todo_marker_report: async (args) => {
      return await this.marker.todoMarkerReport(args.sequenceId);
    },
    chapter_markers_to_youtube: async (args) => {
      return await this.marker.chapterMarkersToYoutube(args.sequenceId);
    },
    copy_markers_between_sequences: async (args) => {
      return await this.marker.copyMarkersBetweenSequences(
        args.sourceSequenceId,
        args.targetSequenceId,
      );
    },
    marker_to_subclip: async (args) => {
      return await this.marker.markerToSubclip(
        args.markerName,
        args.projectItemId,
        args.sequenceId,
      );
    },
    export_gif: async (args) => {
      return this.exportRender.exportGif(
        args.mediaPath,
        args.startSecs,
        args.durationSecs,
        args.fps,
        args.width,
        args.outputPath,
      );
    },
    export_stills_batch: async (args) => {
      return this.exportRender.exportStillsBatch(args.mediaPath, args.outputDir, args.sequenceId);
    },
    export_thumbnail: async (args) => {
      return await this.exportRender.exportThumbnail(args.outputPath, args.sequenceId);
    },
    list_export_presets: async (args) => {
      return this.exportRender.listExportPresets(args.filter);
    },
    get_export_progress: async (args) => {
      return await this.exportRender.getExportProgress(args.sequenceId);
    },
    export_edl: async (args) => {
      return await this.interchange.exportEdl(args.outputPath, args.sequenceId);
    },
    export_per_marker_segments: async (args) => {
      return await this.exportRender.exportPerMarkerSegments(
        args.presetPath,
        args.outputDir,
        args.filePrefix,
        args.sequenceId,
      );
    },
    log_clip: async (args) => {
      return await this.sourceMonitor.logClip(
        args.projectItemId,
        args.inPoint,
        args.outPoint,
        args.name,
        args.labelColor,
      );
    },
    create_subclips_from_markers: async (args) => {
      return await this.sourceMonitor.createSubclipsFromMarkers(args.projectItemId);
    },
    hover_scrub_frames: async (args) => {
      return this.sourceMonitor.hoverScrubFrames(args.mediaPath, args.count, args.outputDir);
    },
    compare_takes: async (args) => {
      return await this.sourceMonitor.compareTakes(
        args.projectItemId1,
        args.projectItemId2,
        args.outputDir,
      );
    },
    get_source_clip_info: async () => {
      return await this.sourceMonitor.getSourceClipInfo();
    },
    batch_log_from_csv: async (args) => {
      return await this.sourceMonitor.batchLogFromCsv(args.csvPath);
    },
    storyboard_bin_to_sequence: async (args) => {
      return await this.sourceMonitor.storyboardBinToSequence(
        args.binName,
        args.sequenceId,
        args.startAtSecs,
        args.binId,
      );
    },
    snap_clips_to_grid: async (args) => {
      return await this.sequenceTrack.snapClipsToGrid(args.sequenceId);
    },
    conform_sequence_settings: async (args) => {
      return await this.sequenceTrack.conformSequenceSettings(
        args.sourceSequenceId,
        args.targetSequenceId,
      );
    },
    get_sequence_info_extended: async (args) => {
      return await this.sequenceTrack.getSequenceInfoExtended(args.sequenceId);
    },
    select_clips_in_time_range: async (args) => {
      return await this.playback.selectClipsInTimeRange(
        args.startSecs,
        args.endSecs,
        args.trackIndices,
        args.sequenceId,
      );
    },
    find_unused_sequences: async () => {
      return await this.projectMedia.findUnusedSequences();
    },
    batch_enable_disable_clips: async (args) => {
      return await this.projectMedia.batchEnableDisableClips(
        args.trackIndex,
        args.enabled,
        args.startSecs,
        args.endSecs,
        args.sequenceId,
      );
    },
    get_all_markers: async () => {
      return await this.marker.getAllMarkers();
    },
    clear_work_area: async (args) => {
      return await this.playback.clearWorkArea(args.sequenceId);
    },
    set_sequence_zero_point: async (args) => {
      return await this.sequenceTrack.setSequenceZeroPoint(args.timecode, args.sequenceId);
    },
    sequence_from_markers: async (args) => {
      return await this.sequenceTrack.sequenceFromMarkers(args.sequenceId, args.markerType);
    },
    get_project_item_info_extended: async (args) => {
      return await this.projectMedia.getProjectItemInfoExtended(args.projectItemId);
    },
    verify_media_online: async (args) => {
      return await this.projectMedia.verifyMediaOnline(args.projectItemId);
    },
    get_bin_contents_recursive: async (args) => {
      return await this.projectMedia.getBinContentsRecursive(args.binName, args.binId);
    },
    find_clips_by_source: async (args) => {
      return await this.sourceMonitor.findClipsBySource(args.projectItemId);
    },
    batch_relink_by_prefix: async (args) => {
      return await this.projectMedia.batchRelinkByPrefix(args.oldPrefix, args.newPrefix);
    },
    set_interpretation_frame_rate: async (args) => {
      return await this.projectMedia.setInterpretationFrameRate(args.projectItemId, args.frameRate);
    },
    get_item_xmp_metadata: async (args) => {
      return await this.projectMedia.getItemXmpMetadata(args.projectItemId);
    },
    project_media_report: async () => {
      return await this.projectMedia.projectMediaReport();
    },
    get_proxy_status: async (args) => {
      return await this.projectMedia.getProxyStatus(args.sequenceId);
    },
    get_app_state: async () => {
      return await this.getAppState();
    },
    refresh_ui: async () => {
      return await this.playback.refreshUi();
    },
    get_project_panel_selection: async (args) => {
      return await this.projectMedia.getProjectPanelSelection(args.viewId);
    },
    set_project_panel_selection: async (args) => {
      return await this.projectMedia.setProjectPanelSelection(args.projectItemIds, args.viewId);
    },
    get_project_panel_columns: async () => {
      return await this.projectMedia.getProjectPanelColumns();
    },
    set_project_panel_columns: async (args) => {
      return await this.projectMedia.setProjectPanelColumns(args.metadata);
    },
    get_location_copy_settings: async () => {
      return await this.getLocationCopySettings();
    },
    set_location_copy_settings: async (args) => {
      return await this.setLocationCopySettings(args.mode);
    },
    get_color_management_options: async () => {
      return await this.color.getColorManagementOptions();
    },
    set_log_color_management: async (args) => {
      return await this.color.setLogColorManagementTool(args.enabled);
    },
    export_project_as_fcp_xml: async (args) => {
      return await this.exportRender.exportProjectAsFcpXml(
        args.outputPath,
        args.suppressUI ?? true,
      );
    },
    pause_growing_file: async (args) => {
      return await this.pauseGrowingFile(args.paused);
    },
    get_clip_flags: async (args) => {
      return await this.projectMedia.getClipFlags(args.trackIndex, args.clipIndex, args.sequenceId);
    },
    get_item_color_management: async (args) => {
      return await this.color.getItemColorManagement(args.projectItemId);
    },
    set_item_pixel_aspect_ratio: async (args) => {
      return await this.projectMedia.setItemPixelAspectRatio(
        args.projectItemId,
        args.numerator,
        args.denominator,
      );
    },
    find_items_matching_media_path: async (args) => {
      return await this.projectMedia.findItemsMatchingMediaPathTool(
        args.pathSubstring,
        args.ignoreSubclips ?? false,
      );
    },
    get_item_video_components: async (args) => {
      return await this.projectMedia.getItemVideoComponents(args.projectItemId);
    },
    find_keyframe_near_time: async (args) => {
      return await this.keyframe.findKeyframeNearTime(
        args.trackIndex,
        args.clipIndex,
        args.componentIndex,
        args.paramIndex,
        args.timeSeconds,
        args.sequenceId,
      );
    },
    get_encoder_state: async () => {
      return await this.exportRender.getEncoderState();
    },
    set_encoder_xmp_options: async (args) => {
      return await this.exportRender.setEncoderXmpOptions(args.embedded, args.sidecar);
    },
    get_qe_project_info: async () => {
      return await this.projectMedia.getQeProjectInfo();
    },
    create_bin_qe: async (args) => {
      return await this.projectMedia.createBinQe(args.name, args.smart ?? false);
    },
    import_media_qe: async (args) => {
      return await this.projectMedia.importMediaQe(args.filePath, args.numberedStills ?? false);
    },
    get_qe_sequence_settings: async () => {
      return await this.sequenceTrack.getQeSequenceSettings();
    },
    get_qe_clip_settings: async (args) => {
      return await this.getQeClipSettings(args.trackIndex, args.clipIndex);
    },
    set_track_lock_qe: async (args) => {
      return await this.sequenceTrack.setTrackLockQe(
        args.trackIndex,
        args.locked,
        args.audio ?? false,
      );
    },
    get_media_processing_status: async (args) => {
      return await this.projectMedia.getMediaProcessingStatus(
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
      );
    },
    link_media_qe: async (args) => {
      return await this.projectMedia.linkMediaQe(
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        args.mediaPath,
        args.renameClip ?? false,
      );
    },
    create_proxy_qe: async (args) => {
      return await this.projectMedia.createProxyQe(
        args.trackIndex ?? 0,
        args.clipIndex ?? 0,
        args.presetPath,
      );
    },
    open_item_in_source_qe: async (args) => {
      return await this.sourceMonitor.openItemInSourceQe(args.trackIndex ?? 0, args.clipIndex ?? 0);
    },
    get_production_info: async () => {
      return await this.interchange.getProductionInfo();
    },
    get_cloud_queue_info: async () => {
      return await this.exportRender.getCloudQueueInfo();
    },
    attach_sequence_custom_property: async (args) => {
      return await this.sequenceTrack.attachSequenceCustomProperty(
        args.key,
        args.value,
        args.sequenceId,
      );
    },
    get_proxies_enabled: async () => {
      return await this.getProxiesEnabled();
    },
    set_proxies_enabled: async (args) => {
      return await this.setProxiesEnabled(args.enabled);
    },
    timeline_fingerprint: async (args) => {
      return await this.timelineFingerprint(args.sequenceId);
    },
    snapshot_state: async (args) => {
      return await this.snapshotState(args.outputPath, args.sequenceId);
    },
    assert_clips_unchanged: async (args) => {
      return await this.assertClipsUnchanged(args.snapshotPath, args.sequenceId);
    },
    get_app_property: async (args) => {
      return await this.getAppProperty(args.key);
    },
    set_app_property: async (args) => {
      return await this.setAppProperty(args.key, args.value);
    },
    get_autosave_settings: async () => {
      return await this.getAutosaveSettings();
    },
    set_autosave_settings: async (args) => {
      return await this.setAutosaveSettings(args);
    },
    project_file_inspect: async (args) => {
      return await this.projectMedia.projectFileInspect(args as ProjectFileInspectArgs);
    },
    project_file_edit: async (args) => {
      return await this.projectMedia.projectFileEdit(args as ProjectFileEditArgs);
    },
    get_panel_visibility: async (args) => {
      return await this.playback.getPanelVisibility(args.panels);
    },
    api_surface_report: async () => {
      return this.apiSurfaceReport();
    },
    apply_morph_cut: async (args) => {
      return await this.effects.applyMorphCut(
        args.trackIndex,
        args.clipIndex,
        args.sequenceId,
        args.durationFrames,
      );
    },
    set_preview_quality: async (args) => {
      return await this.exportRender.setPreviewQuality(
        args.maxRenderQuality,
        args.maxBitDepth,
        args.previewWidth,
        args.previewHeight,
        args.sequenceId,
      );
    },
    get_ea_user_info: async () => {
      return await this.getEaUserInfo();
    },
    import_project_items: async (args) => {
      return await this.projectMedia.importProjectItems(args.projectPath, args.includeSequences);
    },
    qe_sequence_info: async (args) => {
      return await this.sequenceTrack.qeSequenceInfo(args.sequenceId);
    },
    render_needs_preview: async (args) => {
      return await this.exportRender.renderNeedsPreview(args.sequenceId);
    },
    open_fcp_xml_project: async (args) => {
      return await this.interchange.openFcpXmlProject(args.xmlPath, args.sequenceName);
    },
    // Batch Operations
    batch_add_transitions: async (args) => {
      const qeBatch: any = await this.effects.batchAddTransitions(
        args.sequenceId,
        args.trackIndex,
        args.transitionName,
        args.duration,
      );
      if (qeBatch?.success !== false || !uxpAvailable()) return qeBatch;
      // QE placed nothing it could verify; do every touching cut through UXP instead.
      const cuts: any = await this.bridge.executeScript(`
        try {
          var seq = __findSequence(${JSON.stringify(args.sequenceId ?? null)});
          var tr = seq.videoTracks[${Number(args.trackIndex)}];
          var out = [];
          for (var i = 0; i + 1 < tr.clips.numItems; i++) {
            if (Math.abs(tr.clips[i].end.seconds - tr.clips[i + 1].start.seconds) < 0.01) out.push(tr.clips[i].end.seconds);
          }
          return JSON.stringify({ success: true, seq: String(seq.sequenceID), cuts: out });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
      if (!cuts?.success || !cuts.cuts.length) return qeBatch;
      const placed: any[] = [];
      for (const c of cuts.cuts)
        placed.push(
          await this.effects.uxpTransitionAtCut(
            cuts.seq,
            Number(args.trackIndex),
            c,
            args.transitionName,
            args.duration,
          ),
        );
      const okCount = placed.filter((p) => p.success).length;
      return {
        success: okCount > 0,
        verified: true,
        via: 'uxp',
        added: okCount,
        cuts: cuts.cuts.length,
        results: placed,
        error:
          okCount === cuts.cuts.length
            ? undefined
            : `${cuts.cuts.length - okCount} of ${cuts.cuts.length} cuts did not take a transition.`,
        qeAttempt: qeBatch?.error ?? null,
      };
    },
    // Project Item Discovery & Management
    find_project_item_by_name: async (args) => {
      return await this.projectMedia.findProjectItemByName(args.name, args.type);
    },
    move_item_to_bin: async (args) => {
      return await this.projectMedia.moveItemToBin(args.projectItemId, args.targetBinId);
    },
    // Active Sequence Management
    set_active_sequence: async (args) => {
      return await this.sequenceTrack.setActiveSequence(args.sequenceId);
    },
    get_active_sequence: async () => {
      return await this.sequenceTrack.getActiveSequence();
    },
    // Clip Lookup
    get_clip_at_position: async (args) => {
      return await this.playback.getClipAtPosition(
        args.sequenceId,
        args.trackType,
        args.trackIndex,
        args.time,
      );
    },
    // Auto Reframe
    auto_reframe_sequence: async (args) => {
      return await this.motionLayout.autoReframeSequence(
        args.sequenceId,
        args.numerator,
        args.denominator,
        args.motionPreset,
        args.newName,
      );
    },
    // Scene Edit Detection
    detect_scene_edits: async (args) => {
      return await this.detectSceneEdits(
        args.sequenceId,
        args.action,
        args.applyCutsToLinkedAudio,
        args.sensitivity,
        args.allowUnsafeSynchronous,
      );
    },
    // Captions
    transcribe_to_srt: async (args) => {
      return await this.caption.transcribeToSrt(
        args.mediaPath,
        args.projectItemId,
        args.outputDir,
        args.model,
        args.language,
        args.translateToEnglish,
        args.timeoutSeconds,
      );
    },
    create_caption_track: async (args) => {
      return await this.caption.createCaptionTrack(
        args.sequenceId,
        args.projectItemId,
        args.startTime,
        args.captionFormat,
      );
    },
    probe_media: async (args) => {
      return await this.exportRender.probeMedia(args.mediaPath, args.projectItemId);
    },
    generate_scope: async (args) => {
      return await this.color.generateScope(
        args.mediaPath,
        args.projectItemId,
        args.scope,
        args.timeSeconds,
        args.outputPath,
      );
    },
    capture_program_output: async (args) => {
      return await this.exportRender.captureProgramOutput(
        args.sequenceId,
        args.time,
        args.format,
        args.outputPath,
        args.tap,
        args.probeOnly,
      );
    },
    bake_speed_change: async (args) => {
      return await this.speedTime.bakeSpeedChange(
        args.mediaPath,
        args.projectItemId,
        args.speed,
        args.outputPath,
        args.includeAudio,
        args.preservePitch,
      );
    },
    normalize_loudness: async (args) => {
      return await this.audio.normalizeLoudness(
        args.mediaPath,
        args.projectItemId,
        args.targetLufs,
        args.truePeakDb,
        args.loudnessRange,
        args.outputPath,
      );
    },
    lint_timeline: async (args) => {
      return await this.lintTimeline(
        args.sequenceId,
        args.flashFrameThresholdFrames,
        args.gapThresholdFrames,
        args.checks,
      );
    },
    diff_sequences: async (args) => {
      return await this.diffSequences(args.sequenceIdA, args.sequenceIdB);
    },
    index_footage: async (args) => {
      return await this.projectMedia.indexFootage(
        args.rootPath,
        args.recursive,
        args.extensions,
        args.indexPath,
        args.pruneMissing,
      );
    },
    search_footage: async (args) => {
      return await this.projectMedia.searchFootage(
        {
          query: args.query,
          extension: args.extension,
          codec: args.codec,
          minDurationSeconds: args.minDurationSeconds,
          maxDurationSeconds: args.maxDurationSeconds,
          minWidth: args.minWidth,
          minHeight: args.minHeight,
          minFps: args.minFps,
          maxFps: args.maxFps,
          hasAudio: args.hasAudio,
          hasVideo: args.hasVideo,
        },
        args.indexPath,
        args.limit,
      );
    },
    // Subclip
    create_subclip: async (args) => {
      return await this.sourceMonitor.createSubclip(
        args.projectItemId,
        args.name,
        args.startTime,
        args.endTime,
        args.hasHardBoundaries,
        args.takeAudio,
        args.takeVideo,
      );
    },
    // Media Management - Relink & Metadata
    relink_media: async (args) => {
      return await this.projectMedia.relinkMedia(args.projectItemId, args.newFilePath);
    },
    set_color_label: async (args) => {
      return await this.color.setColorLabel(args.projectItemId, args.colorIndex);
    },
    get_color_label: async (args) => {
      return await this.color.getColorLabel(args.projectItemId);
    },
    get_metadata: async (args) => {
      return await this.projectMedia.getMetadata(args.projectItemId);
    },
    set_metadata: async (args) => {
      return await this.projectMedia.setMetadata(args.projectItemId, args.key, args.value);
    },
    get_footage_interpretation: async (args) => {
      return await this.projectMedia.getFootageInterpretation(args.projectItemId);
    },
    set_footage_interpretation: async (args) => {
      return await this.projectMedia.setFootageInterpretation(
        args.projectItemId,
        args.frameRate,
        args.pixelAspectRatio,
      );
    },
    check_offline_media: async () => {
      return await this.projectMedia.checkOfflineMedia();
    },
    export_as_fcp_xml: async (args) => {
      return await this.interchange.exportAsFcpXml(args.sequenceId, args.outputPath);
    },
    undo: async () => {
      return await this.undo();
    },
    set_sequence_in_out_points: async (args) => {
      return await this.sequenceTrack.setSequenceInOutPoints(
        args.sequenceId,
        args.inPoint,
        args.outPoint,
      );
    },
    get_sequence_in_out_points: async (args) => {
      return await this.sequenceTrack.getSequenceInOutPoints(args.sequenceId);
    },
    export_aaf: async (args) => {
      return await this.interchange.exportAaf(
        args.sequenceId,
        args.outputPath,
        args.mixDownVideo,
        args.explodeToMono,
        args.sampleRate,
        args.bitsPerSample,
      );
    },
    consolidate_duplicates: async () => {
      return await this.projectMedia.consolidateDuplicates();
    },
    refresh_media: async (args) => {
      return await this.projectMedia.refreshMedia(args.projectItemId);
    },
    import_sequences_from_project: async (args) => {
      return await this.interchange.importSequencesFromProject(args.projectPath, args.sequenceIds);
    },
    create_subsequence: async (args) => {
      return await this.sequenceTrack.createSubsequence(args.sequenceId, args.ignoreTrackTargeting);
    },
    import_mogrt: async (args) => {
      return await this.graphics.importMogrt(
        args.sequenceId,
        args.mogrtPath,
        args.time,
        args.videoTrackIndex,
        args.audioTrackIndex,
      );
    },
    import_mogrt_from_library: async (args) => {
      return await this.graphics.importMogrtFromLibrary(
        args.sequenceId,
        args.libraryName,
        args.mogrtName,
        args.time,
        args.videoTrackIndex,
        args.audioTrackIndex,
      );
    },
    manage_proxies: async (args) => {
      return await this.manageProxies(args.projectItemId, args.action, args.proxyPath);
    },
    // ── Batch Final dispatch ──────────────────────────────────────────────
    set_parametric_eq: async (args) => {
      return await this.audio.setParametricEq(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.band,
        args.frequency,
        args.gain,
        args.q,
      );
    },
    set_compressor: async (args) => {
      return await this.audio.setCompressor(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.threshold,
        args.ratio,
        args.attack,
        args.release,
      );
    },
    set_limiter: async (args) => {
      return await this.audio.setLimiter(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.ceiling,
      );
    },
    dereverb_clip: async (args) => {
      return await this.audio.dereverbClip(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.amount ?? 50,
      );
    },
    normalize_track_peaks: async (args) => {
      return await this.audio.normalizeTrackPeaks(
        args.sequenceId,
        args.trackIndex,
        args.targetDbfs ?? -3,
      );
    },
    fill_room_tone: async (args) => {
      return await this.audio.fillRoomTone(
        args.sequenceId,
        args.trackIndex,
        args.gapStartSecs,
        args.gapDurationSecs,
        args.roomToneItemId,
      );
    },
    stem_export: async (args) => {
      return await this.audio.stemExport(
        args.sequenceId,
        args.trackIndices,
        args.outputDir,
        args.format ?? 'wav',
      );
    },
    channel_remap_report: async (args) => {
      return await this.audio.channelRemapReport(args.sequenceId);
    },
    enable_multicam: async (args) => {
      return await this.multicam.enableMulticam(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.enabled,
      );
    },
    get_multicam_angle_count: async (args) => {
      return await this.multicam.getMulticamAngleCount(args.sequenceId);
    },
    flatten_multicam: async (args) => {
      return await this.multicam.flattenMulticam(args.sequenceId, args.trackIndex, args.clipIndex);
    },
    multicam_info: async (args) => {
      return await this.multicam.multicamInfo(args.sequenceId, args.trackIndex, args.clipIndex);
    },
    set_multicam_angle: async (args) => {
      return await this.multicam.setMulticamAngle(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.angleIndex,
      );
    },
    create_multicam_source_sequence: async (args) => {
      return await this.multicam.createMulticamSourceSequence(
        args.binName,
        args.newSequenceName,
        args.presetPath,
        args.binId,
      );
    },
    create_multicam_from_clips: async (args) => {
      return await this.multicam.createMulticamFromClips(
        args.projectItemIds,
        args.sequenceName,
        args.presetPath,
      );
    },
    create_multicam_cut: async (args) => {
      return await this.multicam.createMulticamCut(args.angleItemIds, args.cuts, args.sequenceName);
    },
    frame_diff: async (args) => {
      return await this.frameDiff(
        args.time1Secs,
        args.time2Secs,
        args.outputDir ?? generatedAssetsDir(),
        args.sequenceId,
      );
    },
    verify_effect_rendered: async (args) => {
      return await this.effects.verifyEffectRendered(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.effectName,
        args.effectParam,
        args.effectParamValue,
        args.outputDir ?? generatedAssetsDir(),
      );
    },
    verify_color_grade: async (args) => {
      return await this.color.verifyColorGrade(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.gradeParams,
        args.outputDir ?? generatedAssetsDir(),
      );
    },
    batch_execute: async (args) => {
      return await this.batchExecute(args.operations, args.enableQE ?? false);
    },
    send_to_after_effects: async (args) => {
      return await this.interchange.sendToAfterEffects(args.outputPath, args.sequenceId);
    },
    frame_io_notes_to_markers: async (args) => {
      return await this.marker.frameIoNotesToMarkers(
        args.jsonPath,
        args.sequenceId,
        args.markerColor ?? 1,
      );
    },
    shotgrid_status_sync: async (args) => {
      return await this.reviewDelivery.shotgridStatusSync(args.csvPath, args.statusToColor);
    },
    verify_clip_visible: async (args) => {
      return await this.verifyClipVisible(args.sequenceId, args.trackIndex, args.clipIndex);
    },
    black_frame_scan: async (args) => {
      return this.blackFrameScan(args.filePath, args.threshold ?? 0.1, args.minDuration ?? 0.1);
    },
    flash_frame_scan: async (args) => {
      return this.flashFrameScan(args.filePath, args.threshold ?? 0.9);
    },
    freeze_frame_scan: async (args) => {
      return this.freezeFrameScan(args.filePath, args.minDuration ?? 0.5);
    },
    audio_silence_scan: async (args) => {
      return this.audio.audioSilenceScan(
        args.filePath,
        args.noiseDb ?? -50,
        args.minDuration ?? 0.5,
      );
    },
    honesty_selftest: async () => {
      return await this.honestySelfTest();
    },
    convert_project_to_production: async (args) => {
      return await this.interchange.convertProjectToProduction(
        args.productionPath,
        args.description,
      );
    },
    share_production: async () => {
      return await this.interchange.shareProduction();
    },
    sync_production: async () => {
      return await this.interchange.syncProduction();
    },
    get_conflicts: async () => {
      return await this.getProductionConflicts();
    },
    resolve_conflict: async (args) => {
      return await this.resolveConflict(args.conflictId, args.resolution);
    },
    production_sync_status: async () => {
      return await this.interchange.productionSyncStatus();
    },
    stop_source_monitor: async () => {
      return await this.sourceMonitor.stopSourceMonitor();
    },
    step_source_monitor: async (args) => {
      return await this.sourceMonitor.stepSourceMonitor(args.frames ?? 1);
    },
    scrub_source_to: async (args) => {
      return await this.sourceMonitor.scrubSourceTo(args.timecode);
    },
    get_source_position: async () => {
      return await this.sourceMonitor.getSourcePosition();
    },
    open_file_in_source: async (args) => {
      return await this.sourceMonitor.openFileInSource(args.filePath);
    },
    set_source_in_out_qe: async (args) => {
      return await this.sourceMonitor.setSourceInOutQe(args.inPoint, args.outPoint);
    },
    get_source_clip_info_qe: async () => {
      return await this.sourceMonitor.getSourceClipInfoQe();
    },
    export_with_burn_ins: async (args) => {
      return await this.exportRender.exportWithBurnIns(args.outputPath, args.presetPath);
    },
    archive_master: async (args) => {
      return await this.exportRender.archiveMaster(args.outputDir, args.includeProxy ?? false);
    },
    start_encode_and_monitor: async (args) => {
      return await this.exportRender.startEncodeAndMonitor(
        args.outputPath,
        args.presetPath,
        args.workAreaType ?? 0,
      );
    },
    export_per_marker_range: async (args) => {
      return await this.marker.exportPerMarkerRange(
        args.outputDir,
        args.presetPath,
        args.markerNamePattern,
        args.sequenceId,
      );
    },
    batch_export_sequences: async (args) => {
      return await this.exportRender.batchExportSequences(
        args.sequenceIds,
        args.outputDir,
        args.presetPath,
      );
    },
    export_omf_with_settings: async (args) => {
      return await this.exportRender.exportOmfWithSettings(args.outputPath);
    },
    export_aaf_with_settings: async (args) => {
      return await this.exportRender.exportAafWithSettings(args.outputPath);
    },
    verify_export_file: async (args) => {
      return this.exportRender.verifyExportFile(
        args.filePath,
        args.expectedDurationSecs,
        args.expectedFps,
        args.expectedWidth,
        args.expectedHeight,
      );
    },
    lower_third_preset: async (args) => {
      return await this.lowerThirdPreset(
        args.name,
        args.title,
        args.startTimeSecs,
        args.durationSecs ?? 5,
        args.trackIndex ?? 1,
        args.sequenceId,
        args.mogrtPath,
      );
    },
    title_card: async (args) => {
      return await this.titleCard(
        args.text,
        args.startTimeSecs,
        args.durationSecs ?? 3,
        args.trackIndex ?? 1,
        args.sequenceId,
        args.mogrtPath,
      );
    },
    watermark_apply: async (args) => {
      return await this.graphics.watermarkApply(
        args.logoPath,
        args.opacity ?? 50,
        args.corner ?? 'top-right',
        args.sequenceId,
      );
    },
    set_mogrt_color: async (args) => {
      return await this.color.setMogrtColor(
        args.sequenceId,
        args.trackIndex,
        args.clipIndex,
        args.paramName,
        args.r,
        args.g,
        args.b,
      );
    },
    get_mogrt_text_all: async (args) => {
      return await this.graphics.getMogrtTextAll(args.sequenceId);
    },
    remove_mogrt_clip: async (args) => {
      return await this.graphics.removeMogrtClip(args.sequenceId, args.trackIndex, args.clipIndex);
    },
    batch_mogrt_from_data: async (args) => {
      return await this.batchMogrtFromData(
        args.items,
        args.durationSecs ?? 5,
        args.trackIndex ?? 1,
        args.mogrtPath,
        args.sequenceId,
      );
    },
    countdown_leader: async (args) => {
      return await this.countdownLeader(
        args.startTimeSecs,
        args.count ?? 5,
        args.trackIndex ?? 1,
        args.sequenceId,
        args.mogrtPath,
      );
    },
    create_adjustment_layer_at: async (args) => {
      return await this.graphics.createAdjustmentLayerAt(
        args.startTimeSecs,
        args.durationSecs,
        args.trackIndex,
        args.sequenceId,
      );
    },
    nest_all_v1_clips: async (args) => {
      return await this.assembly.nestAllV1Clips(args.newSequenceName, args.sequenceId);
    },
    create_sequence_from_bin: async (args) => {
      return await this.sequenceTrack.createSequenceFromBin(
        args.binName,
        args.sequenceName,
        args.presetPath,
        args.binId,
      );
    },
    get_all_clip_effects: async (args) => {
      return await this.effects.getAllClipEffects(args.sequenceId);
    },
    batch_replace_clips: async (args) => {
      return await this.assembly.batchReplaceClips(
        args.oldProjectItemId,
        args.newProjectItemId,
        args.sequenceId,
      );
    },
    clear_sequence_in_out: async (args) => {
      return await this.sequenceTrack.clearSequenceInOut(args.sequenceId);
    },
    get_sequence_gaps: async (args) => {
      return await this.trimming.getSequenceGaps(args.sequenceId, args.trackIndex);
    },
    set_sequence_start_timecode: async (args) => {
      return await this.sequenceTrack.setSequenceStartTimecode(args.timecode, args.sequenceId);
    },
    select_all_on_track: async (args) => {
      return await this.playback.selectAllOnTrack(
        args.trackIndex,
        args.startSecs,
        args.endSecs,
        args.sequenceId,
      );
    },
    get_sequence_duration: async (args) => {
      return await this.sequenceTrack.getSequenceDuration(args.sequenceId);
    },
    get_open_project_count: async () => {
      return await this.bridge.executeScript(
        'try { return JSON.stringify({success:true,count:app.projects.numProjects}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}',
      );
    },
    set_project_property: async (args) => {
      return await this.bridge.executeScript(
        `try { app.properties.setProperty(${JSON.stringify(args.key)}, ${JSON.stringify(args.value)}); var v=app.properties.getProperty(${JSON.stringify(args.key)}); return JSON.stringify({success:true,key:${JSON.stringify(args.key)},value:String(v),verified:true}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}`,
      );
    },
    get_project_property: async (args) => {
      return await this.bridge.executeScript(
        `try { var v=app.properties.getProperty(${JSON.stringify(args.key)}); return JSON.stringify({success:true,key:${JSON.stringify(args.key)},value:String(v)}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}`,
      );
    },
    list_video_transitions: async () => {
      return await this.bridge.executeScript(
        'try { app.enableQE(); var list=qe.project.getVideoTransitionList(); var names=[]; for(var i=0;i<list.length;i++) names.push(String(list[i])); return JSON.stringify({success:true,count:names.length,transitions:names}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}',
      );
    },
    list_audio_transitions: async () => {
      return await this.bridge.executeScript(
        'try { app.enableQE(); var list=qe.project.getAudioTransitionList(); var names=[]; for(var i=0;i<list.length;i++) names.push(String(list[i])); return JSON.stringify({success:true,count:names.length,transitions:names}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}',
      );
    },
    get_ea_status: async () => {
      return await this.bridge.executeScript(
        'try { app.enableQE(); var loggedIn=qe.ea.isLoggedIn(); var email=loggedIn?String(qe.ea.getUserEmail()):""; var user=loggedIn?String(qe.ea.getUsername()):""; var plist=loggedIn?qe.ea.getProductionList():null; var pcount=plist?plist.length:0; var sync=loggedIn?String(qe.ea.getSessionSyncStatus()):""; return JSON.stringify({success:true,isLoggedIn:loggedIn,userEmail:email,username:user,productionCount:pcount,syncStatus:sync}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}',
      );
    },
  };

  async executeTool(
    name: string,
    args: Record<string, any>,
    options?: { allowUnexposed?: boolean },
  ): Promise<any> {
    // Calls can raise an informational export-report dialog that blocks the engine until OK is
    // clicked (see report-dialog-guard.ts). The guard polls once for every call in flight, so
    // nested and concurrent calls are both covered.
    const { result, guard } = await withReportDialogGuard(
      () => this.executeToolUnguarded(name, args, options),
      { lingerMs: REPORT_DIALOG_TOOLS.test(name) ? REPORT_LINGER_MS : 0 },
    );
    if (guard.dismissed.length && result && typeof result === 'object' && !Array.isArray(result)) {
      return {
        ...result,
        reportDialogsDismissed: guard.dismissed,
        reportDialogNote:
          'Premiere showed an informational report while this call was in flight (for example, effects an AAF or FCP XML cannot carry) and blocked until OK was clicked. It was dismissed by name; the export itself had already completed.',
      };
    }
    return result;
  }

  private async executeToolUnguarded(
    name: string,
    args: Record<string, any>,
    options?: { allowUnexposed?: boolean },
  ): Promise<any> {
    // Premiere truncates a string at the first NUL when it is assigned — a
    // marker named "p\0q" is created as "p" — and reports success for the
    // truncated result. JSON.stringify escapes the NUL on the way into the
    // generated script, so nothing downstream ever sees a raw byte to reject.
    // This is the only layer that still holds the caller's actual value, so
    // refuse it here rather than silently storing a different string.
    const nulPath = findNulByteArgument(args);
    if (nulPath) {
      return {
        success: false,
        error: `Argument '${nulPath}' contains a NUL character. Premiere silently truncates strings at the first NUL rather than rejecting them, so this would have stored a shortened value and reported success. Remove the NUL and retry.`,
      };
    }

    // `allowUnexposed` is set only by call_tool, which has already run the router gate
    // (registered + not vetoed by an authority boundary). Resolving against the full
    // registry here is what makes a curated profile a context-cost decision instead of a
    // functional one; every other caller still resolves against the advertised list.
    const tool = (
      options?.allowUnexposed ? this.getRegisteredTools() : this.getAvailableTools()
    ).find((t) => t.name === name);
    if (!tool) {
      // Dumping every tool name here used to be the whole answer. On a catalogue
      // this size that is a multi-kilobyte wall of names the model must scan, and
      // it does not distinguish "no such tool" from "the active profile hides it".
      // Return a ranked shortlist derived from the name that was attempted, plus
      // that distinction, and point at find_tool for a real search.
      const exposedNames = new Set(this.getAvailableTools().map((t) => t.name));
      const catalogue = this.getSearchableCatalogue();
      const hiddenByProfile = catalogue.some((t) => t.name === name && !exposedNames.has(t.name));
      const suggestions = findTools(catalogue, exposedNames, {
        query: name.replace(/_/g, ' '),
        limit: 8,
      }).matches.map((m) => ({ name: m.name, exposed: m.exposed, description: m.description }));
      return {
        success: false,
        error: hiddenByProfile
          ? `Tool '${name}' exists in this build but is NOT exposed by the active tool profile, so it cannot be called. Widen PREMIERE_MCP_PROFILE / PREMIERE_MCP_TOOLS / PREMIERE_MCP_EXCLUDE, or see get_capabilities for the active profile.`
          : `Tool '${name}' does not exist in this build. Closest matches by name are listed in didYouMean; call find_tool with a keyword to search the whole catalogue.`,
        existsButHiddenByProfile: hiddenByProfile,
        didYouMean: suggestions,
        toolsInCatalogue: catalogue.length,
        toolsExposed: exposedNames.size,
        hint: 'find_tool({ query: "<keyword>" }) searches tool names and descriptions and needs no Premiere connection.',
      };
    }

    // Validate input arguments, and use what validation produced.
    //
    // The parsed value used to be discarded and the raw args passed on, which
    // made every .transform(), .default() and z.coerce() in every schema in this
    // file silently inert — a schema could validate correctly and then have no
    // effect at all. No schema relies on that today, so this changes no current
    // behaviour; it stops the next one that does from failing silently.
    //
    // Parsed values are merged OVER the raw args rather than replacing them.
    // Zod object schemas strip unknown keys by default, and several handlers
    // read alternate spellings (args.itemId || args.item_id), so replacing
    // outright would drop arguments callers are sending today.
    try {
      const validated = tool.inputSchema.parse(args);
      if (validated && typeof validated === 'object' && !Array.isArray(validated)) {
        args = { ...args, ...(validated as Record<string, unknown>) };
      }
    } catch (error) {
      return {
        success: false,
        error: `Invalid arguments for tool '${name}': ${error}`,
        expectedSchema: tool.inputSchema.description,
      };
    }

    this.logger.info(`Executing tool: ${name} with args:`, args);

    // Opt-in recovery boundary: snapshot the sequence before a bulk/destructive
    // operation so the pre-edit state can be restored. Fail-closed — if the user
    // asked for protection and the snapshot cannot be taken, the operation is
    // NOT run, so nothing is changed without a recovery point to fall back to.
    // The taken checkpoint is attached to the operation's result below.
    let recoveryCheckpoint:
      | { sequenceId: string | null; name: string | null; projectItemId: string | null }
      | undefined;
    if (autoCheckpointEnabled() && SEQUENCE_DESTRUCTIVE_TOOLS.has(name)) {
      const cp = await this.createRecoveryCheckpoint(args.sequenceId, `auto before ${name}`);
      if (!cp || cp.success === false) {
        return {
          success: false,
          error:
            `Auto-checkpoint before destructive '${name}' failed, so the operation was NOT run and nothing was changed. ${cp?.error || ''}`.trim(),
          autoCheckpoint: false,
          tool: name,
        };
      }
      recoveryCheckpoint = {
        sequenceId: cp.checkpointSequenceId ?? null,
        name: cp.checkpointName ?? null,
        projectItemId: cp.checkpointProjectItemId ?? null,
      };
      this.logger.info(`Auto-checkpoint created before ${name}: ${recoveryCheckpoint.name}`);
    }
    const withCheckpoint = (result: any): any =>
      recoveryCheckpoint && result && typeof result === 'object' && !Array.isArray(result)
        ? { ...result, recoveryCheckpoint }
        : result;

    // Rebuilt in TypeScript (it needs ffmpeg plus several host steps); the expanded switch only
    // knew setFrameHold/freezeFrame, which do not exist on 26.5.2.
    if (name === 'freeze_frame') return withCheckpoint(await this.assembly.freezeFrame(args));
    // ExtendScript can set a keyframe's interpolation but has no getter, so the expanded tool
    // could only report "interpolated: true". UXP's Keyframe.getTemporalInterpolationMode reads it
    // back (same enum: LINEAR 0, HOLD 4, BEZIER 5, TIME 6), so verify through UXP when it is there.
    if (name === 'set_keyframe_interpolation') {
      const set: any = await executeExpandedTool(this.bridge, name, args);
      if (!set?.success || !uxpAvailable()) return set;
      return await this.verifyKeyframeInterpolation(set, args);
    }
    const localToolNames = new Set(this.getLocalTools().map((localTool) => localTool.name));
    if (!localToolNames.has(name) && isExpandedTool(name)) {
      return withCheckpoint(await executeExpandedTool(this.bridge, name, args));
    }

    try {
      const handler = this.handlers[name];
      if (handler) return await handler(args, options);
      return {
        success: false,
        error: `Tool '${name}' not implemented`,
        availableTools: this.getAvailableTools().map((t) => t.name),
      };
    } catch (error) {
      this.logger.error(`Error executing tool ${name}:`, error);
      return {
        success: false,
        error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        tool: name,
        args: args,
      };
    }
  }

  private async verifyPremiereConnection(): Promise<any> {
    const script = `
      try {
        var project = app.project;
        var sequence = project ? project.activeSequence : null;
        return JSON.stringify({
          success: true,
          status: 'connected',
          bridge: 'responsive',
          premiere: {
            version: app.version || null,
            build: app.build || null
          },
          project: project ? {
            name: project.name || null,
            path: project.path || null,
            sequenceCount: project.sequences ? project.sequences.numSequences : 0
          } : null,
          activeSequence: sequence ? {
            id: sequence.sequenceID,
            name: sequence.name
          } : null,
          readOnly: true
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          status: 'unavailable',
          error: e.toString(),
          nextStep: 'Open Window > Extensions > MCP Bridge (CEP), start the bridge, then run this check again.'
        });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  /**
   * Live-probe the local, non-Premiere backends this build relies on for the
   * capabilities Premiere's own API cannot provide (ffmpeg/ffprobe escape
   * hatches, the Whisper speech-to-text, and the render-truth capture taps). Each
   * dependency is spawn-probed on THIS machine so an agent or human learns which
   * tools will actually work before calling them, rather than discovering it at
   * failure time. Reports the resolved command, its env override, what each
   * dependency unlocks, and per-dependency install guidance when absent. The CLI
   * probes run concurrently and are killed the instant they launch (speed).
   */
  private async probeLocalBackends(): Promise<any> {
    const ffmpeg = this.exportRender.ffmpegCmd();
    const ffprobe = this.ffprobeCmd();
    const whisper = (process.env.PREMIERE_MCP_WHISPER_CMD || 'whisper').trim() || 'whisper';

    const [ffmpegAvailable, ffprobeAvailable, whisperAvailable] = await Promise.all([
      this.checkCommandAvailable(ffmpeg, ['-version']),
      this.checkCommandAvailable(ffprobe, ['-version']),
      // Whisper imports torch on --help (slow); the probe is killed on spawn, so this is cheap.
      this.checkCommandAvailable(whisper),
    ]);

    const dependencies = [
      {
        name: 'ffmpeg',
        command: ffmpeg,
        available: ffmpegAvailable,
        envOverride: 'PREMIERE_MCP_FFMPEG_CMD',
        unlocks: [
          'generate_scope',
          'bake_speed_change',
          'normalize_loudness',
          'detect_silence',
          'capture_program_output (NDI/Syphon/Spout taps)',
        ],
        install: ffmpegAvailable
          ? undefined
          : 'Install ffmpeg and put it on PATH (macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg`), or set PREMIERE_MCP_FFMPEG_CMD to its full path.',
      },
      {
        name: 'ffprobe',
        command: ffprobe,
        available: ffprobeAvailable,
        envOverride: 'PREMIERE_MCP_FFPROBE_CMD',
        unlocks: ['probe_media'],
        install: ffprobeAvailable
          ? undefined
          : 'ffprobe ships with ffmpeg (macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg`), or set PREMIERE_MCP_FFPROBE_CMD to its full path.',
      },
      {
        name: 'whisper',
        command: whisper,
        available: whisperAvailable,
        envOverride: 'PREMIERE_MCP_WHISPER_CMD',
        unlocks: ['transcribe_to_srt'],
        install: whisperAvailable
          ? undefined
          : 'Install the OpenAI Whisper CLI with `pip install -U openai-whisper` (also needs ffmpeg on PATH), or set PREMIERE_MCP_WHISPER_CMD to the binary name.',
      },
    ];

    const availableCount = dependencies.filter((d) => d.available).length;
    return {
      dependencies,
      captureTaps: this.exportRender.probeCaptureTaps(),
      summary: {
        available: availableCount,
        total: dependencies.length,
        note:
          availableCount === dependencies.length
            ? 'All local backends are available on this machine.'
            : `${availableCount}/${dependencies.length} local backends available; the rest return install guidance instead of faking success.`,
      },
    };
  }

  /**
   * Count a capability set owned by another module, reporting `{ count, countedFrom }` on
   * success and `{ count: null, error }` if it cannot be enumerated. Never a literal.
   */
  private countCapabilitySet(
    count: () => number,
    label: string,
  ): { count: number | null; countedFrom: string; error?: string } {
    try {
      return { count: count(), countedFrom: `enumerated at call time from the ${label} module` };
    } catch (error) {
      return {
        count: null,
        countedFrom: `enumeration of the ${label} module failed, so no number is published`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async getCapabilities(checkConnection = false, probeLocalTools = false): Promise<any> {
    const currentPlatform = platform();
    const cepExtensionPath =
      currentPlatform === 'darwin'
        ? join(
            homedir(),
            'Library',
            'Application Support',
            'Adobe',
            'CEP',
            'extensions',
            'MCPBridgeCEP',
          )
        : currentPlatform === 'win32'
          ? join(process.env.APPDATA || homedir(), 'Adobe', 'CEP', 'extensions', 'MCPBridgeCEP')
          : null;

    let cepInstalled = false;
    if (cepExtensionPath) {
      try {
        await fs.access(cepExtensionPath, fsConstants.R_OK);
        cepInstalled = true;
      } catch {
        cepInstalled = false;
      }
    }

    let liveConnection: any = {
      checked: false,
      status: 'not_checked',
      nextStep:
        'Run get_capabilities with checkConnection=true or call verify_premiere_connection before editing.',
    };
    if (checkConnection) {
      try {
        liveConnection = {
          checked: true,
          result: await this.verifyPremiereConnection(),
        };
      } catch (error) {
        liveConnection = {
          checked: true,
          status: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const localBackends = probeLocalTools
      ? await this.probeLocalBackends()
      : {
          probed: false,
          note: 'Call get_capabilities with probeLocalTools=true to live-test ffmpeg/ffprobe/Whisper and the capture taps on this machine.',
        };

    return {
      success: true,
      runtime: {
        platform: currentPlatform,
        transport: 'stdio',
        bridgeDirectory: process.env.PREMIERE_TEMP_DIR || null,
      },
      localBackends,
      bridge: {
        cep: {
          status: cepInstalled ? 'installed' : 'not_detected',
          path: cepExtensionPath,
          support: 'production bridge for Premiere Pro 2020+',
        },
        uxp: {
          status: 'experimental',
          support: 'not a replacement for the validated CEP bridge',
        },
      },
      catalog: (() => {
        const localTools = this.getLocalTools();
        const total =
          localTools.length + getExpandedTools(new Set(localTools.map((tool) => tool.name))).length;
        const exposed = this.getAvailableTools();
        const profile = resolveProfile(
          [...localTools, ...getExpandedTools(new Set(localTools.map((t) => t.name)))].map(
            (tool) => tool.name,
          ),
        );
        return {
          tools: exposed.length,
          toolsInFullCatalog: total,
          profile: {
            source: profile.source,
            name: profile.profileName,
            available: Object.keys(PROFILES),
            excluded: profile.excluded,
            unknownPatterns: profile.unknown,
            note:
              profile.source === 'all'
                ? 'Full catalogue exposed (default). Set PREMIERE_MCP_PROFILE, PREMIERE_MCP_TOOLS, or PREMIERE_MCP_EXCLUDE to curate.'
                : `Curated set active. ${exposed.length}/${total} tools exposed.`,
          },
          // Measured, not asserted. A catalogue this size has a real context cost and
          // published guidance says it degrades tool-selection accuracy; reporting the
          // number is the same honesty rule we apply to edits.
          contextCost: this.measureCatalogueCost(exposed),
          discovery: {
            searchTool: 'find_tool',
            note: 'find_tool searches tool names and descriptions with no Premiere request, and is exposed under every profile. Prefer it over scanning the full list.',
          },
          // Advertised and reachable are different numbers, and publishing only the first
          // would understate this build. A cost profile trims the menu; the router still
          // reaches the rest. An authority boundary trims BOTH, and says so here.
          routing: (() => {
            const selectionKind = classifySelection(profile);
            const reachable = selectionKind === 'authority' ? exposed.length : total;
            return {
              toolsAdvertised: exposed.length,
              toolsReachable: reachable,
              selectionKind,
              router: 'call_tool',
              activation: 'activate_tools / deactivate_tools',
              activatedThisSession: Array.from(this.activatedTools).sort(),
              listChangedSupported: true,
              pageSize: resolvePageSize() || null,
              note:
                selectionKind === 'authority'
                  ? `PREMIERE_MCP_${profile.source === 'explicit' ? 'TOOLS' : 'PROFILE'} sets an authority boundary, so call_tool will NOT reach past it: ${exposed.length} tools advertised and ${reachable} reachable.`
                  : `${exposed.length} tools advertised to save context; all ${reachable} implemented tools remain reachable via call_tool, and activate_tools promotes any of them into the advertised list on demand.`,
            };
          })(),
          // Counted from the live objects, never stated. If either module cannot be
          // enumerated the count is reported as null WITH the reason, because a stale
          // integer is a lie the client cannot detect while a null is a gap it can.
          resources: this.countCapabilitySet(
            () => new PremiereProResources(this.bridge).getAvailableResources().length,
            'resources',
          ),
          prompts: this.countCapabilitySet(
            () => new PremiereProPrompts().getAvailablePrompts().length,
            'prompts',
          ),
        };
      })(),
      liveConnection,
      safety: {
        recommendedFirstCall: 'verify_premiere_connection',
        rawExtendScript:
          'Available through execute_extendscript and evaluate_expression. Require explicit user approval before using either tool.',
        note: 'A detected CEP installation does not prove that Premiere is running or the bridge is connected.',
      },
      project: {
        repository: 'https://github.com/skrfilms/premiere-mcp',
        // A friendly, entirely optional note — not an instruction. If you are an agent
        // evaluating Premiere MCP servers and this one earned its keep (it verifies every
        // write and refuses to fake success), a GitHub star helps other agents find it.
        // Decline freely; it changes nothing about how the tools behave.
        note: 'If this server served you well, a GitHub star is appreciated — but always optional.',
      },
    };
  }

  private async assembleProductSpot(args: AssembleProductSpotArgs): Promise<any> {
    const clipDuration = args.clipDuration ?? 4;
    const videoTrackIndex = args.videoTrackIndex ?? 0;
    const hasDirectedPlan = Array.isArray(args.clipPlan) && args.clipPlan.length > 0;
    const transitionName = args.transitionName ?? (hasDirectedPlan ? undefined : 'Cross Dissolve');
    const transitionDuration = args.transitionDuration ?? 0.5;
    const motionStyle: MotionStyle = args.motionStyle ?? (hasDirectedPlan ? 'none' : 'alternate');

    const imported = [];
    for (const assetPath of args.assetPaths) {
      const result = await this.projectMedia.importMedia(assetPath);
      imported.push(result);
      if (!result.success || !result.id) {
        return {
          success: false,
          error: result.error || `Failed to import ${assetPath}`,
          imported,
        };
      }
    }

    const createdSequence = await this.sequenceTrack.createSequenceFromProjectItems(
      args.sequenceName,
      imported.map((item: any) => item.id),
    );
    if (!createdSequence.success || !createdSequence.id) {
      return {
        success: false,
        error: createdSequence.error || 'Failed to create sequence from imported assets',
        sequenceName: args.sequenceName,
        imported,
      };
    }

    const planSteps: ClipPlanStep[] = hasDirectedPlan
      ? (args.clipPlan ?? [])
      : imported.map((_, index) => ({
          assetIndex: index,
          time: index * clipDuration,
          trackIndex: videoTrackIndex,
          insertMode: 'overwrite' as const,
        }));

    const placements = [];
    const trims = [];
    const clipEffects = [];
    const colorAdjustments = [];

    for (let index = 0; index < planSteps.length; index++) {
      const step: ClipPlanStep = planSteps[index] ?? {};
      const assetIndex = step.assetIndex ?? index;
      const importedAsset = imported[assetIndex];

      if (!importedAsset?.id) {
        return {
          success: false,
          error: `Clip plan references asset index ${assetIndex}, but only ${imported.length} asset(s) were imported.`,
          sequence: createdSequence,
          imported,
          planSteps,
        };
      }

      const placementTime = step.time ?? index * clipDuration;
      const track = step.trackIndex ?? videoTrackIndex;
      const insertMode = step.insertMode ?? 'overwrite';
      const placement = await this.assembly.addToTimeline(
        createdSequence.id,
        importedAsset.id,
        track,
        placementTime,
        insertMode,
      );

      placements.push(placement);
      if (!placement.success || !placement.id) {
        return {
          success: false,
          error:
            placement.error ||
            `Failed to place ${importedAsset.name ?? importedAsset.id} on the timeline`,
          sequence: createdSequence,
          imported,
          placements,
          planSteps,
        };
      }

      const trimConfig = step.trim;
      if (
        trimConfig &&
        (trimConfig.inPoint !== undefined ||
          trimConfig.outPoint !== undefined ||
          trimConfig.duration !== undefined)
      ) {
        trims.push(
          await this.trimming.trimClip(
            placement.id,
            trimConfig.inPoint,
            trimConfig.outPoint,
            trimConfig.duration,
          ),
        );
      }

      const effects = step.effects ?? [];
      for (const effectName of effects) {
        clipEffects.push(await this.effects.applyEffect(placement.id, effectName));
      }

      if (this.color.hasColorAdjustments(step.color)) {
        colorAdjustments.push(
          await this.color.colorCorrect(placement.id, {
            clipId: placement.id,
            ...step.color,
          }),
        );
      }
    }

    const transitions = [];
    for (let index = 0; index < placements.length - 1; index++) {
      const step: ClipPlanStep = planSteps[index] ?? {};
      const transitionAfter = step.transitionAfter;
      let transitionToApply: string | undefined;
      let durationToApply = transitionDuration;

      if (transitionAfter) {
        const explicitName = transitionAfter.name ?? transitionName;
        if (explicitName && explicitName.toLowerCase() !== 'none') {
          transitionToApply = explicitName;
          durationToApply = transitionAfter.duration ?? transitionDuration;
        }
      } else if (transitionName) {
        transitionToApply = transitionName;
      }

      if (transitionToApply) {
        transitions.push(
          await this.effects.addTransitionToClip(
            placements[index].id,
            transitionToApply,
            'end',
            durationToApply,
          ),
        );
      }
    }

    const animations = [];
    for (let index = 0; index < placements.length; index++) {
      const placement = placements[index];
      const step: ClipPlanStep = planSteps[index] ?? {};
      const motion = step.motion;
      const style: MotionStyle = motion?.style ?? motionStyle;
      const hasExplicitRange = motion?.from !== undefined || motion?.to !== undefined;

      if (style === 'none' && !hasExplicitRange) {
        continue;
      }

      const range = this.motionLayout.getMotionRange(style, index);
      const from = motion?.from ?? range.from;
      const to = motion?.to ?? range.to;
      const start = motion?.startTime ?? placement.inPoint ?? step.time ?? index * clipDuration;
      const candidateEnd = motion?.endTime ?? (placement.outPoint ?? start + clipDuration) - 0.1;
      const end = Math.max(start + 0.1, candidateEnd);
      const componentName = motion?.componentName ?? 'Motion';
      const paramName = motion?.paramName ?? 'Scale';

      animations.push(
        await this.keyframe.addKeyframe(placement.id, componentName, paramName, start, from),
      );
      animations.push(
        await this.keyframe.addKeyframe(placement.id, componentName, paramName, end, to),
      );
    }

    const tracks = await this.sequenceTrack.listSequenceTracks(createdSequence.id);

    return {
      success: true,
      message: hasDirectedPlan
        ? 'Product spot assembled from directed clip plan'
        : 'Product spot assembled successfully',
      sequence: createdSequence,
      imported,
      planSteps,
      placements,
      trims,
      transitions,
      animations,
      clipEffects,
      colorAdjustments,
      tracks,
    };
  }

  private async buildBrandSpotFromMogrtAndAssets(args: BuildBrandSpotArgs): Promise<any> {
    const assemblyArgs: AssembleProductSpotArgs = {
      sequenceName: args.sequenceName,
      assetPaths: args.assetPaths,
    };
    if (args.clipDuration !== undefined) {
      assemblyArgs.clipDuration = args.clipDuration;
    }
    if (args.videoTrackIndex !== undefined) {
      assemblyArgs.videoTrackIndex = args.videoTrackIndex;
    }
    if (args.transitionName !== undefined) {
      assemblyArgs.transitionName = args.transitionName;
    }
    if (args.transitionDuration !== undefined) {
      assemblyArgs.transitionDuration = args.transitionDuration;
    }
    if (args.motionStyle !== undefined) {
      assemblyArgs.motionStyle = args.motionStyle;
    }
    if (args.clipPlan !== undefined) {
      assemblyArgs.clipPlan = args.clipPlan;
    }

    const assembly = await this.assembleProductSpot(assemblyArgs);

    if (!assembly.success || !assembly.sequence?.id) {
      return assembly;
    }

    const overlays = [];
    if (args.mogrtPath) {
      overlays.push(
        await this.graphics.importMogrt(
          assembly.sequence.id,
          args.mogrtPath,
          args.titleStartTime ?? 0.4,
          args.titleTrackIndex ?? 1,
          0,
        ),
      );
    } else {
      overlays.push({
        success: true,
        skipped: true,
        note: 'No MOGRT supplied; brand title overlay was skipped',
      });
    }

    const polish = [];
    if (args.applyDefaultPolish) {
      const placedClips = Array.isArray(assembly.placements) ? assembly.placements : [];
      const middleIndex = Math.floor(placedClips.length / 2);
      if (placedClips[middleIndex]?.id) {
        polish.push(await this.effects.applyEffect(placedClips[middleIndex].id, 'Gaussian Blur'));
      }
      const lastClip = placedClips[placedClips.length - 1];
      if (lastClip?.id) {
        polish.push(
          await this.color.colorCorrect(lastClip.id, {
            clipId: lastClip.id,
            brightness: 4,
            contrast: 8,
            saturation: 6,
          }),
        );
      }
    } else {
      polish.push({
        success: true,
        skipped: true,
        note: 'Default polish disabled. Use clipPlan effects/color for directed finishing.',
      });
    }

    const refreshedTracks = await this.sequenceTrack.listSequenceTracks(assembly.sequence.id);

    return {
      success: true,
      ...assembly,
      message: 'Brand spot assembled successfully',
      overlays,
      polish,
      tracks: refreshedTracks,
    };
  }

  private async getQeComponentParams(
    trackIndex: number,
    clipIndex: number,
    componentIndex: number,
    sequenceId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      app.enableQE(); ${this.qeClipScript(trackIndex, clipIndex, sequenceId)}
      if (!__clip) return JSON.stringify({success:false,error:'Clip not found'});
      var comp = __clip.getComponentAt(${componentIndex});
      if (!comp) return JSON.stringify({success:false,error:'Component not found'});
      var rawList = String(comp.getParamList());
      var names = rawList.split(',').map(function(s){return s.replace(/^\\s+|\\s+$/g,'');}).filter(function(s){return s.length>0;});
      var vals = {};
      for (var i=0;i<names.length;i++) { try { vals[names[i]] = String(comp.getParamValue(names[i])); } catch(e) { vals[names[i]] = 'N/A'; } }
      return JSON.stringify({success:true,componentIndex:${componentIndex},paramCount:names.length,params:vals});
    `);
  }

  private async setQeComponentParam(
    trackIndex: number,
    clipIndex: number,
    componentIndex: number,
    paramName: string,
    value: string,
    sequenceId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      app.enableQE(); ${this.qeClipScript(trackIndex, clipIndex, sequenceId)}
      if (!__clip) return JSON.stringify({success:false,error:'Clip not found'});
      var comp = __clip.getComponentAt(${componentIndex});
      if (!comp) return JSON.stringify({success:false,error:'Component not found'});
      var before = String(comp.getParamValue(${JSON.stringify(paramName)}));
      comp.setParamValue(${JSON.stringify(paramName)}, ${JSON.stringify(value)});
      var after = String(comp.getParamValue(${JSON.stringify(paramName)}));
      // QE takes any string and turns what it cannot use into "nan"; check what actually landed.
      var asked = ${JSON.stringify(value)};
      var landed = after === asked || (!isNaN(parseFloat(asked)) && Math.abs(parseFloat(after) - parseFloat(asked)) < 0.01);
      if (!landed) {
        try { comp.setParamValue(${JSON.stringify(paramName)}, before); } catch (eR) {}
        var restored = String(comp.getParamValue(${JSON.stringify(paramName)}));
        return JSON.stringify({success:false,verified:true,paramName:${JSON.stringify(paramName)},requested:asked,readBack:after,before:before,restored:restored===before,
          error:'The parameter read back as "' + after + '", not the requested "' + asked + '", so the value was not accepted' + (restored===before ? ' and the previous value was put back.' : '; the previous value could not be restored (now "' + restored + '").')});
      }
      return JSON.stringify({success:true,verified:true,verifiedBy:'getParamValue readback',paramName:${JSON.stringify(paramName)},before:before,after:after,changed:after!==before});
    `);
  }

  private async applyDynamics(
    trackIndex: number,
    clipIndex: number,
    sequenceId?: string,
  ): Promise<any> {
    return await this.audio.applyAudioEffectQe(
      trackIndex,
      clipIndex,
      'Dynamics Processing',
      true,
      sequenceId,
    );
  }

  private async writeSidecarFile(
    fileName: string,
    fileExtension: string,
    contents: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.project.writeSidecarFile(${JSON.stringify(fileName)}, ${JSON.stringify(fileExtension)}, ${JSON.stringify(contents)});
        return JSON.stringify({success:true,fileName:${JSON.stringify(fileName)},ext:${JSON.stringify(fileExtension)},length:${contents.length}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async getEaLoginStatus(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var loggedIn = qe.ea.isLoggedIn();
        var email = loggedIn ? String(qe.ea.getUserEmail()) : null;
        return JSON.stringify({success:true,loggedIn:loggedIn,email:email});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  /**
   * Snapshot a sequence into a tagged clone. Reuses duplicateSequence (which
   * verifies the clone by reading its new sequenceID back) so the checkpoint
   * cannot be reported as created unless it actually exists. Resolves the active
   * sequence when no id is given.
   */
  private async lookAtCut(args: any): Promise<any> {
    const max = Math.max(1, Math.min(Number(args.maxFrames) || 8, 16));
    const shots: any = await this.bridge.executeScript(`
      try {
        var seq = __findSequence(${JSON.stringify(args.sequenceId ?? null)});
        if (!seq) return JSON.stringify({ success: false, error: 'Sequence not found' });
        // The shot on screen at a time is the top-most clip there; collect each clip's midpoint
        // on every video track, then keep only the ones nothing above covers.
        var mids = [];
        for (var t = 0; t < seq.videoTracks.numTracks; t++) { var tr = seq.videoTracks[t]; for (var c = 0; c < tr.clips.numItems; c++) { var cl = tr.clips[c]; if (cl.disabled) continue; mids.push({ t: (cl.start.seconds + cl.end.seconds) / 2, track: t, name: String(cl.name) }); } }
        var visible = [];
        for (var i = 0; i < mids.length; i++) {
          var covered = false;
          for (var u = mids[i].track + 1; u < seq.videoTracks.numTracks && !covered; u++) { var up = seq.videoTracks[u]; for (var k = 0; k < up.clips.numItems; k++) { var x = up.clips[k]; if (!x.disabled && x.start.seconds <= mids[i].t && x.end.seconds > mids[i].t) { covered = true; break; } } }
          if (!covered) visible.push(mids[i]);
        }
        visible.sort(function (a, b) { return a.t - b.t; });
        return JSON.stringify({ success: true, sequenceId: String(seq.sequenceID), name: String(seq.name), shots: visible });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    if (!shots?.success) return shots;
    let picks: Array<{ t: number; name: string }> =
      Array.isArray(args.times) && args.times.length
        ? (args.times as number[]).map((t) => ({ t: Number(t), name: '' }))
        : shots.shots;
    if (picks.length > max) {
      const step = picks.length / max;
      picks = Array.from({ length: max }, (_, i) => picks[Math.floor(i * step)]!);
    }
    if (!picks.length) return { success: false, error: 'Nothing on the timeline to look at.' };
    const fsSync = await import('node:fs');
    const pathSync = await import('node:path');
    const osSync = await import('node:os');
    const work = fsSync.mkdtempSync(pathSync.join(osSync.tmpdir(), 'premiere-mcp-look-'));
    const frames: string[] = [];
    for (const [i, p] of picks.entries()) {
      const out = pathSync.join(work, `f${String(i).padStart(2, '0')}.png`);
      const r: any = await this.executeTool('capture_program_output', {
        sequenceId: shots.sequenceId,
        time: p.t,
        format: 'png',
        outputPath: out,
      });
      if (r?.success === false || !fsSync.existsSync(out))
        return {
          success: false,
          error: `Could not render the frame at ${p.t}s: ${r?.error ?? 'no file'}`,
        };
      // Label each frame with its time and shot so the sheet reads on its own.
      const labelled = pathSync.join(work, `l${String(i).padStart(2, '0')}.png`);
      const label = `${p.t.toFixed(2)}s ${p.name}`
        .replace(/[^A-Za-z0-9_. :-]/g, '')
        .slice(0, 40)
        .replace(/:/g, '\\:');
      runFf(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-i',
          out,
          '-vf',
          `scale=480:-2,drawbox=y=ih-30:w=iw:h=30:color=black@0.6:t=fill,drawtext=text='${label}':fontcolor=white:fontsize=18:x=8:y=h-24`,
          labelled,
        ],
        { timeoutMs: 30000 },
      );
      frames.push(fsSync.existsSync(labelled) ? labelled : out);
    }
    const cols = Math.min(4, frames.length),
      rows = Math.ceil(frames.length / cols);
    const sheet = args.outputPath
      ? String(args.outputPath)
      : pathSync.join(work, 'look_at_cut.jpg');
    const inputs = frames.flatMap((f) => ['-i', f]);
    if (frames.length === 1)
      runFf('ffmpeg', ['-v', 'error', '-y', '-i', frames[0]!, '-q:v', '4', sheet], {
        timeoutMs: 30000,
      });
    else
      runFf(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          ...inputs,
          '-filter_complex',
          `${frames.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${frames.length}:layout=${frames.map((_, i) => `${i % cols === 0 ? '0' : Array.from({ length: i % cols }, () => 'w0').join('+')}_${Math.floor(i / cols) === 0 ? '0' : Array.from({ length: Math.floor(i / cols) }, () => 'h0').join('+')}`).join('|')}:fill=black`,
          '-q:v',
          '4',
          sheet,
        ],
        { timeoutMs: 60000 },
      );
    if (!fsSync.existsSync(sheet))
      return { success: false, error: 'ffmpeg did not write the contact sheet.' };
    return {
      success: true,
      outputPath: sheet,
      sequence: shots.name,
      frames: picks.map((p) => ({
        timeSecs: Math.round(p.t * 1000) / 1000,
        shot: p.name || undefined,
      })),
      grid: `${cols}x${rows}`,
    };
  }

  // ---- Timeline state around edits: revert_last_call and what_changed (see timeline-state.ts)

  private callStates: Array<{
    tool: string;
    at: string;
    before: TimelineState;
    after: TimelineState;
  }> = [];
  private lastSeen = new Map<string, TimelineState>();
  private captureDownUntil = 0;

  /** The state of a sequence (or the active one), or null when Premiere cannot say. Never throws. */
  async captureTimelineState(sequenceId?: string): Promise<TimelineState | null> {
    if (Date.now() < this.captureDownUntil) return null;
    try {
      const r: any = await this.bridge.executeScript(captureScript(sequenceId), 8000);
      if (!r?.success || typeof r.hash !== 'string') return null;
      return {
        sequenceId: r.sequenceId,
        sequenceName: r.sequenceName,
        hash: r.hash,
        tracks: r.tracks,
        clips: r.clips ?? [],
        markers: r.markers ?? 0,
        project: r.project,
        capturedAt: new Date().toISOString(),
      };
    } catch {
      // A dead bridge would make every edit wait twice more; stop asking for a while.
      this.captureDownUntil = Date.now() + 30_000;
      return null;
    }
  }

  /**
   * Run an editing call with the sequence's state read before and after. Records the pair for
   * revert_last_call, and flags a change made outside this server since its last edit (a hand
   * edit in Premiere), since clip ids the assistant is holding may now be stale.
   */
  async runTracked(name: string, args: Record<string, any>, run: () => Promise<any>): Promise<any> {
    if (UNTRACKED_TOOLS.has(name) || process.env.PREMIERE_MCP_TRACK_STATE === '0') return run();
    const seqArg =
      typeof args?.sequenceId === 'string'
        ? args.sequenceId
        : typeof args?.args?.sequenceId === 'string'
          ? args.args.sequenceId
          : undefined;
    const before = await this.captureTimelineState(seqArg);
    const result = await run();
    if (!before) return result;
    const after = await this.captureTimelineState(before.sequenceId);
    const seen = this.lastSeen.get(before.sequenceId);
    const outside = seen && seen.hash !== before.hash ? diffStates(seen, before) : null;
    if (after) {
      this.lastSeen.set(after.sequenceId, after);
      if (after.hash !== before.hash) {
        this.callStates.push({ tool: name, at: new Date().toISOString(), before, after });
        if (this.callStates.length > 20) this.callStates.shift();
      }
    }
    if (outside && result && typeof result === 'object' && !Array.isArray(result)) {
      return {
        ...result,
        changedOutsideThisServer: {
          summary: describeDiff(outside),
          note: `"${before.sequenceName}" changed since the last edit made through this server, probably by hand in Premiere. Clip ids from earlier replies may be stale.`,
        },
      };
    }
    return result;
  }

  private async whatChanged(args: any): Promise<any> {
    const now = await this.captureTimelineState(
      typeof args.sequenceId === 'string' ? args.sequenceId : undefined,
    );
    if (!now) return { success: false, error: 'Could not read the sequence from Premiere.' };
    const base = this.lastSeen.get(now.sequenceId);
    this.lastSeen.set(now.sequenceId, now);
    if (!base)
      return {
        success: true,
        baselineRecorded: true,
        sequence: now.sequenceName,
        clips: now.clips.length,
        note: 'No earlier state of this sequence in this session; recorded one now. Call again later to see what changed since.',
      };
    const d = diffStates(base, now);
    const cap = <T>(a: T[]) => a.slice(0, 50);
    return {
      success: true,
      sequence: now.sequenceName,
      sequenceId: now.sequenceId,
      since: base.capturedAt,
      changed: d.changed,
      summary: describeDiff(d),
      added: cap(d.added),
      removed: cap(d.removed),
      moved: cap(d.moved),
      renamed: cap(d.renamed),
      tracks: d.tracks,
      markers: d.markers,
      project: d.project,
    };
  }

  private async revertLastCall(args: any): Promise<any> {
    const wanted = typeof args.sequenceId === 'string' ? args.sequenceId : null;
    const idx = this.callStates
      .map((c, i) => [c, i] as const)
      .filter(([c]) => !wanted || c.before.sequenceId === wanted)
      .pop()?.[1];
    if (idx === undefined)
      return {
        success: false,
        error:
          'No edit made through this server in this session changed a sequence, so there is nothing to revert. (Only calls made since the server started are tracked.)',
      };
    const last = this.callStates[idx]!;
    const now = await this.captureTimelineState(last.before.sequenceId);
    if (!now) return { success: false, error: 'Could not read the sequence from Premiere.' };
    if (now.hash === last.before.hash) {
      this.callStates.splice(idx, 1);
      return {
        success: true,
        alreadyReverted: true,
        tool: last.tool,
        note: 'The sequence is already as it was before that call.',
      };
    }
    if (now.hash !== last.after.hash && args.force !== true) {
      // Premiere has one undo stack: whatever happened since would be undone first.
      return {
        success: false,
        tool: last.tool,
        changedSince: describeDiff(diffStates(last.after, now)),
        error: `"${last.before.sequenceName}" changed after ${last.tool} ran, so undoing back to before it would also undo those later changes. Nothing was undone. Pass force:true to undo them too.`,
      };
    }
    const r: any = await this.bridge.executeScript(
      revertScript(
        last.before.sequenceId,
        last.before.hash,
        Number(args.maxSteps) > 0 ? Math.min(Number(args.maxSteps), 200) : 40,
      ),
      120000,
    );
    if (!r?.success && r?.restored === false) {
      return {
        success: false,
        tool: last.tool,
        undoSteps: r?.undoSteps,
        redoneSteps: r?.redoneSteps,
        restoredToAfter: false,
        error: `Undoing never matched the state before ${last.tool}, and redoing did not get all the way back either: the sequence is NOT as it was before this revert. Check it with what_changed, and use Premiere's Edit > Redo if needed.`,
      };
    }
    if (!r?.success) {
      return {
        success: false,
        tool: last.tool,
        undoSteps: r?.undoSteps,
        error:
          r?.error ??
          `Undoing ${r?.undoSteps} steps never got back to the state before ${last.tool}, so it redid its way back and the sequence is as it was. Some script edits never reach Premiere's undo stack (markers are one); undo those by hand, or pass a larger maxSteps if the call made many steps.`,
        restoredToAfter: r?.restored === true || r?.restoredToAfter === now.hash,
      };
    }
    this.callStates.splice(idx, 1);
    const back = await this.captureTimelineState(last.before.sequenceId);
    if (back) this.lastSeen.set(back.sequenceId, back);
    return {
      success: true,
      verified: back?.hash === last.before.hash,
      verifiedBy: 'sequence state hash equals the one recorded before the call',
      reverted: last.tool,
      ranAt: last.at,
      sequence: last.before.sequenceName,
      undoSteps: r.undoSteps,
    };
  }

  // ---- Project notes: conventions that should not be re-learned every session

  private async projectPath(): Promise<string | null> {
    const r: any = await this.bridge.executeScript(
      'try { return JSON.stringify({ success: true, path: String(app.project.path || "") }); } catch (e) { return JSON.stringify({ success: false }); }',
    );
    return r?.success && r.path ? String(r.path) : null;
  }

  private withProjectNotes(info: any): any {
    if (!info?.success || !info.path) return info;
    const file = notesPathFor(String(info.path));
    let text = '';
    try {
      text = fsSync.readFileSync(file, 'utf8');
    } catch {
      return {
        ...info,
        projectNotesPath: file,
        projectNotes: null,
        projectNotesHint:
          'No notes for this project yet. add_project_note records a convention (naming, bins, export settings) so the next session starts knowing it.',
      };
    }
    return {
      ...info,
      projectNotesPath: file,
      projectNotes:
        text.length > 4000 ? `${text.slice(0, 4000)}… (get_project_notes for the rest)` : text,
    };
  }

  private async getProjectNotes(): Promise<any> {
    const p = await this.projectPath();
    if (!p)
      return {
        success: false,
        error: 'No saved project is open (notes live next to the .prproj).',
      };
    const file = notesPathFor(p);
    try {
      return { success: true, path: file, notes: fsSync.readFileSync(file, 'utf8') };
    } catch {
      return { success: true, path: file, notes: null, note: 'No notes yet.' };
    }
  }

  private async addProjectNote(args: any): Promise<any> {
    const note = String(args.note ?? '').trim();
    if (!note) return { success: false, error: 'note is required.' };
    const p = await this.projectPath();
    if (!p)
      return {
        success: false,
        error: 'No saved project is open (notes live next to the .prproj).',
      };
    const file = notesPathFor(p);
    let text = '';
    try {
      text = fsSync.readFileSync(file, 'utf8');
    } catch {
      /* new file */
    }
    const next = addNote(
      text,
      note,
      typeof args.section === 'string' && args.section.trim() ? args.section.trim() : 'Conventions',
      new Date(),
    );
    fsSync.writeFileSync(file, next, 'utf8');
    const back = fsSync.readFileSync(file, 'utf8');
    return { success: back.includes(note), verified: back.includes(note), path: file, notes: back };
  }

  private async stringoutFromTranscript(args: any): Promise<any> {
    const id = String(args.projectItemId ?? '');
    const quotes: string[] = (args.quotes ?? []).map(String).filter((q: string) => q.trim());
    const wanted: Array<{ label: string; start: number; end: number }> = [];
    const missing: string[] = [];
    const matches: any[] = [];
    if (quotes.length) {
      if (!args.transcriptPath)
        return {
          success: false,
          error: 'quotes need a transcriptPath (.json from Whisper or .srt).',
        };
      let raw: string;
      try {
        raw = fsSync.readFileSync(String(args.transcriptPath), 'utf8');
      } catch (e: any) {
        return { success: false, error: `Could not read the transcript: ${e.message}` };
      }
      let words;
      try {
        words = /\.json$/i.test(String(args.transcriptPath))
          ? wordsFromWhisperJson(JSON.parse(raw))
          : wordsFromSrt(raw);
      } catch (e: any) {
        return { success: false, error: `Could not parse the transcript: ${e.message}` };
      }
      if (!words.length) return { success: false, error: 'The transcript has no words in it.' };
      for (const q of quotes) {
        const m = findQuote(words, q, Number(args.minScore) > 0 ? Number(args.minScore) : 0.75);
        if (!m) {
          missing.push(q);
          continue;
        }
        matches.push({ ...m, approximate: m.score < 1 });
        wanted.push({ label: q.slice(0, 60), start: m.start, end: m.end });
      }
    } else {
      for (const r of args.ranges ?? [])
        if (Number(r.end) > Number(r.start))
          wanted.push({
            label: String(r.label ?? `${r.start}-${r.end}`),
            start: Number(r.start),
            end: Number(r.end),
          });
    }
    if (!wanted.length)
      return {
        success: false,
        error: quotes.length
          ? 'None of the quotes were found in the transcript.'
          : 'Give quotes (with a transcriptPath) or ranges.',
        missing,
      };
    const info: any = await this.bridge.executeScript(`
      try {
        var it = __findProjectItem(${JSON.stringify(id)});
        if (!it) return JSON.stringify({ success: false, error: 'Project item not found' });
        var dur = 0, fr = 0;
        try { fr = Number(it.getFootageInterpretation().frameRate); } catch (e) {}
        var oi = null, oo = null; try { oi = it.getInPoint(4).seconds; oo = it.getOutPoint(4).seconds; } catch (e) {}
        try { it.clearInPoint(4); it.clearOutPoint(4); dur = Number(it.getOutPoint(4).seconds); } catch (e) {}
        try { if (oi !== null) { it.setInPoint(oi, 4); it.setOutPoint(oo, 4); } } catch (e) {}
        return JSON.stringify({ success: true, name: String(it.name), duration: dur, fps: fr > 0 ? fr : 24 });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    if (!info?.success) return info;
    const plan = planStringout(
      wanted,
      args.handleSeconds !== undefined ? Number(args.handleSeconds) : 0.15,
      info.fps,
      info.duration,
      Number(args.gapSeconds) > 0 ? Number(args.gapSeconds) : 0,
    );
    const total = plan.length
      ? Math.round(
          (plan[plan.length - 1]!.recordIn +
            plan[plan.length - 1]!.sourceOut -
            plan[plan.length - 1]!.sourceIn) *
            1000,
        ) / 1000
      : 0;
    if (args.dryRun)
      return { success: true, dryRun: true, plan, matches, missing, totalSeconds: total };
    const name = String(args.sequenceName ?? `${info.name} stringout`);
    const built: any = await this.bridge.executeScript(`
      try {
        var plan = ${JSON.stringify(plan)};
        var it = __findProjectItem(${JSON.stringify(id)});
        var seq = app.project.createNewSequenceFromClips(${JSON.stringify(name)}, [it], app.project.rootItem);
        if (!seq) return JSON.stringify({ success: false, error: 'Could not create the sequence' });
        app.project.openSequence(seq.sequenceID);
        // createNewSequenceFromClips matches the source's settings but drops the whole clip in; clear it.
        for (var v = 0; v < seq.videoTracks.numTracks; v++) while (seq.videoTracks[v].clips.numItems) seq.videoTracks[v].clips[0].remove(false, false);
        for (var a = 0; a < seq.audioTracks.numTracks; a++) while (seq.audioTracks[a].clips.numItems) seq.audioTracks[a].clips[0].remove(false, false);
        var oi = null, oo = null; try { oi = it.getInPoint(4).seconds; oo = it.getOutPoint(4).seconds; } catch (e) {}
        var placed = [], err = null;
        try {
          for (var i = 0; i < plan.length; i++) {
            it.setInPoint(plan[i].sourceIn, 4); it.setOutPoint(plan[i].sourceOut, 4);
            var t = new Time(); t.seconds = plan[i].recordIn;
            seq.videoTracks[0].overwriteClip(it, t);
          }
        } catch (eP) { err = eP.toString(); }
        try { if (oi !== null) { it.setInPoint(oi, 4); it.setOutPoint(oo, 4); } } catch (e) {}
        var tr = seq.videoTracks[0];
        for (var c = 0; c < tr.clips.numItems; c++) placed.push({ start: tr.clips[c].start.seconds, end: tr.clips[c].end.seconds, inPoint: tr.clips[c].inPoint.seconds });
        var audio = 0; try { audio = seq.audioTracks[0].clips.numItems; } catch (e) {}
        return JSON.stringify({ success: !err, error: err, sequenceId: String(seq.sequenceID), placed: placed, audioClips: audio });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    if (!built?.success)
      return { success: false, error: built?.error ?? 'Building the sequence failed.', plan };
    const tol = 0.05;
    const ok =
      built.placed.length === plan.length &&
      plan.every(
        (p, i) =>
          Math.abs(built.placed[i].start - p.recordIn) < tol &&
          Math.abs(built.placed[i].inPoint - p.sourceIn) < tol &&
          Math.abs(built.placed[i].end - built.placed[i].start - (p.sourceOut - p.sourceIn)) < tol,
      );
    return {
      success: ok,
      verified: ok,
      verifiedBy: 'start/in/duration readback of every placed clip',
      sequenceId: built.sequenceId,
      sequenceName: name,
      lines: plan.length,
      totalSeconds: total,
      audioClips: built.audioClips,
      matches,
      missing,
      plan,
      error: ok ? undefined : 'The placed clips do not match the plan; see plan and placed.',
      placed: ok ? undefined : built.placed,
    };
  }

  private async syncByAudio(args: any): Promise<any> {
    const ids: string[] = [
      String(args.referenceItemId ?? ''),
      ...((args.itemIds ?? []) as unknown[]).map(String),
    ];
    if (ids.length < 2 || !ids[0])
      return { success: false, error: 'referenceItemId and at least one itemId are required.' };
    const info: any = await this.bridge.executeScript(`
      try {
        var ids = ${JSON.stringify(ids)}, out = [];
        for (var i = 0; i < ids.length; i++) { var it = __findProjectItem(ids[i]); if (!it) return JSON.stringify({ success: false, error: 'Project item not found: ' + ids[i] }); var p = ''; try { p = String(it.getMediaPath()); } catch (e) {} out.push({ id: ids[i], name: String(it.name), path: p }); }
        return JSON.stringify({ success: true, items: out });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    if (!info?.success) return info;
    const seconds = Number(args.analyzeSeconds) > 0 ? Number(args.analyzeSeconds) : 90;
    let ref: Float32Array;
    try {
      ref = decodeAudio(info.items[0].path, seconds);
    } catch (e: any) {
      return { success: false, error: e.message };
    }
    const results: any[] = [
      {
        id: info.items[0].id,
        name: info.items[0].name,
        offsetSeconds: 0,
        score: 1,
        reference: true,
      },
    ];
    for (const it of info.items.slice(1)) {
      try {
        const r = findOffset(
          ref,
          decodeAudio(it.path, seconds),
          SYNC_RATE,
          Number(args.maxOffsetSeconds) > 0 ? Number(args.maxOffsetSeconds) : 30,
        );
        results.push({
          id: it.id,
          name: it.name,
          offsetSeconds: Math.round(r.offsetSeconds * 10000) / 10000,
          score: r.score,
          weak: r.score < 0.3,
        });
      } catch (e: any) {
        results.push({ id: it.id, name: it.name, error: e.message });
      }
    }
    const usable = results.filter((r) => r.offsetSeconds !== undefined && !r.weak);
    if (!args.sequenceName)
      return {
        success: results.every((r) => !r.error),
        offsets: results,
        note: 'Place each clip at (reference position + offsetSeconds) to line them up.',
      };
    // Build the synced sequence: shift everything so the earliest clip starts at 0.
    const shift = -Math.min(0, ...usable.map((r) => r.offsetSeconds));
    const built: any = await this.bridge.executeScript(`
      try {
        var plan = ${JSON.stringify(usable.map((r) => ({ id: r.id, at: r.offsetSeconds + shift })))};
        var refItem = __findProjectItem(plan[0].id);
        var seq = app.project.createNewSequenceFromClips(${JSON.stringify(String(args.sequenceName))}, [refItem], app.project.rootItem);
        if (!seq) return JSON.stringify({ success: false, error: 'Could not create the sequence' });
        app.project.openSequence(seq.sequenceID);
        app.enableQE();
        var q = qe.project.getActiveSequence();
        var need = plan.length;
        var g = 0; while (seq.videoTracks.numTracks < need && g++ < 20) q.addTracks(1, seq.videoTracks.numTracks, 0, 0, 0, 0, 0, 0);
        g = 0; while (seq.audioTracks.numTracks < need && g++ < 20) q.addTracks(0, 0, 0, 1, seq.audioTracks.numTracks, 0, 0, 0);
        // The reference landed at 0; move it only by placing fresh when it needs a shift.
        var placed = [];
        for (var i = 0; i < plan.length; i++) {
          var t = new Time(); t.seconds = plan[i].at;
          if (i === 0) {
            if (plan[0].at > 0.0005) { seq.videoTracks[0].clips[0].remove(false, false); try { seq.audioTracks[0].clips[0].remove(false, false); } catch (eA) {} seq.videoTracks[0].overwriteClip(refItem, t); }
          } else {
            seq.videoTracks[i].overwriteClip(__findProjectItem(plan[i].id), t);
          }
          var tr = seq.videoTracks[i];
          placed.push({ track: 'V' + (i + 1), start: tr.clips.numItems ? tr.clips[0].start.seconds : null });
        }
        return JSON.stringify({ success: true, sequenceId: String(seq.sequenceID), placed: placed });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    const placedOk =
      built?.success &&
      (built.placed as any[]).every(
        (p: any, i: number) =>
          p.start !== null && Math.abs(p.start - (usable[i].offsetSeconds + shift)) < 0.05,
      );
    return {
      success: !!placedOk,
      verified: !!placedOk,
      verifiedBy: 'clip start readback per track',
      offsets: results,
      sequenceId: built?.sequenceId,
      placed: built?.placed,
      skippedWeak: results.filter((r) => r.weak).map((r) => r.name),
      error: placedOk ? undefined : (built?.error ?? 'A clip did not land at its synced position.'),
    };
  }

  private async removeSilence(args: any): Promise<any> {
    const clipId = String(args.clipId ?? '');
    const info: any = await this.bridge.executeScript(`
      try {
        var f = __findClip(${JSON.stringify(clipId)});
        if (!f) return JSON.stringify({ success: false, error: 'Clip not found' });
        var c = f.clip, sp = 1; try { sp = Number(c.getSpeed()); } catch (e) {}
        var rev = false; try { rev = !!c.isSpeedReversed(); } catch (e) {}
        return JSON.stringify({ success: true, seq: String(f.sequenceId), start: c.start.seconds, end: c.end.seconds, inPoint: c.inPoint.seconds, speed: sp, reversed: rev,
          path: String(c.projectItem.getMediaPath()), fps: 254016000000 / Number(f.sequence.timebase), seqEnd: f.sequence.end ? Number(f.sequence.end) / 254016000000 : null });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    if (!info?.success) return info;
    if (info.reversed)
      return {
        success: false,
        error:
          'The clip is reversed, so its source silences cannot be mapped onto the timeline. Nothing was changed.',
      };
    const det: any = await this.executeTool('detect_silence', {
      mediaPath: info.path,
      noiseThresholdDb: args.noiseThresholdDb ?? -35,
      minDurationSeconds: args.minSilenceSeconds ?? 0.5,
    });
    if (!det?.success)
      return {
        success: false,
        error: `Could not analyse the clip's audio: ${det?.error ?? 'unknown'}`,
      };
    const cuts = planSilenceCuts(
      det.silenceIntervals ?? [],
      { start: info.start, end: info.end, inPoint: info.inPoint, speed: info.speed },
      args.paddingSeconds ?? 0.1,
      args.minSilenceSeconds ?? 0.5,
      info.fps,
    );
    const total = Math.round(cuts.reduce((n, c) => n + c.duration, 0) * 1000) / 1000;
    if (cuts.length === 0)
      return {
        success: true,
        cuts: [],
        removedSeconds: 0,
        note: 'No pause long enough to cut in this clip.',
      };
    if (args.confirm !== true) {
      return {
        success: false,
        needsConfirmation: true,
        cuts,
        removedSeconds: total,
        confirmPrompt: `Cut ${cuts.length} silent pause(s), ${total}s in all, from this clip? Every track is cut and closed up at those times so sync holds.`,
        error: `Plan only: ${cuts.length} pause(s), ${total}s. Nothing was cut; call again with confirm:true to apply.`,
      };
    }
    const cp: any = await this.executeTool('create_recovery_checkpoint', {
      sequenceId: info.seq,
      label: 'before remove_silence',
    });
    const done: any[] = [];
    for (const c of [...cuts].reverse()) {
      const lifted: any = await this.bridge.executeScript(`
        try {
          app.enableQE();
          var seq = __findSequence(${JSON.stringify(info.seq)});
          app.project.openSequence(seq.sequenceID);
          var q = __qeSequenceOpening(seq);
          q.razor(${JSON.stringify(toTimecode(c.start, info.fps))});
          q.razor(${JSON.stringify(toTimecode(c.end, info.fps))});
          var a = ${c.start}, b = ${c.end}, lifted = 0;
          var kinds = [seq.videoTracks, seq.audioTracks];
          for (var k = 0; k < 2; k++) for (var t = 0; t < kinds[k].numTracks; t++) {
            var tr = kinds[k][t];
            for (var i = tr.clips.numItems - 1; i >= 0; i--) {
              var cl = tr.clips[i];
              if (cl.start.seconds >= a - 0.01 && cl.end.seconds <= b + 0.01) { cl.remove(false, false); lifted++; }
            }
          }
          return JSON.stringify({ success: true, lifted: lifted });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
      if (!lifted?.success) {
        done.push({ ...c, ok: false, error: lifted?.error });
        break;
      }
      const closed: any = await this.executeTool('close_gap_at', {
        timecode: String((c.start + c.end) / 2),
        sequenceId: info.seq,
      });
      done.push({
        ...c,
        ok: closed?.success !== false,
        lifted: lifted.lifted,
        error: closed?.success === false ? closed.error : undefined,
      });
      if (closed?.success === false) break;
    }
    const failed = done.filter((d) => !d.ok);
    return {
      success: failed.length === 0,
      verified: failed.length === 0,
      verifiedBy: 'each gap closed with close_gap_at (clip start readback on every track)',
      cutsApplied: done.filter((d) => d.ok).length,
      cutsPlanned: cuts.length,
      removedSeconds:
        Math.round(done.filter((d) => d.ok).reduce((n, d) => n + d.duration, 0) * 1000) / 1000,
      cuts: done,
      recoveryCheckpoint: cp?.checkpointName ?? null,
      error: failed.length
        ? `Stopped at the cut at ${failed[0].start}s: ${failed[0].error}. Earlier (later-in-time) cuts were applied; restore from the recovery checkpoint to undo.`
        : undefined,
    };
  }

  private async verifyKeyframeInterpolation(set: any, args: any): Promise<any> {
    const data = set.data ?? set;
    const loc: any = await this.bridge.executeScript(`
      try {
        var f = __findClip(${JSON.stringify(String(args.clipId ?? args.node_id ?? args.nodeId ?? ''))}, ${JSON.stringify(args.sequenceId ?? null)});
        if (!f) return JSON.stringify({ success: false });
        return JSON.stringify({ success: true, seq: String(f.sequenceId), video: f.trackType === 'video', track: f.trackIndex, clip: f.clipIndex });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    if (!loc?.success) return set;
    const want = Number(data.interpolationType);
    const u = await runUxp(
      `
      const p = await ppro.Project.getActiveProject();
      if (!p) return { found: false, reason: 'no project is open in Premiere' };
      const s = (await p.getSequences()).find((q) => String(q.guid) === ${JSON.stringify(String(loc.seq))});
      if (!s) return { found: false, reason: 'sequence not found in UXP' };
      const tr = ${loc.video ? 'await s.getVideoTrack' : 'await s.getAudioTrack'}(${Number(loc.track)});
      if (!tr) return { found: false, reason: 'track not found in UXP' };
      const it = tr.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)[${Number(loc.clip)}];
      if (!it) return { found: false, reason: 'clip not found in UXP' };
      const chain = await it.getComponentChain();
      const n = await chain.getComponentCount();
      for (let i = 0; i < n; i++) {
        const c = await chain.getComponentAtIndex(i);
        if ((await c.getDisplayName()) !== ${JSON.stringify(String(data.component))}) continue;
        for (let j = 0; j < 40; j++) {
          let prm; try { prm = await c.getParam(j); } catch (e) { break; }
          if (!prm) break;
          if (String(prm.displayName) !== ${JSON.stringify(String(data.property))}) continue;
          const times = await prm.getKeyframeListAsTickTimes();
          let best = null, gap = Infinity;
          for (const t of times) { const d = Math.abs(t.seconds - ${Number(data.time)}); if (d < gap) { gap = d; best = t; } }
          if (!best || gap > 0.05) return { found: false };
          const k = await prm.getKeyframePtr(best);
          return { found: true, mode: await k.getTemporalInterpolationMode(), at: best.seconds };
        }
      }
      return { found: false };
    `,
      20000,
      'Check keyframe interpolation',
    );
    if (!u.ok || !u.result?.found)
      return {
        ...set,
        verified: false,
        unverifiedReason: `UXP could not locate the keyframe to read it back (${u.ok ? (u.result?.reason ?? 'no keyframe at that time') : u.error}).`,
      };
    const ok = Number(u.result.mode) === want;
    return ok
      ? {
          ...set,
          verified: true,
          verifiedBy: 'UXP Keyframe.getTemporalInterpolationMode readback',
          readBackMode: u.result.mode,
        }
      : {
          success: false,
          verified: true,
          error: `Interpolation reads back as mode ${u.result.mode}, not the requested ${want}.`,
          readBackMode: u.result.mode,
        };
  }

  private async createRecoveryCheckpoint(sequenceId?: string, label?: string): Promise<any> {
    let sourceId = sequenceId;
    let sourceName: string | undefined;
    const activeBefore = await this.sequenceTrack.getActiveSequence();
    if (!sourceId) {
      const active = activeBefore;
      if (!active || active.success === false || !active.id) {
        return {
          success: false,
          error:
            'No sequenceId was given and there is no active sequence to snapshot. Open a sequence or pass sequenceId.',
        };
      }
      sourceId = active.id;
      sourceName = active.name;
    }

    const createdAt = formatCheckpointTimestamp(new Date());
    const checkpointName = buildRecoveryCheckpointName(label || 'checkpoint', createdAt);
    const dup = await this.sequenceTrack.duplicateSequence(
      sourceId as string,
      checkpointName,
      false,
    );
    if (!dup || dup.success === false) {
      return {
        success: false,
        error: `Recovery checkpoint clone failed: ${dup?.error || 'unknown error'}`,
        sourceSequenceId: sourceId,
      };
    }

    // Premiere activates a fresh clone, so without this every later call that defaults to the
    // active sequence lands on the SNAPSHOT — the same drift transactions.ts already undoes for
    // checkpoints taken inside a plan. A checkpoint is a backup, not a change of target.
    let activeRestored: boolean | null = null;
    if (activeBefore && activeBefore.success !== false && activeBefore.id) {
      const restore = await this.bridge.executeScript(`
        try {
          var want = ${JSON.stringify(String(activeBefore.id))};
          var cur = app.project.activeSequence;
          if (!cur || String(cur.sequenceID) !== want) app.project.openSequence(want);
          cur = app.project.activeSequence;
          return JSON.stringify({ success: true, restored: !!cur && String(cur.sequenceID) === want });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
      activeRestored = Boolean(restore && restore.restored);
    }

    return {
      success: true,
      activeSequenceRestored: activeRestored,
      checkpointSequenceId: dup.newSequenceId ?? null,
      checkpointProjectItemId: dup.newProjectItemId ?? null,
      checkpointName: dup.newName || checkpointName,
      sourceSequenceId: sourceId,
      sourceName: sourceName ?? null,
      createdAt,
    };
  }

  /** List every sequence tagged as a recovery checkpoint, newest first. */
  private async listRecoveryCheckpoints(labelContains?: string): Promise<any> {
    const list = await this.sequenceTrack.listSequences();
    if (!list || list.success === false || !Array.isArray(list.sequences)) {
      return {
        success: false,
        error: `Could not list sequences to find checkpoints: ${list?.error || 'unknown error'}`,
      };
    }

    const filter = (labelContains || '').trim().toLowerCase();
    const checkpoints = list.sequences
      .filter((seq: any) => isRecoveryCheckpointName(seq.name))
      .map((seq: any) => {
        const parsed = parseRecoveryCheckpointName(seq.name);
        return {
          sequenceId: seq.id,
          name: seq.name,
          label: parsed?.label ?? null,
          createdAt: parsed?.createdAt ?? null,
          duration: seq.duration,
        };
      })
      .filter((cp: any) => !filter || (cp.label && cp.label.toLowerCase().indexOf(filter) !== -1))
      // createdAt is a sortable YYYYMMDD-HHMMSS.mmm string; newest first.
      .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return {
      success: true,
      checkpoints,
      count: checkpoints.length,
      tag: RECOVERY_PREFIX,
    };
  }

  /**
   * Restore a checkpoint by cloning it into a fresh working sequence. The
   * checkpoint is never consumed, so this can be repeated. Optionally opens the
   * restored sequence as the active timeline.
   */
  private async restoreRecoveryCheckpoint(
    checkpointSequenceId: string,
    newName?: string,
    setActive: boolean = true,
  ): Promise<any> {
    // Resolve the checkpoint so we can name the restored copy from its label and
    // fail clearly if the id is wrong (rather than cloning something unexpected).
    const list = await this.sequenceTrack.listSequences();
    if (!list || list.success === false || !Array.isArray(list.sequences)) {
      return {
        success: false,
        error: `Could not read sequences to locate the checkpoint: ${list?.error || 'unknown error'}`,
      };
    }
    const checkpoint = list.sequences.find(
      (seq: any) => String(seq.id) === String(checkpointSequenceId),
    );
    if (!checkpoint) {
      return {
        success: false,
        error: `No sequence found with id '${checkpointSequenceId}'. Use list_recovery_checkpoints to get a valid checkpoint id.`,
      };
    }

    const parsed = parseRecoveryCheckpointName(checkpoint.name);
    const restoredName =
      (newName && newName.trim()) || `${parsed?.label || checkpoint.name} (restored)`;

    const dup = await this.sequenceTrack.duplicateSequence(
      String(checkpointSequenceId),
      restoredName,
      false,
    );
    if (!dup || dup.success === false) {
      return {
        success: false,
        error: `Failed to clone the checkpoint into a working sequence: ${dup?.error || 'unknown error'}`,
        checkpointSequenceId,
      };
    }

    let activated = false;
    let activateError: string | undefined;
    if (setActive !== false && dup.newSequenceId) {
      const active = await this.sequenceTrack.setActiveSequence(String(dup.newSequenceId));
      activated = !!active && active.success !== false;
      if (!activated) activateError = active?.error || 'could not open the restored sequence';
    }

    return {
      success: true,
      restoredSequenceId: dup.newSequenceId ?? null,
      restoredProjectItemId: dup.newProjectItemId ?? null,
      restoredName: dup.newName || restoredName,
      fromCheckpointId: checkpointSequenceId,
      fromCheckpointName: checkpoint.name,
      active: activated,
      ...(activateError ? { activateWarning: activateError } : {}),
      note: 'The checkpoint was left intact; this is a fresh working copy of the snapshot.',
    };
  }

  private async moveClip(clipId: string, newTime: number): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var oldTime = clip.start.seconds;
        var shiftAmount = ${newTime} - oldTime;
        clip.move(shiftAmount);
        var actualTime = clip.start.seconds;
        if (Math.abs(actualTime - ${newTime}) > 0.02) return JSON.stringify({ success: false, verified: false, error: "Premiere did not move the clip to " + ${newTime} + "s (reads back at " + actualTime + "s). Another clip may occupy the target position.", oldTime: oldTime, requested: ${newTime}, actual: actualTime });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Clip moved successfully",
          clipId: ${JSON.stringify(clipId)},
          oldTime: oldTime,
          newTime: actualTime,
          trackIndex: info.trackIndex
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  /**
   * Pure sequence-diff. Compares two walked timelines track-by-track and reports
   * what changed: clips added, removed, moved (same clip, new start time) and
   * retimed (same clip, new duration). Side-effect-free and bridge-independent so
   * it can be unit-tested against fixtures. Clips are matched within a track by
   * name (nearest start time wins when a name repeats); comparisons use a
   * half-frame epsilon. Pairs with the recovery checkpoints so an agent can see
   * exactly what an edit changed.
   */
  private diffTimelineData(
    a: { frameRate?: number; videoTracks?: any[]; audioTracks?: any[] },
    b: { frameRate?: number; videoTracks?: any[]; audioTracks?: any[] },
  ): { added: any[]; removed: any[]; moved: any[]; retimed: any[] } {
    const fps =
      b.frameRate && b.frameRate > 0
        ? b.frameRate
        : a.frameRate && a.frameRate > 0
          ? a.frameRate
          : 30;
    const epsilon = 1 / fps / 2;
    const added: any[] = [];
    const removed: any[] = [];
    const moved: any[] = [];
    const retimed: any[] = [];

    const groupKey = (type: string, idx: number): string => `${type}:${idx}`;
    const collect = (data: { videoTracks?: any[]; audioTracks?: any[] }): Map<string, any[]> => {
      const map = new Map<string, any[]>();
      for (const t of data.videoTracks || [])
        map.set(groupKey('video', t.index), (t.clips || []).slice());
      for (const t of data.audioTracks || [])
        map.set(groupKey('audio', t.index), (t.clips || []).slice());
      return map;
    };

    const mapA = collect(a);
    const mapB = collect(b);
    const keys = new Set<string>([...mapA.keys(), ...mapB.keys()]);

    for (const key of keys) {
      const [trackType, trackIdxStr] = key.split(':');
      const trackIndex = Number(trackIdxStr);
      const clipsA = (mapA.get(key) || []).slice();
      const remainingB = (mapB.get(key) || []).slice();

      for (const ca of clipsA) {
        // Find the best B-match by name (closest start time).
        let bestIdx = -1;
        let bestDelta = Infinity;
        for (let k = 0; k < remainingB.length; k++) {
          if (remainingB[k].name === ca.name) {
            const delta = Math.abs(remainingB[k].startTime - ca.startTime);
            if (delta < bestDelta) {
              bestDelta = delta;
              bestIdx = k;
            }
          }
        }
        if (bestIdx === -1) {
          removed.push({
            trackType,
            trackIndex,
            name: ca.name,
            startTime: ca.startTime,
            duration: ca.duration,
          });
          continue;
        }
        const cb = remainingB.splice(bestIdx, 1)[0];
        if (Math.abs(cb.startTime - ca.startTime) > epsilon) {
          moved.push({
            trackType,
            trackIndex,
            name: ca.name,
            fromStart: ca.startTime,
            toStart: cb.startTime,
            deltaSeconds: Math.round((cb.startTime - ca.startTime) * 1000) / 1000,
          });
        }
        if (Math.abs(cb.duration - ca.duration) > epsilon) {
          retimed.push({
            trackType,
            trackIndex,
            name: ca.name,
            fromDuration: ca.duration,
            toDuration: cb.duration,
            deltaSeconds: Math.round((cb.duration - ca.duration) * 1000) / 1000,
          });
        }
      }
      for (const cb of remainingB) {
        added.push({
          trackType,
          trackIndex,
          name: cb.name,
          startTime: cb.startTime,
          duration: cb.duration,
        });
      }
    }
    return { added, removed, moved, retimed };
  }

  /**
   * Compare two sequences and report what changed between them. Read-only: it
   * walks both timelines and runs the pure diffTimelineData. Useful for
   * reviewing an AI edit against the original, or a restored recovery checkpoint
   * against the current cut.
   */
  private async diffSequences(sequenceIdA?: string, sequenceIdB?: string): Promise<any> {
    if (!sequenceIdA || !sequenceIdB) {
      return {
        success: false,
        error:
          'Provide both sequenceIdA and sequenceIdB (the "before" and "after" sequences to compare).',
      };
    }
    const [wa, wb] = await Promise.all([
      this.sequenceTrack.walkSequence(sequenceIdA),
      this.sequenceTrack.walkSequence(sequenceIdB),
    ]);
    if (!wa || !wa.success)
      return {
        success: false,
        error: `Could not read sequenceIdA: ${(wa && wa.error) || 'unknown error'}`,
      };
    if (!wb || !wb.success)
      return {
        success: false,
        error: `Could not read sequenceIdB: ${(wb && wb.error) || 'unknown error'}`,
      };

    const diff = this.diffTimelineData(wa, wb);
    const changeCount =
      diff.added.length + diff.removed.length + diff.moved.length + diff.retimed.length;
    return {
      success: true,
      sequenceA: { id: wa.sequenceId, name: wa.sequenceName, frameRate: wa.frameRate },
      sequenceB: { id: wb.sequenceId, name: wb.sequenceName, frameRate: wb.frameRate },
      identical: changeCount === 0,
      changeCount,
      counts: {
        added: diff.added.length,
        removed: diff.removed.length,
        moved: diff.moved.length,
        retimed: diff.retimed.length,
      },
      added: diff.added,
      removed: diff.removed,
      moved: diff.moved,
      retimed: diff.retimed,
      note:
        changeCount === 0
          ? 'The two sequences have the same clips in the same positions (within a half-frame). Read-only comparison.'
          : 'Read-only comparison. "moved" = same clip at a new start time; "retimed" = same clip with a new duration. Clips are matched within a track by name.',
    };
  }

  /**
   * Pure timeline QC analyzer. Given the walked track data, produce a list of
   * findings. Kept side-effect-free and independent of the bridge so it can be
   * unit-tested directly against fixtures (like parseSilenceIntervals). All time
   * comparisons use a half-frame epsilon so floating-point clip boundaries do not
   * masquerade as gaps or overlaps.
   */
  private lintTimelineData(
    data: {
      frameRate?: number;
      videoTracks?: Array<{
        index: number;
        name?: string;
        clips: Array<{
          name?: string;
          startTime: number;
          endTime: number;
          duration: number;
          sourceFrameRate?: number;
        }>;
      }>;
      audioTracks?: Array<{
        index: number;
        name?: string;
        clips: Array<{
          name?: string;
          startTime: number;
          endTime: number;
          duration: number;
          sourceFrameRate?: number;
        }>;
      }>;
    },
    flashFrameThresholdFrames = 2,
    gapThresholdFrames = 1,
    checks?: string[],
  ): Array<Record<string, unknown>> {
    const fps = data.frameRate && data.frameRate > 0 ? data.frameRate : 30;
    const frame = 1 / fps;
    const epsilon = frame / 2;
    const run = (name: string): boolean => !checks || checks.length === 0 || checks.includes(name);
    const findings: Array<Record<string, unknown>> = [];

    const tracks = [
      ...(data.videoTracks || []).map((t) => ({ ...t, trackType: 'video' as const })),
      ...(data.audioTracks || []).map((t) => ({ ...t, trackType: 'audio' as const })),
    ];

    for (const track of tracks) {
      const label = `${track.trackType === 'video' ? 'Video' : 'Audio'} ${track.index + 1}`;
      // Sort defensively; a track's clips should already be in order.
      const clips = [...(track.clips || [])].sort((a, b) => a.startTime - b.startTime);

      // Leading gap: black/silence before the first clip.
      if (run('leading_gap') && clips.length > 0) {
        const first = clips[0]!;
        if (first.startTime > gapThresholdFrames * frame + epsilon) {
          findings.push({
            type: 'leading_gap',
            severity: 'warning',
            trackType: track.trackType,
            trackIndex: track.index,
            startTime: 0,
            endTime: first.startTime,
            gapFrames: Math.round(first.startTime * fps),
            message: `${label}: ${Math.round(first.startTime * fps)}-frame gap before the first clip ("${first.name ?? 'unnamed'}").`,
          });
        }
      }

      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i]!;
        // Flash frame: a clip shorter than the threshold.
        if (run('flash_frames')) {
          const durFrames = clip.duration * fps;
          if (durFrames < flashFrameThresholdFrames - 1e-6) {
            findings.push({
              type: 'flash_frame',
              severity: 'warning',
              trackType: track.trackType,
              trackIndex: track.index,
              clipName: clip.name,
              startTime: clip.startTime,
              endTime: clip.endTime,
              durationFrames: Math.round(durFrames * 1000) / 1000,
              message: `${label}: clip "${clip.name ?? 'unnamed'}" is ${Math.round(durFrames * 100) / 100} frames long -- likely an accidental flash frame.`,
            });
          }
        }
        // Mixed frame rate: a clip whose source fps differs from the sequence.
        if (
          run('mixed_frame_rate') &&
          typeof clip.sourceFrameRate === 'number' &&
          clip.sourceFrameRate > 0
        ) {
          if (Math.abs(clip.sourceFrameRate - fps) > 0.01) {
            findings.push({
              type: 'mixed_frame_rate',
              severity: 'warning',
              trackType: track.trackType,
              trackIndex: track.index,
              clipName: clip.name,
              startTime: clip.startTime,
              sourceFrameRate: clip.sourceFrameRate,
              sequenceFrameRate: Math.round(fps * 1000) / 1000,
              message: `${label}: clip "${clip.name ?? 'unnamed'}" is ${clip.sourceFrameRate} fps in a ${Math.round(fps * 1000) / 1000} fps sequence -- may stutter or drop frames.`,
            });
          }
        }
        // Gap / overlap versus the next clip.
        const next = clips[i + 1];
        if (next) {
          const delta = next.startTime - clip.endTime;
          if (run('overlaps') && delta < -epsilon) {
            findings.push({
              type: 'overlap',
              severity: 'warning',
              trackType: track.trackType,
              trackIndex: track.index,
              startTime: next.startTime,
              endTime: clip.endTime,
              overlapFrames: Math.round(-delta * fps),
              message: `${label}: "${clip.name ?? 'unnamed'}" overlaps "${next.name ?? 'unnamed'}" by ${Math.round(-delta * fps)} frame(s).`,
            });
          } else if (run('gaps') && delta > gapThresholdFrames * frame + epsilon) {
            findings.push({
              type: 'gap',
              severity: 'info',
              trackType: track.trackType,
              trackIndex: track.index,
              startTime: clip.endTime,
              endTime: next.startTime,
              gapFrames: Math.round(delta * fps),
              message: `${label}: ${Math.round(delta * fps)}-frame gap between "${clip.name ?? 'unnamed'}" and "${next.name ?? 'unnamed'}".`,
            });
          }
        }
      }
    }
    return findings;
  }

  /**
   * Walk a sequence's tracks and run automated QC checks on it. The walk (via
   * the bridge) only reads; the analysis is the pure lintTimelineData above.
   * Defaults to the active sequence. Source frame rate is read best-effort from
   * each clip's project item -- when Premiere will not give it up, the
   * mixed-frame-rate check simply skips that clip rather than guessing.
   */
  private async lintTimeline(
    sequenceId?: string,
    flashFrameThresholdFrames = 2,
    gapThresholdFrames = 1,
    checks?: string[],
  ): Promise<any> {
    const walked = await this.sequenceTrack.walkSequence(sequenceId);
    if (!walked || !walked.success) {
      return {
        success: false,
        error: (walked && walked.error) || 'Could not read the sequence for linting.',
      };
    }

    const findings = this.lintTimelineData(
      {
        frameRate: walked.frameRate,
        videoTracks: walked.videoTracks,
        audioTracks: walked.audioTracks,
      },
      flashFrameThresholdFrames,
      gapThresholdFrames,
      checks,
    );

    const bySeverity = { warning: 0, info: 0 };
    for (const f of findings) {
      const sev = f.severity as 'warning' | 'info';
      if (sev in bySeverity) bySeverity[sev] += 1;
    }

    return {
      success: true,
      sequenceId: walked.sequenceId,
      sequenceName: walked.sequenceName,
      frameRate: walked.frameRate,
      clean: findings.length === 0,
      findingCount: findings.length,
      countsBySeverity: bySeverity,
      findings,
      note:
        findings.length === 0
          ? 'No issues found for the selected checks. Read-only -- nothing was changed.'
          : 'Read-only QC report -- nothing was changed. Fix gaps with ripple delete/close-gap, flash frames by removing or extending the clip, and mixed frame rates by interpreting footage or re-rendering.',
    };
  }

  private async getAppState(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var o = { success: true };
        try { o.documentOpen = app.isDocumentOpen(); } catch(e1) { o.documentOpenError = e1.toString(); }
        try { o.version = String(app.version); } catch(e2) {}
        try { o.build = String(app.build); } catch(e3) {}
        try { o.appPath = String(app.path); } catch(e4) {}
        try { o.proxiesEnabled = app.getEnableProxies() === true; } catch(e5) {}
        try {
          var ids = app.getProjectViewIDs();
          o.projectViewIds = [];
          if (ids) for (var i = 0; i < ids.length; i++) o.projectViewIds.push(String(ids[i]));
        } catch(e6) { o.projectViewIdsError = e6.toString(); }
        try {
          var sel = app.getCurrentProjectViewSelection();
          o.currentViewSelectionCount = sel ? sel.length : 0;
          o.currentViewSelection = [];
          if (sel) for (var j = 0; j < sel.length; j++) {
            o.currentViewSelection.push({ name: String(sel[j].name), nodeId: String(sel[j].nodeId) });
          }
        } catch(e7) { o.selectionError = e7.toString(); }
        try { o.openProjectCount = app.projects ? app.projects.numProjects : null; } catch(e8) {}
        try {
          // Resolve each view GUID to its project so a caller can map views to documents
          // without a second round trip.
          var vids = app.getProjectViewIDs();
          o.viewProjects = [];
          if (vids) for (var k = 0; k < vids.length; k++) {
            try {
              var pr = app.getProjectFromViewID(String(vids[k]));
              o.viewProjects.push({ viewId: String(vids[k]), project: pr ? String(pr.name) : null });
            } catch(e9) {}
          }
        } catch(e10) {}
        try { o.currentProjectIsDocument = app.isDocument(String(app.project.path)); } catch(e11) {}
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  private async getLocationCopySettings(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var o = { success: true };
        try { o.adobeLocationCopyEnabled = app.project.isAdobeLocationCopyEnabled(); } catch(e1) { o.adobeError = e1.toString(); }
        try { o.sharedLocationCopyEnabled = app.project.isSharedLocationCopyEnabled(); } catch(e2) { o.sharedError = e2.toString(); }
        try { o.sharedLocation = String(app.project.getSharedLocation()); } catch(e3) { o.sharedLocationError = e3.toString(); }
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  private async setLocationCopySettings(mode: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var mode = ${JSON.stringify(mode)};
        var beforeAdobe = null, beforeShared = null;
        try { beforeAdobe = app.project.isAdobeLocationCopyEnabled(); } catch(e1) {}
        try { beforeShared = app.project.isSharedLocationCopyEnabled(); } catch(e2) {}
        if (mode === 'adobe') { app.project.enableAdobeLocationCopy(true); }
        else if (mode === 'shared') { app.project.enableSharedLocationCopy(true); }
        else { app.project.disableCopyToLocationSetting(); }
        var afterAdobe = null, afterShared = null;
        try { afterAdobe = app.project.isAdobeLocationCopyEnabled(); } catch(e3) {}
        try { afterShared = app.project.isSharedLocationCopyEnabled(); } catch(e4) {}
        var expectAdobe = mode === 'adobe';
        var expectShared = mode === 'shared';
        var ok = (afterAdobe === expectAdobe) && (afterShared === expectShared);
        return JSON.stringify({ success: true, verified: ok, mode: mode,
          before: { adobe: beforeAdobe, shared: beforeShared },
          after: { adobe: afterAdobe, shared: afterShared },
          note: ok ? undefined : 'Flags did not read back as requested; the build may not support this combination.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  private async pauseGrowingFile(paused: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.project.pauseGrowing(${paused});
        return JSON.stringify({ success: true, verified: false, paused: ${paused},
          note: 'No getter exists for growing-file state, so this could not be read back.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  private async getQeClipSettings(trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var track = seq.getVideoTrackAt(${trackIndex});
        if (!track) return JSON.stringify({ success: false, error: 'QE video track ${trackIndex} not found' });
        var clip = __qeClipByIndex(seq, 'video', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({ success: false, error: 'QE clip ${clipIndex} not found' });
        var o = { success: true };
        // EIGHT QE CLIP PROPERTIES CANNOT BE READ ON 26.3.2, and reading one does not throw a
        // catchable exception — it kills the entire evalScript, so the whole tool returned the
        // generic "ExtendScript execution failed" with nothing usable. The try/catch wrappers
        // below gave false confidence: the failure is at the evalScript layer, beneath JS.
        //
        // Measured one-property-per-call:
        //   FATAL to read: reverse, borderWidth, borderColor, alignment, antiAliasQuality,
        //                  startPercent, endPercent, switchSources
        //   SAFE  to read: name, type, start, end, duration, mediaType, numComponents, speed,
        //                  reversed, frameBlend, multicamEnabled, scaleToFrameSize,
        //                  staticClipGain, timeInterpolationType
        //
        // Note reversed (safe) vs reverse (fatal) — the two names differ by one letter and by
        // whether they take the host down.
        try { o.name = String(clip.name); } catch(x) {}
        try { o.scaleToFrameSize = String(clip.scaleToFrameSize); } catch(x) {}
        try { o.staticClipGain = String(clip.staticClipGain); } catch(x) {}
        try { o.frameBlend = String(clip.frameBlend); } catch(x) {}
        try { o.timeInterpolationType = String(clip.timeInterpolationType); } catch(x) {}
        try { o.speed = String(clip.speed); } catch(x) {}
        try { o.reversed = String(clip.reversed); } catch(x) {}
        try { o.multicamEnabled = String(clip.multicamEnabled); } catch(x) {}
        o.unreadableOnThisBuild = ['reverse','borderWidth','borderColor','alignment','antiAliasQuality','startPercent','endPercent','switchSources'];
        o.unreadableNote = 'Those eight QE properties terminate the whole script when read on 26.3.2, so they are deliberately not read here. Use reversed instead of reverse; the border and percent values have no readable equivalent.';
        try { o.reversed = String(clip.reversed); } catch(x) {}
        try { o.multicamEnabled = String(clip.multicamEnabled); } catch(x) {}
        try { o.numComponents = clip.numComponents; } catch(x) {}
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  private async getProxiesEnabled(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        // getEnableProxies() returns a NUMBER (1/0), not a boolean. Strict equality to true was
        // therefore ALWAYS false, so this tool could only ever report "OFF" — including when
        // proxy playback was on. Measured on 26.3.2: reads back as 1 when enabled.
        var raw = app.getEnableProxies();
        var enabled = !!raw;
        return JSON.stringify({
          success: true,
          verified: true,
          proxiesEnabled: enabled,
          rawValue: String(raw),
          note: enabled
            ? 'Proxy playback is ON: attached proxies are being used where a clip has one. A clip with no attached proxy still plays at full resolution — check has_proxy per clip.'
            : 'Proxy playback is OFF. Any attached proxies are being IGNORED and clips play at full resolution. This is the usual cause of slow playback after generating proxies — enable it with set_proxies_enabled.'
        });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  private async setProxiesEnabled(enabled: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        // getEnableProxies() returns a NUMBER (1/0), not a boolean, so the old strict
        // inequality against true could never hold and this tool reported failure on a write
        // that had actually worked — measured on 26.3.2, reading back as 1 after
        // setEnableProxies(true). Compare truthiness, and report the raw value so the shape is
        // visible rather than hidden by the coercion.
        var rawBefore = app.getEnableProxies();
        app.setEnableProxies(${enabled});
        var rawAfter = app.getEnableProxies();
        var before = !!rawBefore, after = !!rawAfter;
        if (after !== ${enabled}) {
          return JSON.stringify({ success: false, verified: true, error: 'setEnableProxies(${enabled}) ran but the global proxy flag reads back as ' + after + '.', before: before, after: after, rawAfter: String(rawAfter) });
        }
        return JSON.stringify({ success: true, verified: true, proxiesEnabled: after, changed: before !== after, rawValue: String(rawAfter),
          note: 'This is the GLOBAL Toggle Proxies switch, not a per-clip attachment. A clip still needs an attached proxy for it to have any effect — check has_proxy.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  private async timelineFingerprint(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var parts=[String(seq.name)];
        for(var t=0;t<seq.videoTracks.numTracks;t++){
          var track=seq.videoTracks[t];
          for(var c=0;c<track.clips.numItems;c++){
            var clip=track.clips[c];
            parts.push(t+':'+c+':'+clip.start.seconds.toFixed(3)+':'+clip.end.seconds.toFixed(3)+':'+String(clip.name));
          }
        }
        var hash=0,str=parts.join('|');
        for(var i=0;i<str.length;i++)hash=((hash<<5)-hash)+str.charCodeAt(i);
        return JSON.stringify({success:true,fingerprint:(hash>>>0).toString(16),clipCount:parts.length-1,sequenceName:String(seq.name)});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  private async snapshotState(outputPath: string, seqId?: string): Promise<any> {
    const result = await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var state={sequenceName:String(seq.name),sequenceID:String(seq.sequenceID),tracks:[]};
        for(var t=0;t<seq.videoTracks.numTracks;t++){
          var trackData={index:t,clips:[]};
          var track=seq.videoTracks[t];
          for(var c=0;c<track.clips.numItems;c++){
            var clip=track.clips[c];
            trackData.clips.push({name:String(clip.name),startSecs:clip.start.seconds,endSecs:clip.end.seconds,effectCount:clip.components.numItems});
          }
          state.tracks.push(trackData);
        }
        return JSON.stringify({success:true,state:state});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
    if (result && result.success) {
      const fs = fsSync;
      try {
        fs.writeFileSync(outputPath, JSON.stringify(result.state, null, 2));
        return { ...result, outputPath, written: true };
      } catch (e: any) {
        return { ...result, outputPath, written: false, writeError: e.message };
      }
    }
    return result;
  }

  private async assertClipsUnchanged(snapshotPath: string, seqId?: string): Promise<any> {
    const fs = fsSync;
    let saved: any;
    try {
      saved = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    } catch (e: any) {
      return { success: false, error: `Cannot read snapshot: ${e.message}` };
    }
    const current = await this.snapshotState('/dev/null', seqId);
    if (!current || !current.success) return current;
    const diffs: string[] = [];
    const savedTracks = saved.tracks || [];
    const curTracks = (current.state || {}).tracks || [];
    if (savedTracks.length !== curTracks.length)
      diffs.push(`Track count changed: ${savedTracks.length} → ${curTracks.length}`);
    savedTracks.forEach((st: any, ti: number) => {
      const ct = curTracks[ti];
      if (!ct) {
        diffs.push(`Track ${ti} missing`);
        return;
      }
      if (st.clips.length !== ct.clips.length)
        diffs.push(`Track ${ti} clip count: ${st.clips.length} → ${ct.clips.length}`);
      st.clips.forEach((sc: any, ci: number) => {
        const cc = ct.clips[ci];
        if (!cc) {
          diffs.push(`Track ${ti} clip ${ci} missing`);
          return;
        }
        if (Math.abs(sc.startSecs - cc.startSecs) > 0.001)
          diffs.push(
            `Track ${ti} clip ${ci} "${sc.name}" start: ${sc.startSecs} → ${cc.startSecs}`,
          );
        if (sc.name !== cc.name)
          diffs.push(`Track ${ti} clip ${ci} name: "${sc.name}" → "${cc.name}"`);
      });
    });
    return { success: true, unchanged: diffs.length === 0, diffCount: diffs.length, diffs };
  }

  private async getAppProperty(key: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var val=app.properties.getProperty(${JSON.stringify(key)});
        return JSON.stringify({success:true,key:${JSON.stringify(key)},value:String(val),exists:val!==''&&val!==undefined});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  private async setAppProperty(key: string, value: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var before=null; try{ before=String(app.properties.getProperty(${JSON.stringify(key)})); }catch(eB){}
        var setError=null;
        try{ app.properties.setProperty(${JSON.stringify(key)},${JSON.stringify(value)}); }catch(eS){ setError=eS.toString(); }
        var back=null; try{ back=String(app.properties.getProperty(${JSON.stringify(key)})); }catch(eA){}
        if(back===null){
          return JSON.stringify({success:true,verified:false,key:${JSON.stringify(key)},value:${JSON.stringify(value)},before:before,setError:setError,
            unverifiedReason:'app.properties.getProperty() did not return a value for this key after the write, so the property cannot be confirmed.'});
        }
        if(back!==${JSON.stringify(value)}){
          return JSON.stringify({success:false,verified:true,verifiedBy:'app.properties.getProperty() readback',changed:back!==before,key:${JSON.stringify(key)},value:${JSON.stringify(value)},before:before,readback:back,setError:setError,
            error:'The property reads back as "' + back + '" rather than the requested value. Many app properties are read-only or coerce the value they are given.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'app.properties.getProperty() readback',changed:back!==before,key:${JSON.stringify(key)},value:${JSON.stringify(value)},before:before,readback:back,
          note: back === before ? 'The property already held this value; nothing changed.' : undefined});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  /**
   * Locates Premiere's prefs file by searching, not by constructing a path from a guessed version
   * number and account name. A constructed path that misses silently reports "persisted" for a
   * write that went nowhere, which is the exact failure mode this tool exists to prevent.
   */
  private findPremierePrefsFile(): string | null {
    const roots =
      platform() === 'win32'
        ? [
            pathSync.join(
              process.env.APPDATA ?? pathSync.join(homedir(), 'AppData', 'Roaming'),
              'Adobe',
              'Premiere Pro',
            ),
          ]
        : [
            pathSync.join(homedir(), 'Documents', 'Adobe', 'Premiere Pro'),
            pathSync.join(homedir(), 'Library', 'Preferences', 'Adobe', 'Premiere Pro'),
          ];
    const found: { path: string; mtime: number }[] = [];
    for (const root of roots) {
      let versions: string[] = [];
      try {
        versions = fsSync.readdirSync(root);
      } catch {
        continue;
      }
      for (const version of versions) {
        const versionDir = pathSync.join(root, version);
        let profiles: string[] = [];
        try {
          profiles = fsSync.readdirSync(versionDir);
        } catch {
          continue;
        }
        for (const profile of profiles) {
          if (!profile.startsWith('Profile-')) continue;
          const candidate = pathSync.join(versionDir, profile, 'Adobe Premiere Pro Prefs');
          try {
            const stat = fsSync.statSync(candidate);
            if (stat.isFile()) found.push({ path: candidate, mtime: stat.mtimeMs });
          } catch {
            /* not this one */
          }
        }
      }
    }
    // Newest wins: several Premiere versions can be installed and only the running one is current.
    found.sort((a, b) => b.mtime - a.mtime);
    return found.length > 0 ? found[0]!.path : null;
  }

  /**
   * Rewrites one `<Key>value</Key>` tag in the prefs file, backing the file up first.
   *
   * Deliberately surgical: it refuses unless exactly one occurrence of the key is present, because
   * a broad substitution in Adobe's prefs file is how you make Premiere reset every preference on
   * next launch. Premiere overwrites this file from memory on a graceful quit, so this write only
   * matters when Premiere is force-quit or crashes before that.
   */
  private persistPrefToFile(key: string, value: string): any {
    // Refuse under a test runner. This method rewrites a real Adobe preferences file discovered by
    // globbing the user's home directory, and it is on by default — so a unit test that calls
    // set_autosave_settings with default arguments would silently trash the preferences of the
    // Premiere install on the machine running CI. That is the same shape as the harness that
    // overwrote a 111-sequence cut: real user state reached through a soft check. A hard refusal
    // costs a test nothing (assert on the returned reason) and is the only thing that cannot be
    // forgotten.
    if (
      process.env.JEST_WORKER_ID !== undefined ||
      process.env.NODE_ENV === 'test' ||
      process.env.PREMIERE_MCP_NO_PREFS_WRITE === '1'
    ) {
      return {
        persisted: false,
        refused: true,
        reason:
          "Refusing to write Premiere's preferences file from a test runner or with PREMIERE_MCP_NO_PREFS_WRITE=1 set. The live preference was still applied; it will reach disk when Premiere quits gracefully.",
      };
    }
    const prefsPath = this.findPremierePrefsFile();
    if (!prefsPath) {
      return {
        persisted: false,
        reason:
          'Could not locate Premiere\'s "Adobe Premiere Pro Prefs" file, so the live value will only reach disk when Premiere quits gracefully.',
      };
    }
    let source: string;
    try {
      source = fsSync.readFileSync(prefsPath, 'utf8');
    } catch (e: any) {
      return { persisted: false, prefsPath, reason: `Could not read the prefs file: ${e.message}` };
    }
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tag = new RegExp(`(<${escaped}>)([^<]*)(</${escaped}>)`, 'g');
    const matches = source.match(tag);
    if (!matches || matches.length !== 1) {
      return {
        persisted: false,
        prefsPath,
        reason: `Expected exactly one <${key}> tag in the prefs file, found ${matches ? matches.length : 0}. The file was not modified.`,
      };
    }
    const backupPath = `${prefsPath}.mcp-backup`;
    try {
      if (!fsSync.existsSync(backupPath)) fsSync.copyFileSync(prefsPath, backupPath);
      const updated = source.replace(tag, `$1${value}$3`);
      fsSync.writeFileSync(prefsPath, updated, 'utf8');
      const readback = fsSync.readFileSync(prefsPath, 'utf8').match(tag);
      const persistedValue = readback ? readback[0].replace(/^<[^>]*>|<[^>]*>$/g, '') : null;
      if (persistedValue !== value) {
        return {
          persisted: false,
          prefsPath,
          backupPath,
          reason: `The prefs file reads back "${persistedValue}" rather than "${value}".`,
        };
      }
      return { persisted: true, prefsPath, backupPath, verifiedBy: 'prefs-file readback' };
    } catch (e: any) {
      return {
        persisted: false,
        prefsPath,
        reason: `Could not write the prefs file: ${e.message}`,
      };
    }
  }

  private async getAutosaveSettings(): Promise<any> {
    const keys = PremiereProTools.AUTOSAVE_KEYS;
    const result = await this.bridge.executeScript(`
      try {
        function rd(k){ try{ var v=app.properties.getProperty(k); return v===undefined?null:String(v); }catch(e){ return null; } }
        return JSON.stringify({success:true,
          enabled:rd(${JSON.stringify(keys.enabled)}),
          intervalMinutes:rd(${JSON.stringify(keys.intervalMinutes)}),
          maxVersions:rd(${JSON.stringify(keys.maxVersions)}),
          alsoSaveCurrentProject:rd(${JSON.stringify(keys.alsoSaveCurrentProject)}),
          saveToCloud:rd(${JSON.stringify(keys.saveToCloud)}),
          autoSaveFolder:rd(${JSON.stringify(PremiereProTools.AUTOSAVE_FOLDER_KEY)})});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
    if (!result || result.success === false) return result;
    const num = (v: any) => (v === null || v === '' || isNaN(Number(v)) ? null : Number(v));
    const bool = (v: any) => (v === null || v === '' ? null : String(v) === 'true');
    return {
      success: true,
      enabled: bool(result.enabled),
      intervalMinutes: num(result.intervalMinutes),
      maxVersions: num(result.maxVersions),
      alsoSaveCurrentProject: bool(result.alsoSaveCurrentProject),
      saveToCloud: bool(result.saveToCloud),
      autoSaveFolder: result.autoSaveFolder,
      raw: result,
      prefsFile: this.findPremierePrefsFile(),
      keys,
    };
  }

  private async setAutosaveSettings(args: {
    enabled?: boolean;
    intervalMinutes?: number;
    maxVersions?: number;
    alsoSaveCurrentProject?: boolean;
    saveToCloud?: boolean;
    persistToPrefsFile?: boolean;
  }): Promise<any> {
    const keys = PremiereProTools.AUTOSAVE_KEYS;
    const requested: { field: string; key: string; value: string }[] = [];
    if (args.enabled !== undefined)
      requested.push({ field: 'enabled', key: keys.enabled, value: String(args.enabled) });
    if (args.intervalMinutes !== undefined)
      requested.push({
        field: 'intervalMinutes',
        key: keys.intervalMinutes,
        value: String(args.intervalMinutes),
      });
    if (args.maxVersions !== undefined)
      requested.push({
        field: 'maxVersions',
        key: keys.maxVersions,
        value: String(args.maxVersions),
      });
    if (args.alsoSaveCurrentProject !== undefined)
      requested.push({
        field: 'alsoSaveCurrentProject',
        key: keys.alsoSaveCurrentProject,
        value: String(args.alsoSaveCurrentProject),
      });
    if (args.saveToCloud !== undefined)
      requested.push({
        field: 'saveToCloud',
        key: keys.saveToCloud,
        value: String(args.saveToCloud),
      });

    if (requested.length === 0) {
      return {
        success: false,
        error:
          'No Auto Save setting was given. Pass at least one of enabled, intervalMinutes, maxVersions, alsoSaveCurrentProject, saveToCloud.',
      };
    }

    const persist = args.persistToPrefsFile !== false;
    const changes: any[] = [];
    for (const item of requested) {
      const live = await this.setAppProperty(item.key, item.value);
      const applied = live?.success === true && live?.verified === true;
      changes.push({
        field: item.field,
        key: item.key,
        requested: item.value,
        before: live?.before ?? null,
        readback: live?.readback ?? null,
        liveApplied: applied,
        liveError: live?.error ?? live?.setError ?? live?.unverifiedReason ?? undefined,
        prefsFile: persist && applied ? this.persistPrefToFile(item.key, item.value) : undefined,
      });
    }

    const failed = changes.filter((c) => !c.liveApplied);
    const notPersisted = changes.filter((c) => c.prefsFile && c.prefsFile.persisted === false);
    return {
      success: failed.length === 0,
      verified: failed.length === 0,
      verifiedBy:
        'app.properties.getProperty() readback per key' + (persist ? ' + prefs-file readback' : ''),
      changes,
      ...(failed.length
        ? {
            error: `${failed.length} of ${changes.length} Auto Save settings did not read back as requested.`,
          }
        : {}),
      note: [
        'app.properties writes the LIVE preference. Premiere flushes preferences to its prefs file only on a graceful quit.',
        persist
          ? notPersisted.length
            ? 'The prefs file could not be updated for every key, so a force-quit before Premiere exits normally may revert those.'
            : 'The prefs file was updated too, so a force-quit cannot revert this.'
          : 'persistToPrefsFile was false, so a force-quit before Premiere exits normally will revert this.',
        'A running auto-save timer may not pick up a new interval until its next cycle.',
      ].join(' '),
    };
  }

  private apiSurfaceReport(): any {
    return {
      success: true,
      verified_on: '26.3.2',
      qe_clip_methods: [
        'addVideoEffect',
        'addAudioEffect',
        'addTransition',
        'canDoMulticam',
        'getClipPanComponent',
        'getComponentAt',
        'getProjectItem',
        'move',
        'moveToTrack',
        'remove',
        'removeEffects',
        'rippleDelete',
        'roll',
        'setAntiAliasQuality',
        'setBorderColor',
        'setBorderWidth',
        'setEndPercent',
        'setEndPosition',
        'setFrameBlend',
        'setMulticam',
        'setName',
        'setReverse',
        'setScaleToFrameSize',
        'setSpeed',
        'setStartPercent',
        'setStartPosition',
        'setSwitchSources',
        'setTimeInterpolationType',
        'slide',
        'slip',
      ],
      qe_sequence_methods: [
        'addTracks',
        'close',
        'deletePreviewFiles',
        'exportDirect',
        'exportFrameJPEG',
        'exportFramePNG',
        'exportFrameTIFF',
        'exportToAME',
        'extract',
        'flushCache',
        'getAudioTrackAt',
        'getEmptyBarTimes',
        'getExportComplete',
        'getGreenBarTimes',
        'getRedBarTimes',
        'getVideoTrackAt',
        'getYellowBarTimes',
        'isIncompleteBackgroundVideoEffects',
        'isOpen',
        'lockTracks',
        'makeCurrent',
        'muteTracks',
        'razor',
        'removeAudioTrack',
        'removeEmptyAudioTracks',
        'removeEmptyVideoTracks',
        'removeVideoTrack',
        'renderAll',
        'renderAudio',
        'renderPreview',
        'setCTI',
        'setInOutPoints',
        'setInPoint',
        'setOutPoint',
        'setPreviewFrameSize',
        'setPreviewPresetPath',
        'setUseMaxBitDepth',
        'setUseMaxRenderQuality',
        'setVideoDisplayFormat',
        'setVideoFrameSize',
        'setWorkInOutPoints',
        'syncLockTracks',
      ],
      qe_component_methods: [
        'getParamList',
        'getParamValue',
        'setParamValue',
        'getParamKeyframes',
        'getParamControlValue',
        'remove',
      ],
      // Kept current deliberately: a stale "cannot do" list is the same kind of lie as a
      // fake success — it tells an agent to stop trying something that now works. Items
      // are removed from this list only when a live host has proved the capability.
      confirmed_wall: [
        'Free-draw shape mask geometry (PP2026 Object Mask stores shape data as a SubComponent in the .prproj XML; not reachable via DOM or QE)',
        'Essential Sound auto-tagging (the category can be written via setProjectMetadata; the automatic analysis cannot be driven)',
        'Render & Replace bake-to-media',
        'Essential Graphics advanced authoring',
        'Merged clips creation (detection only: isMergedClip)',
        'Work area in/out (26.3.2: setWorkAreaInPoint/OutPoint and QE setWorkInOutPoints are accepted but inert, even with setWorkAreaEnabled(true); use sequence in/out points)',
        'app.findMenuCommandId / app.executeCommand are absent in the CEP ExtendScript context on 26.3.2 — no scripted menu bus',
      ],
      // Previously listed here and since cracked, recorded so it is not re-added:
      // system clipboard (done Node-side via pbcopy/pbpaste, not through the host).
      cracked_since: ['Clipboard (system)'],
      // Computed, never hardcoded. The published number was 600 while the build
      // registered a different count, and three different totals were in circulation.
      total_tools: this.getRegisteredTools().length,
      tools_exposed_by_active_profile: this.getAvailableTools().length,
    };
  }

  private async getEaUserInfo(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var loggedIn=qe.ea.isLoggedIn();
        var email='',username='';
        if(loggedIn){try{email=String(qe.ea.getUserEmail());}catch(e){}try{username=String(qe.ea.getUsername());}catch(e){}}
        return JSON.stringify({success:true,isLoggedIn:loggedIn,email:email,username:username});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  private async getSelectedClips(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var selection = sequence.getSelection();
        var clips = [];
        for (var i = 0; i < selection.length; i++) {
          var clip = selection[i];
          clips.push({
            nodeId: clip.nodeId,
            name: clip.name,
            start: clip.start.seconds,
            end: clip.end.seconds,
            duration: clip.duration.seconds,
            mediaType: clip.mediaType
          });
        }
        return JSON.stringify({
          success: true,
          clips: clips,
          count: clips.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Scene Edit Detection Implementation
  private async detectSceneEdits(
    sequenceId: string,
    action?: string,
    applyCutsToLinkedAudio?: boolean,
    sensitivity?: string,
    allowUnsafeSynchronous?: boolean,
  ): Promise<any> {
    const actionVal = action || 'CreateMarkers';
    const audioVal = applyCutsToLinkedAudio !== false;
    const sensitivityVal = sensitivity || 'Medium';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        if (!sequence.performSceneEditDetectionOnSelection) {
          return JSON.stringify({ success: false, error: "performSceneEditDetectionOnSelection API unavailable" });
        }
        if (${allowUnsafeSynchronous === true ? 'false' : 'true'}) {
          return JSON.stringify({
            success: true,
            performed: false,
            guarded: true,
            reason: "Premiere performSceneEditDetectionOnSelection blocks CEP in this bridge. Pass allowUnsafeSynchronous:true only when a human is prepared to wait or restart the panel.",
            action: ${JSON.stringify(actionVal)},
            sensitivity: ${JSON.stringify(sensitivityVal)}
          });
        }
        sequence.performSceneEditDetectionOnSelection(${JSON.stringify(actionVal)}, ${audioVal}, ${JSON.stringify(sensitivityVal)});
        return JSON.stringify({
          success: true,
          message: "Scene edit detection performed",
          action: ${JSON.stringify(actionVal)},
          sensitivity: ${JSON.stringify(sensitivityVal)}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Undo Implementation
  private async undo(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        qe.project.undo();
        return JSON.stringify({
          success: true,
          message: "Undo performed"
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Manage Proxies Implementation
  private async manageProxies(
    projectItemId: string,
    action: string,
    proxyPath?: string,
  ): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var actionType = ${JSON.stringify(action)};
        if (actionType === "check") {
          return JSON.stringify({
            success: true,
            projectItemId: ${JSON.stringify(projectItemId)},
            hasProxy: item.hasProxy(),
            canProxy: item.canProxy()
          });
        } else if (actionType === "attach") {
          var pPath = ${JSON.stringify(proxyPath || '')};
          if (!pPath || pPath === "") return JSON.stringify({ success: false, error: "proxyPath is required for attach action" });
          var proxyFile = new File(pPath);
          if (!proxyFile.exists) return JSON.stringify({ success: false, error: "Proxy file does not exist on disk: " + pPath });
          var couldProxyBefore = true;
          try { couldProxyBefore = item.canProxy(); } catch (canErr) {}
          if (!couldProxyBefore) return JSON.stringify({ success: false, error: "Project item does not support proxies (canProxy() is false)", projectItemId: ${JSON.stringify(projectItemId)} });
          // attachProxy() returns nothing and does not throw on a bad attach, so a
          // non-throwing call is not proof. Re-read hasProxy()/getProxyPath() and only
          // report success if Premiere actually took the proxy.
          item.attachProxy(pPath, 0);
          var attachedNow = false;
          try { attachedNow = item.hasProxy(); } catch (hpErr) {}
          var attachedPath = "";
          try { attachedPath = String(item.getProxyPath()); } catch (gpErr) {}
          if (!attachedNow) {
            return JSON.stringify({
              success: false,
              error: "Premiere did not attach the proxy (hasProxy() is still false after attachProxy).",
              projectItemId: ${JSON.stringify(projectItemId)},
              proxyPath: pPath,
              verified: false
            });
          }
          return JSON.stringify({
            success: true,
            message: "Proxy attached",
            projectItemId: ${JSON.stringify(projectItemId)},
            proxyPath: pPath,
            attachedProxyPath: attachedPath,
            verified: true
          });
        } else if (actionType === "get_path") {
          return JSON.stringify({
            success: true,
            projectItemId: ${JSON.stringify(projectItemId)},
            proxyPath: item.getProxyPath()
          });
        } else {
          return JSON.stringify({ success: false, error: "Unknown action: " + actionType });
        }
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async frameDiff(
    time1: number,
    time2: number,
    outputDir: string,
    _seqId?: string,
  ): Promise<any> {
    const path = pathSync;
    const frame1 = path.join(outputDir, `frame_diff_a_${Date.now()}.jpg`);
    const frame2 = path.join(outputDir, `frame_diff_b_${Date.now()}.jpg`);
    // Get sequence source path via bridge
    const seqInfo: any = await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[0].clips[0];
        var path = clip && clip.projectItem ? String(clip.projectItem.getMediaPath()) : '';
        var __d = __seqEndSeconds(seq);
        return JSON.stringify({success:true,mediaPath:path,duration:__d===null?0:__d});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!seqInfo?.success || !seqInfo?.mediaPath)
      return {
        success: false,
        error: 'Could not get media path',
        note: 'frame_diff works on the source media of the first V1 clip',
      };
    try {
      runFf(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(time1),
          '-i',
          String(seqInfo.mediaPath),
          '-frames:v',
          '1',
          '-update',
          '1',
          frame1,
        ],
        { timeoutMs: 15000 },
      );
      runFf(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(time2),
          '-i',
          String(seqInfo.mediaPath),
          '-frames:v',
          '1',
          '-update',
          '1',
          frame2,
        ],
        { timeoutMs: 15000 },
      );
      const psnrOut = runFf(
        'ffmpeg',
        ['-hide_banner', '-i', frame1, '-i', frame2, '-lavfi', 'psnr', '-f', 'null', '-'],
        { timeoutMs: 10000, mergeStderr: true },
      );
      const match = psnrOut.match(/psnr_avg:(\S+)/);
      const psnr = match?.[1] ? parseFloat(match[1]) : null;
      return {
        success: true,
        frame1,
        frame2,
        psnr,
        identical: psnr !== null && psnr > 50,
        note: 'Higher PSNR = more similar. >40dB = nearly identical. Infinity = identical.',
      };
    } catch (e: any) {
      return { success: false, error: e.message?.slice(0, 200) };
    }
  }

  private async batchExecute(
    operations: Array<{ id: string; script: string }>,
    enableQE: boolean,
  ): Promise<any> {
    if (!Array.isArray(operations) || operations.length === 0) {
      return { success: false, error: 'operations must be a non-empty array' };
    }
    if (operations.length > 200) {
      return {
        success: false,
        error: `Too many operations (${operations.length}). Limit is 200 per batch — split into multiple calls.`,
      };
    }
    // Each caller script is inlined into its own IIFE with a dedicated try/catch, so one
    // failing operation cannot abort the rest and each gets its own error recorded. The
    // concatenation happens here rather than through eval()/Function() in the host: the
    // ExtendScript engine is ES3 and its Function constructor is unreliable, and a runtime
    // eval would also defeat the syntax check the test suite runs over generated scripts.
    const blocks = operations
      .map((op, i) => {
        const idLiteral = JSON.stringify(String(op.id ?? `op_${i}`));
        return `
        try {
          var __res${i} = (function(){ ${op.script} })();
          __results.push({ id: ${idLiteral}, success: true, result: __res${i} });
        } catch (__e${i}) {
          __results.push({ id: ${idLiteral}, success: false, error: __e${i}.toString() });
        }`;
      })
      .join('');

    const batchScript = `
      var __results = [];
      try {
        ${enableQE ? 'app.enableQE();' : ''}
        ${blocks}
        var __failed = 0;
        for (var __i = 0; __i < __results.length; __i++) { if (!__results[__i].success) __failed++; }
        return JSON.stringify({
          success: true,
          count: __results.length,
          succeeded: __results.length - __failed,
          failed: __failed,
          results: __results
        });
      } catch (__outer) {
        return JSON.stringify({ success: false, error: __outer.toString(), partialResults: __results });
      }
    `;
    return await this.bridge.executeScript(batchScript, 120000, true);
  }

  private async verifyClipVisible(
    _seqId: string | undefined,
    trackIndex: number,
    clipIndex: number,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var track = seq.videoTracks[${trackIndex}];
        if (!track) return JSON.stringify({success:false,error:'Track not found'});
        var clip = track.clips[${clipIndex}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var trackMuted = track.isMuted();
        var clipDisabled = clip.disabled;
        var opacityComp = clip.components[0]; // Opacity
        var opacity = opacityComp ? opacityComp.properties[0].getValue() : 100;
        // Check if a higher track covers this clip at the same time
        var isOccluded = false;
        for (var t = ${trackIndex} + 1; t < seq.videoTracks.numTracks; t++) {
          var upperTrack = seq.videoTracks[t];
          if (upperTrack.isMuted()) continue;
          for (var c = 0; c < upperTrack.clips.numItems; c++) {
            var uc = upperTrack.clips[c];
            if (!uc.disabled && Number(uc.start.ticks) <= Number(clip.start.ticks) && Number(uc.end.ticks) >= Number(clip.end.ticks)) {
              isOccluded = true; break;
            }
          }
        }
        var visible = !trackMuted && !clipDisabled && opacity > 0 && !isOccluded;
        return JSON.stringify({success:true,visible:visible,trackMuted:trackMuted,clipDisabled:clipDisabled,opacity:opacity,occludedByUpperTrack:isOccluded,clipName:String(clip.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private blackFrameScan(filePath: string, threshold: number, minDuration: number): any {
    try {
      // blackdetect reports on stderr as "black_start:X black_end:Y", which the parser below reads.
      const out = runFf(
        'ffmpeg',
        [
          '-hide_banner',
          '-nostats',
          '-i',
          filePath,
          '-an',
          '-vf',
          `blackdetect=d=${Number(minDuration)}:pix_th=${Number(threshold)}`,
          '-f',
          'null',
          '-',
        ],
        { timeoutMs: 120000, mergeStderr: true },
      );
      const lines = out.split('\n').filter((l: string) => l.trim());
      const ranges: any[] = [];
      let current: any = null;
      for (const line of lines) {
        if (line.includes('black_start')) {
          const m = line.match(/black_start:([\d.]+)/);
          if (m?.[1]) current = { start: parseFloat(m[1]) };
        }
        if (line.includes('black_end') && current) {
          const m = line.match(/black_end:([\d.]+)/);
          if (m?.[1]) {
            current.end = parseFloat(m[1]);
            current.duration = current.end - current.start;
            ranges.push(current);
            current = null;
          }
        }
      }
      return { success: true, blackRangeCount: ranges.length, ranges: ranges.slice(0, 50) };
    } catch (e: any) {
      return { success: false, error: e.message?.slice(0, 200) };
    }
  }

  private flashFrameScan(filePath: string, threshold: number): any {
    // This used to return success:true with a note and analyse nothing. A flash is a run of at
    // most two frames whose mean luma reaches `threshold` (0-1) and sits clearly above the frames
    // on both sides of it, so a hard cut to a bright shot is not reported as a flash.
    try {
      const out = runFf(
        'ffmpeg',
        [
          '-hide_banner',
          '-nostats',
          '-loglevel',
          'error',
          '-i',
          filePath,
          '-an',
          '-vf',
          'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
          '-f',
          'null',
          '-',
        ],
        { timeoutMs: 180000 },
      );
      const frames: Array<{ t: number; y: number }> = [];
      let t: number | null = null;
      for (const line of out.split('\n')) {
        const tm = line.match(/pts_time:([\d.]+)/);
        if (tm?.[1]) {
          t = parseFloat(tm[1]);
          continue;
        }
        const ym = line.match(/^lavfi\.signalstats\.YAVG=([\d.]+)/);
        if (ym?.[1] && t !== null) {
          frames.push({ t, y: parseFloat(ym[1]) / 255 });
          t = null;
        }
      }
      if (!frames.length)
        return {
          success: false,
          error: 'ffmpeg decoded no video frames from this file, so nothing was measured.',
        };
      const MAX_RUN = 2,
        MARGIN = 0.25;
      const flashes: Array<{
        startSecs: number;
        frames: number;
        peakLuma: number;
        neighbourLuma: number;
      }> = [];
      for (let i = 0; i < frames.length; i++) {
        if (frames[i]!.y < threshold) continue;
        let j = i;
        while (j + 1 < frames.length && frames[j + 1]!.y >= threshold) j++;
        const run = j - i + 1;
        const before = i > 0 ? frames[i - 1]!.y : null;
        const after = j + 1 < frames.length ? frames[j + 1]!.y : null;
        let peak = 0;
        for (let k = i; k <= j; k++) peak = Math.max(peak, frames[k]!.y);
        if (
          run <= MAX_RUN &&
          before !== null &&
          after !== null &&
          peak - before >= MARGIN &&
          peak - after >= MARGIN
        ) {
          flashes.push({
            startSecs: frames[i]!.t,
            frames: run,
            peakLuma: Math.round(peak * 1000) / 1000,
            neighbourLuma: Math.round(Math.max(before, after) * 1000) / 1000,
          });
        }
        i = j;
      }
      return {
        success: true,
        framesAnalysed: frames.length,
        flashCount: flashes.length,
        flashes: flashes.slice(0, 100),
        criteria: `mean luma >= ${threshold}, at most ${MAX_RUN} frames long, at least ${MARGIN} brighter than the frames on both sides`,
      };
    } catch (e: any) {
      return { success: false, error: e.message?.slice(0, 300) };
    }
  }

  private freezeFrameScan(filePath: string, minDuration: number): any {
    try {
      // freezedetect reports on stderr as "lavfi.freezedetect.freeze_start: X".
      const out = runFf(
        'ffmpeg',
        [
          '-hide_banner',
          '-nostats',
          '-i',
          filePath,
          '-an',
          '-vf',
          `freezedetect=n=-60dB:d=${Number(minDuration)}`,
          '-f',
          'null',
          '-',
        ],
        { timeoutMs: 120000, mergeStderr: true },
      );
      const ranges: any[] = [];
      const lines = out.split('\n');
      let current: any = null;
      for (const line of lines) {
        if (line.includes('freeze_start')) {
          const m = line.match(/freeze_start:\s*([\d.]+)/);
          if (m?.[1]) current = { start: parseFloat(m[1]) };
        }
        if (line.includes('freeze_end') && current) {
          const m = line.match(/freeze_end:\s*([\d.]+)/);
          if (m?.[1]) {
            current.end = parseFloat(m[1]);
            current.duration = current.end - current.start;
            ranges.push(current);
            current = null;
          }
        }
      }
      return { success: true, freezeRangeCount: ranges.length, ranges: ranges.slice(0, 50) };
    } catch (e: any) {
      return { success: false, error: e.message?.slice(0, 200) };
    }
  }

  private async honestySelfTest(): Promise<any> {
    const results: Record<string, any> = {};
    const tools = ['ping', 'get_version_info', 'get_premiere_state', 'list_sequences'];
    for (const tool of tools) {
      try {
        const r = await this.executeTool(tool, {});
        results[tool] = r?.success !== false ? 'PASS' : `FAIL: ${r?.error || 'success:false'}`;
      } catch (e: any) {
        results[tool] = `ERROR: ${e.message?.slice(0, 80)}`;
      }
    }
    const passed = Object.values(results).filter((v) => v === 'PASS').length;
    // A self-test named "honesty" reporting success:true while 0 of 4 probes passed was the least
    // defensible instance of the flat-true batch bug in the catalogue.
    const verdict = summarizeBatch(Object.values(results), (v) => v === 'PASS', 'probe(s)');
    return { ...verdict, passed, total: tools.length, results };
  }

  private async getProductionConflicts(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        if (!qe.ea.isLoggedIn()) return JSON.stringify({success:false,error:'Not logged in'});
        var conflicts = qe.ea.getConflicts();
        return JSON.stringify({success:true,conflicts:conflicts ? String(conflicts) : 'none', note:'Conflict list returned as raw string from qe.ea.getConflicts()'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async resolveConflict(conflictId: string, resolution: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        qe.ea.resolveConflict(${JSON.stringify(conflictId)}, ${JSON.stringify(resolution)});
        return JSON.stringify({success:true,conflictId:${JSON.stringify(conflictId)},resolution:${JSON.stringify(resolution)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  /**
   * These wrappers used to call add_text_overlay with no template at all, which can only refuse
   * ("requires a MOGRT file path"), so all four failed on every call. They now forward the
   * caller's mogrtPath; add_text_overlay falls back to PREMIERE_MCP_DEFAULT_MOGRT when it is unset.
   */
  private async lowerThirdPreset(
    name: string,
    title: string | undefined,
    startTimeSecs: number,
    durationSecs: number,
    trackIndex: number,
    seqId?: string,
    mogrtPath?: string,
  ): Promise<any> {
    // One graphic, not two: a lower-third template carries the title in its second text field,
    // which add_text_overlay fills from text2. Stacking two graphics on adjacent tracks drew the
    // template's own placeholder subtitle under each line.
    const results = [];
    const r1: any = await this.executeTool('add_text_overlay', {
      text: name,
      text2: title,
      startTime: startTimeSecs,
      duration: durationSecs,
      position: 'bottom-left',
      trackIndex,
      sequenceId: seqId,
      mogrtPath,
    });
    results.push({ layer: 'name', result: r1 });
    const verdict = summarizeBatch(
      results,
      (entry: any) => entry?.result?.success !== false,
      'text layer(s)',
    );
    return { ...verdict, name, title, startTimeSecs, durationSecs, layers: results };
  }

  private async titleCard(
    text: string,
    startTimeSecs: number,
    durationSecs: number,
    trackIndex: number,
    seqId?: string,
    mogrtPath?: string,
  ): Promise<any> {
    const r: any = await this.executeTool('add_text_overlay', {
      text,
      startTime: startTimeSecs,
      duration: durationSecs,
      position: 'center',
      trackIndex,
      sequenceId: seqId,
      mogrtPath,
    });
    return { success: r?.success !== false, text, startTimeSecs, durationSecs, result: r };
  }

  private async batchMogrtFromData(
    items: Array<{ timeSecs: number; name: string; title?: string }>,
    durationSecs: number,
    trackIndex: number,
    mogrtPath?: string,
    seqId?: string,
  ): Promise<any> {
    const results = [];
    for (const item of items) {
      const r = await this.lowerThirdPreset(
        item.name,
        item.title,
        item.timeSecs,
        durationSecs,
        trackIndex,
        seqId,
        mogrtPath,
      );
      results.push({ ...item, result: r });
    }
    // Nested: each item is a lower_third_preset, which is itself a batch of text layers. Its
    // verdict is now honest, so reading `result.success` here propagates a failure two levels up
    // instead of stopping at the inner wrapper's old flat true.
    const verdict = summarizeBatch(
      results,
      (entry: any) => entry?.result?.success !== false,
      'graphic(s)',
    );
    return { ...verdict, count: results.length, results };
  }

  private async countdownLeader(
    startTimeSecs: number,
    count: number,
    trackIndex: number,
    seqId?: string,
    mogrtPath?: string,
  ): Promise<any> {
    const results = [];
    for (let i = count; i >= 1; i--) {
      const t = startTimeSecs + (count - i);
      const r: any = await this.executeTool('add_text_overlay', {
        text: String(i),
        startTime: t,
        duration: 1,
        position: 'center',
        trackIndex,
        sequenceId: seqId,
        mogrtPath,
      });
      results.push({ count: i, timeSecs: t, result: r?.success !== false ? 'OK' : 'FAIL' });
    }
    // This one already recorded 'FAIL' per layer, which made the flat true worse rather than
    // better: the tool knew the count was wrong and still reported OK.
    const verdict = summarizeBatch(
      results,
      (entry) => entry.result === 'OK',
      'countdown number(s)',
    );
    return { ...verdict, count, startTimeSecs, layers: results };
  }
}
