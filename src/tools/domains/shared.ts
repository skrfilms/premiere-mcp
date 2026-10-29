/**
 * Types and pure helpers shared by every tool-domain class.
 *
 * These lived at the top of tools/index.ts. They are declarations only -- no server state --
 * so the domain classes can import them without importing each other.
 */

import { type Replacement } from '../prproj-surgery.js';

export interface ProjectFileInspectArgs {
  projectPath: string;
  countStrings?: string[];
  xmlExcerptAround?: string;
}

export interface ProjectFileEditArgs {
  sourcePath: string;
  outputPath: string;
  replacements: Replacement[];
  dryRun?: boolean;
  allowCensusChange?: boolean;
}

export type MotionStyle = 'push_in' | 'pull_out' | 'alternate' | 'none';

/**
 * One Motion-component parameter write. `index` is the position it is EXPECTED at and
 * `name`/`aliases` are the labels that make trusting that index safe — a bare index writes a
 * real value into whatever parameter has drifted into that slot, with no error.
 */
export interface MotionParamTarget {
  index: number;
  name: string;
  value: number | number[] | boolean;
  aliases?: string[];
}

export type InsertMode = 'overwrite' | 'insert';

export type ExportSourceRange = 'entire' | 'in_out' | 'work_area';

export interface EncoderPresetEntry {
  name: string;
  path: string;
  source: 'user';
  ameVersion: string;
}

export interface EncoderPresetDiscovery {
  success: true;
  presets: EncoderPresetEntry[];
  count: number;
  searchedDirectories: string[];
  errors: Array<{ path: string; error: string }>;
  factoryPresets: {
    supported: false;
    note: string;
  };
}

export interface ExportSequenceArgs {
  sequenceId: string;
  outputPath: string;
  presetPath?: string;
  presetName?: string;
  sourceRange?: ExportSourceRange;
  allowOverwrite?: boolean;
  removeOnCompletion?: boolean;
  format?: string;
  quality?: string;
  resolution?: string;
}

export interface AddToRenderQueueArgs extends ExportSequenceArgs {
  startImmediately?: boolean;
}

export interface ClipPlanTransition {
  name?: string;
  duration?: number;
}

export interface ClipPlanMotion {
  style?: MotionStyle;
  from?: number;
  to?: number;
  startTime?: number;
  endTime?: number;
  componentName?: string;
  paramName?: string;
}

export interface ClipPlanTrim {
  inPoint?: number;
  outPoint?: number;
  duration?: number;
}

export interface ClipPlanColor {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
}

export interface ClipPlanStep {
  assetIndex?: number;
  time?: number;
  trackIndex?: number;
  insertMode?: InsertMode;
  transitionAfter?: ClipPlanTransition;
  motion?: ClipPlanMotion;
  trim?: ClipPlanTrim;
  effects?: string[];
  color?: ClipPlanColor;
}

export interface AssembleProductSpotArgs {
  sequenceName: string;
  assetPaths: string[];
  clipDuration?: number;
  videoTrackIndex?: number;
  transitionName?: string;
  transitionDuration?: number;
  motionStyle?: MotionStyle;
  clipPlan?: ClipPlanStep[];
}

export interface BuildBrandSpotArgs extends AssembleProductSpotArgs {
  mogrtPath?: string;
  titleTrackIndex?: number;
  titleStartTime?: number;
  applyDefaultPolish?: boolean;
}

export interface TextInjectionEntry {
  textIndex?: number;
  ok?: boolean;
  [key: string]: any;
}

/**
 * Returns the path of the first argument holding a NUL character, or null.
 *
 * Premiere truncates a string at the first NUL when it is assigned and reports
 * success for the shortened value, so a name like "p\0q" is stored as "p".
 * Nothing downstream can catch it: JSON.stringify turns the NUL into a \\u0000
 * escape on the way into the generated script, so the script itself is clean
 * and only the host sees the real character.
 */
export function findNulByteArgument(value: any, path = ''): string | null {
  if (typeof value === 'string') {
    return value.indexOf('\u0000') === -1 ? null : path || 'argument';
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findNulByteArgument(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = findNulByteArgument(value[key], path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }

  return null;
}

export function evaluateTextInjectionResult(result: any): any {
  if (!result || result.success === false) return result;

  const requestedCount = Number(result.textRequestedCount || 0);
  if (requestedCount === 0) {
    return {
      ...result,
      textInjectionStatus: 'not_requested',
      textInjectionSummary: { requested: 0, succeeded: 0, failed: 0 },
    };
  }

  const attempts = Array.isArray(result.textInjectionResults)
    ? result.textInjectionResults.filter(
        (entry: TextInjectionEntry) => typeof entry.textIndex === 'number',
      )
    : [];
  const succeededCount = attempts.filter((entry: TextInjectionEntry) => entry.ok === true).length;
  const failedCount = requestedCount - succeededCount;
  const summary = {
    requested: requestedCount,
    succeeded: succeededCount,
    failed: failedCount,
  };

  if (succeededCount === 0) {
    const version = result.premiereVersion || 'unknown';
    const build = result.premiereBuild ? ` (build ${result.premiereBuild})` : '';
    return {
      ...result,
      success: false,
      message: 'MOGRT imported, but requested text was not written',
      error:
        `Text injection failed for all ${requestedCount} requested field(s) in ` +
        `Premiere Pro ${version}${build}.`,
      textInjectionStatus: 'failed',
      textInjectionSummary: summary,
    };
  }

  if (succeededCount < requestedCount) {
    return {
      ...result,
      success: true,
      message: 'MOGRT imported; some requested text was written and read back',
      warning: `${failedCount} of ${requestedCount} requested text field(s) could not be written`,
      textInjectionStatus: 'partial',
      textInjectionSummary: summary,
    };
  }

  return {
    ...result,
    success: true,
    message: 'MOGRT imported; all requested text was written and read back',
    textInjectionStatus: 'complete',
    textInjectionSummary: summary,
  };
}

/** The aggregate verdict for a tool that loops over N items. */
export interface BatchVerdict {
  success: boolean;
  batchStatus: 'complete' | 'partial' | 'failed' | 'empty';
  batchSummary: { requested: number; succeeded: number; failed: number };
  error?: string;
  warning?: string;
}

/**
 * Decide whether a batch of per-item results is a success.
 *
 * Every wrapper that loops used to end in a flat `success: true`, so a batch whose every single
 * item failed reported exactly what a batch that fully worked reported. The per-item errors WERE in
 * the payload, but `success` is the field an agent branches on, and it said OK — which is the one
 * thing this server is not supposed to do.
 *
 * The three states deliberately match `evaluateTextInjectionResult` above so a caller reads one
 * vocabulary across the catalogue: nothing worked is a FAILURE, something worked is a success
 * carrying a `warning`, and the counts are always present either way. An empty request is honest
 * rather than an error — asking for zero items and getting zero is not a fault.
 */
export function summarizeBatch<T>(
  items: T[],
  isOk: (item: T) => boolean,
  noun: string,
): BatchVerdict {
  const requested = items.length;
  const succeeded = items.filter((item) => isOk(item)).length;
  const failed = requested - succeeded;
  const batchSummary = { requested, succeeded, failed };

  if (requested === 0) return { success: true, batchStatus: 'empty', batchSummary };
  if (succeeded === 0) {
    return {
      success: false,
      batchStatus: 'failed',
      batchSummary,
      error: `All ${requested} ${noun} failed. Nothing was produced; see the per-item results for each reason.`,
    };
  }
  if (failed > 0) {
    return {
      success: true,
      batchStatus: 'partial',
      batchSummary,
      warning: `${failed} of ${requested} ${noun} failed; the other ${succeeded} succeeded. See the per-item results.`,
    };
  }
  return { success: true, batchStatus: 'complete', batchSummary };
}

/** One row of the capture-tap capability probe (see captureProgramOutput / probeCaptureTaps). */
export interface CaptureTapReport {
  tap: 'render' | 'ndi' | 'syphon' | 'spout';
  available: boolean;
  video: boolean;
  audio: boolean;
  realtime: boolean;
  reason: string;
  install?: string | undefined;
}
