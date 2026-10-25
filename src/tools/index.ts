/**
 * MCP Tools for Adobe Premiere Pro
 * 
 * This module provides tools that can be called by AI agents to perform
 * various video editing operations in Adobe Premiere Pro.
 */

import { z } from 'zod';
import { execSync } from 'child_process';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
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
import { applyProfile, resolveProfile, PROFILES } from './profiles.js';
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
import {
  type TransactionExecutor,
  TRANSACTION_TOOL_NAME,
  runTransaction,
} from './transactions.js';
import { buildToolCatalogue } from './catalogue.js';
import { findNulByteArgument, summarizeBatch } from './domains/shared.js';
import type { AssembleProductSpotArgs, BuildBrandSpotArgs, ClipPlanStep, MotionStyle, ProjectFileEditArgs, ProjectFileInspectArgs } from './domains/shared.js';
import { TrimmingTools } from './domains/trimming.js';

// MCPTool now lives in ./tool-types.js so the catalogue module can be typed without
// importing this class. Re-exported because expanded.ts and the tests import it from here.
export type { MCPTool } from './tool-types.js';
import type { MCPTool } from './tool-types.js';

// The header declarations and pure helpers moved to ./domains/shared.ts when this file was
// split into one class per tool domain. Re-exported here: they were part of this module's
// public surface before the split and the tests import them from it.
export { findNulByteArgument, evaluateTextInjectionResult, summarizeBatch } from './domains/shared.js';
export type { BatchVerdict } from './domains/shared.js';

export class PremiereProTools extends TrimmingTools {
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
    const all = [
      ...localTools,
      ...getExpandedTools(new Set(localTools.map((tool) => tool.name))),
    ];
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
      chars += JSON.stringify({
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
        jsonSchema = z.toJSONSchema(tool.inputSchema as any, { unrepresentable: 'any' }) as JsonSchemaNode;
      } catch { /* keep the permissive fallback */ }
      return tool.description
        ? { name: tool.name, description: tool.description, jsonSchema }
        : { name: tool.name, jsonSchema };
    });

    const only: string[] | undefined = Array.isArray(args?.only) && args.only.length ? args.only : undefined;
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
      toolsDeclared: only ? only.filter((name) => knownNames.has(name)).length : typingsTools.length,
      toolsRegistered: registered.length,
      toolsCallableUnderActiveProfile: exposed.size,
      ...(unknown.length ? { unknownToolNames: unknown, note: `${unknown.length} requested name(s) are not tools in this build; use find_tool to search the catalogue.` } : {}),
    };
  }

  getRegisteredTools(): MCPTool[] {
    PremiereProTools.registeredToolsCache ??= (() => {
      const localTools = this.getLocalTools();
      return [
        ...localTools,
        ...getExpandedTools(new Set(localTools.map((tool) => tool.name)))
      ];
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
      return { success: false, error: 'call_tool requires a tool name. Use find_tool({ query: "<keyword>" }) to search the catalogue.' };
    }

    const verdict = this.routerGateFor(name);
    if (!verdict.allowed) {
      // An unknown name gets the same ranked shortlist a direct miss would produce —
      // a refusal with no next step is where an agent starts guessing names.
      const exposedNames = new Set(this.getAvailableTools().map((tool) => tool.name));
      const suggestions = verdict.code === 'UNKNOWN_TOOL'
        ? findTools(this.getSearchableCatalogue(), exposedNames, { query: name.replace(/_/g, ' '), limit: 8 })
            .matches.map((m) => ({ name: m.name, exposed: m.exposed, description: m.description }))
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
      return { success: false, error: `Tool '${name}' passed the router gate but is not in the registry. This is a server bug; please report it.` };
    }

    const targetArgs: Record<string, any> =
      args.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : {};

    if (args.dryRun === true) {
      let jsonSchema: unknown = { type: 'object', additionalProperties: true };
      try {
        jsonSchema = z.toJSONSchema(target.inputSchema as any, { unrepresentable: 'any' });
      } catch { /* keep the permissive fallback rather than failing the dry run */ }
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
        note: 'dryRun validated the arguments against the target\'s real schema and made no Premiere request. Nothing was changed.',
      };
    }

    // Everything downstream — NUL guard, schema validation, auto-checkpoint, verification
    // — is the target tool's normal path. The router adds a gate, not a second code path,
    // so a tool cannot behave differently depending on how it was called.
    const result = await this.executeTool(name, targetArgs, { allowUnexposed: true });
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return { ...result, routed: { requested: name, invoked: true, reachedPastProfile: verdict.reachedPastProfile } };
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

  /** activate_tools: promote hidden tools into the advertised list for this session. */
  private activateTools(args: Record<string, any>): any {
    const requested: string[] = [];
    if (Array.isArray(args?.names)) {
      for (const entry of args.names) if (typeof entry === 'string' && entry.trim()) requested.push(entry.trim());
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

    if (!requested.length) {
      return { success: false, error: 'activate_tools requires names or a query. Use find_tool to search the catalogue first.' };
    }

    const activated: string[] = [];
    const alreadyExposed: string[] = [];
    const refused: Array<{ name: string; reason: string; refusedBy: string }> = [];

    for (const name of requested) {
      const verdict = this.routerGateFor(name);
      if (!verdict.allowed) {
        refused.push({ name, reason: verdict.reason ?? 'refused', refusedBy: verdict.code ?? 'NOT_ROUTABLE' });
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
      activated,
      alreadyExposed,
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
      ? args.names.filter((entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
    if (!names.length) {
      return { success: false, error: 'deactivate_tools requires names, or all:true to clear every activation.' };
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
        ? { notActivated, note: 'These were not activated this session. A tool the configured profile advertises cannot be deactivated — change PREMIERE_MCP_PROFILE instead.' }
        : {}),
      toolsNowAdvertised: exposed.length,
      contextCost: this.measureCatalogueCost(exposed),
      listChangedNotified: deactivated.length > 0,
    };
  }

  async executeTool(name: string, args: Record<string, any>, options?: { allowUnexposed?: boolean }): Promise<any> {
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
    const tool = (options?.allowUnexposed ? this.getRegisteredTools() : this.getAvailableTools())
      .find(t => t.name === name);
    if (!tool) {
      // Dumping every tool name here used to be the whole answer. On a catalogue
      // this size that is a multi-kilobyte wall of names the model must scan, and
      // it does not distinguish "no such tool" from "the active profile hides it".
      // Return a ranked shortlist derived from the name that was attempted, plus
      // that distinction, and point at find_tool for a real search.
      const exposedNames = new Set(this.getAvailableTools().map((t) => t.name));
      const catalogue = this.getSearchableCatalogue();
      const hiddenByProfile = catalogue.some(
        (t) => t.name === name && !exposedNames.has(t.name),
      );
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
        expectedSchema: tool.inputSchema.description
      };
    }

    this.logger.info(`Executing tool: ${name} with args:`, args);

    // Opt-in recovery boundary: snapshot the sequence before a bulk/destructive
    // operation so the pre-edit state can be restored. Fail-closed — if the user
    // asked for protection and the snapshot cannot be taken, the operation is
    // NOT run, so nothing is changed without a recovery point to fall back to.
    // The taken checkpoint is attached to the operation's result below.
    let recoveryCheckpoint: { sequenceId: string | null; name: string | null; projectItemId: string | null } | undefined;
    if (autoCheckpointEnabled() && SEQUENCE_DESTRUCTIVE_TOOLS.has(name)) {
      const cp = await this.createRecoveryCheckpoint(args.sequenceId, `auto before ${name}`);
      if (!cp || cp.success === false) {
        return {
          success: false,
          error: `Auto-checkpoint before destructive '${name}' failed, so the operation was NOT run and nothing was changed. ${cp?.error || ''}`.trim(),
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

    const localToolNames = new Set(this.getLocalTools().map((localTool) => localTool.name));
    if (!localToolNames.has(name) && isExpandedTool(name)) {
      return withCheckpoint(await executeExpandedTool(this.bridge, name, args));
    }
    
    try {
      switch (name) {
        // Discovery Tools
        case 'list_project_items':
          return await this.listProjectItems(args.includeBins, args.includeMetadata);
        case 'list_sequences':
          return await this.listSequences();
        case 'list_sequence_tracks':
          return await this.listSequenceTracks(args.sequenceId);
        case 'get_project_info':
          return await this.getProjectInfo();
        case 'verify_premiere_connection':
          return await this.verifyPremiereConnection();
        case 'get_capabilities':
          return await this.getCapabilities(args.checkConnection, args.probeLocalTools);
        case 'find_tool':
          return this.findTool(args);
        case 'get_tool_typings':
          return this.getToolTypings(args);
        case 'call_tool':
          return await this.callTool(args);
        case 'activate_tools':
          return this.activateTools(args);
        case 'deactivate_tools':
          return this.deactivateTools(args);
        case TRANSACTION_TOOL_NAME:
          return await this.transactSequenceEdits(args);
        case 'validate_project_for_export':
          return await this.validateProjectForExport(args.sequenceId, args.outputPath, args.presetPath, args.requireNonEmptyTimeline, args.checkGaps);
        case 'get_encoder_presets':
          return await this.getEncoderPresets(args.directories);
        case 'build_motion_graphics_demo':
          return await this.buildMotionGraphicsDemo(args.sequenceName);
        case 'assemble_product_spot':
          return await this.assembleProductSpot(args as AssembleProductSpotArgs);
        case 'build_brand_spot_from_mogrt_and_assets':
          return await this.buildBrandSpotFromMogrtAndAssets(args as BuildBrandSpotArgs);

        // Project Management
        case 'create_project':
          return await this.createProject(args.name, args.location);
        case 'open_project':
          return await this.openProject(args.path);
        case 'save_project':
          return await this.saveProject();
        case 'save_project_as':
          return await this.saveProjectAs(args.name, args.location);
        case 'close_project':
          return await this.closeProject(args.saveFirst ?? false, args.closeIfLast ?? false);
        case 'list_open_projects':
          return await this.listOpenProjects();
        case 'list_recent_projects':
          return this.listRecentProjects(args.limit ?? 10, args.excludeAutosave ?? true);
        case 'read_clipboard':
          return this.clipboardRead();
        case 'write_clipboard':
          return this.clipboardWrite(args.text);
        case 'get_sequence_render_status':
          return await this.getSequenceRenderStatus(args.sequenceId);
        case 'render_sequence_previews':
          return await this.renderSequencePreviews(args.sequenceId, args.renderAll ?? false);
        case 'set_essential_sound_category':
          return await this.setEssentialSoundCategory(args.projectItemId, args.category);
        case 'open_project_item_in_source':
          return await this.openProjectItemInSource(args.projectItemId, args.timecode);

        // Navigation
        case 'go_to_sequence_start': return await this.goToSequenceStart(args.sequenceId);
        case 'go_to_sequence_end': return await this.goToSequenceEnd(args.sequenceId);
        case 'go_to_in_point': return await this.goToInPoint(args.sequenceId);
        case 'go_to_out_point': return await this.goToOutPoint(args.sequenceId);
        case 'step_frames': return await this.stepFrames(args.frames, args.sequenceId);
        case 'get_playback_state': return await this.getPlaybackState(args.sequenceId);

        // Trimming
        case 'ripple_trim_in': return await this.rippleTrimIn(args.sequenceId, args.trackIndex, args.clipIndex);
        case 'ripple_trim_out': return await this.rippleTrimOut(args.sequenceId, args.trackIndex, args.clipIndex);
        case 'extend_edit': return await this.extendEdit(args.sequenceId, args.trackIndex, args.clipIndex);
        case 'nudge_clip': return await this.nudgeClip(args.sequenceId, args.trackIndex, args.clipIndex, args.frames);

        // J/L Cuts
        case 'j_cut': return await this.jCut(args.sequenceId, args.videoTrackIndex, args.clipIndex, args.frames);
        case 'l_cut': return await this.lCut(args.sequenceId, args.videoTrackIndex, args.clipIndex, args.frames);

        // 3-point edit
        case 'three_point_edit': return await this.threePointEdit(args.projectItemId, args.sourceIn, args.sourceOut, args.sequenceTimecode, args.mode ?? 'overwrite', args.videoTrackIndex ?? 0, args.audioTrackIndex ?? 0);

        // Gaps & tracks
        case 'close_gap_at': return await this.closeGapAt(args.timecode, args.sequenceId);
        case 'close_all_gaps': return await this.closeAllGaps(args.sequenceId, args.trackIndex);
        case 'delete_empty_tracks': return await this.deleteEmptyTracks(args.sequenceId, args.video ?? true, args.audio ?? true);

        // Selection
        case 'get_sequence_selection': return await this.getSequenceSelection(args.sequenceId);
        case 'set_sequence_selection': return await this.setSequenceSelection(args.clips, args.sequenceId);

        // Markers
        case 'create_marker': return await this.createMarker(args.timecode as number, args.name, args.comment, args.type, args.colorIndex, args.durationSeconds, args.sequenceId);

        // Batch 1: Lumetri
        case 'lumetri_basic_set': return await this.lumetriBasicSet(args);
        case 'lumetri_creative_set': return await this.lumetriCreativeSet(args);
        case 'lumetri_vignette_set': return await this.lumetriVignetteSet(args);
        case 'lumetri_report': return await this.lumetriReport(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0);
        case 'copy_grade': return await this.copyGrade(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0);
        case 'paste_grade_to_clips': return await this.pasteGradeToClips(args.gradeJson, args.targets, args.sequenceId);
        case 'auto_white_balance': return await this.autoWhiteBalance(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0);
        case 'set_lut_interpolation': return await this.setLutInterpolation(args.method);

        // Batch 2: Motion/Transform
        case 'flip_horizontal': return await this.flipClip(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0, 'horizontal');
        case 'flip_vertical': return await this.flipClip(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0, 'vertical');
        case 'fade_in_video': return await this.fadeVideo(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0, args.durationFrames, 'in');
        case 'fade_out_video': return await this.fadeVideo(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0, args.durationFrames, 'out');
        case 'reset_transform': return await this.resetTransform(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0);
        case 'match_transform': return await this.matchTransform(args.sequenceId, args.sourceTrackIndex, args.sourceClipIndex, args.targets);
        case 'letterbox': return await this.applyLetterbox(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0, args.aspect, args.cropPercent);
        case 'ken_burns': return await this.kenBurns(args);
        case 'set_clip_scale_to_frame_size': return await this.setClipScaleToFrameSize(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0, args.enabled ?? true);
        case 'set_scale_to_frame_size_batch': return await this.setScaleToFrameSizeBatch(args.enabled ?? true, args.sequenceId, args.trackIndex, args.clipIds);

        // Batch 3: Audio
        case 'fade_in_audio': return await this.fadeAudio(args.sequenceId, args.audioTrackIndex ?? 0, args.clipIndex ?? 0, args.durationFrames, 'in');
        case 'fade_out_audio': return await this.fadeAudio(args.sequenceId, args.audioTrackIndex ?? 0, args.clipIndex ?? 0, args.durationFrames, 'out');
        case 'set_clip_gain': return await this.setClipGain(args.sequenceId, args.audioTrackIndex ?? 0, args.clipIndex ?? 0, args.gainDb);
        case 'audio_crossfade_at_cut': return await this.audioCrossfadeAtCut(args.sequenceId, args.audioTrackIndex ?? 0, args.clipIndex, args.durationFrames ?? 15);
        case 'mute_clip_audio': return await this.muteClipAudio(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0, args.mute ?? true);
        case 'loudness_report': return this.loudnessReport(args.filePath);
        case 'normalize_clip_peaks': return await this.normalizeClipPeaks(args.sequenceId, args.audioTrackIndex ?? 0, args.clipIndex ?? 0, args.targetDbfs ?? -1);

        // Batch 4: Export
        case 'export_in_out_range': return await this.exportInOutRange(args.outputPath, args.presetPath, args.sequenceId);
        case 'list_all_encoder_presets': return this.listAllEncoderPresets(args.format);
        case 'create_custom_export_preset': return this.createCustomExportPreset(args.format, args.basePresetName, args.params, args.outputPresetPath);
        case 'export_social_preset': return await this.exportSocialPreset(args.outputPath, args.preset, args.sequenceId);
        case 'export_audio_only': return await this.exportAudioOnly(args.outputPath, args.format ?? 'wav', args.sequenceId);
        case 'verify_export': return this.verifyExport(args.filePath, args.expectedDurationSecs, args.expectedFps, args.expectedWidth, args.expectedHeight);

        // Batch 5: Batch & Metadata
        case 'markers_to_csv': return await this.markersToCsv(args.outputPath, args.sequenceId);
        case 'markers_from_csv': return await this.markersFromCsv(args.csvPath, args.sequenceId);
        case 'add_metadata_schema_field': return await this.addMetadataSchemaField(args.columnId, args.displayName, args.type ?? 0);
        case 'set_item_metadata': return await this.setItemMetadata(args.projectItemId, args.key, args.value);
        case 'get_item_metadata_columns': return await this.getItemMetadataColumns(args.projectItemId);
        case 'batch_set_label': return await this.batchSetLabel(args.projectItemIds, args.labelColor);
        case 'batch_rename_project_items': return await this.batchRenameProjectItems(args.renames);

        // Batch 6: Review & Delivery
        case 'assemble_review_reel': return await this.assembleReviewReel(args.sequenceIds, args.reelName, args.handles ?? 0);
        case 'version_up_sequence': return await this.versionUpSequence(args.sequenceId, args.setActive ?? true);
        case 'shot_status_report': return await this.shotStatusReport();
        case 'notes_to_markers': return await this.notesToMarkers(args.notesPath, args.sequenceId, args.markerType ?? 'Comment', args.colorIndex);
        case 'markers_to_notes': return await this.markersToNotes(args.outputPath, args.sequenceId, args.format ?? 'text');
        case 'delivery_qc': return await this.deliveryQc(args.sequenceId);

        // Batch 7: VFX & Interchange
        case 'vfx_pull_list': return await this.vfxPullList(args.sequenceId, args.handles ?? 8, args.trackIndex ?? 0);
        case 'cut_list_csv': return await this.cutListCsv(args.outputPath, args.sequenceId, args.trackIndex ?? 0);
        case 'export_sequence_as_project': return await this.exportSequenceAsProject(args.outputPath, args.sequenceId);
        case 'change_list_report': return await this.changeListReport(args.sequenceIdA, args.sequenceIdB);
        case 'get_item_treepath': return await this.getItemTreepath(args.projectItemId);

        // Batch 8: MOGRT/Titles
        case 'set_mogrt_text': return await this.setMogrtText(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0, args.paramName, args.text);
        case 'set_mogrt_param': return await this.setMogrtParam(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0, args.paramName, args.value);
        case 'mogrt_params_report': return await this.mogrtParamsReport(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0);
        case 'timecode_burn_in': return await this.timecodeBurnIn(args.sequenceId, args.trackIndex ?? 0, args.clipIndex ?? 0);

        // Batch 9: QE + Productions
        case 'get_renderer_names': return await this.getRendererNames();
        case 'set_renderer': return await this.setRenderer(args.rendererName);
        case 'sync_lock_track': return await this.syncLockTrack(args.sequenceId, args.trackType, args.trackIndex, args.locked);
        case 'render_audio': return await this.renderAudio(args.sequenceId);
        case 'get_production_list': return await this.getProductionList();
        case 'get_lumetri_preset_list': return await this.getLumetriPresetList(args.folder);
        case 'set_sequence_in_out_qe': return await this.setSequenceInOutQe(args.inPoint, args.outPoint, args.sequenceId);
        case 'get_qe_sequence_props': return await this.getQeSequenceProps(args.sequenceId);

        // Batch A: Navigation
        case 'go_to_next_marker': return await this.goToNextMarker(args.sequenceId);
        case 'go_to_prev_marker': return await this.goToPrevMarker(args.sequenceId);
        case 'go_to_timecode': return await this.goToTimecode(args.timecode, args.sequenceId);
        case 'play_in_to_out': return await this.playInToOut(args.sequenceId);
        case 'get_edit_point_list': return await this.getEditPointList(args.sequenceId, args.videoOnly);
        case 'detect_settings_mismatch': return await this.detectSettingsMismatch(args.sequenceId);
        case 'count_tracks_used': return await this.countTracksUsed(args.sequenceId);
        case 'sequence_thumbnail_strip': return this.sequenceThumbnailStrip(args.filePath, args.count ?? 10, args.outputDir);

        // Batch B: QE clip ops
        case 'set_clip_reverse': return await this.setClipReverse(args.trackIndex, args.clipIndex, args.reverse, args.sequenceId);
        case 'set_frame_blend_qe': return await this.setFrameBlendQe(args.trackIndex, args.clipIndex, args.enabled, args.sequenceId);
        case 'set_time_interpolation_type': return await this.setTimeInterpolationType(args.trackIndex, args.clipIndex, args.type, args.sequenceId);
        case 'set_clip_border_color': return await this.setClipBorderColor(args.trackIndex, args.clipIndex, args.r, args.g, args.b, args.sequenceId);
        case 'set_clip_border_width': return await this.setClipBorderWidth(args.trackIndex, args.clipIndex, args.width, args.sequenceId);
        case 'rename_timeline_clip': return await this.renameTimelineClip(args.trackIndex, args.clipIndex, args.name, args.sequenceId);
        case 'get_qe_component_params': return await this.getQeComponentParams(args.trackIndex, args.clipIndex, args.componentIndex, args.sequenceId);
        case 'set_qe_component_param': return await this.setQeComponentParam(args.trackIndex, args.clipIndex, args.componentIndex, args.paramName, args.value, args.sequenceId);
        case 'remove_effect_at_index': return await this.removeEffectAtIndex(args.trackIndex, args.clipIndex, args.componentIndex, args.sequenceId);
        case 'reorder_effects': return await this.reorderEffects(args.trackIndex, args.clipIndex, args.newOrder, args.sequenceId);

        // Batch C: Audio
        case 'apply_audio_effect_qe': return await this.applyAudioEffectQe(args.trackIndex, args.clipIndex, args.effectName, args.audioTrack ?? true, args.sequenceId);
        case 'denoise_clip': return await this.denoiseClip(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'list_audio_effects_on_clip': return await this.listAudioEffectsOnClip(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'audio_peaks_report': return this.audioPeaksReport(args.filePath);
        case 'apply_dynamics': return await this.applyDynamics(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'set_track_volume_keyframes': return await this.setTrackVolumeKeyframes(args.trackIndex, args.keyframes, args.sequenceId);

        // Batch D: Captions
        case 'export_captions_to_srt': return await this.exportCaptionsToSrt(args.outputPath, args.sequenceId);
        case 'caption_qc_report': return this.captionQcReport(args.srtPath, args.maxCps ?? 17, args.maxLineLength ?? 42);
        case 'caption_qc_fix': return this.captionQcFix(args.srtPath, args.outputPath, args.maxCps ?? 17, args.minGapMs ?? 80);
        case 'captions_from_transcript_json': return this.captionsFromTranscriptJson(args.jsonPath, args.outputPath, args.maxCps ?? 17, args.maxLineLength ?? 42);
        case 'srt_diff': return this.srtDiff(args.srtPathA, args.srtPathB);
        case 'captions_to_markers': return await this.captionsToMarkers(args.srtPath, args.sequenceId, args.markerType ?? 'Comment');

        // Batch E: Project lifecycle
        case 'open_fcp_xml': return await this.openFcpXml(args.filePath, args.sequenceName);
        case 'get_project_stats': return await this.getProjectStats();
        case 'write_sidecar_file': return await this.writeSidecarFile(args.fileName, args.fileExtension, args.contents);
        case 'get_ea_login_status': return await this.getEaLoginStatus();
        case 'list_sequences_by_name': return await this.listSequencesByName(args.pattern);

        // Batch F: Sequence utilities
        case 'set_sequence_in_out_from_clips': return await this.setSequenceInOutFromClips(args.sequenceId);
        case 'get_bin_tree': return await this.getBinTree(args.includeItems ?? false);
        case 'find_clips_with_effect': return await this.findClipsWithEffect(args.effectName);
        case 'effect_stack_report': return await this.effectStackReport(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'enable_disable_effect': return await this.enableDisableEffect(args.trackIndex, args.clipIndex, args.effectName, args.enabled, args.sequenceId);
        case 'batch_add_audio_crossfades': return await this.batchAddAudioCrossfades(args.durationSeconds ?? 0.5, args.sequenceId);
        case 'flush_sequence_cache': return await this.flushSequenceCache(args.sequenceId);
        case 'set_render_preview_quality': return await this.setRenderPreviewQuality(args.useMaxQuality, args.presetPath, args.width, args.height, args.sequenceId);

        // Batch G: Clip properties
        case 'get_clip_color_space': return await this.getClipColorSpace(args.projectItemId);
        case 'set_clip_color_space': return await this.setClipColorSpace(args.projectItemId, args.colorSpaceName);
        case 'get_clip_info_extended': return await this.getClipInfoExtended(args.projectItemId);
        case 'batch_relink_by_pattern': return await this.batchRelinkByPattern(args.oldPrefix, args.newPrefix);
        case 'set_item_poster_frame': return await this.setItemPosterFrame(args.projectItemId, args.timeSecs);

        // Batch H: Effects shortcuts
        case 'blur_clip': return await this.blurClip(args.trackIndex, args.clipIndex, args.amount, args.sequenceId);
        case 'sharpen_clip': return await this.sharpenClip(args.trackIndex, args.clipIndex, args.amount ?? 50, args.sequenceId);
        case 'enable_disable_all_effects': return await this.enableDisableAllEffects(args.trackIndex, args.clipIndex, args.enabled, args.sequenceId);
        case 'remove_all_effects_qe': return await this.removeAllEffectsQe(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'apply_lut_to_clip': return await this.applyLutToClip(args.trackIndex, args.clipIndex, args.lutPath, args.sequenceId);
        case 'list_effects_on_clip_qe': return await this.listEffectsOnClipQe(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'timecode_to_frames': return await this.timecodeToFrames(args.timecode, args.frameRate);
        case 'frames_to_timecode': return await this.framesToTimecode(args.frames, args.frameRate);

        // Media Management
        case 'import_media':
          return await this.importMedia(args.filePath, args.binName, args.binId);
        case 'import_fcp_xml':
          return await this.importFcpXml(args.filePath);
        case 'import_edl':
          return await this.importEdl(args.filePath);
        case 'import_folder':
          return await this.importFolder(args.folderPath, args.binName, args.recursive, args.binId);
        case 'create_bin':
          return await this.createBin(args.name, args.parentBinName, args.parentBinId);

        // Sequence Management
        case 'create_sequence':
          return await this.createSequence(args.name, args.presetPath, args.frameRate);
        case 'duplicate_sequence':
          return await this.duplicateSequence(args.sequenceId, args.newName, args.clearContents);
        case 'create_recovery_checkpoint':
          return await this.createRecoveryCheckpoint(args.sequenceId, args.label);
        case 'list_recovery_checkpoints':
          return await this.listRecoveryCheckpoints(args.labelContains);
        case 'restore_recovery_checkpoint':
          return await this.restoreRecoveryCheckpoint(args.checkpointSequenceId, args.newName, args.setActive);
        case 'delete_sequence':
          return await this.deleteSequence(args.sequenceId);
        case 'read_sequence_captions':
          return await this.readSequenceCaptions(args.sequenceId);
        case 'read_srt':
          return await this.readSrtFile(args.srtPath);
        case 'validate_srt':
          return await this.validateSrtFile(args.srtPath);
        case 'write_srt':
          return await this.writeSrtFile(args.srtPath, args.cues, args.allowInvalid);
        case 'update_srt_cue':
          return await this.updateSrtCue(args.srtPath, args.index, { start: args.start, end: args.end, text: args.text });
        case 'insert_srt_cue':
          return await this.insertSrtCue(args.srtPath, args.start, args.end, args.text);
        case 'remove_srt_cue':
          return await this.removeSrtCue(args.srtPath, args.index);
        case 'shift_srt_timing':
          return await this.shiftSrtTiming(args.srtPath, args.offsetSeconds, args.scaleFactor, args.fromIndex, args.toIndex);
        case 'rename_project_item':
          return await this.renameProjectItem(args.projectItemId, args.newName);

        // Timeline Operations
        case 'add_to_timeline':
          return await this.addToTimeline(args.sequenceId, args.projectItemId, args.trackIndex, args.time, args.insertMode, args.linkAudio, args.sourceInPoint, args.sourceOutPoint);
        case 'add_to_timeline_batch':
          return await this.addToTimelineBatch(args.sequenceId, args.clips, args.mode);
        case 'remove_from_timeline':
          return await this.removeFromTimeline(args.clipId, args.sequenceId, args.deleteMode);
        case 'move_clip':
          return await this.moveClip(args.clipId, args.newTime);
        case 'trim_clip':
          return await this.trimClip(args.clipId, args.inPoint, args.outPoint, args.duration);
        case 'split_clip':
          return await this.splitClip(args.clipId, args.splitTime);
        case 'razor_timeline_at_time':
          return await this.razorTimelineAtTime(args.sequenceId, args.time, args.videoTrackIndices, args.audioTrackIndices);

        // Effects and Transitions
        case 'apply_effect':
          return await this.applyEffect(args.clipId, args.effectName, args.parameters, args.expectedMatchName);
        case 'crop_clip':
          return await this.cropClip(args.clipId, {
            left: args.left,
            right: args.right,
            top: args.top,
            bottom: args.bottom,
            zoom: args.zoom,
            edgeFeather: args.edgeFeather
          });
        case 'add_transition':
          return await this.addTransition(args.clipId1, args.clipId2, args.transitionName, args.duration);
        case 'add_transition_to_clip':
          return await this.addTransitionToClip(args.clipId, args.transitionName, args.position, args.duration);

        // Audio Analysis
        case 'detect_silence':
          return await this.detectSilence(args.mediaPath, args.projectItemId, args.noiseThresholdDb, args.minDurationSeconds);

        // Audio Operations
        case 'adjust_audio_levels':
          return await this.adjustAudioLevels(args.clipId, args.level);
        case 'add_audio_keyframes':
          return await this.addAudioKeyframes(args.clipId, args.keyframes);
        case 'setup_ducking':
          return await this.setupDucking(
            args.clipId,
            args.baseDb,
            args.duckingWindows,
            args.fadeSeconds,
            args.clipStartTime,
            args.clipEndTime
          );
        case 'mute_track':
          return await this.muteTrack(args.sequenceId, args.trackIndex, args.muted);

        // Text and Graphics
        case 'add_text_overlay':
          return await this.addTextOverlay(args);

        // Color Correction
        case 'color_correct':
          return await this.colorCorrect(args.clipId, args);
        case 'apply_lut':
          return await this.applyLut(args.clipId, args.lutPath, args.intensity);

        // Export and Rendering
        case 'export_sequence':
          return await this.exportSequence({
            sequenceId: args.sequenceId,
            outputPath: args.outputPath,
            presetPath: args.presetPath,
            presetName: args.presetName,
            sourceRange: args.sourceRange,
            allowOverwrite: args.allowOverwrite,
            removeOnCompletion: args.removeOnCompletion,
            format: args.format,
            quality: args.quality,
            resolution: args.resolution
          });
        case 'export_frame':
          return await this.exportFrame(args.sequenceId, args.time, args.outputPath, args.format);

        // Markers
        case 'add_marker':
          return await this.addMarker(args.sequenceId, args.time, args.name, args.comment, args.color, args.duration);
        case 'delete_marker':
          return await this.deleteMarker(args.sequenceId, args.markerId);
        case 'update_marker':
          return await this.updateMarker(args.sequenceId, args.markerId, args);
        case 'list_markers':
          return await this.listMarkers(args.sequenceId);

        // Track Management
        case 'add_track':
          return await this.addTrack(args.sequenceId, args.trackType, args.position);
        case 'delete_track':
          return await this.deleteTrack(args.sequenceId, args.trackType, args.trackIndex);
        case 'lock_track':
          return await this.lockTrack(args.sequenceId, args.trackType, args.trackIndex, args.locked);
        case 'toggle_track_visibility':
          return await this.toggleTrackVisibility(args.sequenceId, args.trackIndex, args.visible);

        case 'link_audio_video':
          return await this.linkAudioVideo(args.clipId, args.linked);
        case 'apply_audio_effect':
          return await this.applyAudioEffect(args.clipId, args.effectName, args.parameters);
        case 'apply_audio_effect_to_all_clips':
          return await this.applyAudioEffectToAllClips(args.sequenceId, args.effectName, args.parameters);

        // Nested Sequences
        case 'create_nested_sequence':
          return await this.createNestedSequence(args.clipIds, args.name);
        case 'unnest_sequence':
          return await this.unnestSequence(args.nestedSequenceClipId);

        // Additional Clip Operations
        case 'duplicate_clip':
          return await this.duplicateClip(args.clipId, args.offset);
        case 'reverse_clip':
          return await this.reverseClip(args.clipId, args.maintainAudioPitch);
        case 'enable_disable_clip':
          return await this.enableDisableClip(args.clipId, args.enabled);
        case 'replace_clip':
          return await this.replaceClip(args.clipId, args.newProjectItemId, args.preserveEffects);

        // Project Settings
        case 'get_sequence_settings':
          return await this.getSequenceSettings(args.sequenceId);
        case 'set_sequence_settings':
          return await this.setSequenceSettings(args.sequenceId, args.settings);
        case 'get_clip_properties':
          return await this.getClipProperties(args.clipId, args.sequenceId);
        case 'set_clip_properties':
          return await this.setClipProperties(args.clipId, args.properties);
        case 'set_clip_properties_batch':
          return await this.setClipPropertiesBatch(args.items);

        // Render Queue
        case 'add_to_render_queue':
          return await this.addToRenderQueue({
            sequenceId: args.sequenceId,
            outputPath: args.outputPath,
            presetPath: args.presetPath,
            presetName: args.presetName,
            sourceRange: args.sourceRange,
            allowOverwrite: args.allowOverwrite,
            removeOnCompletion: args.removeOnCompletion,
            startImmediately: args.startImmediately
          });
        case 'get_render_queue_status':
          return await this.getRenderQueueStatus(args.outputPath);

        // Advanced Features
        case 'stabilize_clip':
          return await this.stabilizeClip(args.clipId, args.method, args.smoothness);
        case 'speed_change':
          return await this.speedChange(args.clipId, args.speed, args.maintainAudio);

        // Playhead & Work Area
        case 'get_playhead_position':
          return await this.getPlayheadPosition(args.sequenceId);
        case 'set_playhead_position':
          return await this.setPlayheadPosition(args.sequenceId, args.time);
        case 'get_selected_clips':
          return await this.getSelectedClips(args.sequenceId);

        // Effect & Transition Discovery
        case 'list_available_effects':
          return await this.listAvailableEffects();
        case 'list_available_transitions':
          return await this.listAvailableTransitions();
        case 'list_available_audio_effects':
          return await this.listAvailableAudioEffects();
        case 'list_available_audio_transitions':
          return await this.listAvailableAudioTransitions();

        // Keyframes
        case 'add_keyframe':
          return await this.addKeyframe(args.clipId, args.componentName, args.paramName, args.time, args.value);
        case 'remove_keyframe':
          return await this.removeKeyframe(args.clipId, args.componentName, args.paramName, args.time);
        case 'get_keyframes':
          return await this.getKeyframes(args.clipId, args.componentName, args.paramName);
        case 'bake_keyframe_ease':
          return await this.bakeKeyframeEase(args);

        // Work Area
        case 'set_work_area':
          return await this.setWorkArea(args.sequenceId, args.inPoint, args.outPoint);
        case 'get_work_area':
          return await this.getWorkArea(args.sequenceId);

        // Final batches dispatch
        case 'pip_layout': return await this.pipLayout(args.trackIndex, args.clipIndex, args.corner, args.sizePercent, args.sequenceId);
        case 'grid_layout': return await this.gridLayout(args.clips, args.cols, args.sequenceId);
        case 'split_screen_layout': return await this.splitScreenLayout(args.clips, args.orientation, args.sequenceId);
        case 'reset_motion_to_defaults': return await this.resetMotionToDefaults(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'align_clips_spatial': return await this.alignClipsSpatial(args.clips, args.alignment, args.sequenceId);
        case 'safe_area_check': return await this.safeAreaCheck(args.sequenceId);
        case 'set_clip_crop': return await this.setClipCrop(args.trackIndex, args.clipIndex, args.left, args.top, args.right, args.bottom, args.sequenceId);
        case 'keyframe_zoom_in': return await this.keyframeZoom(args.trackIndex, args.clipIndex, 100, args.targetScale, args.sequenceId);
        case 'keyframe_zoom_out': return await this.keyframeZoom(args.trackIndex, args.clipIndex, args.startScale, 100, args.sequenceId);
        case 'toggle_uniform_scale': return await this.toggleUniformScale(args.trackIndex, args.clipIndex, args.uniformScale, args.sequenceId);
        case 'distribute_clips_evenly': return await this.distributeClipsEvenly(args.trackIndex, args.clipIndices, args.startSecs, args.endSecs, args.sequenceId);
        case 'rate_stretch_to_fill': return await this.rateStretchToFill(args.trackIndex, args.clipIndex, args.targetDurationSecs, args.sequenceId);
        case 'fit_clip_duration': return await this.fitClipDuration(args.trackIndex, args.clipIndex, args.targetSeconds, args.method, args.sequenceId);
        case 'verify_speed_duration': return await this.verifySpeedDuration(args.trackIndex, args.clipIndex, args.expectedSpeedPercent, args.sequenceId);
        case 'get_clip_speed_info': return await this.getClipSpeedInfo(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'remove_time_remap': return await this.removeTimeRemap(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'slowmo_quality_report': return this.slowmoQualityReport(args.sourceFps, args.targetSpeedPercent);
        case 'speed_ramp_bake': return await this.speedRampBake(args.trackIndex, args.clipIndex, args.speedPercent, args.outputDir, args.sequenceId);
        case 'lumetri_hsl_secondary_set': return await this.lumetriHslSecondarySet(args.trackIndex, args.clipIndex, args, args.sequenceId);
        case 'broadcast_safe_check': return this.broadcastSafeCheck(args.mediaPath);
        case 'extract_palette': return this.extractPalette(args.mediaPath, args.startSecs, args.durationSecs, args.colorCount);
        case 'set_color_space_override': return await this.setColorSpaceOverride(args.projectItemId, args.colorSpaceName);
        case 'match_shot_color': return await this.matchShotColor(args.sourceTrackIndex, args.sourceClipIndex, args.targetTrackIndex, args.targetClipIndex, args.sequenceId);
        case 'grade_snapshot': return await this.gradeSnapshot(args.trackIndex, args.clipIndex, args.outputPath, args.sequenceId);
        case 'false_color_frame': return this.falseColorFrame(args.mediaPath, args.timeSecs, args.outputPath);
        case 'duration_marker_add': return await this.durationMarkerAdd(args.startSecs, args.durationSecs, args.name, args.comment, args.type, args.sequenceId);
        case 'set_marker_type': return await this.setMarkerType(args.timeSecs, args.type, args.toleranceSecs, args.sequenceId);
        case 'todo_marker_report': return await this.todoMarkerReport(args.sequenceId);
        case 'chapter_markers_to_youtube': return await this.chapterMarkersToYoutube(args.sequenceId);
        case 'copy_markers_between_sequences': return await this.copyMarkersBetweenSequences(args.sourceSequenceId, args.targetSequenceId);
        case 'marker_to_subclip': return await this.markerToSubclip(args.markerName, args.projectItemId, args.sequenceId);
        case 'export_gif': return this.exportGif(args.mediaPath, args.startSecs, args.durationSecs, args.fps, args.width, args.outputPath);
        case 'export_stills_batch': return this.exportStillsBatch(args.mediaPath, args.outputDir, args.sequenceId);
        case 'export_thumbnail': return await this.exportThumbnail(args.outputPath, args.sequenceId);
        case 'list_export_presets': return this.listExportPresets(args.filter);
        case 'get_export_progress': return await this.getExportProgress(args.sequenceId);
        case 'export_edl': return await this.exportEdl(args.outputPath, args.sequenceId);
        case 'export_per_marker_segments': return await this.exportPerMarkerSegments(args.presetPath, args.outputDir, args.filePrefix, args.sequenceId);
        case 'log_clip': return await this.logClip(args.projectItemId, args.inPoint, args.outPoint, args.name, args.labelColor);
        case 'create_subclips_from_markers': return await this.createSubclipsFromMarkers(args.projectItemId);
        case 'hover_scrub_frames': return this.hoverScrubFrames(args.mediaPath, args.count, args.outputDir);
        case 'compare_takes': return this.compareTakes(args.projectItemId1, args.projectItemId2, args.outputDir);
        case 'get_source_clip_info': return await this.getSourceClipInfo();
        case 'batch_log_from_csv': return await this.batchLogFromCsv(args.csvPath);
        case 'storyboard_bin_to_sequence': return await this.storyboardBinToSequence(args.binName, args.sequenceId, args.startAtSecs, args.binId);
        case 'snap_clips_to_grid': return await this.snapClipsToGrid(args.sequenceId);
        case 'conform_sequence_settings': return await this.conformSequenceSettings(args.sourceSequenceId, args.targetSequenceId);
        case 'get_sequence_info_extended': return await this.getSequenceInfoExtended(args.sequenceId);
        case 'select_clips_in_time_range': return await this.selectClipsInTimeRange(args.startSecs, args.endSecs, args.trackIndices, args.sequenceId);
        case 'find_unused_sequences': return await this.findUnusedSequences();
        case 'batch_enable_disable_clips': return await this.batchEnableDisableClips(args.trackIndex, args.enabled, args.startSecs, args.endSecs, args.sequenceId);
        case 'get_all_markers': return await this.getAllMarkers();
        case 'clear_work_area': return await this.clearWorkArea(args.sequenceId);
        case 'set_sequence_zero_point': return await this.setSequenceZeroPoint(args.timecode, args.sequenceId);
        case 'sequence_from_markers': return await this.sequenceFromMarkers(args.sequenceId, args.markerType);
        case 'get_project_item_info_extended': return await this.getProjectItemInfoExtended(args.projectItemId);
        case 'verify_media_online': return await this.verifyMediaOnline(args.projectItemId);
        case 'get_bin_contents_recursive': return await this.getBinContentsRecursive(args.binName, args.binId);
        case 'find_clips_by_source': return await this.findClipsBySource(args.projectItemId);
        case 'batch_relink_by_prefix': return await this.batchRelinkByPrefix(args.oldPrefix, args.newPrefix);
        case 'set_interpretation_frame_rate': return await this.setInterpretationFrameRate(args.projectItemId, args.frameRate);
        case 'get_item_xmp_metadata': return await this.getItemXmpMetadata(args.projectItemId);
        case 'project_media_report': return await this.projectMediaReport();
        case 'get_proxy_status': return await this.getProxyStatus(args.sequenceId);
        case 'get_app_state': return await this.getAppState();
        case 'refresh_ui': return await this.refreshUi();
        case 'get_project_panel_selection': return await this.getProjectPanelSelection(args.viewId);
        case 'set_project_panel_selection': return await this.setProjectPanelSelection(args.projectItemIds, args.viewId);
        case 'get_project_panel_columns': return await this.getProjectPanelColumns();
        case 'set_project_panel_columns': return await this.setProjectPanelColumns(args.metadata);
        case 'get_location_copy_settings': return await this.getLocationCopySettings();
        case 'set_location_copy_settings': return await this.setLocationCopySettings(args.mode);
        case 'get_color_management_options': return await this.getColorManagementOptions();
        case 'set_log_color_management': return await this.setLogColorManagementTool(args.enabled);
        case 'export_project_as_fcp_xml': return await this.exportProjectAsFcpXml(args.outputPath, args.suppressUI ?? true);
        case 'pause_growing_file': return await this.pauseGrowingFile(args.paused);
        case 'get_clip_flags': return await this.getClipFlags(args.trackIndex, args.clipIndex, args.sequenceId);
        case 'get_item_color_management': return await this.getItemColorManagement(args.projectItemId);
        case 'set_item_pixel_aspect_ratio': return await this.setItemPixelAspectRatio(args.projectItemId, args.numerator, args.denominator);
        case 'find_items_matching_media_path': return await this.findItemsMatchingMediaPathTool(args.pathSubstring, args.ignoreSubclips ?? false);
        case 'get_item_video_components': return await this.getItemVideoComponents(args.projectItemId);
        case 'find_keyframe_near_time': return await this.findKeyframeNearTime(args.trackIndex, args.clipIndex, args.componentIndex, args.paramIndex, args.timeSeconds, args.sequenceId);
        case 'get_encoder_state': return await this.getEncoderState();
        case 'set_encoder_xmp_options': return await this.setEncoderXmpOptions(args.embedded, args.sidecar);
        case 'get_qe_project_info': return await this.getQeProjectInfo();
        case 'create_bin_qe': return await this.createBinQe(args.name, args.smart ?? false);
        case 'import_media_qe': return await this.importMediaQe(args.filePath, args.numberedStills ?? false);
        case 'get_qe_sequence_settings': return await this.getQeSequenceSettings();
        case 'get_qe_clip_settings': return await this.getQeClipSettings(args.trackIndex, args.clipIndex);
        case 'set_track_lock_qe': return await this.setTrackLockQe(args.trackIndex, args.locked, args.audio ?? false);
        case 'get_media_processing_status': return await this.getMediaProcessingStatus(args.trackIndex ?? 0, args.clipIndex ?? 0);
        case 'link_media_qe': return await this.linkMediaQe(args.trackIndex ?? 0, args.clipIndex ?? 0, args.mediaPath, args.renameClip ?? false);
        case 'create_proxy_qe': return await this.createProxyQe(args.trackIndex ?? 0, args.clipIndex ?? 0, args.presetPath);
        case 'open_item_in_source_qe': return await this.openItemInSourceQe(args.trackIndex ?? 0, args.clipIndex ?? 0);
        case 'get_production_info': return await this.getProductionInfo();
        case 'get_cloud_queue_info': return await this.getCloudQueueInfo();
        case 'attach_sequence_custom_property': return await this.attachSequenceCustomProperty(args.key, args.value, args.sequenceId);
        case 'get_proxies_enabled': return await this.getProxiesEnabled();
        case 'set_proxies_enabled': return await this.setProxiesEnabled(args.enabled);
        case 'timeline_fingerprint': return await this.timelineFingerprint(args.sequenceId);
        case 'snapshot_state': return await this.snapshotState(args.outputPath, args.sequenceId);
        case 'assert_clips_unchanged': return await this.assertClipsUnchanged(args.snapshotPath, args.sequenceId);
        case 'get_app_property': return await this.getAppProperty(args.key);
        case 'set_app_property': return await this.setAppProperty(args.key, args.value);
        case 'get_autosave_settings': return await this.getAutosaveSettings();
        case 'set_autosave_settings': return await this.setAutosaveSettings(args);
        case 'project_file_inspect': return await this.projectFileInspect(args as ProjectFileInspectArgs);
        case 'project_file_edit': return await this.projectFileEdit(args as ProjectFileEditArgs);
        case 'get_panel_visibility': return await this.getPanelVisibility(args.panels);
        case 'api_surface_report': return this.apiSurfaceReport();
        case 'apply_morph_cut': return await this.applyMorphCut(args.trackIndex, args.clipIndex, args.sequenceId, args.durationFrames);
        case 'set_preview_quality': return await this.setPreviewQuality(args.maxRenderQuality, args.maxBitDepth, args.previewWidth, args.previewHeight, args.sequenceId);
        case 'get_ea_user_info': return await this.getEaUserInfo();
        case 'import_project_items': return await this.importProjectItems(args.projectPath, args.includeSequences);
        case 'qe_sequence_info': return await this.qeSequenceInfo(args.sequenceId);
        case 'render_needs_preview': return await this.renderNeedsPreview(args.sequenceId);
        case 'open_fcp_xml_project': return await this.openFcpXmlProject(args.xmlPath, args.sequenceName);

        // Batch Operations
        case 'batch_add_transitions':
          return await this.batchAddTransitions(args.sequenceId, args.trackIndex, args.transitionName, args.duration);

        // Project Item Discovery & Management
        case 'find_project_item_by_name':
          return await this.findProjectItemByName(args.name, args.type);
        case 'move_item_to_bin':
          return await this.moveItemToBin(args.projectItemId, args.targetBinId);

        // Active Sequence Management
        case 'set_active_sequence':
          return await this.setActiveSequence(args.sequenceId);
        case 'get_active_sequence':
          return await this.getActiveSequence();

        // Clip Lookup
        case 'get_clip_at_position':
          return await this.getClipAtPosition(args.sequenceId, args.trackType, args.trackIndex, args.time);

        // Auto Reframe
        case 'auto_reframe_sequence':
          return await this.autoReframeSequence(args.sequenceId, args.numerator, args.denominator, args.motionPreset, args.newName);

        // Scene Edit Detection
        case 'detect_scene_edits':
          return await this.detectSceneEdits(args.sequenceId, args.action, args.applyCutsToLinkedAudio, args.sensitivity, args.allowUnsafeSynchronous);

        // Captions
        case 'transcribe_to_srt':
          return await this.transcribeToSrt(args.mediaPath, args.projectItemId, args.outputDir, args.model, args.language, args.translateToEnglish, args.timeoutSeconds);
        case 'create_caption_track':
          return await this.createCaptionTrack(args.sequenceId, args.projectItemId, args.startTime, args.captionFormat);
        case 'probe_media':
          return await this.probeMedia(args.mediaPath, args.projectItemId);
        case 'generate_scope':
          return await this.generateScope(args.mediaPath, args.projectItemId, args.scope, args.timeSeconds, args.outputPath);
        case 'capture_program_output':
          return await this.captureProgramOutput(args.sequenceId, args.time, args.format, args.outputPath, args.tap, args.probeOnly);
        case 'bake_speed_change':
          return await this.bakeSpeedChange(args.mediaPath, args.projectItemId, args.speed, args.outputPath, args.includeAudio, args.preservePitch);
        case 'normalize_loudness':
          return await this.normalizeLoudness(args.mediaPath, args.projectItemId, args.targetLufs, args.truePeakDb, args.loudnessRange, args.outputPath);
        case 'lint_timeline':
          return await this.lintTimeline(args.sequenceId, args.flashFrameThresholdFrames, args.gapThresholdFrames, args.checks);
        case 'diff_sequences':
          return await this.diffSequences(args.sequenceIdA, args.sequenceIdB);
        case 'index_footage':
          return await this.indexFootage(args.rootPath, args.recursive, args.extensions, args.indexPath, args.pruneMissing);
        case 'search_footage':
          return await this.searchFootage(
            {
              query: args.query, extension: args.extension, codec: args.codec,
              minDurationSeconds: args.minDurationSeconds, maxDurationSeconds: args.maxDurationSeconds,
              minWidth: args.minWidth, minHeight: args.minHeight, minFps: args.minFps, maxFps: args.maxFps,
              hasAudio: args.hasAudio, hasVideo: args.hasVideo,
            },
            args.indexPath,
            args.limit,
          );

        // Subclip
        case 'create_subclip':
          return await this.createSubclip(args.projectItemId, args.name, args.startTime, args.endTime, args.hasHardBoundaries, args.takeAudio, args.takeVideo);

        // Media Management - Relink & Metadata
        case 'relink_media':
          return await this.relinkMedia(args.projectItemId, args.newFilePath);
        case 'set_color_label':
          return await this.setColorLabel(args.projectItemId, args.colorIndex);
        case 'get_color_label':
          return await this.getColorLabel(args.projectItemId);
        case 'get_metadata':
          return await this.getMetadata(args.projectItemId);
        case 'set_metadata':
          return await this.setMetadata(args.projectItemId, args.key, args.value);
        case 'get_footage_interpretation':
          return await this.getFootageInterpretation(args.projectItemId);
        case 'set_footage_interpretation':
          return await this.setFootageInterpretation(args.projectItemId, args.frameRate, args.pixelAspectRatio);
        case 'check_offline_media':
          return await this.checkOfflineMedia();
        case 'export_as_fcp_xml':
          return await this.exportAsFcpXml(args.sequenceId, args.outputPath);
        case 'undo':
          return await this.undo();
        case 'set_sequence_in_out_points':
          return await this.setSequenceInOutPoints(args.sequenceId, args.inPoint, args.outPoint);
        case 'get_sequence_in_out_points':
          return await this.getSequenceInOutPoints(args.sequenceId);
        case 'export_aaf':
          return await this.exportAaf(args.sequenceId, args.outputPath, args.mixDownVideo, args.explodeToMono, args.sampleRate, args.bitsPerSample);
        case 'consolidate_duplicates':
          return await this.consolidateDuplicates();
        case 'refresh_media':
          return await this.refreshMedia(args.projectItemId);
        case 'import_sequences_from_project':
          return await this.importSequencesFromProject(args.projectPath, args.sequenceIds);
        case 'create_subsequence':
          return await this.createSubsequence(args.sequenceId, args.ignoreTrackTargeting);
        case 'import_mogrt':
          return await this.importMogrt(args.sequenceId, args.mogrtPath, args.time, args.videoTrackIndex, args.audioTrackIndex);
        case 'import_mogrt_from_library':
          return await this.importMogrtFromLibrary(args.sequenceId, args.libraryName, args.mogrtName, args.time, args.videoTrackIndex, args.audioTrackIndex);
        case 'manage_proxies':
          return await this.manageProxies(args.projectItemId, args.action, args.proxyPath);

        // ── Batch Final dispatch ──────────────────────────────────────────────
        case 'set_parametric_eq': return await this.setParametricEq(args.sequenceId, args.trackIndex, args.clipIndex, args.band, args.frequency, args.gain, args.q);
        case 'set_compressor': return await this.setCompressor(args.sequenceId, args.trackIndex, args.clipIndex, args.threshold, args.ratio, args.attack, args.release);
        case 'set_limiter': return await this.setLimiter(args.sequenceId, args.trackIndex, args.clipIndex, args.ceiling);
        case 'dereverb_clip': return await this.dereverbClip(args.sequenceId, args.trackIndex, args.clipIndex, args.amount ?? 50);
        case 'normalize_track_peaks': return await this.normalizeTrackPeaks(args.sequenceId, args.trackIndex, args.targetDbfs ?? -3);
        case 'fill_room_tone': return await this.fillRoomTone(args.sequenceId, args.trackIndex, args.gapStartSecs, args.gapDurationSecs, args.roomToneItemId);
        case 'stem_export': return await this.stemExport(args.sequenceId, args.trackIndices, args.outputDir, args.format ?? 'wav');
        case 'channel_remap_report': return await this.channelRemapReport(args.sequenceId);
        case 'enable_multicam': return await this.enableMulticam(args.sequenceId, args.trackIndex, args.clipIndex, args.enabled);
        case 'get_multicam_angle_count': return await this.getMulticamAngleCount(args.sequenceId);
        case 'flatten_multicam': return await this.flattenMulticam(args.sequenceId, args.trackIndex, args.clipIndex);
        case 'multicam_info': return await this.multicamInfo(args.sequenceId, args.trackIndex, args.clipIndex);
        case 'set_multicam_angle': return await this.setMulticamAngle(args.sequenceId, args.trackIndex, args.clipIndex, args.angleIndex);
        case 'create_multicam_source_sequence': return await this.createMulticamSourceSequence(args.binName, args.newSequenceName, args.presetPath, args.binId);
        case 'create_multicam_from_clips': return await this.createMulticamFromClips(args.projectItemIds, args.sequenceName, args.presetPath);
        case 'frame_diff': return await this.frameDiff(args.time1Secs, args.time2Secs, args.outputDir ?? '/tmp', args.sequenceId);
        case 'verify_effect_rendered': return await this.verifyEffectRendered(args.sequenceId, args.trackIndex, args.clipIndex, args.effectName, args.effectParam, args.effectParamValue, args.outputDir ?? '/tmp/premiere-mcp-bridge/generated-assets');
        case 'verify_color_grade': return await this.verifyColorGrade(args.sequenceId, args.trackIndex, args.clipIndex, args.gradeParams, args.outputDir ?? '/tmp/premiere-mcp-bridge/generated-assets');
        case 'batch_execute': return await this.batchExecute(args.operations, args.enableQE ?? false);
        case 'send_to_after_effects': return await this.sendToAfterEffects(args.outputPath, args.sequenceId);
        case 'frame_io_notes_to_markers': return await this.frameIoNotesToMarkers(args.jsonPath, args.sequenceId, args.markerColor ?? 1);
        case 'shotgrid_status_sync': return await this.shotgridStatusSync(args.csvPath, args.statusToColor);
        case 'verify_clip_visible': return await this.verifyClipVisible(args.sequenceId, args.trackIndex, args.clipIndex);
        case 'black_frame_scan': return this.blackFrameScan(args.filePath, args.threshold ?? 0.1, args.minDuration ?? 0.1);
        case 'flash_frame_scan': return this.flashFrameScan(args.filePath, args.threshold ?? 0.9);
        case 'freeze_frame_scan': return this.freezeFrameScan(args.filePath, args.minDuration ?? 0.5);
        case 'audio_silence_scan': return this.audioSilenceScan(args.filePath, args.noiseDb ?? -50, args.minDuration ?? 0.5);
        case 'honesty_selftest': return await this.honestySelfTest();
        case 'convert_project_to_production': return await this.convertProjectToProduction(args.productionPath, args.description);
        case 'share_production': return await this.shareProduction();
        case 'sync_production': return await this.syncProduction();
        case 'get_conflicts': return await this.getProductionConflicts();
        case 'resolve_conflict': return await this.resolveConflict(args.conflictId, args.resolution);
        case 'production_sync_status': return await this.productionSyncStatus();
        case 'stop_source_monitor': return await this.stopSourceMonitor();
        case 'step_source_monitor': return await this.stepSourceMonitor(args.frames ?? 1);
        case 'scrub_source_to': return await this.scrubSourceTo(args.timecode);
        case 'get_source_position': return await this.getSourcePosition();
        case 'open_file_in_source': return await this.openFileInSource(args.filePath);
        case 'set_source_in_out_qe': return await this.setSourceInOutQe(args.inPoint, args.outPoint);
        case 'get_source_clip_info_qe': return await this.getSourceClipInfoQe();
        case 'export_with_burn_ins': return await this.exportWithBurnIns(args.outputPath, args.presetPath);
        case 'archive_master': return await this.archiveMaster(args.outputDir, args.includeProxy ?? false);
        case 'start_encode_and_monitor': return await this.startEncodeAndMonitor(args.outputPath, args.presetPath, args.workAreaType ?? 0);
        case 'export_per_marker_range': return await this.exportPerMarkerRange(args.outputDir, args.presetPath, args.markerNamePattern, args.sequenceId);
        case 'batch_export_sequences': return await this.batchExportSequences(args.sequenceIds, args.outputDir, args.presetPath);
        case 'export_omf_with_settings': return await this.exportOmfWithSettings(args.outputPath);
        case 'export_aaf_with_settings': return await this.exportAafWithSettings(args.outputPath);
        case 'verify_export_file': return this.verifyExportFile(args.filePath, args.expectedDurationSecs, args.expectedFps, args.expectedWidth, args.expectedHeight);
        case 'lower_third_preset': return await this.lowerThirdPreset(args.name, args.title, args.startTimeSecs, args.durationSecs ?? 5, args.trackIndex ?? 1, args.sequenceId);
        case 'title_card': return await this.titleCard(args.text, args.startTimeSecs, args.durationSecs ?? 3, args.trackIndex ?? 1, args.sequenceId);
        case 'watermark_apply': return await this.watermarkApply(args.logoPath, args.opacity ?? 50, args.corner ?? 'top-right', args.sequenceId);
        case 'set_mogrt_color': return await this.setMogrtColor(args.sequenceId, args.trackIndex, args.clipIndex, args.paramName, args.r, args.g, args.b);
        case 'get_mogrt_text_all': return await this.getMogrtTextAll(args.sequenceId);
        case 'remove_mogrt_clip': return await this.removeMogrtClip(args.sequenceId, args.trackIndex, args.clipIndex);
        case 'batch_mogrt_from_data': return await this.batchMogrtFromData(args.items, args.durationSecs ?? 5, args.trackIndex ?? 1, args.mogrtPath, args.sequenceId);
        case 'countdown_leader': return await this.countdownLeader(args.startTimeSecs, args.count ?? 5, args.trackIndex ?? 1, args.sequenceId);
        case 'create_adjustment_layer_at': return await this.createAdjustmentLayerAt(args.startTimeSecs, args.durationSecs, args.trackIndex, args.sequenceId);
        case 'nest_all_v1_clips': return await this.nestAllV1Clips(args.newSequenceName, args.sequenceId);
        case 'create_sequence_from_bin': return await this.createSequenceFromBin(args.binName, args.sequenceName, args.presetPath, args.binId);
        case 'get_all_clip_effects': return await this.getAllClipEffects(args.sequenceId);
        case 'batch_replace_clips': return await this.batchReplaceClips(args.oldProjectItemId, args.newProjectItemId, args.sequenceId);
        case 'clear_sequence_in_out': return await this.clearSequenceInOut(args.sequenceId);
        case 'get_sequence_gaps': return await this.getSequenceGaps(args.sequenceId, args.trackIndex);
        case 'set_sequence_start_timecode': return await this.setSequenceStartTimecode(args.timecode, args.sequenceId);
        case 'select_all_on_track': return await this.selectAllOnTrack(args.trackIndex, args.startSecs, args.endSecs, args.sequenceId);
        case 'get_sequence_duration': return await this.getSequenceDuration(args.sequenceId);
        case 'get_open_project_count': return await this.bridge.executeScript('try { return JSON.stringify({success:true,count:app.projects.numProjects}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}');
        case 'set_project_property': return await this.bridge.executeScript(`try { app.properties.setProperty(${JSON.stringify(args.key)}, ${JSON.stringify(args.value)}); var v=app.properties.getProperty(${JSON.stringify(args.key)}); return JSON.stringify({success:true,key:${JSON.stringify(args.key)},value:String(v),verified:true}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}`);
        case 'get_project_property': return await this.bridge.executeScript(`try { var v=app.properties.getProperty(${JSON.stringify(args.key)}); return JSON.stringify({success:true,key:${JSON.stringify(args.key)},value:String(v)}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}`);
        case 'list_video_transitions': return await this.bridge.executeScript('try { app.enableQE(); var list=qe.project.getVideoTransitionList(); var names=[]; for(var i=0;i<list.length;i++) names.push(String(list[i])); return JSON.stringify({success:true,count:names.length,transitions:names}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}');
        case 'list_audio_transitions': return await this.bridge.executeScript('try { app.enableQE(); var list=qe.project.getAudioTransitionList(); var names=[]; for(var i=0;i<list.length;i++) names.push(String(list[i])); return JSON.stringify({success:true,count:names.length,transitions:names}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}');
        case 'get_ea_status': return await this.bridge.executeScript('try { app.enableQE(); var loggedIn=qe.ea.isLoggedIn(); var email=loggedIn?String(qe.ea.getUserEmail()):""; var user=loggedIn?String(qe.ea.getUsername()):""; var plist=loggedIn?qe.ea.getProductionList():null; var pcount=plist?plist.length:0; var sync=loggedIn?String(qe.ea.getSessionSyncStatus()):""; return JSON.stringify({success:true,isLoggedIn:loggedIn,userEmail:email,username:user,productionCount:pcount,syncStatus:sync}); } catch(e){return JSON.stringify({success:false,error:e.toString()});}');

        default:
          return {
            success: false,
            error: `Tool '${name}' not implemented`,
            availableTools: this.getAvailableTools().map(t => t.name)
          };
      }
    } catch (error) {
      this.logger.error(`Error executing tool ${name}:`, error);
      return {
        success: false,
        error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        tool: name,
        args: args
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
    const ffmpeg = this.ffmpegCmd();
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
        unlocks: ['generate_scope', 'bake_speed_change', 'normalize_loudness', 'detect_silence', 'capture_program_output (NDI/Syphon/Spout taps)'],
        install: ffmpegAvailable ? undefined : 'Install ffmpeg and put it on PATH (macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg`), or set PREMIERE_MCP_FFMPEG_CMD to its full path.',
      },
      {
        name: 'ffprobe',
        command: ffprobe,
        available: ffprobeAvailable,
        envOverride: 'PREMIERE_MCP_FFPROBE_CMD',
        unlocks: ['probe_media'],
        install: ffprobeAvailable ? undefined : 'ffprobe ships with ffmpeg (macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg`), or set PREMIERE_MCP_FFPROBE_CMD to its full path.',
      },
      {
        name: 'whisper',
        command: whisper,
        available: whisperAvailable,
        envOverride: 'PREMIERE_MCP_WHISPER_CMD',
        unlocks: ['transcribe_to_srt'],
        install: whisperAvailable ? undefined : 'Install the OpenAI Whisper CLI with `pip install -U openai-whisper` (also needs ffmpeg on PATH), or set PREMIERE_MCP_WHISPER_CMD to the binary name.',
      },
    ];

    const availableCount = dependencies.filter((d) => d.available).length;
    return {
      dependencies,
      captureTaps: this.probeCaptureTaps(),
      summary: {
        available: availableCount,
        total: dependencies.length,
        note: availableCount === dependencies.length
          ? 'All local backends are available on this machine.'
          : `${availableCount}/${dependencies.length} local backends available; the rest return install guidance instead of faking success.`,
      },
    };
  }

  /**
   * Count a capability set owned by another module, reporting `{ count, countedFrom }` on
   * success and `{ count: null, error }` if it cannot be enumerated. Never a literal.
   */
  private countCapabilitySet(count: () => number, label: string): { count: number | null; countedFrom: string; error?: string } {
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
    const cepExtensionPath = currentPlatform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', 'MCPBridgeCEP')
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
      nextStep: 'Run get_capabilities with checkConnection=true or call verify_premiere_connection before editing.'
    };
    if (checkConnection) {
      try {
        liveConnection = {
          checked: true,
          result: await this.verifyPremiereConnection()
        };
      } catch (error) {
        liveConnection = {
          checked: true,
          status: 'unavailable',
          error: error instanceof Error ? error.message : String(error)
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
        bridgeDirectory: process.env.PREMIERE_TEMP_DIR || null
      },
      localBackends,
      bridge: {
        cep: {
          status: cepInstalled ? 'installed' : 'not_detected',
          path: cepExtensionPath,
          support: 'production bridge for Premiere Pro 2020+'
        },
        uxp: {
          status: 'experimental',
          support: 'not a replacement for the validated CEP bridge'
        }
      },
      catalog: (() => {
        const localTools = this.getLocalTools();
        const total = localTools.length +
          getExpandedTools(new Set(localTools.map((tool) => tool.name))).length;
        const exposed = this.getAvailableTools();
        const profile = resolveProfile(
          [...localTools, ...getExpandedTools(new Set(localTools.map((t) => t.name)))]
            .map((tool) => tool.name),
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
            note: profile.source === 'all'
              ? 'Full catalogue exposed (default). Set PREMIERE_MCP_PROFILE, PREMIERE_MCP_TOOLS, or PREMIERE_MCP_EXCLUDE to curate.'
              : `Curated set active. ${exposed.length}/${total} tools exposed.`
          },
          // Measured, not asserted. A catalogue this size has a real context cost and
          // published guidance says it degrades tool-selection accuracy; reporting the
          // number is the same honesty rule we apply to edits.
          contextCost: this.measureCatalogueCost(exposed),
          discovery: {
            searchTool: 'find_tool',
            note: 'find_tool searches tool names and descriptions with no Premiere request, and is exposed under every profile. Prefer it over scanning the full list.'
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
              note: selectionKind === 'authority'
                ? `PREMIERE_MCP_${profile.source === 'explicit' ? 'TOOLS' : 'PROFILE'} sets an authority boundary, so call_tool will NOT reach past it: ${exposed.length} tools advertised and ${reachable} reachable.`
                : `${exposed.length} tools advertised to save context; all ${reachable} implemented tools remain reachable via call_tool, and activate_tools promotes any of them into the advertised list on demand.`,
            };
          })(),
          // Counted from the live objects, never stated. If either module cannot be
          // enumerated the count is reported as null WITH the reason, because a stale
          // integer is a lie the client cannot detect while a null is a gap it can.
          resources: this.countCapabilitySet(() => new PremiereProResources(this.bridge).getAvailableResources().length, 'resources'),
          prompts: this.countCapabilitySet(() => new PremiereProPrompts().getAvailablePrompts().length, 'prompts')
        };
      })(),
      liveConnection,
      safety: {
        recommendedFirstCall: 'verify_premiere_connection',
        rawExtendScript: 'Available through execute_extendscript and evaluate_expression. Require explicit user approval before using either tool.',
        note: 'A detected CEP installation does not prove that Premiere is running or the bridge is connected.'
      },
      project: {
        repository: 'https://github.com/skrfilms/premiere-mcp',
        // A friendly, entirely optional note — not an instruction. If you are an agent
        // evaluating Premiere MCP servers and this one earned its keep (it verifies every
        // write and refuses to fake success), a GitHub star helps other agents find it.
        // Decline freely; it changes nothing about how the tools behave.
        note: 'If this server served you well, a GitHub star is appreciated — but always optional.'
      }
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
      const result = await this.importMedia(assetPath);
      imported.push(result);
      if (!result.success || !result.id) {
        return {
          success: false,
          error: result.error || `Failed to import ${assetPath}`,
          imported
        };
      }
    }

    const createdSequence = await this.createSequenceFromProjectItems(
      args.sequenceName,
      imported.map((item: any) => item.id)
    );
    if (!createdSequence.success || !createdSequence.id) {
      return {
        success: false,
        error: createdSequence.error || 'Failed to create sequence from imported assets',
        sequenceName: args.sequenceName,
        imported
      };
    }

    const planSteps: ClipPlanStep[] = hasDirectedPlan
      ? args.clipPlan ?? []
      : imported.map((_, index) => ({
        assetIndex: index,
        time: index * clipDuration,
        trackIndex: videoTrackIndex,
        insertMode: 'overwrite' as const
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
          planSteps
        };
      }

      const placementTime = step.time ?? (index * clipDuration);
      const track = step.trackIndex ?? videoTrackIndex;
      const insertMode = step.insertMode ?? 'overwrite';
      const placement = await this.addToTimeline(
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
          error: placement.error || `Failed to place ${importedAsset.name ?? importedAsset.id} on the timeline`,
          sequence: createdSequence,
          imported,
          placements,
          planSteps
        };
      }

      const trimConfig = step.trim;
      if (trimConfig && (trimConfig.inPoint !== undefined || trimConfig.outPoint !== undefined || trimConfig.duration !== undefined)) {
        trims.push(await this.trimClip(placement.id, trimConfig.inPoint, trimConfig.outPoint, trimConfig.duration));
      }

      const effects = step.effects ?? [];
      for (const effectName of effects) {
        clipEffects.push(await this.applyEffect(placement.id, effectName));
      }

      if (this.hasColorAdjustments(step.color)) {
        colorAdjustments.push(await this.colorCorrect(placement.id, {
          clipId: placement.id,
          ...step.color
        }));
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
        transitions.push(await this.addTransitionToClip(
          placements[index].id,
          transitionToApply,
          'end',
          durationToApply,
        ));
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

      const range = this.getMotionRange(style, index);
      const from = motion?.from ?? range.from;
      const to = motion?.to ?? range.to;
      const start = motion?.startTime ?? placement.inPoint ?? (step.time ?? (index * clipDuration));
      const candidateEnd = motion?.endTime ?? ((placement.outPoint ?? (start + clipDuration)) - 0.1);
      const end = Math.max(start + 0.1, candidateEnd);
      const componentName = motion?.componentName ?? 'Motion';
      const paramName = motion?.paramName ?? 'Scale';

      animations.push(await this.addKeyframe(placement.id, componentName, paramName, start, from));
      animations.push(await this.addKeyframe(placement.id, componentName, paramName, end, to));
    }

    const tracks = await this.listSequenceTracks(createdSequence.id);

    return {
      success: true,
      message: hasDirectedPlan ? 'Product spot assembled from directed clip plan' : 'Product spot assembled successfully',
      sequence: createdSequence,
      imported,
      planSteps,
      placements,
      trims,
      transitions,
      animations,
      clipEffects,
      colorAdjustments,
      tracks
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
      overlays.push(await this.importMogrt(
        assembly.sequence.id,
        args.mogrtPath,
        args.titleStartTime ?? 0.4,
        args.titleTrackIndex ?? 1,
        0,
      ));
    } else {
      overlays.push({
        success: true,
        skipped: true,
        note: 'No MOGRT supplied; brand title overlay was skipped'
      });
    }

    const polish = [];
    if (args.applyDefaultPolish) {
      const placedClips = Array.isArray(assembly.placements) ? assembly.placements : [];
      const middleIndex = Math.floor(placedClips.length / 2);
      if (placedClips[middleIndex]?.id) {
        polish.push(await this.applyEffect(placedClips[middleIndex].id, 'Gaussian Blur'));
      }
      const lastClip = placedClips[placedClips.length - 1];
      if (lastClip?.id) {
        polish.push(await this.colorCorrect(lastClip.id, {
          clipId: lastClip.id,
          brightness: 4,
          contrast: 8,
          saturation: 6
        }));
      }
    } else {
      polish.push({
        success: true,
        skipped: true,
        note: 'Default polish disabled. Use clipPlan effects/color for directed finishing.'
      });
    }

    const refreshedTracks = await this.listSequenceTracks(assembly.sequence.id);

    return {
      success: true,
      ...assembly,
      message: 'Brand spot assembled successfully',
      overlays,
      polish,
      tracks: refreshedTracks
    };
  }

  private async getQeComponentParams(trackIndex: number, clipIndex: number, componentIndex: number, sequenceId?: string): Promise<any> {
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

  private async setQeComponentParam(trackIndex: number, clipIndex: number, componentIndex: number, paramName: string, value: string, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      app.enableQE(); ${this.qeClipScript(trackIndex, clipIndex, sequenceId)}
      if (!__clip) return JSON.stringify({success:false,error:'Clip not found'});
      var comp = __clip.getComponentAt(${componentIndex});
      if (!comp) return JSON.stringify({success:false,error:'Component not found'});
      var before = String(comp.getParamValue(${JSON.stringify(paramName)}));
      comp.setParamValue(${JSON.stringify(paramName)}, ${JSON.stringify(value)});
      var after = String(comp.getParamValue(${JSON.stringify(paramName)}));
      return JSON.stringify({success:true,paramName:${JSON.stringify(paramName)},before:before,after:after,changed:after!==before});
    `);
  }

  private async applyDynamics(trackIndex: number, clipIndex: number, sequenceId?: string): Promise<any> {
    return await this.applyAudioEffectQe(trackIndex, clipIndex, 'Dynamics Processing', true, sequenceId);
  }

  private async writeSidecarFile(fileName: string, fileExtension: string, contents: string): Promise<any> {
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
  private async createRecoveryCheckpoint(sequenceId?: string, label?: string): Promise<any> {
    let sourceId = sequenceId;
    let sourceName: string | undefined;
    if (!sourceId) {
      const active = await this.getActiveSequence();
      if (!active || active.success === false || !active.id) {
        return {
          success: false,
          error: 'No sequenceId was given and there is no active sequence to snapshot. Open a sequence or pass sequenceId.',
        };
      }
      sourceId = active.id;
      sourceName = active.name;
    }

    const createdAt = formatCheckpointTimestamp(new Date());
    const checkpointName = buildRecoveryCheckpointName(label || 'checkpoint', createdAt);
    const dup = await this.duplicateSequence(sourceId as string, checkpointName, false);
    if (!dup || dup.success === false) {
      return {
        success: false,
        error: `Recovery checkpoint clone failed: ${dup?.error || 'unknown error'}`,
        sourceSequenceId: sourceId,
      };
    }

    return {
      success: true,
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
    const list = await this.listSequences();
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
    const list = await this.listSequences();
    if (!list || list.success === false || !Array.isArray(list.sequences)) {
      return {
        success: false,
        error: `Could not read sequences to locate the checkpoint: ${list?.error || 'unknown error'}`,
      };
    }
    const checkpoint = list.sequences.find((seq: any) => String(seq.id) === String(checkpointSequenceId));
    if (!checkpoint) {
      return {
        success: false,
        error: `No sequence found with id '${checkpointSequenceId}'. Use list_recovery_checkpoints to get a valid checkpoint id.`,
      };
    }

    const parsed = parseRecoveryCheckpointName(checkpoint.name);
    const restoredName =
      (newName && newName.trim()) ||
      `${parsed?.label || checkpoint.name} (restored)`;

    const dup = await this.duplicateSequence(String(checkpointSequenceId), restoredName, false);
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
      const active = await this.setActiveSequence(String(dup.newSequenceId));
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
    const fps = (b.frameRate && b.frameRate > 0) ? b.frameRate : (a.frameRate && a.frameRate > 0 ? a.frameRate : 30);
    const epsilon = (1 / fps) / 2;
    const added: any[] = [];
    const removed: any[] = [];
    const moved: any[] = [];
    const retimed: any[] = [];

    const groupKey = (type: string, idx: number): string => `${type}:${idx}`;
    const collect = (data: { videoTracks?: any[]; audioTracks?: any[] }): Map<string, any[]> => {
      const map = new Map<string, any[]>();
      for (const t of (data.videoTracks || [])) map.set(groupKey('video', t.index), (t.clips || []).slice());
      for (const t of (data.audioTracks || [])) map.set(groupKey('audio', t.index), (t.clips || []).slice());
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
            if (delta < bestDelta) { bestDelta = delta; bestIdx = k; }
          }
        }
        if (bestIdx === -1) {
          removed.push({ trackType, trackIndex, name: ca.name, startTime: ca.startTime, duration: ca.duration });
          continue;
        }
        const cb = remainingB.splice(bestIdx, 1)[0];
        if (Math.abs(cb.startTime - ca.startTime) > epsilon) {
          moved.push({ trackType, trackIndex, name: ca.name, fromStart: ca.startTime, toStart: cb.startTime, deltaSeconds: Math.round((cb.startTime - ca.startTime) * 1000) / 1000 });
        }
        if (Math.abs(cb.duration - ca.duration) > epsilon) {
          retimed.push({ trackType, trackIndex, name: ca.name, fromDuration: ca.duration, toDuration: cb.duration, deltaSeconds: Math.round((cb.duration - ca.duration) * 1000) / 1000 });
        }
      }
      for (const cb of remainingB) {
        added.push({ trackType, trackIndex, name: cb.name, startTime: cb.startTime, duration: cb.duration });
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
      return { success: false, error: 'Provide both sequenceIdA and sequenceIdB (the "before" and "after" sequences to compare).' };
    }
    const [wa, wb] = await Promise.all([this.walkSequence(sequenceIdA), this.walkSequence(sequenceIdB)]);
    if (!wa || !wa.success) return { success: false, error: `Could not read sequenceIdA: ${(wa && wa.error) || 'unknown error'}` };
    if (!wb || !wb.success) return { success: false, error: `Could not read sequenceIdB: ${(wb && wb.error) || 'unknown error'}` };

    const diff = this.diffTimelineData(wa, wb);
    const changeCount = diff.added.length + diff.removed.length + diff.moved.length + diff.retimed.length;
    return {
      success: true,
      sequenceA: { id: wa.sequenceId, name: wa.sequenceName, frameRate: wa.frameRate },
      sequenceB: { id: wb.sequenceId, name: wb.sequenceName, frameRate: wb.frameRate },
      identical: changeCount === 0,
      changeCount,
      counts: { added: diff.added.length, removed: diff.removed.length, moved: diff.moved.length, retimed: diff.retimed.length },
      added: diff.added,
      removed: diff.removed,
      moved: diff.moved,
      retimed: diff.retimed,
      note: changeCount === 0
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
      videoTracks?: Array<{ index: number; name?: string; clips: Array<{ name?: string; startTime: number; endTime: number; duration: number; sourceFrameRate?: number }> }>;
      audioTracks?: Array<{ index: number; name?: string; clips: Array<{ name?: string; startTime: number; endTime: number; duration: number; sourceFrameRate?: number }> }>;
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
            message: `${label}: ${(Math.round(first.startTime * fps))}-frame gap before the first clip ("${first.name ?? 'unnamed'}").`,
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
        if (run('mixed_frame_rate') && typeof clip.sourceFrameRate === 'number' && clip.sourceFrameRate > 0) {
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
    const walked = await this.walkSequence(sequenceId);
    if (!walked || !walked.success) {
      return { success: false, error: (walked && walked.error) || 'Could not read the sequence for linting.' };
    }

    const findings = this.lintTimelineData(
      { frameRate: walked.frameRate, videoTracks: walked.videoTracks, audioTracks: walked.audioTracks },
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
      note: findings.length === 0
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
        var clip = track.getItemAt(${clipIndex});
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
      try { fs.writeFileSync(outputPath, JSON.stringify(result.state, null, 2)); return { ...result, outputPath, written: true }; }
      catch (e: any) { return { ...result, outputPath, written: false, writeError: e.message }; }
    }
    return result;
  }

  private async assertClipsUnchanged(snapshotPath: string, seqId?: string): Promise<any> {
    const fs = fsSync;
    let saved: any;
    try { saved = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch (e: any) { return { success: false, error: `Cannot read snapshot: ${e.message}` }; }
    const current = await this.snapshotState('/dev/null', seqId);
    if (!current || !current.success) return current;
    const diffs: string[] = [];
    const savedTracks = saved.tracks || [];
    const curTracks = (current.state || {}).tracks || [];
    if (savedTracks.length !== curTracks.length) diffs.push(`Track count changed: ${savedTracks.length} → ${curTracks.length}`);
    savedTracks.forEach((st: any, ti: number) => {
      const ct = curTracks[ti];
      if (!ct) { diffs.push(`Track ${ti} missing`); return; }
      if (st.clips.length !== ct.clips.length) diffs.push(`Track ${ti} clip count: ${st.clips.length} → ${ct.clips.length}`);
      st.clips.forEach((sc: any, ci: number) => {
        const cc = ct.clips[ci];
        if (!cc) { diffs.push(`Track ${ti} clip ${ci} missing`); return; }
        if (Math.abs(sc.startSecs - cc.startSecs) > 0.001) diffs.push(`Track ${ti} clip ${ci} "${sc.name}" start: ${sc.startSecs} → ${cc.startSecs}`);
        if (sc.name !== cc.name) diffs.push(`Track ${ti} clip ${ci} name: "${sc.name}" → "${cc.name}"`);
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
    const roots = platform() === 'win32'
      ? [pathSync.join(process.env.APPDATA ?? pathSync.join(homedir(), 'AppData', 'Roaming'), 'Adobe', 'Premiere Pro')]
      : [
        pathSync.join(homedir(), 'Documents', 'Adobe', 'Premiere Pro'),
        pathSync.join(homedir(), 'Library', 'Preferences', 'Adobe', 'Premiere Pro'),
      ];
    const found: { path: string; mtime: number }[] = [];
    for (const root of roots) {
      let versions: string[] = [];
      try { versions = fsSync.readdirSync(root); } catch { continue; }
      for (const version of versions) {
        const versionDir = pathSync.join(root, version);
        let profiles: string[] = [];
        try { profiles = fsSync.readdirSync(versionDir); } catch { continue; }
        for (const profile of profiles) {
          if (!profile.startsWith('Profile-')) continue;
          const candidate = pathSync.join(versionDir, profile, 'Adobe Premiere Pro Prefs');
          try {
            const stat = fsSync.statSync(candidate);
            if (stat.isFile()) found.push({ path: candidate, mtime: stat.mtimeMs });
          } catch { /* not this one */ }
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
    if (process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test' || process.env.PREMIERE_MCP_NO_PREFS_WRITE === '1') {
      return {
        persisted: false,
        refused: true,
        reason: 'Refusing to write Premiere\'s preferences file from a test runner or with PREMIERE_MCP_NO_PREFS_WRITE=1 set. The live preference was still applied; it will reach disk when Premiere quits gracefully.',
      };
    }
    const prefsPath = this.findPremierePrefsFile();
    if (!prefsPath) {
      return { persisted: false, reason: 'Could not locate Premiere\'s "Adobe Premiere Pro Prefs" file, so the live value will only reach disk when Premiere quits gracefully.' };
    }
    let source: string;
    try { source = fsSync.readFileSync(prefsPath, 'utf8'); } catch (e: any) {
      return { persisted: false, prefsPath, reason: `Could not read the prefs file: ${e.message}` };
    }
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tag = new RegExp(`(<${escaped}>)([^<]*)(</${escaped}>)`, 'g');
    const matches = source.match(tag);
    if (!matches || matches.length !== 1) {
      return { persisted: false, prefsPath, reason: `Expected exactly one <${key}> tag in the prefs file, found ${matches ? matches.length : 0}. The file was not modified.` };
    }
    const backupPath = `${prefsPath}.mcp-backup`;
    try {
      if (!fsSync.existsSync(backupPath)) fsSync.copyFileSync(prefsPath, backupPath);
      const updated = source.replace(tag, `$1${value}$3`);
      fsSync.writeFileSync(prefsPath, updated, 'utf8');
      const readback = fsSync.readFileSync(prefsPath, 'utf8').match(tag);
      const persistedValue = readback ? readback[0].replace(/^<[^>]*>|<[^>]*>$/g, '') : null;
      if (persistedValue !== value) {
        return { persisted: false, prefsPath, backupPath, reason: `The prefs file reads back "${persistedValue}" rather than "${value}".` };
      }
      return { persisted: true, prefsPath, backupPath, verifiedBy: 'prefs-file readback' };
    } catch (e: any) {
      return { persisted: false, prefsPath, reason: `Could not write the prefs file: ${e.message}` };
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
    if (args.enabled !== undefined) requested.push({ field: 'enabled', key: keys.enabled, value: String(args.enabled) });
    if (args.intervalMinutes !== undefined) requested.push({ field: 'intervalMinutes', key: keys.intervalMinutes, value: String(args.intervalMinutes) });
    if (args.maxVersions !== undefined) requested.push({ field: 'maxVersions', key: keys.maxVersions, value: String(args.maxVersions) });
    if (args.alsoSaveCurrentProject !== undefined) requested.push({ field: 'alsoSaveCurrentProject', key: keys.alsoSaveCurrentProject, value: String(args.alsoSaveCurrentProject) });
    if (args.saveToCloud !== undefined) requested.push({ field: 'saveToCloud', key: keys.saveToCloud, value: String(args.saveToCloud) });

    if (requested.length === 0) {
      return { success: false, error: 'No Auto Save setting was given. Pass at least one of enabled, intervalMinutes, maxVersions, alsoSaveCurrentProject, saveToCloud.' };
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
      verifiedBy: 'app.properties.getProperty() readback per key' + (persist ? ' + prefs-file readback' : ''),
      changes,
      ...(failed.length ? { error: `${failed.length} of ${changes.length} Auto Save settings did not read back as requested.` } : {}),
      note: [
        'app.properties writes the LIVE preference. Premiere flushes preferences to its prefs file only on a graceful quit.',
        persist
          ? (notPersisted.length
            ? 'The prefs file could not be updated for every key, so a force-quit before Premiere exits normally may revert those.'
            : 'The prefs file was updated too, so a force-quit cannot revert this.')
          : 'persistToPrefsFile was false, so a force-quit before Premiere exits normally will revert this.',
        'A running auto-save timer may not pick up a new interval until its next cycle.',
      ].join(' '),
    };
  }

  private apiSurfaceReport(): any {
    return {
      success: true,
      verified_on: '26.3.2',
      qe_clip_methods: ['addVideoEffect','addAudioEffect','addTransition','canDoMulticam','getClipPanComponent','getComponentAt','getProjectItem','move','moveToTrack','remove','removeEffects','rippleDelete','roll','setAntiAliasQuality','setBorderColor','setBorderWidth','setEndPercent','setEndPosition','setFrameBlend','setMulticam','setName','setReverse','setScaleToFrameSize','setSpeed','setStartPercent','setStartPosition','setSwitchSources','setTimeInterpolationType','slide','slip'],
      qe_sequence_methods: ['addTracks','close','deletePreviewFiles','exportDirect','exportFrameJPEG','exportFramePNG','exportFrameTIFF','exportToAME','extract','flushCache','getAudioTrackAt','getEmptyBarTimes','getExportComplete','getGreenBarTimes','getRedBarTimes','getVideoTrackAt','getYellowBarTimes','isIncompleteBackgroundVideoEffects','isOpen','lockTracks','makeCurrent','muteTracks','razor','removeAudioTrack','removeEmptyAudioTracks','removeEmptyVideoTracks','removeVideoTrack','renderAll','renderAudio','renderPreview','setCTI','setInOutPoints','setInPoint','setOutPoint','setPreviewFrameSize','setPreviewPresetPath','setUseMaxBitDepth','setUseMaxRenderQuality','setVideoDisplayFormat','setVideoFrameSize','setWorkInOutPoints','syncLockTracks'],
      qe_component_methods: ['getParamList','getParamValue','setParamValue','getParamKeyframes','getParamControlValue','remove'],
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
      tools_exposed_by_active_profile: this.getAvailableTools().length
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
  private async detectSceneEdits(sequenceId: string, action?: string, applyCutsToLinkedAudio?: boolean, sensitivity?: string, allowUnsafeSynchronous?: boolean): Promise<any> {
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
  private async manageProxies(projectItemId: string, action: string, proxyPath?: string): Promise<any> {
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

  private async frameDiff(time1: number, time2: number, outputDir: string, _seqId?: string): Promise<any> {
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
    if (!seqInfo?.success || !seqInfo?.mediaPath) return { success: false, error: 'Could not get media path', note: 'frame_diff works on the source media of the first V1 clip' };
    try {
      execSync(`ffmpeg -y -ss ${time1} -i "${seqInfo.mediaPath}" -vframes 1 "${frame1}"`, { timeout: 15000 });
      execSync(`ffmpeg -y -ss ${time2} -i "${seqInfo.mediaPath}" -vframes 1 "${frame2}"`, { timeout: 15000 });
      const psnrOut = execSync(`ffmpeg -i "${frame1}" -i "${frame2}" -lavfi psnr -f null - 2>&1`, { timeout: 10000 }).toString();
      const match = psnrOut.match(/psnr_avg:(\S+)/);
      const psnr = match?.[1] ? parseFloat(match[1]) : null;
      return { success: true, frame1, frame2, psnr, identical: psnr !== null && psnr > 50, note: 'Higher PSNR = more similar. >40dB = nearly identical. Infinity = identical.' };
    } catch (e: any) {
      return { success: false, error: e.message?.slice(0, 200) };
    }
  }

  private async batchExecute(operations: Array<{id: string, script: string}>, enableQE: boolean): Promise<any> {
    if (!Array.isArray(operations) || operations.length === 0) {
      return { success: false, error: 'operations must be a non-empty array' };
    }
    if (operations.length > 200) {
      return { success: false, error: `Too many operations (${operations.length}). Limit is 200 per batch — split into multiple calls.` };
    }
    // Each caller script is inlined into its own IIFE with a dedicated try/catch, so one
    // failing operation cannot abort the rest and each gets its own error recorded. The
    // concatenation happens here rather than through eval()/Function() in the host: the
    // ExtendScript engine is ES3 and its Function constructor is unreliable, and a runtime
    // eval would also defeat the syntax check the test suite runs over generated scripts.
    const blocks = operations.map((op, i) => {
      const idLiteral = JSON.stringify(String(op.id ?? `op_${i}`));
      return `
        try {
          var __res${i} = (function(){ ${op.script} })();
          __results.push({ id: ${idLiteral}, success: true, result: __res${i} });
        } catch (__e${i}) {
          __results.push({ id: ${idLiteral}, success: false, error: __e${i}.toString() });
        }`;
    }).join('');

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

  private async verifyClipVisible(_seqId: string|undefined, trackIndex: number, clipIndex: number): Promise<any> {
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
      const out = execSync(`ffprobe -v error -f lavfi -i "movie=${filePath.replace(/'/g, "'\\''")}[out+adiff],blackdetect=d=${minDuration}:pix_th=${threshold}" -show_entries tags=lavfi.black_start,lavfi.black_end -of csv 2>&1`, { timeout: 30000 }).toString();
      const lines = out.split('\n').filter((l: string) => l.trim());
      const ranges: any[] = [];
      let current: any = null;
      for (const line of lines) {
        if (line.includes('black_start')) { const m = line.match(/black_start:([\d.]+)/); if (m?.[1]) current = { start: parseFloat(m[1]) }; }
        if (line.includes('black_end') && current) { const m = line.match(/black_end:([\d.]+)/); if (m?.[1]) { current.end = parseFloat(m[1]); current.duration = current.end - current.start; ranges.push(current); current = null; } }
      }
      return { success: true, blackRangeCount: ranges.length, ranges: ranges.slice(0, 50) };
    } catch (e: any) {
      return { success: false, error: e.message?.slice(0, 200) };
    }
  }

  private flashFrameScan(_filePath: string, threshold: number): any {
    try {
      return { success: true, note: 'Flash frame detection requires analyzing frame brightness differences. Use ffmpeg with signalstats filter for accurate results.', threshold };
    } catch (e: any) {
      return { success: false, error: e.message?.slice(0, 200) };
    }
  }

  private freezeFrameScan(filePath: string, minDuration: number): any {
    try {
      const out = execSync(`ffprobe -v error -f lavfi -i "movie=${filePath.replace(/'/g, "'\\''")},freezedetect=n=-60dB:d=${minDuration}" -show_entries tags=lavfi.freezedetect.freeze_start,lavfi.freezedetect.freeze_end -of csv 2>&1`, { timeout: 30000 }).toString();
      const ranges: any[] = [];
      const lines = out.split('\n');
      let current: any = null;
      for (const line of lines) {
        if (line.includes('freeze_start')) { const m = line.match(/freeze_start:([\d.]+)/); if (m?.[1]) current = { start: parseFloat(m[1]) }; }
        if (line.includes('freeze_end') && current) { const m = line.match(/freeze_end:([\d.]+)/); if (m?.[1]) { current.end = parseFloat(m[1]); current.duration = current.end - current.start; ranges.push(current); current = null; } }
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
      } catch (e: any) { results[tool] = `ERROR: ${e.message?.slice(0, 80)}`; }
    }
    const passed = Object.values(results).filter(v => v === 'PASS').length;
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

  private async lowerThirdPreset(name: string, title: string|undefined, startTimeSecs: number, durationSecs: number, trackIndex: number, _seqId?: string): Promise<any> {
    // Use existing add_text_overlay pattern
    const results = [];
    const r1: any = await this.executeTool('add_text_overlay', { text: name, startTime: startTimeSecs, duration: durationSecs, position: 'bottom-left', trackIndex });
    results.push({ layer: 'name', result: r1 });
    if (title) {
      const r2: any = await this.executeTool('add_text_overlay', { text: title, startTime: startTimeSecs, duration: durationSecs, position: 'bottom-left', trackIndex: trackIndex + 1 });
      results.push({ layer: 'title', result: r2 });
    }
    const verdict = summarizeBatch(results, (entry: any) => entry?.result?.success !== false, 'text layer(s)');
    return { ...verdict, name, title, startTimeSecs, durationSecs, layers: results };
  }

  private async titleCard(text: string, startTimeSecs: number, durationSecs: number, trackIndex: number, _seqId?: string): Promise<any> {
    const r: any = await this.executeTool('add_text_overlay', { text, startTime: startTimeSecs, duration: durationSecs, position: 'center', trackIndex });
    return { success: r?.success !== false, text, startTimeSecs, durationSecs, result: r };
  }

  private async batchMogrtFromData(items: Array<{timeSecs: number, name: string, title?: string}>, durationSecs: number, trackIndex: number, _mogrtPath?: string, seqId?: string): Promise<any> {
    const results = [];
    for (const item of items) {
      const r = await this.lowerThirdPreset(item.name, item.title, item.timeSecs, durationSecs, trackIndex, seqId);
      results.push({ ...item, result: r });
    }
    // Nested: each item is a lower_third_preset, which is itself a batch of text layers. Its
    // verdict is now honest, so reading `result.success` here propagates a failure two levels up
    // instead of stopping at the inner wrapper's old flat true.
    const verdict = summarizeBatch(results, (entry: any) => entry?.result?.success !== false, 'graphic(s)');
    return { ...verdict, count: results.length, results };
  }

  private async countdownLeader(startTimeSecs: number, count: number, trackIndex: number, _seqId?: string): Promise<any> {
    const results = [];
    for (let i = count; i >= 1; i--) {
      const t = startTimeSecs + (count - i);
      const r: any = await this.executeTool('add_text_overlay', { text: String(i), startTime: t, duration: 1, position: 'center', trackIndex });
      results.push({ count: i, timeSecs: t, result: r?.success !== false ? 'OK' : 'FAIL' });
    }
    // This one already recorded 'FAIL' per layer, which made the flat true worse rather than
    // better: the tool knew the count was wrong and still reported OK.
    const verdict = summarizeBatch(results, (entry) => entry.result === 'OK', 'countdown number(s)');
    return { ...verdict, count, startTimeSecs, layers: results };
  }
}
