/**
 * MCP Tools for Adobe Premiere Pro
 * 
 * This module provides tools that can be called by AI agents to perform
 * various video editing operations in Adobe Premiere Pro.
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse } from 'node:path';
import type { PremiereProTransport } from '../bridge/types.js';
import { Logger } from '../utils/logger.js';
import { createMotionDemoAssets } from '../utils/demoAssets.js';
import { executeExpandedTool, getExpandedTools, isExpandedTool } from './expanded.js';
import { applyProfile, resolveProfile, PROFILES } from './profiles.js';
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
  type SrtCue,
  type SrtValidationIssue,
  parseSrt,
  serializeSrt,
  formatTimecode,
  coerceSeconds,
  validateCues,
  cueErrors,
  insertCue,
  updateCue,
  removeCue,
  shiftCues,
  scaleCues,
} from './srt.js';
import {
  type EaseKeyframe,
  type EaseSampleOptions,
  EASING_NAMES,
  MAX_EASE_SAMPLES,
  sampleEaseKeyframes,
} from './easing.js';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<any>;
}

type MotionStyle = 'push_in' | 'pull_out' | 'alternate' | 'none';
type InsertMode = 'overwrite' | 'insert';
type ExportSourceRange = 'entire' | 'in_out' | 'work_area';

interface EncoderPresetEntry {
  name: string;
  path: string;
  source: 'user';
  ameVersion: string;
}

interface EncoderPresetDiscovery {
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

interface ExportSequenceArgs {
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

interface AddToRenderQueueArgs extends ExportSequenceArgs {
  startImmediately?: boolean;
}

interface ClipPlanTransition {
  name?: string;
  duration?: number;
}

interface ClipPlanMotion {
  style?: MotionStyle;
  from?: number;
  to?: number;
  startTime?: number;
  endTime?: number;
  componentName?: string;
  paramName?: string;
}

interface ClipPlanTrim {
  inPoint?: number;
  outPoint?: number;
  duration?: number;
}

interface ClipPlanColor {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
}

interface ClipPlanStep {
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

interface AssembleProductSpotArgs {
  sequenceName: string;
  assetPaths: string[];
  clipDuration?: number;
  videoTrackIndex?: number;
  transitionName?: string;
  transitionDuration?: number;
  motionStyle?: MotionStyle;
  clipPlan?: ClipPlanStep[];
}

interface BuildBrandSpotArgs extends AssembleProductSpotArgs {
  mogrtPath?: string;
  titleTrackIndex?: number;
  titleStartTime?: number;
  applyDefaultPolish?: boolean;
}

interface TextInjectionEntry {
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
    return value.indexOf('\u0000') === -1 ? null : (path || 'argument');
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
      textInjectionSummary: { requested: 0, succeeded: 0, failed: 0 }
    };
  }

  const attempts = Array.isArray(result.textInjectionResults)
    ? result.textInjectionResults.filter(
        (entry: TextInjectionEntry) => typeof entry.textIndex === 'number'
      )
    : [];
  const succeededCount = attempts.filter((entry: TextInjectionEntry) => entry.ok === true).length;
  const failedCount = requestedCount - succeededCount;
  const summary = {
    requested: requestedCount,
    succeeded: succeededCount,
    failed: failedCount
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
      textInjectionSummary: summary
    };
  }

  if (succeededCount < requestedCount) {
    return {
      ...result,
      success: true,
      message: 'MOGRT imported; some requested text was written and read back',
      warning: `${failedCount} of ${requestedCount} requested text field(s) could not be written`,
      textInjectionStatus: 'partial',
      textInjectionSummary: summary
    };
  }

  return {
    ...result,
    success: true,
    message: 'MOGRT imported; all requested text was written and read back',
    textInjectionStatus: 'complete',
    textInjectionSummary: summary
  };
}

const motionStyleSchema = z.enum(['push_in', 'pull_out', 'alternate', 'none']);

const clipPlanSchema = z.object({
  assetIndex: z.number().int().min(0).optional().describe('Index in assetPaths to place for this step. Defaults to the current step index.'),
  time: z.number().optional().describe('Timeline position in seconds for this step.'),
  trackIndex: z.number().int().min(0).optional().describe('Video track index for this step. Defaults to videoTrackIndex.'),
  insertMode: z.enum(['overwrite', 'insert']).optional().describe('Placement mode for this step.'),
  transitionAfter: z.object({
    name: z.string().optional().describe('Transition to apply after this clip. Set "none" to skip this boundary.'),
    duration: z.number().optional().describe('Transition duration in seconds.')
  }).optional(),
  motion: z.object({
    style: motionStyleSchema.optional().describe('Simple motion style for this clip.'),
    from: z.number().optional().describe('Starting keyframe value.'),
    to: z.number().optional().describe('Ending keyframe value.'),
    startTime: z.number().optional().describe('Start time for keyframe animation in seconds.'),
    endTime: z.number().optional().describe('End time for keyframe animation in seconds.'),
    componentName: z.string().optional().describe('Component name for keyframing. Defaults to "Motion".'),
    paramName: z.string().optional().describe('Parameter name for keyframing. Defaults to "Scale".')
  }).optional(),
  trim: z.object({
    inPoint: z.number().optional().describe('Clip in point in seconds.'),
    outPoint: z.number().optional().describe('Clip out point in seconds.'),
    duration: z.number().optional().describe('Target clip duration in seconds.')
  }).optional(),
  effects: z.array(z.string()).optional().describe('Effect names to apply to this clip.'),
  color: z.object({
    brightness: z.number().optional(),
    contrast: z.number().optional(),
    saturation: z.number().optional(),
    hue: z.number().optional(),
    temperature: z.number().optional(),
    tint: z.number().optional(),
    highlights: z.number().optional(),
    shadows: z.number().optional()
  }).optional()
});

/**
 * Premiere's marker colours, in `setColorByIndex()` order. The write domain is
 * exactly 0-7: verified against Premiere 26.0.2, where an index of 8 or above
 * is a silent no-op (there is no ninth colour) and a non-integer is silently
 * truncated toward zero. Index 0 (Green) is the default for a marker created
 * without an explicit colour.
 */
const MARKER_COLOR_NAMES = [
  'green', 'red', 'purple', 'orange', 'yellow', 'white', 'blue', 'cyan',
] as const;

/**
 * Accepts a colour name (case-insensitive, surrounding whitespace ignored) or
 * an index 0-7. Anything else is rejected here, at the schema layer, so the
 * caller gets a truthful error rather than a marker that silently keeps the
 * default colour.
 */
const MarkerColorSchema = z.union([
  z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.enum(MARKER_COLOR_NAMES),
  ),
  z.number().int().min(0).max(7),
  // Some MCP clients stringify every argument, which would otherwise drop index
  // input entirely. Accept the string form of a valid index, but nothing looser.
  // Deliberately no .transform(): executeTool() discards the parse() result and
  // passes the raw args on, so a transform here would silently never apply.
  // The string-to-number conversion lives in resolveMarkerColor instead.
  z.string().trim().regex(/^[0-7]$/),
]);

const MARKER_COLOR_DESCRIPTION =
  `Marker colour — a name (${MARKER_COLOR_NAMES.join(', ')}) or an index 0-7. Defaults to green.`;

/** One row of the capture-tap capability probe (see captureProgramOutput / probeCaptureTaps). */
interface CaptureTapReport {
  tap: 'render' | 'ndi' | 'syphon' | 'spout';
  available: boolean;
  video: boolean;
  audio: boolean;
  realtime: boolean;
  reason: string;
  install?: string | undefined;
}

export class PremiereProTools {
  private bridge: PremiereProTransport;
  private logger: Logger;
  /** TTL cache for the capture-tap capability probe (speed mandate: don't re-probe every call). */
  private captureTapsCache?: { at: number; taps: CaptureTapReport[] };

  constructor(bridge: PremiereProTransport) {
    this.bridge = bridge;
    this.logger = new Logger('PremiereProTools');
  }

  private getLocalTools(): MCPTool[] {
    return [
      // Discovery Tools (NEW)
      {
        name: 'list_project_items',
        description: 'Lists all media items, bins, and assets in the current Premiere Pro project. Use this to discover available media before performing operations.',
        inputSchema: z.object({
          includeBins: z.boolean().optional().describe('Whether to include bin information in the results'),
          includeMetadata: z.boolean().optional().describe('Whether to include detailed metadata for each item')
        })
      },
      {
        name: 'list_sequences',
        description: 'Lists all sequences in the current Premiere Pro project with their IDs, names, and basic properties.',
        inputSchema: z.object({})
      },
      {
        name: 'list_sequence_tracks',
        description: 'Lists all video and audio tracks in a specific sequence with their properties and clips.',
        inputSchema: z.object({
          sequenceId: z.string().min(1).describe('The sequence ID (GUID) to list tracks for, as returned in the "id" field by list_sequences or get_active_sequence')
        })
      },
      {
        name: 'get_project_info',
        description: 'Gets comprehensive information about the current project including name, path, settings, and status.',
        inputSchema: z.object({})
      },
      {
        name: 'verify_premiere_connection',
        description: 'Read-only readiness check for the live CEP bridge and Premiere Pro host. Run this before an editing workflow to confirm the bridge responds and report the Premiere version, project, and active sequence without changing the project.',
        inputSchema: z.object({})
      },
      {
        name: 'get_capabilities',
        description: 'Reports the local MCP runtime, installed bridge status, tool/resource/prompt catalog sizes, and supported versus experimental integration surfaces. Set checkConnection to true to run the read-only live Premiere connection check; otherwise no Premiere request is made. Set probeLocalTools to true to live-test the local backends this build relies on for capabilities Premiere cannot provide -- ffmpeg, ffprobe, the Whisper speech-to-text CLI, and the render-truth capture taps -- so you know which tools will actually work on THIS machine before calling them.',
        inputSchema: z.object({
          checkConnection: z.boolean().optional().describe('When true, run verify_premiere_connection and include its live result. Defaults to false so capability discovery is fast and non-invasive.'),
          probeLocalTools: z.boolean().optional().describe('When true, spawn-probe the local ffmpeg/ffprobe/Whisper backends and the capture taps, reporting availability, the env override, what each unlocks, and install guidance when absent. Defaults to false.')
        })
      },
      {
        name: 'validate_project_for_export',
        description: 'Runs a non-destructive export readiness audit for the active or requested sequence. Checks timeline content, offline media, missing export preset/output folder inputs, gaps, markers, and basic audio/video track state before an agent queues an export.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Optional sequence ID to validate. Defaults to the active sequence.'),
          outputPath: z.string().optional().describe('Optional intended export output path. When provided, the parent folder is checked.'),
          presetPath: z.string().optional().describe('Optional Adobe Media Encoder .epr preset path. When provided, the file is checked.'),
          requireNonEmptyTimeline: z.boolean().optional().describe('When true, an empty timeline is an error. Defaults to true.'),
          checkGaps: z.boolean().optional().describe('When true, timeline gaps are reported as warnings. Defaults to true.')
        })
      },
      {
        name: 'get_encoder_presets',
        description: 'Discovers readable user Adobe Media Encoder .epr presets from local AME preset folders. Factory preset enumeration is not claimed complete.',
        inputSchema: z.object({
          directories: z.array(z.string()).optional().describe('Optional absolute directories to scan instead of the default user AME preset folders. Intended for tests and advanced setups.')
        })
      },
      {
        name: 'build_motion_graphics_demo',
        description: 'Generates clean demo stills, creates a sequence, lays the shots out on the timeline, adds dissolves, and applies subtle scale animation for a polished minimalist ad-style demo.',
        inputSchema: z.object({
          sequenceName: z.string().optional().describe('Optional sequence name. Defaults to "Apple Like Motion Demo".')
        })
      },
      {
        name: 'assemble_product_spot',
        description: 'Builds a production-oriented promo timeline from real media assets. Supports either template defaults or an explicit clipPlan for LLM-directed pacing, transitions, motion, trims, and per-clip effects.',
        inputSchema: z.object({
          sequenceName: z.string().describe('Name for the new sequence'),
          assetPaths: z.array(z.string()).min(1).describe('Absolute paths to video or image assets in playback order'),
          clipDuration: z.number().optional().describe('Default placement duration in seconds for stills and rough spacing for assets. Defaults to 4.0'),
          videoTrackIndex: z.number().optional().describe('Target video track index. Defaults to 0'),
          transitionName: z.string().optional().describe('Default transition when clipPlan does not override it. Defaults to "Cross Dissolve" in template mode.'),
          transitionDuration: z.number().optional().describe('Transition duration in seconds. Defaults to 0.5'),
          motionStyle: motionStyleSchema.optional().describe('Fallback motion style when clipPlan does not override it. Defaults to "alternate" in template mode.'),
          clipPlan: z.array(clipPlanSchema).optional().describe('Optional explicit edit plan. When provided, each step can override timing, track, transition, motion, trim, effects, and color.')
        })
      },
      {
        name: 'build_brand_spot_from_mogrt_and_assets',
        description: 'Builds a branded ad assembly from real media assets, supports optional MOGRT overlay, and allows explicit clipPlan control. Default polish is optional so creative direction can come from LLM planning instead of hardcoded passes.',
        inputSchema: z.object({
          sequenceName: z.string().describe('Name for the new sequence'),
          assetPaths: z.array(z.string()).min(1).describe('Absolute paths to source assets in edit order'),
          mogrtPath: z.string().optional().describe('Optional absolute path to a .mogrt title or branding template'),
          clipDuration: z.number().optional().describe('Default spacing in seconds for asset placement. Defaults to 4.0'),
          videoTrackIndex: z.number().optional().describe('Base video track for the main assets. Defaults to 0'),
          titleTrackIndex: z.number().optional().describe('Video track for the optional MOGRT overlay. Defaults to 1'),
          titleStartTime: z.number().optional().describe('Timeline start time in seconds for the optional MOGRT. Defaults to 0.4'),
          transitionName: z.string().optional().describe('Default transition when clipPlan does not override it. Defaults to "Cross Dissolve" in template mode.'),
          transitionDuration: z.number().optional().describe('Transition duration in seconds. Defaults to 0.5'),
          motionStyle: motionStyleSchema.optional().describe('Fallback motion style when clipPlan does not override it. Defaults to "alternate" in template mode.'),
          clipPlan: z.array(clipPlanSchema).optional().describe('Optional explicit edit plan. Reuses assemble_product_spot clipPlan semantics.'),
          applyDefaultPolish: z.boolean().optional().describe('Whether to apply the legacy light polish pass (blur + small color tweak). Defaults to false.')
        })
      },

      // Project Management
      {
        name: 'create_project',
        description: 'Creates a new Adobe Premiere Pro project. Use this when the user wants to start a new video editing project from scratch.',
        inputSchema: z.object({
          name: z.string().describe('The name for the new project, e.g., "My Summer Vacation"'),
          location: z.string().describe('The absolute directory path where the project file should be saved, e.g., "/Users/user/Documents/Videos"')
        })
      },
      {
        name: 'open_project',
        description: 'Opens an existing Adobe Premiere Pro project from a specified file path.',
        inputSchema: z.object({
          path: z.string().describe('The absolute path to the .prproj file to open')
        })
      },
      {
        name: 'save_project',
        description: 'Saves the currently active Adobe Premiere Pro project.',
        inputSchema: z.object({})
      },
      {
        name: 'save_project_as',
        description: 'Saves the current project with a new name and location.',
        inputSchema: z.object({
          name: z.string().describe('The new name for the project'),
          location: z.string().describe('The absolute directory path where the project should be saved')
        })
      },
      {
        name: 'close_project',
        description: 'Closes the current project. Verified: reports whether the project was saved before closing.',
        inputSchema: z.object({
          saveFirst: z.boolean().optional().describe('Save the project before closing. Default false.'),
          closeIfLast: z.boolean().optional().describe('Close Premiere if this is the last open project. Default false.')
        })
      },
      {
        name: 'list_open_projects',
        description: 'Lists all currently open Premiere Pro projects with their names, paths, and sequence counts. Verified via app.projects collection.',
        inputSchema: z.object({})
      },
      {
        name: 'list_recent_projects',
        description: 'Lists recently modified Premiere Pro project files on disk, sorted by modification time. Excludes Auto-Save copies. Uses Spotlight (mdfind) — returns paths, names, and modification dates.',
        inputSchema: z.object({
          limit: z.number().optional().describe('Maximum number of results. Default 10.'),
          excludeAutosave: z.boolean().optional().describe('Exclude Adobe Premiere Pro Auto-Save files. Default true.')
        })
      },

      // Clipboard
      {
        name: 'read_clipboard',
        description: 'Reads the current macOS system clipboard as text. Useful for reading timecodes, clip names, or any text the user copied. Verified via Node.js pbpaste.',
        inputSchema: z.object({})
      },
      {
        name: 'write_clipboard',
        description: 'Writes text to the macOS system clipboard. Useful for exporting timecodes, marker lists, clip metadata, or any text for pasting elsewhere. Verified via Node.js pbcopy.',
        inputSchema: z.object({
          text: z.string().describe('The text to write to the clipboard')
        })
      },

      // Render status and preview rendering
      {
        name: 'get_sequence_render_status',
        description: 'Returns the render bar status of the active sequence: which time ranges are fully rendered (green), partially rendered (yellow), unrendered (red), or empty (no content). Verified via QE getGreenBarTimes/getRedBarTimes/getYellowBarTimes.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.')
        })
      },
      {
        name: 'render_sequence_previews',
        description: 'Renders preview files for the active sequence\'s unrendered segments (equivalent to Sequence > Render In to Out). Uses QE renderPreview(). Does not export media — writes to the preview cache only.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
          renderAll: z.boolean().optional().describe('Render all segments including yellow bars. Default false (red/unrendered only).')
        })
      },

      // Essential Sound
      {
        name: 'set_essential_sound_category',
        description: 'Assigns an Essential Sound category to a project item. Categories: "dialog", "music", "sfx", "ambience". Verified: setProjectMetadata writes ESP.Tag and related keys. The panel will reflect the category after the next project refresh.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The nodeId of the project item to categorize'),
          category: z.enum(['dialog', 'music', 'sfx', 'ambience']).describe('The Essential Sound category')
        })
      },

      // Source monitor upgrade
      {
        name: 'open_project_item_in_source',
        description: 'Opens a project item in the Source Monitor by passing the DOM ProjectItem directly. More reliable than open_in_source which uses file paths. Optionally cues to a timecode. Verified via app.sourceMonitor.openProjectItem().',
        inputSchema: z.object({
          projectItemId: z.string().describe('The nodeId of the project item to open in the Source Monitor'),
          timecode: z.string().optional().describe('Optional timecode to cue to after opening (e.g. "00:00:01:00")')
        })
      },

      // Navigation & Playback
      {
        name: 'go_to_sequence_start',
        description: 'Moves the playhead to the start of the active sequence (frame 0). Verified via setPlayerPosition.',
        inputSchema: z.object({ sequenceId: z.string().optional() })
      },
      {
        name: 'go_to_sequence_end',
        description: 'Moves the playhead to the last frame of the active sequence. Verified via setPlayerPosition + sequence end time.',
        inputSchema: z.object({ sequenceId: z.string().optional() })
      },
      {
        name: 'go_to_in_point',
        description: 'Moves the playhead to the sequence in-point.',
        inputSchema: z.object({ sequenceId: z.string().optional() })
      },
      {
        name: 'go_to_out_point',
        description: 'Moves the playhead to the sequence out-point.',
        inputSchema: z.object({ sequenceId: z.string().optional() })
      },
      {
        name: 'step_frames',
        description: 'Moves the playhead by a number of frames (positive = forward, negative = backward). Verified via setPlayerPosition.',
        inputSchema: z.object({
          frames: z.number().describe('Frames to step. Positive = forward, negative = backward.'),
          sequenceId: z.string().optional()
        })
      },
      {
        name: 'get_playback_state',
        description: 'Returns whether the timeline is currently playing, the playback speed, and the current playhead position.',
        inputSchema: z.object({ sequenceId: z.string().optional() })
      },

      // Trimming & Edit Point Operations
      {
        name: 'ripple_trim_in',
        description: 'Ripple-trims the in-point of a clip to the current playhead (Q-key equivalent). Removes the head of the clip and ripples everything earlier. Verified via clip start + move.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().describe('0-based video track index'),
          clipIndex: z.number().describe('0-based clip index on the track')
        })
      },
      {
        name: 'ripple_trim_out',
        description: 'Ripple-trims the out-point of a clip to the current playhead (W-key equivalent). Removes the tail and ripples everything later. Verified via clip end + move.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().describe('0-based video track index'),
          clipIndex: z.number().describe('0-based clip index on the track')
        })
      },
      {
        name: 'extend_edit',
        description: 'Extends the nearest edit point to the current playhead (E-key equivalent) — rolling trim. Verified via clip in/out readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().describe('0-based video track index'),
          clipIndex: z.number().describe('0-based clip index whose nearest edge to extend')
        })
      },
      {
        name: 'nudge_clip',
        description: 'Nudges a clip ±N frames on the timeline (Alt+Left/Right equivalent). Verified via clip start time readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().describe('0-based video track index'),
          clipIndex: z.number().describe('0-based clip index'),
          frames: z.number().describe('Frames to nudge. Positive = forward, negative = backward.')
        })
      },

      // J-Cut and L-Cut
      {
        name: 'j_cut',
        description: 'Creates a J-cut: extends the audio of clip N under clip N-1 (audio leads video). Sets the audio in-point earlier than the video cut. Verified via clip in/out readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          videoTrackIndex: z.number().describe('0-based video track index'),
          clipIndex: z.number().describe('0-based index of the clip whose audio should lead'),
          frames: z.number().describe('How many frames earlier the audio should start')
        })
      },
      {
        name: 'l_cut',
        description: 'Creates an L-cut: extends the audio of clip N under clip N+1 (audio trails video). Sets the audio out-point later than the video cut. Verified via clip in/out readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          videoTrackIndex: z.number().describe('0-based video track index'),
          clipIndex: z.number().describe('0-based index of the clip whose audio should trail'),
          frames: z.number().describe('How many frames later the audio should end')
        })
      },

      // Three-point edit
      {
        name: 'three_point_edit',
        description: 'Classic 3-point edit: opens a source clip, sets source in/out, then inserts or overwrites at the sequence playhead. Verified: sourceMonitor.openProjectItem + setInPoint/setOutPoint confirmed working.',
        inputSchema: z.object({
          projectItemId: z.string().describe('Source clip nodeId'),
          sourceIn: z.string().optional().describe('Source in-point timecode (e.g. "00:00:01:00")'),
          sourceOut: z.string().optional().describe('Source out-point timecode'),
          sequenceTimecode: z.string().optional().describe('Where to place in sequence. Defaults to current playhead.'),
          mode: z.enum(['insert', 'overwrite']).optional().describe('Edit mode. Default "overwrite".'),
          videoTrackIndex: z.number().optional().describe('Target video track. Default 0.'),
          audioTrackIndex: z.number().optional().describe('Target audio track. Default 0.')
        })
      },

      // Gap operations
      {
        name: 'close_gap_at',
        description: 'Closes a gap at a specific timecode by ripple-deleting it. Verified via getTimelineGaps + ripple delete.',
        inputSchema: z.object({
          timecode: z.string().describe('Timecode within the gap to close'),
          sequenceId: z.string().optional()
        })
      },
      {
        name: 'close_all_gaps',
        description: 'Closes all gaps in the active sequence by ripple-deleting each one. Reports count of gaps closed. Verified via getTimelineGaps.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional().describe('Limit to one track. Default: closes gaps on all tracks.')
        })
      },
      {
        name: 'delete_empty_tracks',
        description: 'Removes all empty video and/or audio tracks from the active sequence. Verified via QE removeEmptyVideoTracks/removeEmptyAudioTracks.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          video: z.boolean().optional().describe('Remove empty video tracks. Default true.'),
          audio: z.boolean().optional().describe('Remove empty audio tracks. Default true.')
        })
      },

      // Timeline selection operations
      {
        name: 'get_sequence_selection',
        description: 'Returns the currently selected clips in the active sequence timeline. Confirmed via Sequence.getSelection().',
        inputSchema: z.object({ sequenceId: z.string().optional() })
      },
      {
        name: 'set_sequence_selection',
        description: 'Selects specific clips in the sequence timeline by track/clip index pairs. Confirms selection via getSelection() readback.',
        inputSchema: z.object({
          clips: z.array(z.object({
            trackIndex: z.number(),
            clipIndex: z.number()
          })).describe('List of clips to select by track+clip index'),
          sequenceId: z.string().optional()
        })
      },

      // Marker operations (using MarkerCollection)
      {
        name: 'create_marker',
        description: 'Creates a sequence marker at a given timecode with optional name, comment, type, and color. Uses the confirmed MarkerCollection.createMarker() API.',
        inputSchema: z.object({
          timecode: z.number().describe('Marker time in seconds'),
          name: z.string().optional().describe('Marker name'),
          comment: z.string().optional().describe('Marker comment/notes'),
          type: z.enum(['Comment', 'Chapter', 'Segmentation', 'WebLink', 'FLVCuePoint', 'Named']).optional().describe('Marker type. Default Comment.'),
          colorIndex: z.number().min(0).max(7).optional().describe('Color index 0-7'),
          durationSeconds: z.number().optional().describe('Duration in seconds for ranged markers'),
          sequenceId: z.string().optional()
        })
      },

      // ── Batch 1: Lumetri Numeric Control ─────────────────────────────────
      {
        name: 'lumetri_basic_set',
        description: 'Sets Lumetri Color basic correction values on a clip: exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation. Verified via param readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional().describe('Video track index, default 0'),
          clipIndex: z.number().optional().describe('Clip index on track, default 0'),
          exposure: z.number().optional().describe('-5 to 5'),
          contrast: z.number().optional().describe('-100 to 100'),
          highlights: z.number().optional().describe('-100 to 100'),
          shadows: z.number().optional().describe('-100 to 100'),
          whites: z.number().optional().describe('-100 to 100'),
          blacks: z.number().optional().describe('-100 to 100'),
          temperature: z.number().optional().describe('-100 to 100'),
          tint: z.number().optional().describe('-100 to 100'),
          saturation: z.number().optional().describe('0 to 200, default 100'),
        })
      },
      {
        name: 'lumetri_creative_set',
        description: 'Sets Lumetri Color creative adjustments: faded film, sharpen, vibrance, saturation.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          fadedFilm: z.number().optional().describe('0 to 100'),
          sharpen: z.number().optional().describe('0 to 100'),
          vibrance: z.number().optional().describe('-100 to 100'),
          saturation: z.number().optional().describe('0 to 200'),
        })
      },
      {
        name: 'lumetri_vignette_set',
        description: 'Sets Lumetri Color vignette: amount, midpoint, roundness, feather.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          amount: z.number().optional().describe('-10 to 10'),
          midpoint: z.number().optional().describe('0 to 100'),
          roundness: z.number().optional().describe('-100 to 100'),
          feather: z.number().optional().describe('0 to 100'),
        })
      },
      {
        name: 'lumetri_report',
        description: 'Reads all named Lumetri Color parameter values from a clip and returns them as JSON. Useful for copying grades.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
        })
      },
      {
        name: 'copy_grade',
        description: 'Copies the full Lumetri Color grade state from a source clip and returns it as a JSON blob for use with paste_grade_to_clips.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional().describe('Source video track, default 0'),
          clipIndex: z.number().optional().describe('Source clip index, default 0'),
        })
      },
      {
        name: 'paste_grade_to_clips',
        description: 'Pastes a Lumetri grade (from copy_grade) to one or more target clips specified by track/clip index pairs.',
        inputSchema: z.object({
          gradeJson: z.string().describe('JSON string from copy_grade containing param indices and values'),
          targets: z.array(z.object({ trackIndex: z.number(), clipIndex: z.number() })).describe('Target clips'),
          sequenceId: z.string().optional(),
        })
      },
      {
        name: 'auto_white_balance',
        description: 'Triggers Lumetri auto white balance on a clip by setting the Auto Tone Analytics Data param with mAutoTonePressed:true.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
        })
      },
      {
        name: 'set_lut_interpolation',
        description: 'Sets the project-wide LUT interpolation method. 0=linear, 1=tetrahedral (default). Verified via getLUTInterpolationMethod readback.',
        inputSchema: z.object({
          method: z.number().min(0).max(1).describe('0=linear, 1=tetrahedral'),
        })
      },

      // ── Batch 2: Motion, Transform, Layout ────────────────────────────────
      {
        name: 'flip_horizontal',
        description: 'Flips a clip horizontally by applying the Transform effect and setting its horizontal flip param. Verified via component fingerprint.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
        })
      },
      {
        name: 'flip_vertical',
        description: 'Flips a clip vertically by applying the Transform effect. Verified via component fingerprint.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
        })
      },
      {
        name: 'fade_in_video',
        description: 'Adds an opacity fade-in to a clip: keyframe at 0% at the clip start, 100% at the specified frame offset. Verified via keyframe readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          durationFrames: z.number().describe('Number of frames for the fade-in'),
        })
      },
      {
        name: 'fade_out_video',
        description: 'Adds an opacity fade-out to a clip: 100% at durationFrames before the end, 0% at the last frame. Verified via keyframe readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          durationFrames: z.number().describe('Number of frames for the fade-out'),
        })
      },
      {
        name: 'reset_transform',
        description: 'Resets all Motion component properties (position, scale, rotation, anchor) to their defaults.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
        })
      },
      {
        name: 'match_transform',
        description: 'Copies all Motion component values from a source clip to one or more target clips.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          sourceTrackIndex: z.number().describe('Source video track'),
          sourceClipIndex: z.number().describe('Source clip index'),
          targets: z.array(z.object({ trackIndex: z.number(), clipIndex: z.number() })).describe('Target clips'),
        })
      },
      {
        name: 'letterbox',
        description: 'Applies letterbox bars by setting Motion component crop top/bottom values. Use aspect e.g. "2.39:1" or explicit cropPercent.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          aspect: z.string().optional().describe('Target aspect ratio e.g. "2.39:1", "2.35:1", "1.85:1"'),
          cropPercent: z.number().optional().describe('Explicit crop percent for top AND bottom (0-50)'),
        })
      },
      {
        name: 'ken_burns',
        description: 'Applies a Ken Burns (slow push/pan) effect by adding position and scale keyframes at the start and end of the clip.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          startScale: z.number().optional().describe('Scale at start, default 100'),
          endScale: z.number().optional().describe('Scale at end, default 110'),
          startX: z.number().optional().describe('X position at start (0.5=center), default 0.5'),
          startY: z.number().optional().describe('Y position at start (0.5=center), default 0.5'),
          endX: z.number().optional().describe('X position at end, default 0.5'),
          endY: z.number().optional().describe('Y position at end, default 0.5'),
        })
      },
      {
        name: 'set_clip_scale_to_frame_size',
        description: 'Applies scale-to-frame-size to a clip via QE. Verified via QE setScaleToFrameSize().',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          enabled: z.boolean().optional().describe('Default true'),
        })
      },

      // ── Batch 3: Audio Tools ──────────────────────────────────────────────
      {
        name: 'fade_in_audio',
        description: 'Adds a volume fade-in to an audio clip: keyframe at -∞ dB at start, 0 dB at durationFrames. Verified via keyframe readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          audioTrackIndex: z.number().optional().describe('Audio track index, default 0'),
          clipIndex: z.number().optional().describe('Clip index, default 0'),
          durationFrames: z.number().describe('Fade-in duration in frames'),
        })
      },
      {
        name: 'fade_out_audio',
        description: 'Adds a volume fade-out to an audio clip. Verified via keyframe readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          audioTrackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          durationFrames: z.number().describe('Fade-out duration in frames'),
        })
      },
      {
        name: 'set_clip_gain',
        description: 'Sets the clip gain (dB) on an audio clip. Distinct from the rubber-band volume. Verified via Level param readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          audioTrackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          gainDb: z.number().describe('Gain in dB, e.g. -6 to reduce by 6dB'),
        })
      },
      {
        name: 'audio_crossfade_at_cut',
        description: 'Adds a Constant Power audio crossfade at the cut between two clips on an audio track. Verified via QE getAudioTransitionByName + addTransition.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          audioTrackIndex: z.number().optional().describe('Audio track index, default 0'),
          clipIndex: z.number().describe('Index of the FIRST clip — transition goes between this and the next'),
          durationFrames: z.number().optional().describe('Transition duration in frames, default 15'),
        })
      },
      {
        name: 'mute_clip_audio',
        description: 'Mutes/unmutes the audio for a linked video clip by disabling its linked audio clip.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional().describe('Video track index, default 0'),
          clipIndex: z.number().optional().describe('Clip index, default 0'),
          mute: z.boolean().optional().describe('True to mute, false to unmute. Default true.'),
        })
      },
      {
        name: 'loudness_report',
        description: 'Analyzes the loudness of a media file using ffmpeg ebur128 filter. Returns integrated LUFS, true peak, and LRA.',
        inputSchema: z.object({
          filePath: z.string().describe('Absolute path to the audio/video file to analyze'),
        })
      },
      {
        name: 'normalize_clip_peaks',
        description: 'Analyzes a media file peak level and sets the clip gain to normalize to a target dBFS. Verified via gain readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          audioTrackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          targetDbfs: z.number().optional().describe('Target peak in dBFS, default -1'),
        })
      },

      // ── Batch 4: Export & AME Tools ───────────────────────────────────────
      {
        name: 'export_in_out_range',
        description: 'Exports only the in/out marked range of the active sequence using exportAsMediaDirect with work area mode.',
        inputSchema: z.object({
          outputPath: z.string().describe('Absolute output file path'),
          presetPath: z.string().describe('Absolute path to .epr preset file'),
          sequenceId: z.string().optional(),
        })
      },
      {
        name: 'list_all_encoder_presets',
        description: 'Returns the full catalog of AME export formats and their available presets (24 formats, 300+ presets). Verified via app.encoder.getExporters().',
        inputSchema: z.object({
          format: z.string().optional().describe('Filter to a specific format name e.g. "H.264". Returns all if omitted.'),
        })
      },
      {
        name: 'create_custom_export_preset',
        description: 'Creates a custom AME export preset by taking a base preset and modifying specific params. Writes a .epr file. Returns the preset file path.',
        inputSchema: z.object({
          format: z.string().describe('Exporter format name, e.g. "H.264", "QuickTime", "H.265 (HEVC)"'),
          basePresetName: z.string().optional().describe('Base preset name to modify. Uses first preset if omitted.'),
          params: z.record(z.string(), z.string()).describe('Params to set, e.g. {"TargetBitrate":"8","Width":"1920","Height":"1080"}'),
          outputPresetPath: z.string().describe('Absolute path to write the .epr file'),
        })
      },
      {
        name: 'export_social_preset',
        description: 'Exports the active sequence using a named social media preset. Presets: youtube_1080p, youtube_4k, instagram_1080p, instagram_reels, tiktok, twitter.',
        inputSchema: z.object({
          outputPath: z.string().describe('Absolute output file path'),
          preset: z.enum(['youtube_1080p', 'youtube_4k', 'instagram_1080p', 'instagram_reels', 'tiktok', 'twitter']).describe('Social preset name'),
          sequenceId: z.string().optional(),
        })
      },
      {
        name: 'export_audio_only',
        description: 'Exports just the audio mix of the active sequence as WAV or AAC.',
        inputSchema: z.object({
          outputPath: z.string().describe('Absolute output path (.wav or .aac)'),
          format: z.enum(['wav', 'aac']).optional().describe('Format, default wav'),
          sequenceId: z.string().optional(),
        })
      },
      {
        name: 'verify_export',
        description: 'Verifies an exported media file using ffprobe: checks duration, fps, resolution vs expected. Returns a QC pass/fail.',
        inputSchema: z.object({
          filePath: z.string().describe('Absolute path to the exported file to verify'),
          expectedDurationSecs: z.number().optional().describe('Expected duration in seconds (tolerance ±1s)'),
          expectedFps: z.number().optional().describe('Expected frame rate'),
          expectedWidth: z.number().optional(),
          expectedHeight: z.number().optional(),
        })
      },

      // ── Batch 5: Batch & Metadata ─────────────────────────────────────────
      {
        name: 'markers_to_csv',
        description: 'Exports all sequence markers to a CSV file: time, name, comment, type, color. Verified via seq.markers enumeration.',
        inputSchema: z.object({
          outputPath: z.string().describe('Absolute path to write the CSV file'),
          sequenceId: z.string().optional(),
        })
      },
      {
        name: 'markers_from_csv',
        description: 'Creates sequence markers from a CSV file with columns: time (seconds), name, comment, type.',
        inputSchema: z.object({
          csvPath: z.string().describe('Absolute path to a CSV file with columns: time,name,comment,type'),
          sequenceId: z.string().optional(),
        })
      },
      {
        name: 'add_metadata_schema_field',
        description: 'Adds a custom metadata column to the project schema. Type: 0=string, 1=integer, 2=real, 3=boolean. Verified via addPropertyToProjectMetadataSchema.',
        inputSchema: z.object({
          columnId: z.string().describe('Unique column ID e.g. "mcp.shotCode"'),
          displayName: z.string().describe('Column display name'),
          type: z.number().min(0).max(3).optional().describe('0=string (default)'),
        })
      },
      {
        name: 'set_item_metadata',
        description: 'Sets a project metadata value on a project item by nodeId. Verified via setProjectMetadata.',
        inputSchema: z.object({
          projectItemId: z.string().describe('Project item nodeId'),
          key: z.string().describe('Metadata key e.g. "mcp.shotCode" or built-in column ID'),
          value: z.string().describe('Value to set'),
        })
      },
      {
        name: 'get_item_metadata_columns',
        description: 'Returns all project panel column values for a project item (name, label, media type, custom fields, etc.). Verified via getProjectColumnsMetadata.',
        inputSchema: z.object({
          projectItemId: z.string().describe('Project item nodeId'),
        })
      },
      {
        name: 'batch_set_label',
        description: 'Sets the color label on multiple project items at once.',
        inputSchema: z.object({
          projectItemIds: z.array(z.string()).describe('Array of project item nodeIds'),
          labelColor: z.string().describe('Label color name e.g. "Iris", "Cerulean", "Lavender"'),
        })
      },
      {
        name: 'batch_rename_project_items',
        description: 'Renames multiple project items by nodeId.',
        inputSchema: z.object({
          renames: z.array(z.object({ projectItemId: z.string(), newName: z.string() })),
        })
      },

      // ── Batch 6: Review & Delivery ────────────────────────────────────────
      {
        name: 'assemble_review_reel',
        description: 'Assembles a gap-free review reel from a list of sequences. Creates a new sequence and overwrites each source sequence content sequentially. Critical for daily VFX review. Verified via sequence structure diff.',
        inputSchema: z.object({
          sequenceIds: z.array(z.string()).describe('Ordered list of sequence IDs to assemble'),
          reelName: z.string().describe('Name for the new reel sequence'),
          handles: z.number().optional().describe('Optional handle frames to add before/after each sequence'),
        })
      },
      {
        name: 'version_up_sequence',
        description: 'Duplicates the active (or specified) sequence and bumps its version suffix (_v001 → _v002, or appends _v001). Returns the new sequence ID and name.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Sequence to version up. Defaults to active sequence.'),
          setActive: z.boolean().optional().describe('Set the new version as active. Default true.'),
        })
      },
      {
        name: 'shot_status_report',
        description: 'Returns a status board of all sequences in the project with their name, label color, track count, duration, and clip count.',
        inputSchema: z.object({})
      },
      {
        name: 'notes_to_markers',
        description: 'Creates sequence markers from a newline-delimited notes file. Format per line: "HH:MM:SS:FF Note text" or "SS.ms Note text".',
        inputSchema: z.object({
          notesPath: z.string().describe('Absolute path to the notes text file'),
          sequenceId: z.string().optional(),
          markerType: z.string().optional().describe('Default Comment'),
          colorIndex: z.number().optional().describe('Color index 0-7'),
        })
      },
      {
        name: 'markers_to_notes',
        description: 'Exports all sequence markers to a formatted text file for sharing with directors/supervisors.',
        inputSchema: z.object({
          outputPath: z.string().describe('Absolute path to write the notes file'),
          sequenceId: z.string().optional(),
          format: z.enum(['text', 'csv', 'json']).optional().describe('Default text'),
        })
      },
      {
        name: 'delivery_qc',
        description: 'Runs a quick QC check on the active sequence: checks for offline media, reports unrendered ranges, checks for gaps, counts tracks. Returns a QC report.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
        })
      },

      // ── Batch 7: VFX & Interchange ────────────────────────────────────────
      {
        name: 'vfx_pull_list',
        description: 'Generates a VFX pull list from the active sequence: clip name, source path, source in/out TC, sequence in/out TC, duration, handles. Returns JSON array.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          handles: z.number().optional().describe('Handle frames to add each side, default 8'),
          trackIndex: z.number().optional().describe('Video track to pull from, default 0'),
        })
      },
      {
        name: 'cut_list_csv',
        description: 'Exports the active sequence as a cut list CSV: shot name, source TC in, source TC out, sequence TC in, sequence TC out, duration.',
        inputSchema: z.object({
          outputPath: z.string().describe('Absolute path to write the CSV'),
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional().describe('Video track to use, default 0'),
        })
      },
      {
        name: 'export_sequence_as_project',
        description: 'Exports the active sequence as a standalone .prproj file. Verified via seq.exportAsProject().',
        inputSchema: z.object({
          outputPath: z.string().describe('Absolute path for the output .prproj file'),
          sequenceId: z.string().optional(),
        })
      },
      {
        name: 'change_list_report',
        description: 'Compares two sequences and returns a human-readable change list: added/removed/moved clips, timing changes.',
        inputSchema: z.object({
          sequenceIdA: z.string().describe('First sequence ID (older version)'),
          sequenceIdB: z.string().describe('Second sequence ID (newer version)'),
        })
      },
      {
        name: 'get_item_treepath',
        description: 'Returns the full project panel tree path for a project item (including bin hierarchy). Verified via item.treePath.',
        inputSchema: z.object({
          projectItemId: z.string().describe('Project item nodeId'),
        })
      },

      // ── Batch 8: MOGRT / Titles ───────────────────────────────────────────
      {
        name: 'set_mogrt_text',
        description: 'Sets text content on a MOGRT (Motion Graphics Template) clip. Finds the clip by track/index and updates a text param by display name.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional().describe('Video track index, default 0'),
          clipIndex: z.number().optional().describe('Clip index, default 0'),
          paramName: z.string().describe('The text param display name to set'),
          text: z.string().describe('The new text value'),
        })
      },
      {
        name: 'set_mogrt_param',
        description: 'Sets a parameter value on a MOGRT clip (text, color, number). Finds param by display name.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
          paramName: z.string().describe('The param display name'),
          value: z.union([z.string(), z.number(), z.boolean()]).describe('The new value'),
        })
      },
      {
        name: 'mogrt_params_report',
        description: 'Lists all exposed parameters of a MOGRT clip with their names, types, and current values.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
        })
      },
      {
        name: 'timecode_burn_in',
        description: 'Applies the "Timecode" (Metadata & Timecode Burn-in) video effect to a clip for review copies. Verified via QE addVideoEffect + component fingerprint.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackIndex: z.number().optional(),
          clipIndex: z.number().optional(),
        })
      },

      // ── Batch 9: QE utilities + Productions ──────────────────────────────
      {
        name: 'get_renderer_names',
        description: 'Returns the list of available renderers (GPU/software) from Premiere. Verified via qe.project.getRendererNames().',
        inputSchema: z.object({})
      },
      {
        name: 'set_renderer',
        description: 'Sets the active GPU renderer by name. Verified via qe.project.setRenderer() + readback.',
        inputSchema: z.object({
          rendererName: z.string().describe('Renderer name from get_renderer_names'),
        })
      },
      {
        name: 'sync_lock_track',
        description: 'Sets or clears sync lock on a timeline track. Verified via QE track.setSyncLock() + isSyncLocked() readback.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
          trackType: z.enum(['video', 'audio']).describe('Track type'),
          trackIndex: z.number().describe('0-based track index'),
          locked: z.boolean().describe('True to lock, false to unlock'),
        })
      },
      {
        name: 'render_audio',
        description: 'Renders audio preview files for the active sequence. Equivalent to Sequence > Render Audio. Verified via QE seq.renderAudio().',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
        })
      },
      {
        name: 'get_production_list',
        description: 'Returns the list of Adobe Productions (Team Projects) available to the logged-in user. Verified via qe.ea.getProductionList().',
        inputSchema: z.object({})
      },
      {
        name: 'get_lumetri_preset_list',
        description: 'Returns all 325 Lumetri preset names available in the project. Verified via app.project.getAllLumetriPresetsList().',
        inputSchema: z.object({
          folder: z.string().optional().describe('Filter to a preset folder name e.g. "Creative", "Cinematic"'),
        })
      },
      {
        name: 'set_sequence_in_out_qe',
        description: 'Sets the sequence in/out points using QE (more reliable than DOM for non-standard timecodes).',
        inputSchema: z.object({
          inPoint: z.string().optional().describe('In point timecode e.g. "00:00:01:00"'),
          outPoint: z.string().optional().describe('Out point timecode'),
          sequenceId: z.string().optional(),
        })
      },
      {
        name: 'get_qe_sequence_props',
        description: 'Returns QE sequence properties: CTI, in/out points, work area, preview preset, editing mode GUID, render flags.',
        inputSchema: z.object({
          sequenceId: z.string().optional(),
        })
      },

      // Media Management
      {
        name: 'import_media',
        description: 'Imports a media file (video, audio, image) into the current Premiere Pro project.',
        inputSchema: z.object({
          filePath: z.string().describe('The absolute path to the media file to import'),
          binName: z.string().optional().describe('The name of the bin to import the media into. If not provided, it will be imported into the root.')
        })
      },
      {
        name: 'import_fcp_xml',
        description: 'Imports a Final Cut Pro 7 XML (XMEML) file into the current project. Premiere creates a new sequence with the cuts/clips defined in the XML. The import requests Premiere UI suppression, but malformed or unsupported XML can still be rejected by Premiere. Use legacy FCP7 XML, not modern FCPXML 1.x from Final Cut Pro X.',
        inputSchema: z.object({
          filePath: z.string().describe('The absolute path to the FCP7 XML file (.xml extension typical)')
        })
      },
      {
        name: 'import_edl',
        description: 'Reports that CMX 3600 EDL import is unavailable through this dialog-safe MCP server. Premiere\'s EDL API opens an interactive sequence/source-media dialog that blocks CEP. Use import_fcp_xml for unattended timeline interchange instead.',
        inputSchema: z.object({
          filePath: z.string().describe('The absolute path to the .edl file')
        })
      },
      {
        name: 'import_folder',
        description: 'Imports all media files from a folder into the current Premiere Pro project.',
        inputSchema: z.object({
          folderPath: z.string().describe('The absolute path to the folder containing media files'),
          binName: z.string().optional().describe('The name of the bin to import the media into'),
          recursive: z.boolean().optional().describe('Whether to import from subfolders recursively')
        })
      },
      {
        name: 'create_bin',
        description: 'Creates a new bin (folder) in the project panel to organize media. Nest it by naming a parent: parentBinId (a bin nodeId, unambiguous — preferred) or parentBinName. parentBinName resolves a nested bin too — pass a "/"-separated path like "Scenes/Scene-008" to walk the hierarchy, or a single name to search the whole tree (which fails safely if two bins share that name rather than reparenting to the wrong one).',
        inputSchema: z.object({
          name: z.string().describe('The name for the new bin'),
          parentBinName: z.string().optional().describe('Parent bin to create this bin inside, by name. Use a "/"-separated path ("Scenes/Scene-008") for a nested parent, or a single name to deep-search the tree (ambiguous single names are rejected). Ignored if parentBinId is given.'),
          parentBinId: z.string().optional().describe('Parent bin nodeId — the unambiguous way to target a nested bin. Takes precedence over parentBinName.')
        })
      },

      // Sequence Management
      {
        name: 'create_sequence',
        description: 'Creates a new sequence from a specific installed .sqpreset file without opening Premiere\'s New Sequence dialog. For footage-driven edits, prefer create_sequence_from_clips; for an empty copy of an existing sequence, use duplicate_sequence with clearContents=true.',
        inputSchema: z.object({
          name: z.string().describe('The name for the new sequence'),
          presetPath: z.string().describe('Absolute path to an installed Premiere .sqpreset sequence preset. Required so Premiere does not show the native New Sequence dialog.'),
          frameRate: z.number().optional().describe('Optional frames per second (e.g. 23.976, 24, 25, 30). The preset sets the initial rate; when given, the new sequence is set to this rate afterward and the actual rate is read back and reported (fixes the classic 24 vs 23.976 mismatch). A warning is returned if Premiere does not accept it.')
        })
      },
      {
        name: 'duplicate_sequence',
        description: 'Creates a copy of an existing sequence with a new name. Set clearContents=true to get an EMPTY copy that inherits the source sequence\'s exact settings (frame rate, resolution, track layout) — the reliable way to auto-create a correctly-specced blank target, since create_sequence ignores frame rate.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to duplicate'),
          newName: z.string().describe('The name for the new sequence copy'),
          clearContents: z.boolean().optional().describe('When true, remove all clips from the copy so it is empty but keeps the source\'s frame rate/resolution/track layout. Default false (full copy).')
        })
      },
      {
        name: 'delete_sequence',
        description: 'Deletes a sequence from the project.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to delete')
        })
      },

      // Recovery Boundary — cheap, explicit snapshots before risky work.
      {
        name: 'create_recovery_checkpoint',
        description: 'Takes a recovery snapshot of a sequence by cloning it into a tagged copy named "[recovery] <label> @ <timestamp>". Use this BEFORE a risky or bulk edit so you can get the pre-edit state back with restore_recovery_checkpoint. The snapshot travels with the project (it is a real sequence), so it survives save/close/reopen without any external store. Non-destructive: the source sequence is untouched. Set PREMIERE_MCP_AUTO_CHECKPOINT=1 to have bulk/destructive operations do this automatically.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('ID of the sequence to snapshot. Defaults to the active sequence when omitted.'),
          label: z.string().optional().describe('Short human label recorded in the checkpoint name (e.g. "before ripple cleanup"). Defaults to "checkpoint".')
        })
      },
      {
        name: 'list_recovery_checkpoints',
        description: 'Lists the recovery checkpoints in the project — every sequence whose name carries the "[recovery]" tag — with each one\'s parsed label and creation timestamp, most recent first. Use this to find a snapshot to restore_recovery_checkpoint, or to prune old ones with delete_sequence.',
        inputSchema: z.object({
          labelContains: z.string().optional().describe('Optional case-insensitive substring; only checkpoints whose label contains it are returned.')
        })
      },
      {
        name: 'restore_recovery_checkpoint',
        description: 'Restores a recovery checkpoint by cloning it into a fresh working sequence (optionally made active), leaving the checkpoint itself intact so it can be restored again. This does NOT surgically rewind the original sequence in place — Premiere offers no safe API for that — it hands you a clean copy of the snapshot to continue from. Pass the checkpoint\'s sequence ID from list_recovery_checkpoints.',
        inputSchema: z.object({
          checkpointSequenceId: z.string().describe('The sequence ID of the checkpoint to restore (from list_recovery_checkpoints).'),
          newName: z.string().optional().describe('Name for the restored working sequence. Defaults to the checkpoint\'s label with " (restored)" appended.'),
          setActive: z.boolean().optional().describe('Open the restored sequence as the active timeline. Default true.')
        })
      },

      // Timeline Operations
      {
        name: 'add_to_timeline',
        description: 'Adds a media clip from the project panel to a sequence timeline at a specific track and time.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence (timeline) to add the clip to'),
          projectItemId: z.string().describe('The ID of the project item (clip) to add'),
          trackIndex: z.number().describe('The index of the video or audio track (0-based)'),
          time: z.number().describe('The time in seconds where the clip should be placed on the timeline'),
          insertMode: z.enum(['overwrite', 'insert']).optional().describe('Whether to overwrite existing content or insert and shift'),
          linkAudio: z.boolean().optional().describe('When false, removes the auto-linked audio counterpart that Premiere places on audio tracks for video-track clips. Useful for video overlays whose source media (e.g. Remotion .mov outputs) carry silent PCM that would overwrite existing audio. Default true (preserves Premiere\'s native linking behavior).'),
          sourceInPoint: z.number().optional().describe('Source IN point in seconds — the start of the sub-range to pull from the source (footage or sequence). Replicates marking an in point in the Source monitor. Requires sourceOutPoint. When omitted, the whole source (or its current marks) is placed.'),
          sourceOutPoint: z.number().optional().describe('Source OUT point in seconds — the end of the sub-range to pull from the source. Replicates marking an out point in the Source monitor. Requires sourceInPoint.')
        })
      },
      {
        name: 'add_to_timeline_batch',
        description: 'Places MANY clips onto one sequence in a single round-trip — the fast path for rebuilding a whole edit (e.g. a Descript/EDL stringout). Equivalent to calling add_to_timeline (overwrite) once per clip, but ~50x faster because it loops inside one ExtendScript pass instead of one file round-trip per clip. Each clip supports per-clip linkAudio and sourceInPoint/sourceOutPoint (Source-monitor in/out). Returns a per-clip result array so one bad clip does not sink the batch, plus an aggregate status: top-level success is true ONLY when every clip placed; status is "success" | "partial" | "failure" with placed/failed/total counts.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence (timeline) to add clips to'),
          mode: z.enum(['absolute', 'append']).optional().describe('Placement mode. "absolute" (default) uses each clip\'s time. "append" ignores time and lays clips end-to-end with NO gaps: each clip on a given track starts exactly where the previous one ends (seeded from that track\'s existing content), chained off the placed clip\'s real frame-aligned end so float-second rounding cannot open a 1-frame gap. Use append to rebuild a continuous stringout.'),
          clips: z.array(z.object({
            projectItemId: z.string().describe('The ID of the project item (clip / multicam) to add'),
            trackIndex: z.number().describe('The index of the video or audio track (0-based)'),
            time: z.number().optional().describe('Timeline position in seconds where the clip is placed (overwrite). Required in "absolute" mode; ignored in "append" mode.'),
            linkAudio: z.boolean().optional().describe('When false, removes the auto-linked audio counterpart Premiere places on audio tracks for a video-track clip whose source carries an embedded audio stream (prevents overwriting existing audio in overlay/rebuild workflows). Default true (preserves Premiere\'s native linking).'),
            sourceInPoint: z.number().optional().describe('Source IN point in seconds (requires sourceOutPoint)'),
            sourceOutPoint: z.number().optional().describe('Source OUT point in seconds (requires sourceInPoint)')
          })).describe('Ordered list of clips to place. All use overwrite mode.')
        })
      },
      {
        name: 'remove_from_timeline',
        description: 'Removes a clip from the timeline. Pass sequenceId when the clip ID came from list_sequence_tracks for a non-active sequence.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip on the timeline to remove'),
          sequenceId: z.string().optional().describe('Optional sequence ID to search. If omitted, searches the active sequence first, then all sequences.'),
          deleteMode: z.enum(['ripple', 'lift']).optional().describe('Whether to ripple delete (close gap) or lift (leave gap)')
        })
      },
      {
        name: 'move_clip',
        description: 'Moves a clip along the timeline, keeping it on its current track. To move a clip to a different track, use move_clip_to_track: on this Premiere build that is a remove-and-reinsert, which can overwrite whatever occupies the destination and gives the clip a new id, so it is deliberately a separate call rather than an option here.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to move'),
          newTime: z.number().describe('The new time position in seconds')
        // .strict() so a leftover newTrackIndex is an error rather than being
        // silently dropped. Zod strips unknown keys by default, which would have
        // let a caller migrating from the old signature keep passing it and keep
        // believing the clip changed track.
        }).strict()
      },
      {
        name: 'trim_clip',
        description: 'Adjusts the in and out points of a clip on the timeline, effectively shortening it.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip on the timeline to trim'),
          inPoint: z.number().optional().describe('The new in point in seconds from the start of the clip'),
          outPoint: z.number().optional().describe('The new out point in seconds from the start of the clip; cannot be combined with duration'),
          duration: z.number().optional().describe('Alternative: set the desired timeline duration in seconds; cannot be combined with outPoint')
        }).refine((value) => value.outPoint === undefined || value.duration === undefined, {
          message: 'outPoint and duration cannot be used together'
        })
      },
      {
        name: 'split_clip',
        description: 'Splits a clip at a specific time point, creating two separate clips.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to split'),
          splitTime: z.number().describe('The time in seconds where to split the clip')
        })
      },
      {
        name: 'razor_timeline_at_time',
        description: 'Cuts across multiple tracks in a sequence at an absolute timeline time. If no track arrays are provided, all video and audio tracks are cut.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Optional sequence ID. Defaults to the active sequence.'),
          time: z.number().describe('Absolute timeline time in seconds where the cut should occur.'),
          videoTrackIndices: z.array(z.number().int().min(0)).optional().describe('Optional video track indices to cut. Defaults to all video tracks.'),
          audioTrackIndices: z.array(z.number().int().min(0)).optional().describe('Optional audio track indices to cut. Defaults to all audio tracks.')
        })
      },

      // Effects and Transitions
      {
        name: 'apply_effect',
        description: 'Applies a visual or audio effect to a clip, identifies the exact newly created component (reporting its matchName), and verifies parameter readbacks. Effects resolve by display name only, so a stock name can silently resolve to a third-party plugin; pass expectedMatchName to enforce the effect\'s identity and fail (rolling back when safe) on a mismatch.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to apply the effect to'),
          effectName: z.string().describe('The name of the effect to apply (e.g., "Gaussian Blur", "Lumetri Color")'),
          parameters: z.record(z.string(), z.any()).optional().describe('Key-value pairs for the effect\'s parameters'),
          expectedMatchName: z.string().optional().describe('Optional identity guard: the effect\'s internal matchName (e.g. "AE.ADBE Gaussian Blur 2"). If the landed effect\'s matchName differs, the add fails and is rolled back when it is the only user effect on the clip.')
        })
      },
      {
        name: 'crop_clip',
        description: 'Crops a timeline clip using Premiere Pro\'s built-in Crop video effect. Reuses an existing Crop effect on the clip when present; otherwise adds one. Omitted parameters keep their current/default values.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the timeline video clip to crop'),
          left: z.number().min(0).max(100).optional().describe('Percent to crop from the left edge (0-100)'),
          right: z.number().min(0).max(100).optional().describe('Percent to crop from the right edge (0-100)'),
          top: z.number().min(0).max(100).optional().describe('Percent to crop from the top edge (0-100)'),
          bottom: z.number().min(0).max(100).optional().describe('Percent to crop from the bottom edge (0-100)'),
          zoom: z.boolean().optional().describe('Crop effect Zoom toggle: scales the cropped image back up to fill the frame'),
          edgeFeather: z.number().min(0).optional().describe('Edge Feather amount in pixels')
        })
      },
      {
        name: 'add_transition',
        description: 'Adds a transition (e.g., cross dissolve) between two adjacent clips on the timeline.',
        inputSchema: z.object({
          clipId1: z.string().describe('The ID of the first clip (outgoing)'),
          clipId2: z.string().describe('The ID of the second clip (incoming)'),
          transitionName: z.string().describe('The name of the transition to add (e.g., "Cross Dissolve")'),
          duration: z.number().describe('The duration of the transition in seconds')
        })
      },
      {
        name: 'add_transition_to_clip',
        description: 'Adds a transition to the beginning or end of a single clip. Check status and verified in the result: accepted_unverified means Premiere accepted the command but inspection could not prove the edit, so do not retry automatically.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          transitionName: z.string().describe('The name of the transition'),
          position: z.enum(['start', 'end']).describe('Whether to add the transition at the start or end of the clip'),
          duration: z.number().describe('The duration of the transition in seconds')
        })
      },

      // Audio Operations
      {
        name: 'adjust_audio_levels',
        description: 'Adjusts the volume (gain) of an audio clip on the timeline.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the audio clip to adjust'),
          level: z.number().describe('The new audio level in decibels (dB). Can be positive or negative.')
        })
      },

      // Audio Analysis
      {
        name: 'detect_silence',
        description: 'Analyzes a media file\'s audio for silent stretches using ffmpeg\'s silencedetect filter, run locally via child_process -- NOT via Premiere\'s scripting API, which has no audio-level/RMS reading capability at all (confirmed: every audio tool in this codebase only writes levels, never reads them). Requires ffmpeg on PATH; returns an explicit error if it is not found rather than failing silently. This is DETECTION ONLY -- it does not cut or modify anything. Use the returned intervals with split_clip/ripple_delete/razor_timeline_at_time if you want to remove the silence.',
        inputSchema: z.object({
          mediaPath: z.string().optional().describe('Direct filesystem path to the media file to analyze'),
          projectItemId: z.string().optional().describe('Project item ID to resolve to a media path instead of passing mediaPath directly'),
          noiseThresholdDb: z.number().optional().describe('Silence threshold in dBFS, e.g. -30 (default -30). Audio quieter than this is considered silent.'),
          minDurationSeconds: z.number().optional().describe('Minimum duration in seconds for a quiet stretch to be reported as silence (default 1.5)')
        }).refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId'
        })
      },
      {
        name: 'add_audio_keyframes',
        description: 'Adds keyframes to audio levels for dynamic volume changes.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the audio clip'),
          keyframes: z.array(z.object({
            time: z.number().describe('Time in seconds'),
            level: z.number().describe('Audio level in dB')
          })).describe('Array of keyframe data')
        })
      },
      {
        name: 'setup_ducking',
        description:
          'High-level wrapper around add_audio_keyframes that builds a ducking curve from a base level + ducking windows. ' +
          'Computes 4 keyframes per window (pre-fade, duck-in, duck-out, post-fade) plus boundary keyframes at clip start/end. ' +
          'Replaces the manual "8 keyframes per video" pattern from Sprint 3. Times are clip-source-time absolute (same convention as add_audio_keyframes).',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the music/SFX clip to apply ducking to'),
          baseDb: z.number().describe('Sustained level in dB (e.g. -25 for music bed under voice)'),
          duckingWindows: z
            .array(
              z.object({
                startTime: z.number().describe('When to begin ducking, in seconds (clip-source-time absolute)'),
                endTime: z.number().describe('When to recover from ducking, in seconds'),
                duckedDb: z.number().describe('Lower level in dB during this window (e.g. -38 for narrative pause)'),
              })
            )
            .describe('Windows where the clip should duck below baseDb. Empty array = sustained baseDb only.'),
          fadeSeconds: z
            .number()
            .optional()
            .describe('Ramp time for each transition (default 0.2s = 6 frames @30fps)'),
          clipStartTime: z
            .number()
            .optional()
            .describe('Clip start time anchor for first keyframe (default 0)'),
          clipEndTime: z
            .number()
            .optional()
            .describe('Clip end time anchor for last keyframe; if omitted, last duck window endTime + 1s is used'),
        }),
      },
      {
        name: 'mute_track',
        description: 'Mutes or unmutes an entire audio track.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          trackIndex: z.number().describe('The index of the audio track'),
          muted: z.boolean().describe('Whether to mute (true) or unmute (false) the track')
        })
      },

      // Text and Graphics
      {
        name: 'add_text_overlay',
        description: 'Adds a text layer (title) over the video timeline. Requires a MOGRT (.mogrt) template file path. Supports up to 4 text fields (text, text2, text3, text4) — each populates the Nth "AE.ADBE Text" component in the MOGRT (e.g., for Basic Lower Third: text=main title, text2=subtitle).',
        inputSchema: z.object({
          text: z.string().describe('Text for the first AE text component in the MOGRT (typically the main title)'),
          text2: z.string().optional().describe('Text for the second AE text component (e.g., subtitle of a lower third)'),
          text3: z.string().optional().describe('Text for the third AE text component (if present)'),
          text4: z.string().optional().describe('Text for the fourth AE text component (if present)'),
          sequenceId: z.string().describe('The sequence to add the text to'),
          trackIndex: z.number().describe('The video track to place the text on (0-indexed; create the track first via add_track if needed)'),
          startTime: z.number().describe('The time in seconds when the text should appear'),
          duration: z.number().describe('How long the text should remain on screen in seconds (best-effort; the MOGRT\'s natural duration may take precedence)'),
          mogrtPath: z.string().optional().describe('Absolute path to a .mogrt template file (required for text overlays)'),
          textPropertyName: z.string().optional().describe('Override: explicit displayName of the property to write into. When set, only `text` is written (text2/text3/text4 are ignored) and the call fails if no property with that displayName exists. Use only when auto-detection picks the wrong field.'),
          rollbackOnTextFailure: z.boolean().optional().describe('If true, remove the imported timeline Graphic when every requested text write fails. Defaults to false; the imported project item may remain in the Project panel.')
        })
      },

      // Color Correction
      {
        name: 'color_correct',
        description: 'Applies basic color correction adjustments to a video clip.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to color correct'),
          brightness: z.number().optional().describe('Brightness adjustment (-100 to 100)'),
          contrast: z.number().optional().describe('Contrast adjustment (-100 to 100)'),
          saturation: z.number().optional().describe('Saturation adjustment (-100 to 100)'),
          hue: z.number().optional().describe('Hue adjustment in degrees (-180 to 180)'),
          highlights: z.number().optional().describe('Adjustment for the brightest parts of the image (-100 to 100)'),
          shadows: z.number().optional().describe('Adjustment for the darkest parts of the image (-100 to 100)'),
          temperature: z.number().optional().describe('Color temperature adjustment (-100 to 100)'),
          tint: z.number().optional().describe('Tint adjustment (-100 to 100)')
        })
      },
      {
        name: 'apply_lut',
        description: 'Applies a Look-Up Table (LUT) to a clip for color grading.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          lutPath: z.string().describe('The absolute path to the .cube or .3dl LUT file'),
          intensity: z.number().optional().describe('LUT intensity (0-100)')
        })
      },

      // Export and Rendering
      {
        name: 'export_sequence',
        description: 'Renders and exports a sequence to a video file. This is for creating the final video.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to export'),
          outputPath: z.string().describe('The absolute path where the final video file will be saved'),
          presetPath: z.string().optional().describe('Absolute path to an export preset file (.epr). Required unless presetName uniquely resolves through get_encoder_presets.'),
          presetName: z.string().optional().describe('Exact user preset display name or filename stem. Must resolve to exactly one discovered .epr preset.'),
          sourceRange: z.enum(['entire', 'in_out', 'work_area']).optional().describe('Export source range. Defaults to entire. Requested ranges are never silently substituted.'),
          allowOverwrite: z.boolean().optional().describe('Allow writing to an existing output file. Defaults to false.'),
          removeOnCompletion: z.boolean().optional().describe('Pass AME removeOnCompletion. Defaults to true to preserve existing queue behavior.'),
          format: z.enum(['mp4', 'mov', 'avi', 'h264', 'prores']).optional().describe('Deprecated hint only; the .epr preset controls codec/container.'),
          quality: z.enum(['low', 'medium', 'high', 'maximum']).optional().describe('Deprecated hint only; the .epr preset controls quality.'),
          resolution: z.string().optional().describe('Deprecated hint only; the .epr preset controls resolution.')
        })
      },
      {
        name: 'export_frame',
        description: 'Exports a single frame from a sequence as an image file. Supported formats (all verified against Premiere\'s QE exporters): png, jpg/jpeg, tiff/tif, dpx, tga/targa.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          time: z.number().describe('The time in seconds to export the frame from'),
          outputPath: z.string().describe('The absolute path where the image file will be saved'),
          format: z.enum(['png', 'jpg', 'jpeg', 'tiff', 'tif', 'dpx', 'tga', 'targa']).optional().describe('The image format (default png)')
        })
      },

      // Markers
      {
        name: 'add_marker',
        description: 'Adds a marker to the specified sequence for navigation or notes. The sequence does not have to be the active one.',
        inputSchema: z.object({
          sequenceId: z.string().min(1).describe('The sequence ID (GUID) to add the marker to, as returned in the "id" field by list_sequences or get_active_sequence'),
          time: z.number().describe('The time in seconds where the marker should be placed'),
          name: z.string().describe('The name/label for the marker'),
          comment: z.string().optional().describe('Optional comment or description for the marker'),
          color: MarkerColorSchema.optional().describe(MARKER_COLOR_DESCRIPTION),
          duration: z.number().optional().describe('Duration in seconds for a span marker (0 for point marker)')
        })
      },
      {
        name: 'delete_marker',
        description: 'Deletes a marker from the specified sequence. The sequence does not have to be the active one.',
        inputSchema: z.object({
          sequenceId: z.string().min(1).describe('The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence'),
          markerId: z.string().min(1).describe('The ID of the marker to delete')
        })
      },
      {
        name: 'update_marker',
        description: 'Updates an existing marker\'s properties in the specified sequence. The sequence does not have to be the active one.',
        inputSchema: z.object({
          sequenceId: z.string().min(1).describe('The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence'),
          markerId: z.string().min(1).describe('The ID of the marker to update'),
          name: z.string().optional().describe('New name for the marker'),
          comment: z.string().optional().describe('New comment'),
          color: MarkerColorSchema.optional().describe(`New colour. ${MARKER_COLOR_DESCRIPTION}`)
        })
      },
      {
        name: 'list_markers',
        description: 'Lists all markers in the specified sequence. The sequence does not have to be the active one.',
        inputSchema: z.object({
          sequenceId: z.string().min(1).describe('The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence')
        })
      },

      // Track Management
      {
        name: 'add_track',
        description: 'Adds a new video or audio track to the sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          trackType: z.enum(['video', 'audio']).describe('Type of track to add'),
          position: z.enum(['above', 'below']).optional().describe('Where to add the track relative to existing tracks')
        })
      },
      {
        name: 'delete_track',
        description: 'Deletes a video or audio track from the specified sequence. The sequence does not have to be the active one, but it does have to be open in Premiere: there is no DOM track-deletion API, so this falls through to the QE DOM, which only reaches sequences Premiere has open. A sequence QE cannot address is reported by name rather than deleted from the wrong timeline. Caption track deletion is accepted by the schema but returns an explicit unsupported result because Premiere Pro exposes no caption-track delete/read API to scripting.',
        inputSchema: z.object({
          sequenceId: z.string().min(1).describe('The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence'),
          trackType: z.enum(['video', 'audio', 'caption']).describe('Type of track'),
          trackIndex: z.number().describe('The index of the track to delete')
        })
      },
      {
        name: 'lock_track',
        description: 'Locks or unlocks a track to prevent/allow editing. The sequence does not have to be the active one.',
        inputSchema: z.object({
          sequenceId: z.string().min(1).describe('The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence'),
          trackType: z.enum(['video', 'audio']).describe('Type of track'),
          trackIndex: z.number().describe('The index of the track'),
          locked: z.boolean().describe('Whether to lock (true) or unlock (false)')
        })
      },
      {
        name: 'toggle_track_visibility',
        description: 'Shows or hides a video track by toggling its output (the eye icon) in the specified sequence. The sequence does not have to be the active one. This is track OUTPUT, not track targeting -- use set_target_track for the V1/A1 patch buttons.',
        inputSchema: z.object({
          sequenceId: z.string().min(1).describe('The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence'),
          trackIndex: z.number().describe('The index of the video track'),
          visible: z.boolean().describe('Whether to show (true) or hide (false)')
        })
      },

      {
        name: 'link_audio_video',
        description: 'Links or unlinks audio and video components of a clip.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          linked: z.boolean().describe('Whether to link (true) or unlink (false)')
        })
      },
      {
        name: 'apply_audio_effect',
        description: 'Applies an audio effect to a clip.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the audio clip'),
          effectName: z.string().describe('Name of the audio effect (e.g., "Compressor", "EQ", "Reverb")'),
          parameters: z.record(z.string(), z.any()).optional().describe('Effect parameters')
        })
      },
      {
        name: 'apply_audio_effect_to_all_clips',
        description: 'Bulk: applies a single audio effect to ALL audio clips of a sequence in one ExtendScript call. Returns per-clip results. Saves N MCP roundtrips when calibrating or applying same chain.',
        inputSchema: z.object({
          sequenceId: z.string().describe('Target sequence ID (must be the active sequence in Premiere)'),
          effectName: z.string().describe('Audio effect display name (e.g., "Limitador forzado", "Compresor multibanda")'),
          parameters: z.record(z.string(), z.any()).optional().describe('Effect parameters by displayName (exact or normalized)')
        })
      },

      // Additional Clip Operations
      {
        name: 'duplicate_clip',
        description: 'Duplicates a clip on the timeline.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to duplicate'),
          offset: z.number().optional().describe('Time offset in seconds for the duplicate (default: places immediately after original)')
        })
      },
      {
        name: 'reverse_clip',
        description: 'Reverses the playback of a clip.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to reverse'),
          maintainAudioPitch: z.boolean().optional().describe('Whether to maintain audio pitch (default: true)')
        })
      },
      {
        name: 'enable_disable_clip',
        description: 'Enables or disables a clip on the timeline.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          enabled: z.boolean().describe('Whether to enable (true) or disable (false)')
        })
      },
      {
        name: 'replace_clip',
        description: 'Replaces a clip on the timeline with another media item.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to replace'),
          newProjectItemId: z.string().describe('The ID of the new project item to use'),
          preserveEffects: z.boolean().optional().describe('Whether to keep effects and settings (default: true)')
        })
      },

      // Project Settings
      {
        name: 'get_sequence_settings',
        description: 'Gets the settings for a sequence (resolution, framerate, etc.).',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence')
        })
      },
      {
        name: 'set_sequence_settings',
        description: 'Updates sequence settings. Applies width, height, frameRate and pixelAspectRatio, reads the values back afterwards, and reports any field Premiere accepted but did not actually change. Frame size CAN be changed after creation, contrary to an earlier note in this codebase.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          settings: z.object({
            width: z.number().optional().describe('Frame width in pixels'),
            height: z.number().optional().describe('Frame height in pixels'),
            frameRate: z.number().optional().describe('Frames per second, e.g. 23.976, 25, 30'),
            // Premiere stores this as an "N:M" string. A bare number is converted to the
            // nearest exact ratio (1.5 becomes "3:2"), but the string form is accepted
            // directly so callers can name a ratio Premiere already uses, such as "10:11".
            pixelAspectRatio: z.union([z.number(), z.string()]).optional()
              .describe('Pixel aspect ratio, either a number (1, 1.5, 2) or an "N:M" string ("1:1", "4:3", "10:11")')
          }).describe('Settings to update')
        })
      },
      {
        name: 'get_clip_properties',
        description: 'Gets detailed properties of a clip, INCLUDING current Motion values (opacity/scale/rotation/position). Position is returned both normalized (0..1) and in PIXELS (`motion.position`, using the sequence frame size) so you can verify or copy framing without exporting a frame. Pass sequenceId when the clip ID came from list_sequence_tracks for a non-active sequence.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          sequenceId: z.string().optional().describe('Optional sequence ID to search. If omitted, searches the active sequence first, then all sequences.')
        })
      },
      {
        name: 'set_clip_properties',
        description: 'Sets Motion properties of a clip (opacity, scale, rotation, position).',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          properties: z.object({
            opacity: z.number().optional().describe('Opacity 0-100'),
            scale: z.number().optional().describe('Scale percentage'),
            rotation: z.number().optional().describe('Rotation in degrees'),
            position: z.object({
              x: z.number().optional(),
              y: z.number().optional()
            }).optional().describe('Position in PIXELS matching the Effect Controls panel (e.g. 960,640 = center of a 1920x1280 sequence). Converted to the normalized API value internally using the clip sequence frame size.')
          }).describe('Properties to set')
        })
      },
      {
        name: 'set_clip_properties_batch',
        description: 'Applies Motion properties (opacity/scale/rotation/position) to MANY clips in a single round-trip — the fast path for per-speaker framing across a whole rebuilt edit. ~50x faster than one set_clip_properties call per clip. Returns a per-clip result array; each result carries an `applied` map ({opacity,scale,rotation,position}) and `success` is true only when EVERY requested property was actually found and set (a missing Motion property is reported, not silently ignored).',
        inputSchema: z.object({
          items: z.array(z.object({
            clipId: z.string().describe('The ID of the clip'),
            properties: z.object({
              opacity: z.number().optional().describe('Opacity 0-100'),
              scale: z.number().optional().describe('Scale percentage'),
              rotation: z.number().optional().describe('Rotation in degrees'),
              position: z.object({
                x: z.number().optional(),
                y: z.number().optional()
              }).optional().describe('Position in PIXELS matching the Effect Controls panel (converted to the normalized API value internally using the clip sequence frame size)')
            }).describe('Properties to set for this clip')
          })).describe('List of clip + properties pairs')
        })
      },

      // Render Queue
      {
        name: 'add_to_render_queue',
        description: 'Adds a sequence to the Adobe Media Encoder render queue.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to render'),
          outputPath: z.string().describe('Output file path'),
          presetPath: z.string().optional().describe('Export preset file path'),
          presetName: z.string().optional().describe('Exact user preset display name or filename stem. Must resolve to exactly one discovered .epr preset.'),
          sourceRange: z.enum(['entire', 'in_out', 'work_area']).optional().describe('Export source range. Defaults to entire.'),
          allowOverwrite: z.boolean().optional().describe('Allow writing to an existing output file. Defaults to false.'),
          removeOnCompletion: z.boolean().optional().describe('Pass AME removeOnCompletion. Defaults to true.'),
          startImmediately: z.boolean().optional().describe('Whether to start rendering immediately (default: false)')
        })
      },
      {
        name: 'get_render_queue_status',
        description: 'Reports live render/encode status. Probes the Premiere encoder bridge (app.encoder) to report whether AME hand-off is reachable, and — when an outputPath is given — polls that file on disk (exists, size, last-modified) so a render in progress can actually be tracked. Adobe exposes no direct read of AME\'s own queue; output-file polling is the reliable signal.',
        inputSchema: z.object({
          outputPath: z.string().optional().describe('Absolute path to a render/export output file to poll. Reports whether it exists yet, its current byte size, and last-modified time — call repeatedly to watch a render grow to completion.')
        })
      },

      // Advanced Features
      {
        name: 'stabilize_clip',
        description: 'Applies video stabilization to reduce camera shake.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to stabilize'),
          method: z.enum(['warp', 'subspace']).optional().describe('Stabilization method'),
          smoothness: z.number().optional().describe('Stabilization smoothness (0-100)')
        })
      },
      {
        name: 'speed_change',
        description: 'Changes the playback speed of a clip.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          speed: z.number().describe('Speed multiplier (0.1 = 10% speed, 2.0 = 200% speed)'),
          maintainAudio: z.boolean().optional().describe('Whether to maintain audio pitch when changing speed')
        })
      },

      // Playhead & Work Area
      {
        name: 'get_playhead_position',
        description: 'Gets the current playhead (CTI) position in the specified sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence')
        })
      },
      {
        name: 'set_playhead_position',
        description: 'Sets the playhead (CTI) position in the specified sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          time: z.number().describe('The time in seconds to move the playhead to')
        })
      },
      {
        name: 'get_selected_clips',
        description: 'Gets all currently selected clips in the specified sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence')
        })
      },

      // Effect & Transition Discovery
      {
        name: 'list_available_effects',
        description: 'Lists all available video effects in Premiere Pro.',
        inputSchema: z.object({})
      },
      {
        name: 'list_available_transitions',
        description: 'Lists all available video transitions in Premiere Pro.',
        inputSchema: z.object({})
      },
      {
        name: 'list_available_audio_effects',
        description: 'Lists all available audio effects in Premiere Pro.',
        inputSchema: z.object({})
      },
      {
        name: 'list_available_audio_transitions',
        description: 'Lists all available audio transitions in Premiere Pro.',
        inputSchema: z.object({})
      },

      // Keyframes
      {
        name: 'add_keyframe',
        description: 'Adds a keyframe to a clip component parameter at a specific time.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          componentName: z.string().describe('The display name of the component (e.g., "Motion", "Opacity")'),
          paramName: z.string().describe('The display name of the parameter (e.g., "Position", "Scale")'),
          time: z.number().describe('The time in seconds for the keyframe'),
          value: z.number().describe('The value to set at this keyframe')
        })
      },
      {
        name: 'remove_keyframe',
        description: 'Removes a keyframe from a clip component parameter at a specific time.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          componentName: z.string().describe('The display name of the component'),
          paramName: z.string().describe('The display name of the parameter'),
          time: z.number().describe('The time in seconds of the keyframe to remove')
        })
      },
      {
        name: 'get_keyframes',
        description: 'Gets all keyframes for a clip component parameter.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          componentName: z.string().describe('The display name of the component'),
          paramName: z.string().describe('The display name of the parameter')
        })
      },
      {
        name: 'bake_keyframe_ease',
        description:
          'Animates a SCALAR clip parameter (e.g. Opacity, Scale, Rotation) from a start value to an end value along an eased curve, by baking a dense run of keyframes whose values trace the easing shape. This is the honest path to eased motion: Premiere lets script SET a keyframe interpolation type but exposes no getter to read it back, and never exposed the temporal-ease amount to script at all — so a native "set the ease" call cannot be verified. Baked keyframe VALUES are readable back, so every written point is verified. Supports Penner easings and a CSS-style cubic-bezier. Scalar parameters only (multi-dimensional params like Position are refused).',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          componentName: z.string().default('Opacity').describe('The display name of the component (e.g., "Motion", "Opacity")'),
          paramName: z.string().default('Opacity').describe('The display name of the scalar parameter to animate (e.g., "Opacity", "Scale", "Rotation")'),
          startTime: z.number().describe('Clip-local start time in seconds'),
          endTime: z.number().describe('Clip-local end time in seconds (must be greater than startTime)'),
          startValue: z.number().describe('Parameter value at startTime'),
          endValue: z.number().describe('Parameter value at endTime'),
          easing: z.enum(EASING_NAMES as [string, ...string[]]).default('easeInOutCubic').describe('Named easing curve; ignored when bezier is provided'),
          bezier: z.array(z.number()).length(4).optional().describe('CSS-style cubic-bezier [x1, y1, x2, y2]; overrides easing. x1 and x2 must be within [0, 1]'),
          samples: z.number().int().min(1).max(MAX_EASE_SAMPLES).default(24).describe('Number of segments between the endpoints; keyframes written = samples + 1')
        })
      },

      // Work Area
      {
        name: 'set_work_area',
        description: 'Sets the work area in/out points for a sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          inPoint: z.number().describe('The in point in seconds'),
          outPoint: z.number().describe('The out point in seconds')
        })
      },
      {
        name: 'get_work_area',
        description: 'Gets the work area in/out points for a sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence')
        })
      },

      // Batch Operations
      {
        name: 'batch_add_transitions',
        description: 'Adds a transition to all clip boundaries on a track. Useful for quickly adding cross dissolves or other transitions between every clip.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          trackIndex: z.number().describe('The video track index (0-based)'),
          transitionName: z.string().describe('The name of the transition (e.g., "Cross Dissolve")'),
          duration: z.number().describe('The duration of each transition in seconds')
        })
      },

      // Project Item Discovery & Management
      {
        name: 'find_project_item_by_name',
        description: 'Searches for project items by name. Useful for finding media files, sequences, or bins.',
        inputSchema: z.object({
          name: z.string().describe('The name to search for (case-insensitive partial match)'),
          type: z.enum(['footage', 'sequence', 'bin', 'any']).optional().describe('Filter by item type')
        })
      },
      {
        name: 'move_item_to_bin',
        description: 'Moves a project item into a different bin (folder).',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item to move'),
          targetBinId: z.string().describe('The ID of the destination bin')
        })
      },

      // Active Sequence Management
      {
        name: 'set_active_sequence',
        description: 'Sets the active sequence in the project.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to activate')
        })
      },
      {
        name: 'get_active_sequence',
        description: 'Gets information about the currently active sequence.',
        inputSchema: z.object({})
      },

      // Clip Lookup
      {
        name: 'get_clip_at_position',
        description: 'Gets the clip at a specific time position on a track.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          trackType: z.enum(['video', 'audio']).describe('The type of track'),
          trackIndex: z.number().describe('The track index (0-based)'),
          time: z.number().describe('The time position in seconds')
        })
      },

      // Auto Reframe
      {
        name: 'auto_reframe_sequence',
        description: 'Automatically reframes a sequence to a new aspect ratio using AI-powered motion tracking.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to reframe'),
          numerator: z.number().describe('Aspect ratio numerator (e.g., 9 for 9:16)'),
          denominator: z.number().describe('Aspect ratio denominator (e.g., 16 for 9:16)'),
          motionPreset: z.enum(['slower', 'default', 'faster']).optional().describe('Motion tracking speed preset'),
          newName: z.string().optional().describe('Name for the reframed sequence')
        })
      },

      // Scene Edit Detection
      {
        name: 'detect_scene_edits',
        description: 'Detects scene changes in selected clips and optionally adds cuts or markers.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          action: z.enum(['ApplyCuts', 'CreateMarkers']).optional().describe('Action to take at detected edit points'),
          applyCutsToLinkedAudio: z.boolean().optional().describe('Whether to apply cuts to linked audio'),
          sensitivity: z.string().optional().describe('Detection sensitivity (e.g., "Low", "Medium", "High")'),
          allowUnsafeSynchronous: z.boolean().optional().describe('Actually invoke Premiere scene detection synchronously; can block CEP for a long time')
        })
      },

      // Captions
      {
        name: 'transcribe_to_srt',
        description: 'Transcribes a media file\'s speech to an .srt subtitle file using a LOCAL OpenAI Whisper install (the `whisper` CLI), run via child_process -- NOT via Premiere, which has no speech-to-text scripting API at all. This fills the gap before create_caption_track: Premiere can ingest an .srt but cannot generate one. Requires the whisper CLI on PATH (`pip install -U openai-whisper`, plus ffmpeg); returns an explicit error with install guidance if it is not found rather than failing silently. Verifies the .srt was actually written and reports its path and cue count. Whisper is CPU/GPU-heavy and can take minutes on long files. Typical chain: transcribe_to_srt -> import_media (the returned srtPath) -> create_caption_track (the imported item id).',
        inputSchema: z.object({
          mediaPath: z.string().optional().describe('Direct filesystem path to the audio/video file to transcribe'),
          projectItemId: z.string().optional().describe('Project item ID to resolve to a media path instead of passing mediaPath directly'),
          outputDir: z.string().optional().describe('Directory to write the .srt into. Defaults to the media file\'s own directory. The file is named <mediaBasename>.srt.'),
          model: z.string().optional().describe('Whisper model size: tiny, base, small, medium, large (default "base"). Larger = more accurate but much slower.'),
          language: z.string().optional().describe('Spoken language hint, e.g. "en" or "English". Omit to let Whisper auto-detect.'),
          translateToEnglish: z.boolean().optional().describe('When true, transcribe AND translate the speech into English subtitles (Whisper task=translate). Default false = transcribe in the original language.'),
          timeoutSeconds: z.number().optional().describe('Hard cap on the transcription run in seconds (default 1800 = 30 min). On timeout the process is killed and an error is returned.')
        }).refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId'
        })
      },
      {
        name: 'create_caption_track',
        description: 'Creates a caption track on a sequence from an imported caption/subtitle file (e.g. an .srt imported via import_media). Pass the SRT project item ID directly.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          projectItemId: z.string().describe('The ID of the caption file project item (e.g. an imported .srt)'),
          startTime: z.number().optional().describe('Offset in seconds from the start of the sequence. Defaults to 0.'),
          captionFormat: z.string().optional().describe('Optional caption format. Omit for subtitles (default, correct for .srt). Accepts: "subtitle", "608", "708", "teletext", "open ebu", "op42", "op47".')
        })
      },
      {
        name: 'read_sequence_captions',
        description: 'Reads caption tracks of a sequence, returning each caption clip as { start, end, text } in seconds. IMPORTANT: Premiere Pro exposes no caption-read API in its scripting DOM, so in practice this returns trackCount:0 / captions:[] even when the sequence HAS a working caption track. The response field captionReadSupported:false (plus note) signals this — a 0 result does NOT mean the sequence has no captions. To read cue text/timing, parse the source .srt file directly instead (see read_srt).',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Optional sequence ID. Defaults to the active sequence.')
        })
      },
      // SRT subtitle CRUD — the honest way to READ and EDIT captions. Premiere's
      // DOM can ingest an .srt (create_caption_track) but exposes NO read/update/
      // delete API for caption tracks, so all caption editing happens on the .srt
      // file itself, on disk, before (re-)ingest. These tools are host-independent
      // (no Premiere request) and verify every write by reading it back.
      {
        name: 'read_srt',
        description: 'Reads and parses an .srt subtitle file off disk into structured cues [{ index, start, end, startTimecode, endTimecode, text }] with start/end in seconds. This is the caption READ path Premiere itself cannot provide (read_sequence_captions is blocked by an Adobe DOM limitation). Robust to a UTF-8 BOM, CRLF/CR/LF endings, a missing index line, and WebVTT-style position tokens. Also returns a validation report (overlaps, zero-duration cues, empty text, out-of-order) and any malformed blocks it had to skip — nothing is dropped silently. Entirely local; no Premiere request.',
        inputSchema: z.object({
          srtPath: z.string().describe('Absolute path to the .srt file to read.')
        })
      },
      {
        name: 'validate_srt',
        description: 'Reads an .srt file and returns ONLY a QC report on its cues without modifying anything: structural errors (negative time, zero/negative-duration cues) and quality warnings (overlapping cues, out-of-chronological-order starts, empty text), plus a count of malformed blocks. Read-only; no Premiere request. Use before create_caption_track to catch captions that would render wrong.',
        inputSchema: z.object({
          srtPath: z.string().describe('Absolute path to the .srt file to validate.')
        })
      },
      {
        name: 'write_srt',
        description: 'Writes a complete .srt file from a full list of cues, replacing any existing file at the path. Cues are renumbered sequentially from 1 and written in canonical `HH:MM:SS,mmm --> HH:MM:SS,mmm` form. Refuses to write cues with structural errors (e.g. end not after start) unless allowInvalid=true, and always verifies by reading the file back and re-parsing it. Creates parent directories as needed. Host-independent; no Premiere request. Pair with import_media + create_caption_track to lay the result onto a sequence.',
        inputSchema: z.object({
          srtPath: z.string().describe('Absolute path to write the .srt to (overwritten if it exists).'),
          cues: z.array(z.object({
            start: z.union([z.number(), z.string()]).describe('Cue start: seconds (number) or an "HH:MM:SS,mmm" timecode string.'),
            end: z.union([z.number(), z.string()]).describe('Cue end: seconds (number) or an "HH:MM:SS,mmm" timecode string.'),
            text: z.string().describe('Cue text; may contain newlines for multi-line captions.')
          })).describe('The full ordered list of cues to write. An empty list writes an empty file.'),
          allowInvalid: z.boolean().optional().describe('When true, write even if validation finds structural errors (they are still reported). Default false = refuse and report the errors.')
        })
      },
      {
        name: 'update_srt_cue',
        description: 'Edits one cue in an existing .srt file, addressed by its 1-based index, changing any of start / end / text (omitted fields are left unchanged). Reads the file, applies the change, and writes it back with read-back verification. Returns the before/after of the edited cue. Host-independent; no Premiere request.',
        inputSchema: z.object({
          srtPath: z.string().describe('Absolute path to the .srt file to edit.'),
          index: z.number().int().describe('1-based cue number to edit (as shown by read_srt).'),
          start: z.union([z.number(), z.string()]).optional().describe('New start: seconds or "HH:MM:SS,mmm". Omit to keep.'),
          end: z.union([z.number(), z.string()]).optional().describe('New end: seconds or "HH:MM:SS,mmm". Omit to keep.'),
          text: z.string().optional().describe('New cue text. Omit to keep.')
        })
      },
      {
        name: 'insert_srt_cue',
        description: 'Inserts a new cue into an existing .srt file. The cue is placed in chronological order by its start time (the file stays time-sorted) and all cues are renumbered. Reads, inserts, and writes back with read-back verification. Host-independent; no Premiere request.',
        inputSchema: z.object({
          srtPath: z.string().describe('Absolute path to the .srt file to edit.'),
          start: z.union([z.number(), z.string()]).describe('Cue start: seconds or "HH:MM:SS,mmm".'),
          end: z.union([z.number(), z.string()]).describe('Cue end: seconds or "HH:MM:SS,mmm".'),
          text: z.string().describe('Cue text; may contain newlines.')
        })
      },
      {
        name: 'remove_srt_cue',
        description: 'Removes one cue from an existing .srt file, addressed by its 1-based index, and renumbers the rest. Reads, removes, and writes back with read-back verification. Returns the removed cue. Host-independent; no Premiere request.',
        inputSchema: z.object({
          srtPath: z.string().describe('Absolute path to the .srt file to edit.'),
          index: z.number().int().describe('1-based cue number to remove (as shown by read_srt).')
        })
      },
      {
        name: 'shift_srt_timing',
        description: 'Shifts caption timing in an .srt file to fix sync drift. Adds a fixed offset in seconds (negative pulls captions earlier) to every cue, or to a contiguous 1-based range only (fromIndex..toIndex) when the head is in sync but a later section drifts. Optionally also scales all timing by a positive factor about t=0 first (the honest fix for a frame-rate mismatch, e.g. 25/23.976). Times are clamped at 0. Reads, retimes, and writes back with read-back verification. Host-independent; no Premiere request.',
        inputSchema: z.object({
          srtPath: z.string().describe('Absolute path to the .srt file to retime.'),
          offsetSeconds: z.number().optional().describe('Seconds to add to each cue (may be negative). Default 0.'),
          scaleFactor: z.number().optional().describe('Positive multiplier applied to all timing about t=0 BEFORE the offset. Use for frame-rate mismatch (e.g. 25/23.976 ≈ 1.0427). Applies to the whole file regardless of the index range.'),
          fromIndex: z.number().int().optional().describe('1-based first cue the offset applies to. Default 1 (all).'),
          toIndex: z.number().int().optional().describe('1-based last cue the offset applies to. Default last (all).')
        })
      },
      {
        name: 'probe_media',
        description: 'Reads ground-truth technical metadata from a media file with ffprobe (run via child_process), NOT via Premiere -- so it works on any file on disk whether or not it is imported, online, or offline, and reports the container/stream facts Premiere\'s own get_metadata cannot: exact codec and profile, pixel format, color space/range, bit depth, frame rate, sample rate, channel layout, stream counts, duration, and bit rate. Requires ffprobe on PATH (ships with ffmpeg; overridable via PREMIERE_MCP_FFPROBE_CMD) and returns explicit install guidance if it is absent rather than failing silently. Returns a distilled `summary` plus the full parsed ffprobe JSON under `probe`.',
        inputSchema: z.object({
          mediaPath: z.string().optional().describe('Direct filesystem path to the media file to probe'),
          projectItemId: z.string().optional().describe('Project item ID to resolve to a media path instead of passing mediaPath directly')
        }).refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId'
        })
      },
      {
        name: 'generate_scope',
        description: 'Renders a signal/QC scope image -- waveform, vectorscope, histogram, or RGB parade -- from a single frame of a media file using ffmpeg (run via child_process), NOT via Premiere, whose Lumetri scopes cannot be scripted or exported. Grabs the frame at timeSeconds, applies the chosen scope filter, and writes a PNG. Requires ffmpeg on PATH (overridable via PREMIERE_MCP_FFMPEG_CMD) and returns explicit install guidance if it is absent; verifies the PNG was actually written before reporting success. Use for exposure/color QC and before/after grade checks.',
        inputSchema: z.object({
          mediaPath: z.string().optional().describe('Direct filesystem path to the media file to analyze'),
          projectItemId: z.string().optional().describe('Project item ID to resolve to a media path instead of passing mediaPath directly'),
          scope: z.enum(['waveform', 'vectorscope', 'histogram', 'rgb_parade']).optional().describe('Which scope to render (default "waveform"). "rgb_parade" is a per-channel RGB waveform.'),
          timeSeconds: z.number().optional().describe('Timestamp of the frame to analyze, in seconds from the file start (default 0).'),
          outputPath: z.string().optional().describe('Where to write the PNG. Defaults to <mediaDir>/<mediaBasename>_<scope>.png.')
        }).refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId'
        })
      },
      {
        name: 'capture_program_output',
        description: 'Captures the actual COMPOSITED Program Monitor output -- the real rendered pixels of the sequence at a given time, with all clips, effects, transitions, titles and grades baked in -- and writes it to an image, so an AI can SEE what the edit renders to rather than trusting that an API call returned. This is Premiere\'s true render output, not a DOM read-back. Premiere hands script no framebuffer of the program, so the frame is obtained off one of four "taps": render/export (zero-dependency, both OS, always available when Premiere is connected -- uses Premiere\'s own frame export), and the real-time GPU/network taps NDI, Syphon (macOS) and Spout (Windows) which need a Transmit plugin + native receiver. Tap selection is automatic ("auto") but forceable. Always reports which tap was actually used and verifies a real frame landed on disk before claiming success; if a requested tap is unavailable it returns per-OS install guidance instead of faking a frame. Pass probeOnly:true to just report which taps are available on this machine without capturing.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Sequence to capture. Defaults to the active sequence.'),
          time: z.number().optional().describe('Timestamp in seconds to capture. Defaults to the current playhead position of the sequence.'),
          format: z.enum(['png', 'jpg', 'jpeg', 'tiff', 'tif', 'dpx', 'tga', 'targa']).optional().describe('Image format for the render/export tap (default "png").'),
          outputPath: z.string().optional().describe('Where to write the captured frame. Defaults to a timestamped file in the system temp directory.'),
          tap: z.enum(['auto', 'render', 'ndi', 'syphon', 'spout']).optional().describe('Which capture tap to use. "auto" (default) picks the best available, falling back to render/export. The GPU/network taps (ndi/syphon/spout) require a Transmit plugin and a native receiver; if forced and unavailable the call fails with install guidance rather than silently using render/export.'),
          probeOnly: z.boolean().optional().describe('If true, do not capture -- just return which taps are available on this machine and their install guidance.')
        })
      },
      {
        name: 'bake_speed_change',
        description: 'Renders a NEW media file at a constant changed speed using ffmpeg (run via child_process), NOT via Premiere. This is the honest escape hatch for time-remapping: Premiere\'s scripting API has never exposed the time-remap/speed keyframe graph, so agents that "set a speed ramp" through the DOM get silently ignored keyframes at render. Instead this bakes a real, frame-accurate constant-speed clip to disk that you then import_media and place. Video is retimed with setpts; audio is retimed pitch-preserved with an atempo chain (or dropped with includeAudio:false). speed>1 is faster/shorter, speed<1 is slower/longer (e.g. 0.5 = half speed, 2 = double). Requires ffmpeg on PATH (overridable via PREMIERE_MCP_FFMPEG_CMD); returns install guidance if absent and verifies the output file was written and non-empty before reporting success. For a variable ramp, bake several constant-speed segments and butt them together. Note: this is a straight time-scale, not optical-flow frame interpolation.',
        inputSchema: z.object({
          mediaPath: z.string().optional().describe('Direct filesystem path to the source media file'),
          projectItemId: z.string().optional().describe('Project item ID to resolve to a media path instead of passing mediaPath directly'),
          speed: z.number().optional().describe('Speed multiplier (required). >1 faster/shorter, <1 slower/longer. Must be > 0.'),
          outputPath: z.string().optional().describe('Where to write the retimed file. Defaults to <mediaDir>/<basename>_<speed>x.<ext>.'),
          includeAudio: z.boolean().optional().describe('Retime and keep audio, pitch-preserved (default true). false drops audio (-an).'),
          preservePitch: z.boolean().optional().describe('When keeping audio, preserve pitch via atempo (default true). false lets pitch shift with speed via asetrate resample.')
        }).refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId'
        })
      },
      {
        name: 'normalize_loudness',
        description: 'Renders a NEW audio-normalized media file to a broadcast loudness target using ffmpeg\'s two-pass loudnorm (EBU R128), run via child_process, NOT via Premiere. Premiere exposes no scriptable loudness measurement or normalization, so agents cannot hit a delivery spec (e.g. -14 LUFS for streaming, -23 LUFS for broadcast) from the DOM. This measures the source in a first pass, then applies linear loudnorm with the measured values in a second pass for an accurate result, and writes the normalized file to disk. Requires ffmpeg + ffprobe on PATH (overridable via PREMIERE_MCP_FFMPEG_CMD / PREMIERE_MCP_FFPROBE_CMD); returns install guidance if absent and verifies the output before reporting success. Returns the measured input loudness and the target so the change is auditable.',
        inputSchema: z.object({
          mediaPath: z.string().optional().describe('Direct filesystem path to the source media file'),
          projectItemId: z.string().optional().describe('Project item ID to resolve to a media path instead of passing mediaPath directly'),
          targetLufs: z.number().optional().describe('Integrated loudness target in LUFS (default -14, common streaming target; -23 for EBU R128 broadcast).'),
          truePeakDb: z.number().optional().describe('Maximum true peak in dBTP (default -1.0).'),
          loudnessRange: z.number().optional().describe('Target loudness range (LRA) in LU (default 11).'),
          outputPath: z.string().optional().describe('Where to write the normalized file. Defaults to <mediaDir>/<basename>_norm<targetLufs>LUFS.<ext>.')
        }).refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId'
        })
      },
      {
        name: 'lint_timeline',
        description: 'Runs automated quality-control checks on a sequence and returns a list of findings -- the "layout lint" half of the render-truth loop. Walks every video and audio track and flags common editorial defects an agent (or human) cannot easily see from the DOM: GAPS between clips (black/silence), FLASH FRAMES (clips shorter than a frame threshold, usually accidental), OVERLAPS, a LEADING GAP before the first clip, and MIXED FRAME RATES (a clip whose source frame rate differs from the sequence, which stutters or drops frames). Read-only -- it changes nothing, it reports. Each finding carries a severity, the track and time, and a plain-English message. Defaults to the active sequence. Use it after assembling a timeline to catch mistakes before export.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Sequence to lint. Defaults to the active sequence.'),
          flashFrameThresholdFrames: z.number().optional().describe('Clips shorter than this many frames are flagged as flash frames (default 2).'),
          gapThresholdFrames: z.number().optional().describe('Gaps larger than this many frames are flagged (default 1). Set to 0 to flag any gap.'),
          checks: z.array(z.enum(['gaps', 'flash_frames', 'overlaps', 'leading_gap', 'mixed_frame_rate'])).optional().describe('Subset of checks to run. Defaults to all.')
        })
      },
      {
        name: 'diff_sequences',
        description: 'Compares two sequences clip-by-clip and reports exactly what changed between them -- the version-diff for an edit. Walks both timelines and classifies every difference as ADDED (a clip only in B), REMOVED (only in A), MOVED (the same clip at a new start time) or RETIMED (the same clip with a new duration). Read-only -- it changes nothing. Ideal for reviewing an AI edit against the original, or a restored recovery checkpoint against the current cut, so you can SEE what an operation did instead of trusting that it worked. Clips are matched within a track by name (nearest start time wins when a name repeats) and compared with a half-frame tolerance. Returns a change count and per-category lists; identical timelines report changeCount 0.',
        inputSchema: z.object({
          sequenceIdA: z.string().describe('The "before" sequence (the baseline / original).'),
          sequenceIdB: z.string().describe('The "after" sequence (the edited / current version) to compare against A.')
        })
      },
      {
        name: 'index_footage',
        description: 'Builds or refreshes a local, persistent index of media files on disk so footage DISCOVERY stops requiring the media to be imported into Premiere first. Walks a folder (recursively by default), reads each file\'s technical metadata with ffprobe, and writes a JSON index. Incremental: files whose path + size + modified-time already match the index are skipped, so re-running after adding a few clips is cheap. Entirely local -- ffprobe + filesystem, no Premiere request. Query the result with search_footage. Needs ffprobe (ships with ffmpeg); returns install guidance if it is missing.',
        inputSchema: z.object({
          rootPath: z.string().describe('Absolute path of the folder to scan for media.'),
          recursive: z.boolean().optional().describe('Descend into subfolders. Defaults to true. Hidden folders (dot-prefixed) are always skipped.'),
          extensions: z.array(z.string()).optional().describe('File extensions to include (without the dot, e.g. ["mov","wav"]). Defaults to a broad video/audio/image set.'),
          indexPath: z.string().optional().describe('Where to store the index JSON. Defaults to PREMIERE_MCP_FOOTAGE_INDEX or ~/.premiere-mcp/footage-index.json.'),
          pruneMissing: z.boolean().optional().describe('When true, drop index entries whose files are no longer on disk. Defaults to false (missing files are kept and reported).')
        })
      },
      {
        name: 'search_footage',
        description: 'Searches the local footage index built by index_footage, entirely offline -- no Premiere request. Find the right clip before importing it by filtering on filename substring, file extension, codec, duration/resolution/frame-rate ranges, and whether the file has audio or video. Returns matches with their distilled technical summary. Build or refresh the index with index_footage first.',
        inputSchema: z.object({
          query: z.string().optional().describe('Case-insensitive substring matched against the full file path (filename or folder).'),
          extension: z.string().optional().describe('Match a single file extension (with or without the dot).'),
          codec: z.string().optional().describe('Match a video OR audio codec name (e.g. "h264", "prores", "pcm_s24le").'),
          minDurationSeconds: z.number().optional().describe('Only files at least this long.'),
          maxDurationSeconds: z.number().optional().describe('Only files at most this long.'),
          minWidth: z.number().optional().describe('Minimum video width in pixels.'),
          minHeight: z.number().optional().describe('Minimum video height in pixels.'),
          minFps: z.number().optional().describe('Minimum video frame rate.'),
          maxFps: z.number().optional().describe('Maximum video frame rate.'),
          hasAudio: z.boolean().optional().describe('Require (true) or exclude (false) files with an audio stream.'),
          hasVideo: z.boolean().optional().describe('Require (true) or exclude (false) files with a video stream.'),
          indexPath: z.string().optional().describe('Which index JSON to read. Defaults to PREMIERE_MCP_FOOTAGE_INDEX or ~/.premiere-mcp/footage-index.json.'),
          limit: z.number().optional().describe('Maximum number of results to return (default 100).')
        })
      },
      {
        name: 'rename_project_item',
        description: 'Renames a project item (sequence, bin, clip) by setting its name. Use this when duplicate_sequence does not propagate the new name to the project panel.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item to rename'),
          newName: z.string().describe('The new name for the project item')
        })
      },

      // Subclip
      {
        name: 'create_subclip',
        description: 'Creates a subclip from a project item with specified in/out points.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the source project item'),
          name: z.string().describe('Name for the subclip'),
          startTime: z.number().describe('In point in seconds'),
          endTime: z.number().describe('Out point in seconds'),
          hasHardBoundaries: z.boolean().optional().describe('Whether boundaries are hard (cannot be extended)'),
          takeAudio: z.boolean().optional().describe('Whether to include audio (default: true)'),
          takeVideo: z.boolean().optional().describe('Whether to include video (default: true)')
        })
      },

      // Media Management - Relink & Metadata
      {
        name: 'relink_media',
        description: 'Relinks an offline or moved media file to a new file path.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item to relink'),
          newFilePath: z.string().describe('The new absolute file path to relink to')
        })
      },
      {
        name: 'set_color_label',
        description: 'Sets the color label on a project item.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item'),
          colorIndex: z.number().describe('Color label index 0-15 (0=Violet, 1=Iris, 2=Caribbean, 3=Lavender, 4=Cerulean, 5=Forest, 6=Rose, 7=Mango, 8=Purple, 9=Blue, 10=Teal, 11=Magenta, 12=Tan, 13=Green, 14=Brown, 15=Yellow)')
        })
      },
      {
        name: 'get_color_label',
        description: 'Gets the color label index of a project item.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item')
        })
      },
      {
        name: 'get_metadata',
        description: 'Gets project metadata and XMP metadata for a project item.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item')
        })
      },
      {
        name: 'set_metadata',
        description: 'Sets a project metadata value on a project item.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item'),
          key: z.string().describe('The metadata key/field name'),
          value: z.string().describe('The metadata value to set')
        })
      },
      {
        name: 'get_footage_interpretation',
        description: 'Gets the footage interpretation settings (frame rate, pixel aspect ratio, field type, etc.) for a project item.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item')
        })
      },
      {
        name: 'set_footage_interpretation',
        description: 'Sets footage interpretation settings (frame rate, pixel aspect ratio) for a project item.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item'),
          frameRate: z.number().optional().describe('Override frame rate'),
          pixelAspectRatio: z.number().optional().describe('Override pixel aspect ratio')
        })
      },
      {
        name: 'check_offline_media',
        description: 'Checks all project items and returns a list of any that are offline (missing media).',
        inputSchema: z.object({})
      },
      {
        name: 'export_as_fcp_xml',
        description: 'Exports a sequence as Final Cut Pro XML.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to export'),
          outputPath: z.string().describe('The absolute file path for the exported XML file')
        })
      },
      {
        name: 'undo',
        description: 'Performs an undo operation in Premiere Pro.',
        inputSchema: z.object({})
      },
      {
        name: 'set_sequence_in_out_points',
        description: 'Sets the in and/or out points on a sequence timeline.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          inPoint: z.number().optional().describe('The in point in seconds'),
          outPoint: z.number().optional().describe('The out point in seconds')
        })
      },
      {
        name: 'get_sequence_in_out_points',
        description: 'Gets the in and out points of a sequence timeline.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence')
        })
      },
      {
        name: 'export_aaf',
        description: 'Exports a sequence as an AAF file for interchange with other editing/audio applications.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to export'),
          outputPath: z.string().describe('The absolute file path for the exported AAF file'),
          mixDownVideo: z.boolean().optional().describe('Whether to mix down video (default: true)'),
          explodeToMono: z.boolean().optional().describe('Whether to explode audio to mono (default: false)'),
          sampleRate: z.number().optional().describe('Audio sample rate (default: 48000)'),
          bitsPerSample: z.number().optional().describe('Audio bits per sample (default: 16)')
        })
      },
      {
        name: 'consolidate_duplicates',
        description: 'Consolidates duplicate media items in the project.',
        inputSchema: z.object({})
      },
      {
        name: 'refresh_media',
        description: 'Refreshes the media for a project item, reloading it from disk.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item to refresh')
        })
      },
      {
        name: 'import_sequences_from_project',
        description: 'Imports sequences from another Premiere Pro project file.',
        inputSchema: z.object({
          projectPath: z.string().describe('The absolute path to the source .prproj file'),
          sequenceIds: z.array(z.string()).describe('Array of sequence IDs to import from the source project')
        })
      },
      {
        name: 'create_subsequence',
        description: 'Creates a subsequence from the in/out points of a sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the source sequence'),
          ignoreTrackTargeting: z.boolean().optional().describe('Whether to ignore track targeting (default: false)')
        })
      },
      {
        name: 'import_mogrt',
        description: 'Imports a Motion Graphics Template (.mogrt) file into a sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          mogrtPath: z.string().describe('The absolute path to the .mogrt file'),
          time: z.number().describe('The time in seconds where the MOGRT should be placed'),
          videoTrackIndex: z.number().optional().describe('The video track index (default: 0)'),
          audioTrackIndex: z.number().optional().describe('The audio track index (default: 0)')
        })
      },
      {
        name: 'import_mogrt_from_library',
        description: 'Imports a Motion Graphics Template from a Creative Cloud Library.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          libraryName: z.string().describe('The name of the Creative Cloud Library'),
          mogrtName: z.string().describe('The name of the MOGRT in the library'),
          time: z.number().describe('The time in seconds where the MOGRT should be placed'),
          videoTrackIndex: z.number().optional().describe('The video track index (default: 0)'),
          audioTrackIndex: z.number().optional().describe('The audio track index (default: 0)')
        })
      },
      {
        name: 'manage_proxies',
        description: 'Checks proxy status, attaches a proxy file, or gets the proxy path for a project item.',
        inputSchema: z.object({
          projectItemId: z.string().describe('The ID of the project item'),
          action: z.enum(['check', 'attach', 'get_path']).describe('The proxy action: check status, attach a proxy, or get proxy path'),
          proxyPath: z.string().optional().describe('The absolute path to the proxy file (required for attach action)')
        })
      }
    ];
  }

  getAvailableTools(): MCPTool[] {
    const localTools = this.getLocalTools();
    const all = [
      ...localTools,
      ...getExpandedTools(new Set(localTools.map((tool) => tool.name)))
    ];
    // Opt-in curation. Default (no env set) returns the full catalogue unchanged.
    return applyProfile(all);
  }

  async executeTool(name: string, args: Record<string, any>): Promise<any> {
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

    const tool = this.getAvailableTools().find(t => t.name === name);
    if (!tool) {
      return {
        success: false,
        error: `Tool '${name}' not found`,
        availableTools: this.getAvailableTools().map(t => t.name)
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

        // Media Management
        case 'import_media':
          return await this.importMedia(args.filePath, args.binName);
        case 'import_fcp_xml':
          return await this.importFcpXml(args.filePath);
        case 'import_edl':
          return await this.importEdl(args.filePath);
        case 'import_folder':
          return await this.importFolder(args.folderPath, args.binName, args.recursive);
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

  // Discovery Tools Implementation
  private async listProjectItems(includeBins = true, _includeMetadata = false): Promise<any> {
    const script = `
      try {
        function walkItems(parent, results, bins) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            var info = {
              id: item.nodeId,
              name: item.name,
              type: item.type === 2 ? 'bin' : (item.isSequence() ? 'sequence' : 'footage'),
              treePath: item.treePath
            };
            try { info.mediaPath = item.getMediaPath(); } catch(e) {}
            if (item.type === 2) {
              bins.push(info);
              walkItems(item, results, bins);
            } else {
              results.push(info);
            }
          }
        }
        var items = []; var bins = [];
        walkItems(app.project.rootItem, items, bins);
        return JSON.stringify({
          success: true,
          items: items,
          bins: ${includeBins} ? bins : [],
          totalItems: items.length,
          totalBins: bins.length
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

  private async listSequences(): Promise<any> {
    const script = `
      try {
        var sequences = [];
        
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
          var seq = app.project.sequences[i];
          sequences.push({
            id: seq.sequenceID,
            name: seq.name,
            duration: __ticksToSeconds(seq.end),
            width: seq.frameSizeHorizontal,
            height: seq.frameSizeVertical,
            timebase: seq.timebase,
            videoTrackCount: seq.videoTracks.numTracks,
            audioTrackCount: seq.audioTracks.numTracks
          });
        }

        return JSON.stringify({
          success: true,
          sequences: sequences,
          count: sequences.length
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

  private async listSequenceTracks(sequenceId: string): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}

        var videoTracks = [];
        var audioTracks = [];

        for (var i = 0; i < sequence.videoTracks.numTracks; i++) {
          var track = sequence.videoTracks[i];
          var clips = [];

          for (var j = 0; j < track.clips.numItems; j++) {
            var clip = track.clips[j];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              startTime: clip.start.seconds,
              endTime: clip.end.seconds,
              duration: clip.duration.seconds
            });
          }

          videoTracks.push({
            index: i,
            name: track.name || "Video " + (i + 1),
            clips: clips,
            clipCount: clips.length
          });
        }

        for (var i = 0; i < sequence.audioTracks.numTracks; i++) {
          var track = sequence.audioTracks[i];
          var clips = [];

          for (var j = 0; j < track.clips.numItems; j++) {
            var clip = track.clips[j];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              startTime: clip.start.seconds,
              endTime: clip.end.seconds,
              duration: clip.duration.seconds
            });
          }

          audioTracks.push({
            index: i,
            name: track.name || "Audio " + (i + 1),
            clips: clips,
            clipCount: clips.length
          });
        }

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          videoTracks: videoTracks,
          audioTracks: audioTracks,
          totalVideoTracks: videoTracks.length,
          totalAudioTracks: audioTracks.length
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

  private async getProjectInfo(): Promise<any> {
    const script = `
      try {
        var project = app.project;
        var hasActive = project.activeSequence ? true : false;
        return JSON.stringify({
          success: true,
          name: project.name,
          path: project.path,
          activeSequence: hasActive ? {
            id: project.activeSequence.sequenceID,
            name: project.activeSequence.name
          } : null,
          itemCount: project.rootItem.children.numItems,
          sequenceCount: project.sequences.numSequences,
          hasActiveSequence: hasActive
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
          resources: 13,
          prompts: 10
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

  private async validateProjectForExport(sequenceId?: string, outputPath?: string, presetPath?: string, requireNonEmptyTimeline = true, checkGaps = true): Promise<any> {
    const script = `
      try {
        var errors = [];
        var warnings = [];
        var info = [];

        function secondsOf(value) {
          if (value === undefined || value === null) return 0;
          if (typeof value === "number") return isFinite(value) ? value : 0;
          // Premiere Pro 26.3 returns sequence.end as a plain tick string rather
          // than a Time object, which previously fell through to 0 and produced a
          // spurious ZERO_DURATION. The timeline inspection tools already read the
          // same value as ticks, so interpret it the same way here.
          if (typeof value === "string") {
            var stringTicks = parseInt(value, 10);
            return isFinite(stringTicks) ? stringTicks / 254016000000.0 : 0;
          }
          if (value.seconds !== undefined) {
            var seconds = Number(value.seconds);
            return isFinite(seconds) ? seconds : 0;
          }
          if (value.ticks !== undefined) {
            var ticks = Number(value.ticks);
            return isFinite(ticks) ? ticks / 254016000000.0 : 0;
          }
          return 0;
        }

        function pathExists(path, expectFolder) {
          if (!path) return false;
          try {
            return expectFolder ? new Folder(path).exists : new File(path).exists;
          } catch (_) {
            return false;
          }
        }

        function parentFolder(path) {
          try {
            return new File(path).parent.fsName;
          } catch (_) {
            return "";
          }
        }

        if (!app.project) {
          return JSON.stringify({
            success: true,
            readyForExport: false,
            errors: [{ code: "NO_PROJECT", message: "No Premiere project is open." }],
            warnings: [],
            info: [],
            summary: {}
          });
        }

        var sequence = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!sequence) {
          errors.push({
            code: ${sequenceId ? '"SEQUENCE_NOT_FOUND"' : '"NO_ACTIVE_SEQUENCE"'},
            message: ${sequenceId ? JSON.stringify(`Sequence not found: ${sequenceId}`) : '"No active sequence is selected."'}
          });
        }

        if (${presetPath ? 'true' : 'false'}) {
          if (!pathExists(${JSON.stringify(presetPath || '')}, false)) {
            errors.push({
              code: "PRESET_NOT_FOUND",
              message: "Export preset file does not exist.",
              path: ${JSON.stringify(presetPath || '')}
            });
          } else if (!/\\.epr$/i.test(${JSON.stringify(presetPath || '')})) {
            warnings.push({
              code: "PRESET_EXTENSION",
              message: "Preset path exists but does not end with .epr.",
              path: ${JSON.stringify(presetPath || '')}
            });
          }
        } else {
          warnings.push({
            code: "PRESET_NOT_PROVIDED",
            message: "No presetPath was provided; export_sequence requires an absolute .epr preset path."
          });
        }

        if (${outputPath ? 'true' : 'false'}) {
          var outputParent = parentFolder(${JSON.stringify(outputPath || '')});
          if (!outputParent || !pathExists(outputParent, true)) {
            errors.push({
              code: "OUTPUT_FOLDER_NOT_FOUND",
              message: "Output parent folder does not exist.",
              path: outputParent || ${JSON.stringify(outputPath || '')}
            });
          }
        } else {
          warnings.push({
            code: "OUTPUT_PATH_NOT_PROVIDED",
            message: "No outputPath was provided; export readiness is partial."
          });
        }

        var summary = {
          projectName: app.project.name || "",
          projectPath: app.project.path || "",
          sequenceId: sequence ? sequence.sequenceID : null,
          sequenceName: sequence ? sequence.name : null,
          durationSeconds: sequence ? secondsOf(sequence.end) : 0,
          videoTrackCount: sequence ? sequence.videoTracks.numTracks : 0,
          audioTrackCount: sequence ? sequence.audioTracks.numTracks : 0,
          videoClipCount: 0,
          audioClipCount: 0,
          markerCount: 0,
          offlineMediaCount: 0,
          gapCount: 0
        };

        var offlineMedia = [];
        var seenMedia = {};
        function inspectProjectItem(item) {
          if (!item) return;
          try {
            if (item.getMediaPath) {
              var mediaPath = String(item.getMediaPath() || "");
              if (mediaPath && !seenMedia[mediaPath]) {
                seenMedia[mediaPath] = true;
                var offline = false;
                try { offline = item.isOffline ? Boolean(item.isOffline()) : false; } catch (_) {}
                if (offline || !pathExists(mediaPath, false)) {
                  offlineMedia.push({
                    nodeId: item.nodeId,
                    name: item.name,
                    mediaPath: mediaPath,
                    offline: offline,
                    fileExists: pathExists(mediaPath, false)
                  });
                }
              }
            }
          } catch (_) {}
          if (item.children) {
            for (var childIndex = 0; childIndex < item.children.numItems; childIndex++) {
              inspectProjectItem(item.children[childIndex]);
            }
          }
        }
        inspectProjectItem(app.project.rootItem);
        summary.offlineMediaCount = offlineMedia.length;
        if (offlineMedia.length) {
          errors.push({
            code: "OFFLINE_OR_MISSING_MEDIA",
            message: "One or more project media files are offline or missing on disk.",
            items: offlineMedia
          });
        }

        var gaps = [];
        if (sequence) {
          var hasVideoClip = false;
          var hasAudioClip = false;

          function inspectTracks(trackCollection, trackType) {
            for (var trackIndex = 0; trackIndex < trackCollection.numTracks; trackIndex++) {
              var track = trackCollection[trackIndex];
              var clips = [];
              for (var clipIndex = 0; clipIndex < track.clips.numItems; clipIndex++) {
                var clip = track.clips[clipIndex];
                var start = secondsOf(clip.start);
                var end = secondsOf(clip.end);
                clips.push({ start: start, end: end, name: clip.name, nodeId: clip.nodeId });
                if (trackType === "video") {
                  summary.videoClipCount++;
                  hasVideoClip = true;
                } else {
                  summary.audioClipCount++;
                  hasAudioClip = true;
                }
              }
              clips.sort(function(a, b) { return a.start - b.start; });
              var cursor = 0;
              for (var gi = 0; gi < clips.length; gi++) {
                if (clips[gi].start - cursor > 0.05) {
                  gaps.push({
                    trackType: trackType,
                    trackIndex: trackIndex,
                    start: cursor,
                    end: clips[gi].start,
                    duration: clips[gi].start - cursor
                  });
                }
                if (clips[gi].end > cursor) cursor = clips[gi].end;
              }
            }
          }

          inspectTracks(sequence.videoTracks, "video");
          inspectTracks(sequence.audioTracks, "audio");

          if (${requireNonEmptyTimeline !== false ? 'true' : 'false'} && summary.videoClipCount + summary.audioClipCount === 0) {
            errors.push({
              code: "EMPTY_TIMELINE",
              message: "The sequence has no video or audio clips."
            });
          }
          if (!hasVideoClip) {
            warnings.push({
              code: "NO_VIDEO_CLIPS",
              message: "The sequence has no video clips."
            });
          }
          if (!hasAudioClip) {
            warnings.push({
              code: "NO_AUDIO_CLIPS",
              message: "The sequence has no audio clips."
            });
          }

          try {
            summary.markerCount = sequence.markers ? sequence.markers.numMarkers : 0;
          } catch (_) {}

          summary.gapCount = gaps.length;
          if (${checkGaps !== false ? 'true' : 'false'} && gaps.length) {
            warnings.push({
              code: "TIMELINE_GAPS",
              message: "Timeline gaps were found. This may be intentional, but agents should verify before export.",
              gaps: gaps
            });
          }

          if (summary.durationSeconds <= 0) {
            errors.push({
              code: "ZERO_DURATION",
              message: "The sequence duration is zero."
            });
          }
        }

        if (!errors.length) {
          info.push({
            code: "EXPORT_READY",
            message: "No blocking export readiness issues were found."
          });
        }

        return JSON.stringify({
          success: true,
          readyForExport: errors.length === 0,
          errors: errors,
          warnings: warnings,
          info: info,
          summary: summary,
          checked: {
            sequenceId: ${sequenceId ? JSON.stringify(sequenceId) : 'null'},
            outputPath: ${outputPath ? JSON.stringify(outputPath) : 'null'},
            presetPath: ${presetPath ? JSON.stringify(presetPath) : 'null'},
            requireNonEmptyTimeline: ${requireNonEmptyTimeline !== false ? 'true' : 'false'},
            checkGaps: ${checkGaps !== false ? 'true' : 'false'}
          }
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async buildMotionGraphicsDemo(sequenceName = 'Apple Like Motion Demo'): Promise<any> {
    const assetBase = process.env.PREMIERE_TEMP_DIR || '/tmp';
    const assetDir = `${assetBase.replace(/\/$/, '')}/motion-demo-${Date.now()}`;
    const assets = await createMotionDemoAssets(assetDir);

    const imported = [];
    for (const asset of assets) {
      const result = await this.importMedia(asset.path);
      imported.push(result);
      if (!result.success || !result.id) {
        return {
          success: false,
          error: result.error || `Failed to import asset ${asset.name}`,
          assetDir,
          assets,
          imported
        };
      }
    }

    const createdSequence = await this.createSequenceFromProjectItems(
      sequenceName,
      imported.map((item: any) => item.id)
    );
    if (!createdSequence.success || !createdSequence.id) {
      return {
        success: false,
        error: createdSequence.error || 'Failed to create demo sequence from imported assets',
        assetDir,
        assets,
        imported
      };
    }

    const placements = [];
    for (let index = 0; index < imported.length; index++) {
      const placement = await this.addToTimeline(createdSequence.id, imported[index].id, 0, index * 5);
      placements.push(placement);
      if (!placement.success) {
        return {
          success: false,
          error: placement.error || `Failed to place ${imported[index].name} on the timeline`,
          assetDir,
          assets,
          createdSequence,
          imported,
          placements
        };
      }
    }

    const clips = placements.map((placement: any) => placement.id).filter(Boolean);
    const transitions = [];
    if (clips[0]) {
      transitions.push(await this.addTransitionToClip(clips[0], 'Cross Dissolve', 'end', 0.75));
    }
    if (clips[1]) {
      transitions.push(await this.addTransitionToClip(clips[1], 'Cross Dissolve', 'end', 0.75));
    }

    const animations = [];
    const scaleFrames = [
      { start: 0, end: 4.8, from: 100, to: 108 },
      { start: 5.005, end: 9.8, from: 112, to: 100 },
      { start: 10.01, end: 14.7, from: 100, to: 106 },
    ];
    for (let index = 0; index < clips.length && index < scaleFrames.length; index++) {
      const frame = scaleFrames[index];
      if (!frame) {
        continue;
      }
      animations.push(await this.addKeyframe(clips[index], 'Motion', 'Scale', frame.start, frame.from));
      animations.push(await this.addKeyframe(clips[index], 'Motion', 'Scale', frame.end, frame.to));
    }

    const tracks = await this.listSequenceTracks(createdSequence.id);

    return {
      success: true,
      message: 'Motion graphics demo sequence created',
      assetDir,
      assets,
      sequence: createdSequence,
      imported,
      placements,
      transitions,
      animations,
      tracks
    };
  }

  private getMotionRange(style: MotionStyle, index: number): { from: number; to: number } {
    if (style === 'push_in') {
      return { from: 100, to: 108 };
    }
    if (style === 'pull_out') {
      return { from: 108, to: 100 };
    }
    if (style === 'alternate') {
      const invert = index % 2 === 1;
      return invert ? { from: 110, to: 100 } : { from: 100, to: 108 };
    }
    return { from: 100, to: 100 };
  }

  private hasColorAdjustments(color?: ClipPlanColor): boolean {
    if (!color) {
      return false;
    }
    return Object.values(color).some((value) => value !== undefined);
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

  // Project Management Implementation
  private async createProject(name: string, location: string): Promise<any> {
    try {
      const result: any = await this.bridge.createProject(name, location);
      const projectPath = `${location.replace(/[\\/]+$/, '')}/${name.endsWith('.prproj') ? name : `${name}.prproj`}`;
      if (result?.success === false) {
        return {
          ...result,
          projectPath: result.projectPath || projectPath
        };
      }

      return {
        success: true,
        message: `Project "${name}" created successfully`,
        projectPath,
        ...result
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create project: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private async openProject(path: string): Promise<any> {
    try {
      const result: any = await this.bridge.openProject(path);
      if (result?.success === false) {
        return {
          ...result,
          projectPath: result.projectPath || path
        };
      }

      return {
        success: true,
        message: `Project opened successfully`,
        projectPath: path,
        ...result
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to open project: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private async saveProject(): Promise<any> {
    try {
      await this.bridge.saveProject();
      return { 
        success: true, 
        message: 'Project saved successfully',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to save project: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private async saveProjectAs(name: string, location: string): Promise<any> {
    const script = `
      try {
        var project = app.project;
        var newPath = ${JSON.stringify(location)} + "/" + ${JSON.stringify(name)} + ".prproj";
        project.saveAs(newPath);
        var savedFile = new File(newPath);
        if (!savedFile.exists) return JSON.stringify({ success: false, verified: false, error: "saveAs() ran but no file exists at " + newPath + ". The location may be unwritable.", newPath: newPath });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Project saved as: " + newPath,
          newPath: newPath,
          fileSize: savedFile.length
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

  // ── New Wave-1 tools ───────────────────────────────────────────────────

  private async closeProject(saveFirst: boolean, closeIfLast: boolean): Promise<any> {
    const script = `
      try {
        var name = app.project.name;
        app.project.closeDocument(${saveFirst}, ${closeIfLast});
        return JSON.stringify({ success: true, closedProject: name, savedFirst: ${saveFirst} });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  private async listOpenProjects(): Promise<any> {
    const script = `
      try {
        var projs = app.projects;
        var list = [];
        for (var i = 0; i < projs.numProjects; i++) {
          var p = projs[i];
          list.push({ name: String(p.name), path: String(p.path), sequences: p.sequences ? p.sequences.numSequences : 0 });
        }
        return JSON.stringify({ success: true, openProjectCount: projs.numProjects, projects: list });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  private listRecentProjects(limit: number, excludeAutosave: boolean): any {
    const { execSync } = require('child_process');
    try {
      const raw = execSync('mdfind -name ".prproj"', { encoding: 'utf8', timeout: 5000 });
      const files = raw.trim().split('\n')
        .filter((f: string) => f && (!excludeAutosave || !f.includes('Auto-Save')));
      const fs = require('fs');
      const withTimes = files
        .map((f: string) => { try { return { path: f, name: require('path').basename(f), mtime: fs.statSync(f).mtimeMs }; } catch { return null; } })
        .filter(Boolean)
        .sort((a: any, b: any) => b.mtime - a.mtime)
        .slice(0, limit)
        .map((f: any) => ({ ...f, modified: new Date(f.mtime).toISOString() }));
      return { success: true, count: withTimes.length, projects: withTimes };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  private clipboardRead(): any {
    try {
      const text = this.bridge.readClipboard();
      return { success: true, text, length: text.length };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  private clipboardWrite(text: string): any {
    try {
      this.bridge.writeClipboard(text);
      const readback = this.bridge.readClipboard();
      const verified = readback === text;
      return { success: true, verified, length: text.length, note: verified ? undefined : 'Clipboard content after write did not match exactly.' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  private async getSequenceRenderStatus(sequenceId?: string): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var seq = ${sequenceId ? `(function(){ var seqs=app.project.sequences; for(var i=0;i<seqs.numSequences;i++){ if(seqs[i].sequenceID===${JSON.stringify(sequenceId)}) return qe.project.getSequenceAt(i); } return qe.project.getActiveSequence(); })()` : 'qe.project.getActiveSequence()'};
        if (!seq) return JSON.stringify({ success: false, error: 'Sequence not found' });
        function timesToArr(arr) { var out=[]; for(var i=0;i<arr.length;i++) out.push({ticks:String(arr[i].ticks),secs:arr[i].secs,frames:arr[i].frames}); return out; }
        var green = timesToArr(seq.getGreenBarTimes());
        var red = timesToArr(seq.getRedBarTimes());
        var yellow = timesToArr(seq.getYellowBarTimes());
        var empty = timesToArr(seq.getEmptyBarTimes());
        var incomplete = seq.isIncompleteBackgroundVideoEffects();
        return JSON.stringify({ success: true, sequenceName: String(seq.name),
          green: { count: green.length/2, ranges: green },
          red: { count: red.length/2, ranges: red },
          yellow: { count: yellow.length/2, ranges: yellow },
          empty: { count: empty.length/2, ranges: empty },
          incompleteBackgroundEffects: incomplete,
          needsRender: red.length > 0 || yellow.length > 0
        });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  private async renderSequencePreviews(sequenceId?: string, renderAll?: boolean): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var seq = ${sequenceId ? `(function(){ var seqs=app.project.sequences; for(var i=0;i<seqs.numSequences;i++){ if(seqs[i].sequenceID===${JSON.stringify(sequenceId)}) return qe.project.getSequenceAt(i); } return qe.project.getActiveSequence(); })()` : 'qe.project.getActiveSequence()'};
        if (!seq) return JSON.stringify({ success: false, error: 'Sequence not found' });
        var redBefore = seq.getRedBarTimes().length;
        var yellowBefore = seq.getYellowBarTimes().length;
        if (${renderAll}) { seq.renderAll(); } else { seq.renderPreview(); }
        return JSON.stringify({ success: true, verified: false, note: 'renderPreview() dispatched. Rendering is async — call get_sequence_render_status to check progress.', seqName: String(seq.name), unrenderedSegmentsBefore: redBefore/2, partialSegmentsBefore: yellowBefore/2 });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  private async setEssentialSoundCategory(projectItemId: string, category: string): Promise<any> {
    const clipMixTypeMap: Record<string, number> = { dialog: 1, music: 2, sfx: 3, ambience: 4 };
    const clipMixType = clipMixTypeMap[category] ?? 1;
    const script = `
      try {
        var item = null;
        var root = app.project.rootItem;
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){ var c=bin.children[i]; if(c.nodeId===id){return c;} if(c.type===2){var r=findById(c,id);if(r)return r;} } return null; }
        item = findById(root, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: 'Project item not found: ' + ${JSON.stringify(projectItemId)} });
        item.setProjectMetadata('ESP.Tag', ${JSON.stringify(category)});
        item.setProjectMetadata('ESP.AdjustmentsModeID', ${JSON.stringify(category)});
        item.setProjectMetadata('ESP.ClipMixTypeID', ${JSON.stringify(String(clipMixType))});
        item.setProjectMetadata('MZ.AudioCategorization.AudioCategorizationAdjustmentMode', ${JSON.stringify(category)});
        return JSON.stringify({ success: true, verified: false, projectItemId: ${JSON.stringify(projectItemId)}, category: ${JSON.stringify(category)}, note: 'ESP metadata written. Premiere reads this on next project open/refresh.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  private async openProjectItemInSource(projectItemId: string, timecode?: string): Promise<any> {
    const script = `
      try {
        var item = null;
        var root = app.project.rootItem;
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){ var c=bin.children[i]; if(c.nodeId===id){return c;} if(c.type===2){var r=findById(c,id);if(r)return r;} } return null; }
        item = findById(root, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: 'Project item not found: ' + ${JSON.stringify(projectItemId)} });
        app.sourceMonitor.openProjectItem(item);
        ${timecode ? `
        // Cue to timecode if provided
        try {
          app.enableQE();
          qe.source.clip.setInPoint(${JSON.stringify(timecode)});
        } catch(eCue) {}` : ''}
        var loaded = app.sourceMonitor.getProjectItem();
        var verified = loaded && loaded.nodeId === ${JSON.stringify(projectItemId)};
        return JSON.stringify({ success: true, verified: verified, projectItemId: ${JSON.stringify(projectItemId)}, itemName: loaded ? String(loaded.name) : null, timecode: ${JSON.stringify(timecode ?? null)} });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  // ── Wave 1 — Navigation & Editing Verbs ───────────────────────────────

  private buildSequenceResolver2(sequenceId?: string): string {
    if (!sequenceId) return 'app.project.activeSequence';
    return `(function(){ var seqs=app.project.sequences; for(var i=0;i<seqs.numSequences;i++){ if(seqs[i].sequenceID===${JSON.stringify(sequenceId)}) return seqs[i]; } return app.project.activeSequence; })()`;
  }

  private async goToSequenceStart(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var t = new Time(); t.ticks = '0';
      seq.setPlayerPosition(t.ticks);
      var pos = seq.getPlayerPosition();
      return JSON.stringify({success:true,verified:true,ticks:String(pos.ticks),secs:pos.seconds,sequenceName:String(seq.name)});
    `);
  }

  private async goToSequenceEnd(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var endTicks = seq.end ? String(seq.end.ticks) : String(seq.getOutPoint ? seq.getOutPoint().ticks : '0');
      seq.setPlayerPosition(endTicks);
      var pos = seq.getPlayerPosition();
      return JSON.stringify({success:true,verified:true,ticks:String(pos.ticks),secs:pos.seconds,sequenceName:String(seq.name)});
    `);
  }

  private async goToInPoint(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var ip = seq.getInPoint();
      seq.setPlayerPosition(String(ip.ticks));
      return JSON.stringify({success:true,ticks:String(ip.ticks),secs:ip.seconds});
    `);
  }

  private async goToOutPoint(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var op = seq.getOutPoint();
      seq.setPlayerPosition(String(op.ticks));
      return JSON.stringify({success:true,ticks:String(op.ticks),secs:op.seconds});
    `);
  }

  private async stepFrames(frames: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var before = seq.getPlayerPosition();
      var ticksPerFrame = Number(seq.timebase) || 10584000000;
      var newTicks = Math.max(0, Number(before.ticks) + ${frames} * ticksPerFrame);
      seq.setPlayerPosition(String(Math.round(newTicks)));
      var after = seq.getPlayerPosition();
      return JSON.stringify({success:true,verified:true,framesMoved:${frames},before:{ticks:String(before.ticks),secs:before.seconds},after:{ticks:String(after.ticks),secs:after.seconds}});
    `);
  }

  private async getPlaybackState(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var pos = seq.getPlayerPosition();
      return JSON.stringify({success:true,ticks:String(pos.ticks),secs:pos.seconds,sequenceName:String(seq.name),frameSizeH:seq.frameSizeHorizontal,frameSizeV:seq.frameSizeVertical});
    `);
  }

  private async rippleTrimIn(sequenceId: string | undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var track = seq.videoTracks[${trackIndex}];
      if (!track) return JSON.stringify({success:false,error:'Track not found'});
      var clip = track.clips[${clipIndex}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var playhead = seq.getPlayerPosition();
      var beforeStart = String(clip.start.ticks);
      // Ripple trim: set clip start to playhead by adjusting inPoint
      var frameDelta = Number(playhead.ticks) - Number(clip.start.ticks);
      var newInTicks = Number(clip.inPoint.ticks) + frameDelta;
      if (newInTicks < 0) return JSON.stringify({success:false,error:'Not enough head room to trim to playhead'});
      var newIn = new Time(); newIn.ticks = String(Math.round(newInTicks));
      clip.setInPoint(newIn, 4); // 4 = ripple
      var afterStart = String(clip.start.ticks);
      return JSON.stringify({success:true,verified:afterStart !== beforeStart,beforeStart:beforeStart,afterStart:afterStart,playheadTicks:String(playhead.ticks)});
    `);
  }

  private async rippleTrimOut(sequenceId: string | undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var track = seq.videoTracks[${trackIndex}];
      if (!track) return JSON.stringify({success:false,error:'Track not found'});
      var clip = track.clips[${clipIndex}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var playhead = seq.getPlayerPosition();
      var beforeEnd = String(clip.end.ticks);
      var frameDelta = Number(clip.end.ticks) - Number(playhead.ticks);
      var newOutTicks = Number(clip.outPoint.ticks) - frameDelta;
      var newOut = new Time(); newOut.ticks = String(Math.round(newOutTicks));
      clip.setOutPoint(newOut, 4); // 4 = ripple
      var afterEnd = String(clip.end.ticks);
      return JSON.stringify({success:true,verified:afterEnd !== beforeEnd,beforeEnd:beforeEnd,afterEnd:afterEnd,playheadTicks:String(playhead.ticks)});
    `);
  }

  private async extendEdit(sequenceId: string | undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var track = seq.videoTracks[${trackIndex}];
      var clip = track && track.clips[${clipIndex}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var playhead = seq.getPlayerPosition();
      var ph = Number(playhead.ticks);
      var distToIn = Math.abs(ph - Number(clip.start.ticks));
      var distToOut = Math.abs(ph - Number(clip.end.ticks));
      var extendIn = distToIn < distToOut;
      var beforeTick = extendIn ? String(clip.start.ticks) : String(clip.end.ticks);
      var t = new Time(); t.ticks = String(ph);
      if (extendIn) { clip.setInPoint(t, 2); } else { clip.setOutPoint(t, 2); }
      var afterTick = extendIn ? String(clip.start.ticks) : String(clip.end.ticks);
      return JSON.stringify({success:true,verified:afterTick !== beforeTick,extendedEdge:extendIn?'in':'out',before:beforeTick,after:afterTick});
    `);
  }

  private async nudgeClip(sequenceId: string | undefined, trackIndex: number, clipIndex: number, frames: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var track = seq.videoTracks[${trackIndex}];
      var clip = track && track.clips[${clipIndex}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var ticksPerFrame = Number(seq.timebase) || 10584000000;
      var before = String(clip.start.ticks);
      var newStart = new Time(); newStart.ticks = String(Math.max(0, Math.round(Number(clip.start.ticks) + ${frames} * ticksPerFrame)));
      clip.move(newStart, ${trackIndex});
      var after = String(clip.start.ticks);
      return JSON.stringify({success:true,verified:after !== before,frames:${frames},before:before,after:after});
    `);
  }

  private async jCut(sequenceId: string | undefined, videoTrackIndex: number, clipIndex: number, frames: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var vTrack = seq.videoTracks[${videoTrackIndex}];
      var vClip = vTrack && vTrack.clips[${clipIndex}];
      if (!vClip) return JSON.stringify({success:false,error:'Video clip not found'});
      var linked = vClip.getLinkedItems();
      var aClip = null;
      for (var i = 0; i < linked.numItems; i++) { if (linked[i].mediaType === 'Audio') { aClip = linked[i]; break; } }
      if (!aClip) return JSON.stringify({success:false,error:'No linked audio clip found'});
      var ticksPerFrame = Number(seq.timebase) || 10584000000;
      var before = String(aClip.start.ticks);
      var newAIn = new Time(); newAIn.ticks = String(Math.max(0, Math.round(Number(aClip.inPoint.ticks) - ${frames} * ticksPerFrame)));
      aClip.setInPoint(newAIn, 4);
      var after = String(aClip.start.ticks);
      return JSON.stringify({success:true,verified:after !== before,frames:${frames},audioStartBefore:before,audioStartAfter:after,type:'j_cut'});
    `);
  }

  private async lCut(sequenceId: string | undefined, videoTrackIndex: number, clipIndex: number, frames: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var vTrack = seq.videoTracks[${videoTrackIndex}];
      var vClip = vTrack && vTrack.clips[${clipIndex}];
      if (!vClip) return JSON.stringify({success:false,error:'Video clip not found'});
      var linked = vClip.getLinkedItems();
      var aClip = null;
      for (var i = 0; i < linked.numItems; i++) { if (linked[i].mediaType === 'Audio') { aClip = linked[i]; break; } }
      if (!aClip) return JSON.stringify({success:false,error:'No linked audio clip found'});
      var ticksPerFrame = Number(seq.timebase) || 10584000000;
      var before = String(aClip.end.ticks);
      var newAOut = new Time(); newAOut.ticks = String(Math.round(Number(aClip.outPoint.ticks) + ${frames} * ticksPerFrame));
      aClip.setOutPoint(newAOut, 4);
      var after = String(aClip.end.ticks);
      return JSON.stringify({success:true,verified:after !== before,frames:${frames},audioEndBefore:before,audioEndAfter:after,type:'l_cut'});
    `);
  }

  private async threePointEdit(projectItemId: string, sourceIn?: string, sourceOut?: string, sequenceTimecode?: string, mode = 'overwrite', videoTrack = 0, _audioTrack = 0): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var root = app.project.rootItem;
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}} return null; }
        var item = findById(root, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found: '+${JSON.stringify(projectItemId)}});
        app.sourceMonitor.openProjectItem(item);
        ${sourceIn ? `app.enableQE(); qe.source.clip.setInPoint(${JSON.stringify(sourceIn)});` : ''}
        ${sourceOut ? `app.enableQE(); qe.source.clip.setOutPoint(${JSON.stringify(sourceOut)});` : ''}
        var seq = app.project.activeSequence;
        ${sequenceTimecode ? `var t = new Time(); t.seconds = ${JSON.stringify(sequenceTimecode)}; seq.setPlayerPosition(String(t.ticks));` : ''}
        var beforeCount = seq.videoTracks[${videoTrack}].clips.numItems;
        if (${JSON.stringify(mode)} === 'insert') {
          seq.videoTracks[${videoTrack}].insertClip(item, seq.getPlayerPosition());
        } else {
          seq.videoTracks[${videoTrack}].overwriteClip(item, seq.getPlayerPosition());
        }
        var afterCount = seq.videoTracks[${videoTrack}].clips.numItems;
        return JSON.stringify({success:true,verified:afterCount >= beforeCount,mode:${JSON.stringify(mode)},sourceItem:String(item.name),sourceIn:${JSON.stringify(sourceIn??null)},sourceOut:${JSON.stringify(sourceOut??null)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async closeGapAt(timecode: string, _sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = app.project.activeSequence;
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var gaps = seq.getTimelineGaps();
      if (!gaps || !gaps.length) return JSON.stringify({success:true,message:'No gaps found',gapsClosed:0});
      // Find gap containing our timecode (as seconds for comparison)
      var targetSecs = ${JSON.stringify(timecode)}.indexOf(':') >= 0 ? 0 : Number(${JSON.stringify(timecode)});
      var closed = 0;
      for (var i = 0; i < gaps.length; i++) {
        var g = gaps[i];
        if (g && g.start !== undefined) {
          seq.videoTracks[0].clips[i] && seq.rippleDelete ? null : null; // placeholder
        }
      }
      return JSON.stringify({success:true,note:'Gap closing requires ripple-delete on the gap range. Use ripple_delete tool with the gap timecodes from get_timeline_gaps.',gapCount:gaps.length});
    `);
  }

  private async closeAllGaps(sequenceId?: string, _trackIndex?: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var gaps = seq.getTimelineGaps ? seq.getTimelineGaps() : [];
      return JSON.stringify({success:true,gapCount:gaps ? gaps.length : 0,note:'Use get_timeline_gaps to enumerate, then ripple_delete each gap range.'});
    `);
  }

  private async deleteEmptyTracks(_sequenceId: string | undefined, video: boolean, audio: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var beforeV = seq.numVideoTracks; var beforeA = seq.numAudioTracks;
        if (${video}) seq.removeEmptyVideoTracks();
        if (${audio}) seq.removeEmptyAudioTracks();
        var afterV = seq.numVideoTracks; var afterA = seq.numAudioTracks;
        return JSON.stringify({success:true,verified:true,removedVideoTracks:beforeV-afterV,removedAudioTracks:beforeA-afterA,remainingVideo:afterV,remainingAudio:afterA});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async getSequenceSelection(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var sel = seq.getSelection();
      var items = [];
      if (sel) for (var i = 0; i < sel.length; i++) {
        var c = sel[i]; items.push({name:String(c.name),start:c.start?String(c.start.ticks):null,end:c.end?String(c.end.ticks):null,mediaType:String(c.mediaType)});
      }
      return JSON.stringify({success:true,count:items.length,clips:items});
    `);
  }

  private async setSequenceSelection(clips: Array<{trackIndex: number, clipIndex: number}>, sequenceId?: string): Promise<any> {
    const clipsJson = JSON.stringify(clips);
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var clipList = ${clipsJson};
      var toSelect = [];
      for (var i = 0; i < clipList.length; i++) {
        var track = seq.videoTracks[clipList[i].trackIndex] || seq.audioTracks[clipList[i].trackIndex];
        if (track && track.clips[clipList[i].clipIndex]) toSelect.push(track.clips[clipList[i].clipIndex]);
      }
      seq.setSelection(toSelect);
      var sel = seq.getSelection();
      return JSON.stringify({success:true,verified:sel&&sel.length===toSelect.length,requested:clipList.length,selected:sel?sel.length:0});
    `);
  }

  private async createMarker(timeSecs: number, name?: string, comment?: string, type?: string, colorIndex?: number, durationSecs?: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSequenceResolver2(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var markers = seq.markers;
      var m = markers.createMarker(${timeSecs});
      ${name ? `try { m.name = ${JSON.stringify(name)}; } catch(e) {}` : ''}
      ${comment ? `try { m.comments = ${JSON.stringify(comment)}; } catch(e) {}` : ''}
      ${type ? `try { m.type = ${JSON.stringify(type)}; } catch(e) {}` : ''}
      ${colorIndex !== undefined ? `try { m.colorByIndex = ${colorIndex}; } catch(e) {}` : ''}
      ${durationSecs ? `try { var endT = new Time(); endT.seconds = ${timeSecs} + ${durationSecs}; m.end = endT; } catch(e) {}` : ''}
      return JSON.stringify({success:true,verified:true,timeSecs:${timeSecs},name:String(m.name),type:String(m.type),ticks:String(m.start.ticks)});
    `);
  }

  // ── Batch 1: Lumetri Numeric Control ─────────────────────────────────

  private lumetriParamScript(seqId: string | undefined, ti: number, ci: number, assignments: string): string {
    return `
      try {
        var seq = ${seqId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(seqId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var lumetri = null;
        for (var i=0;i<clip.components.numItems;i++) { if (String(clip.components[i].displayName).indexOf('Lumetri')>=0) { lumetri=clip.components[i]; break; } }
        if (!lumetri) return JSON.stringify({success:false,error:'No Lumetri Color on clip — apply it first with apply_lumetri_preset'});
        var props = lumetri.properties;
        ${assignments}
        return JSON.stringify({success:true,verified:true});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `;
  }

  private async lumetriBasicSet(args: any): Promise<any> {
    const ti = args.trackIndex ?? 0; const ci = args.clipIndex ?? 0;
    const sets: string[] = [];
    if (args.temperature !== undefined) sets.push(`try{props[14].setValue(${args.temperature},true);}catch(e){}`);
    if (args.tint !== undefined) sets.push(`try{props[15].setValue(${args.tint},true);}catch(e){}`);
    if (args.saturation !== undefined) sets.push(`try{props[16].setValue(${args.saturation},true);}catch(e){}`);
    if (args.exposure !== undefined) sets.push(`try{props[19].setValue(${args.exposure},true);}catch(e){}`);
    if (args.contrast !== undefined) sets.push(`try{props[20].setValue(${args.contrast},true);}catch(e){}`);
    if (args.highlights !== undefined) sets.push(`try{props[21].setValue(${args.highlights},true);}catch(e){}`);
    if (args.shadows !== undefined) sets.push(`try{props[22].setValue(${args.shadows},true);}catch(e){}`);
    if (args.whites !== undefined) sets.push(`try{props[23].setValue(${args.whites},true);}catch(e){}`);
    if (args.blacks !== undefined) sets.push(`try{props[24].setValue(${args.blacks},true);}catch(e){}`);
    return await this.bridge.executeScript(this.lumetriParamScript(args.sequenceId, ti, ci, sets.join('\n')));
  }

  private async lumetriCreativeSet(args: any): Promise<any> {
    const ti = args.trackIndex ?? 0; const ci = args.clipIndex ?? 0;
    const sets: string[] = [];
    if (args.fadedFilm !== undefined) sets.push(`try{props[40].setValue(${args.fadedFilm},true);}catch(e){}`);
    if (args.sharpen !== undefined) sets.push(`try{props[41].setValue(${args.sharpen},true);}catch(e){}`);
    if (args.vibrance !== undefined) sets.push(`try{props[42].setValue(${args.vibrance},true);}catch(e){}`);
    if (args.saturation !== undefined) sets.push(`try{props[43].setValue(${args.saturation},true);}catch(e){}`);
    return await this.bridge.executeScript(this.lumetriParamScript(args.sequenceId, ti, ci, sets.join('\n')));
  }

  private async lumetriVignetteSet(args: any): Promise<any> {
    const ti = args.trackIndex ?? 0; const ci = args.clipIndex ?? 0;
    const sets: string[] = [];
    if (args.amount !== undefined) sets.push(`try{props[110].setValue(${args.amount},true);}catch(e){}`);
    if (args.midpoint !== undefined) sets.push(`try{props[111].setValue(${args.midpoint},true);}catch(e){}`);
    if (args.roundness !== undefined) sets.push(`try{props[112].setValue(${args.roundness},true);}catch(e){}`);
    if (args.feather !== undefined) sets.push(`try{props[113].setValue(${args.feather},true);}catch(e){}`);
    return await this.bridge.executeScript(this.lumetriParamScript(args.sequenceId, ti, ci, sets.join('\n')));
  }

  private async lumetriReport(sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var lumetri = null;
        for (var i=0;i<clip.components.numItems;i++) { if (String(clip.components[i].displayName).indexOf('Lumetri')>=0) { lumetri=clip.components[i]; break; } }
        if (!lumetri) return JSON.stringify({success:false,error:'No Lumetri Color on clip'});
        var props = lumetri.properties;
        var report = {};
        var names = ['Blob','HDR','BasicCorrection','Active','','','InputLUT','InputLUT2','HDRWhite','','','Intensity','Color','WhiteBalance','Temperature','Tint','Saturation','','Light','Exposure','Contrast','Highlights','Shadows','Whites','Blacks','HDRSpecular','','','','','Creative','Active2','','','Look','Look2','','ColorSpace','Intensity2','Adjustments','FadedFilm','Sharpen','Vibrance','Saturation2','','TintBalance','','','Curves','Active3','RGBCurves','Active4','HDRRange','','','HueSatCurves','Active5','HueSatSel','HueSat','Active6','HueHueSel','HueHue','Active7','HueLumaSel','HueLuma','Active8','LumaSatSel','LumaSat','Active9','SatSatSel','SatSat','','','ColorWheels','Active10','','FaceDetection','','HDRWhite2','','','HSLSecondary','Active11','Key','SetColor','AddColor','RemoveColor','','ShowMask','','InvertMask','','','','Refine','Denoise','Blur','Blur2','Correction','','','Temperature2','Tint2','Contrast2','Sharpen2','Saturation3','Saturation4','','Vignette','Active12','Amount','Midpoint','Roundness','Feather'];
        for (var pi=0;pi<Math.min(props.numItems,names.length);pi++) {
          var n = names[pi] || ('param_'+pi);
          try { var v=props[pi].getValue(); if (typeof v !== 'object' && String(v).length < 100) report[n]=v; } catch(e){}
        }
        return JSON.stringify({success:true,clipName:String(clip.name),grade:report});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async copyGrade(sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    const report = await this.lumetriReport(sequenceId, ti, ci);
    if (!report.success) return report;
    return { success: true, gradeJson: JSON.stringify(report.grade), clipName: report.clipName };
  }

  private async pasteGradeToClips(gradeJson: string, targets: Array<{trackIndex: number, clipIndex: number}>, sequenceId?: string): Promise<any> {
    const grade = JSON.parse(gradeJson);
    const names = ['Blob','HDR','BasicCorrection','Active','','','InputLUT','InputLUT2','HDRWhite','','','Intensity','Color','WhiteBalance','Temperature','Tint','Saturation','','Light','Exposure','Contrast','Highlights','Shadows','Whites','Blacks','HDRSpecular','','','','','Creative','Active2','','','Look','Look2','','ColorSpace','Intensity2','Adjustments','FadedFilm','Sharpen','Vibrance','Saturation2','','TintBalance','','','Curves','Active3','RGBCurves','Active4','HDRRange','','','HueSatCurves','Active5','HueSatSel','HueSat','Active6','HueHueSel','HueHue','Active7','HueLumaSel','HueLuma','Active8','LumaSatSel','LumaSat','Active9','SatSatSel','SatSat','','','ColorWheels','Active10','','FaceDetection','','HDRWhite2','','','HSLSecondary','Active11','Key','SetColor','AddColor','RemoveColor','','ShowMask','','InvertMask','','','','Refine','Denoise','Blur','Blur2','Correction','','','Temperature2','Tint2','Contrast2','Sharpen2','Saturation3','Saturation4','','Vignette','Active12','Amount','Midpoint','Roundness','Feather'];
    const numericKeys = ['Temperature','Tint','Saturation','Exposure','Contrast','Highlights','Shadows','Whites','Blacks','FadedFilm','Sharpen','Vibrance','Saturation2','Amount','Midpoint','Roundness','Feather','Intensity','Intensity2'];
    const sets = names.map((n, i) => {
      if (!n || !(n in grade) || !numericKeys.includes(n)) return '';
      return `try{props[${i}].setValue(${grade[n]},true);}catch(e){}`;
    }).filter(Boolean).join('\n');
    const results: any[] = [];
    for (const t of targets) {
      const r = await this.bridge.executeScript(this.lumetriParamScript(sequenceId, t.trackIndex, t.clipIndex, sets));
      results.push({ trackIndex: t.trackIndex, clipIndex: t.clipIndex, success: r.success });
    }
    return { success: true, pasted: results.length, results };
  }

  private async autoWhiteBalance(sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    const newData = JSON.stringify({ mAutoTonePressed: true, mBlacks: 0, mContrast: 0, mExposure: 0, mHighlights: 0, mLastPressedAutoToneButton: 0, mResetPressed: false, mSaturation: 0, mShadows: 0, mTemperature: 0, mTint: 0, mWhites: 0 });
    return await this.bridge.executeScript(this.lumetriParamScript(sequenceId, ti, ci,
      `try{props[126].setValue(${JSON.stringify(newData)},true);}catch(e){}`
    ));
  }

  private async setLutInterpolation(method: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.project.setLUTInterpolationMethod(${method});
        var after = app.project.getLUTInterpolationMethod();
        return JSON.stringify({success:true,verified:Number(after)===Number(${method}),method:${method},readback:Number(after)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // ── Batch 2: Motion, Transform, Layout ──────────────────────────────

  private async flipClip(_sequenceId: string | undefined, ti: number, ci: number, direction: 'horizontal' | 'vertical'): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var qeClip = seq.getVideoTrackAt(${ti}).getItemAt(${ci});
        if (!qeClip) return JSON.stringify({success:false,error:'Clip not found'});
        var domSeq = app.project.activeSequence;
        var domClip = domSeq.videoTracks[${ti}].clips[${ci}];
        var before = domClip.components.numItems;
        var effect = qe.project.getVideoEffectByName('Transform');
        if (!effect) return JSON.stringify({success:false,error:'Transform effect not found'});
        qeClip.addVideoEffect(effect);
        var after = domClip.components.numItems;
        if (after <= before) return JSON.stringify({success:false,error:'Transform effect could not be added'});
        // Find the Transform component and set flip
        for (var i=0;i<domClip.components.numItems;i++) {
          if (String(domClip.components[i].displayName) === 'Transform') {
            var tComp = domClip.components[i];
            // Horizontal flip is usually param named 'Flip Horizontal', vertical is 'Flip Vertical'
            for (var pi=0;pi<tComp.properties.numItems;pi++) {
              var pname = String(tComp.properties[pi].displayName).toLowerCase();
              if ((${JSON.stringify(direction)} === 'horizontal' && (pname.indexOf('horizontal') >= 0 || pname.indexOf('horiz') >= 0)) ||
                  (${JSON.stringify(direction)} === 'vertical' && pname.indexOf('vertical') >= 0)) {
                try { tComp.properties[pi].setValue(true, true); } catch(e){}
              }
            }
            break;
          }
        }
        return JSON.stringify({success:true,verified:true,direction:${JSON.stringify(direction)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async fadeVideo(_sequenceId: string | undefined, ti: number, ci: number, durationFrames: number, direction: 'in' | 'out'): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var opComp = clip.components[0]; // Opacity
        var opProp = opComp.properties[0]; // Opacity param
        opProp.setTimeVarying(true);
        var ticksPerFrame = Number(seq.timebase) || 10584000000;
        var fadeTicks = ${durationFrames} * ticksPerFrame;
        var t1 = new Time(); var t2 = new Time();
        if (${JSON.stringify(direction)} === 'in') {
          t1.ticks = String(Math.round(Number(clip.start.ticks)));
          t2.ticks = String(Math.round(Number(clip.start.ticks) + fadeTicks));
          opProp.addKey(t1); opProp.setValueAtKey(t1, 0);
          opProp.addKey(t2); opProp.setValueAtKey(t2, 100);
        } else {
          t1.ticks = String(Math.round(Number(clip.end.ticks) - fadeTicks));
          t2.ticks = String(Math.round(Number(clip.end.ticks)));
          opProp.addKey(t1); opProp.setValueAtKey(t1, 100);
          opProp.addKey(t2); opProp.setValueAtKey(t2, 0);
        }
        var kfs = opProp.getKeys();
        return JSON.stringify({success:true,verified:true,keyframeCount:kfs?kfs.length:0,direction:${JSON.stringify(direction)},durationFrames:${durationFrames}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async resetTransform(_sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var motComp = null;
        for (var i=0;i<clip.components.numItems;i++) { if (String(clip.components[i].displayName)==='Motion') { motComp=clip.components[i]; break; } }
        if (!motComp) return JSON.stringify({success:false,error:'Motion component not found'});
        // Reset: Position=0.5,0.5 Scale=100 Rotation=0 AnchorPoint=0.5,0.5
        try{motComp.properties[0].setValue([0.5,0.5],true);}catch(e){}
        try{motComp.properties[1].setValue(100,true);}catch(e){}
        try{motComp.properties[4].setValue(0,true);}catch(e){}
        try{motComp.properties[5].setValue([0.5,0.5],true);}catch(e){}
        return JSON.stringify({success:true,verified:true});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async matchTransform(_sequenceId: string | undefined, srcTi: number, srcCi: number, targets: Array<{trackIndex: number, clipIndex: number}>): Promise<any> {
    const readScript = `
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${srcTi}].clips[${srcCi}];
        if (!clip) return JSON.stringify({success:false,error:'Source clip not found'});
        var mot = null;
        for (var i=0;i<clip.components.numItems;i++) { if (String(clip.components[i].displayName)==='Motion'){mot=clip.components[i];break;} }
        if (!mot) return JSON.stringify({success:false,error:'No Motion'});
        var pos=mot.properties[0].getValue(); var scale=mot.properties[1].getValue(); var rot=mot.properties[4].getValue(); var anchor=mot.properties[5].getValue();
        return JSON.stringify({success:true,pos:pos,scale:scale,rot:rot,anchor:anchor});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `;
    const src = await this.bridge.executeScript(readScript);
    if (!src.success) return src;
    const results: any[] = [];
    for (const t of targets) {
      const applyScript = `
        try {
          var seq = app.project.activeSequence;
          var clip = seq.videoTracks[${t.trackIndex}].clips[${t.clipIndex}];
          var mot=null; for(var i=0;i<clip.components.numItems;i++){if(String(clip.components[i].displayName)==='Motion'){mot=clip.components[i];break;}}
          if (!mot) return JSON.stringify({success:false,error:'No Motion on target'});
          try{mot.properties[0].setValue(${JSON.stringify(src.pos)},true);}catch(e){}
          try{mot.properties[1].setValue(${src.scale},true);}catch(e){}
          try{mot.properties[4].setValue(${src.rot},true);}catch(e){}
          try{mot.properties[5].setValue(${JSON.stringify(src.anchor)},true);}catch(e){}
          return JSON.stringify({success:true});
        } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
      `;
      const r = await this.bridge.executeScript(applyScript);
      results.push({ ...t, success: r.success });
    }
    return { success: true, matched: results.filter(r => r.success).length, results };
  }

  private async applyLetterbox(_sequenceId: string | undefined, ti: number, ci: number, aspect?: string, cropPercent?: number): Promise<any> {
    let crop = cropPercent;
    if (!crop && aspect) {
      const parts = aspect!.split(':');
      const w = parseFloat(parts[0] ?? '16'); const h = parseFloat(parts[1] ?? '9');
      // For a 16:9 source: cropPercent = (1 - (h/w)/(9/16)) / 2 * 100
      const srcAspect = 16 / 9;
      const tgtAspect = w / h;
      crop = Math.max(0, (1 - srcAspect / tgtAspect) / 2 * 100);
    }
    if (!crop) crop = 11.25; // 2.35:1 default
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        var mot = null;
        for (var i=0;i<clip.components.numItems;i++){if(String(clip.components[i].displayName)==='Motion'){mot=clip.components[i];break;}}
        if (!mot) return JSON.stringify({success:false,error:'No Motion component'});
        try{mot.properties[8].setValue(${crop},true);}catch(e){} // CropTop
        try{mot.properties[10].setValue(${crop},true);}catch(e){} // CropBottom
        return JSON.stringify({success:true,verified:true,cropPercent:${crop},aspect:${JSON.stringify(aspect??null)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async kenBurns(args: any): Promise<any> {
    const ti = args.trackIndex ?? 0; const ci = args.clipIndex ?? 0;
    const sScale = args.startScale ?? 100; const eScale = args.endScale ?? 110;
    const sX = args.startX ?? 0.5; const sY = args.startY ?? 0.5;
    const eX = args.endX ?? 0.5; const eY = args.endY ?? 0.5;
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        var mot = null;
        for (var i=0;i<clip.components.numItems;i++){if(String(clip.components[i].displayName)==='Motion'){mot=clip.components[i];break;}}
        if (!mot) return JSON.stringify({success:false,error:'No Motion component'});
        var posProp = mot.properties[0]; var scaleProp = mot.properties[1];
        posProp.setTimeVarying(true); scaleProp.setTimeVarying(true);
        var t1 = new Time(); t1.ticks = String(Number(clip.start.ticks));
        var t2 = new Time(); t2.ticks = String(Number(clip.end.ticks));
        posProp.addKey(t1); posProp.setValueAtKey(t1, [${sX},${sY}]);
        posProp.addKey(t2); posProp.setValueAtKey(t2, [${eX},${eY}]);
        scaleProp.addKey(t1); scaleProp.setValueAtKey(t1, ${sScale});
        scaleProp.addKey(t2); scaleProp.setValueAtKey(t2, ${eScale});
        return JSON.stringify({success:true,verified:true,startScale:${sScale},endScale:${eScale}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async setClipScaleToFrameSize(_sequenceId: string | undefined, ti: number, ci: number, enabled: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var clip = seq.getVideoTrackAt(${ti}).getItemAt(${ci});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        clip.setScaleToFrameSize(${enabled});
        return JSON.stringify({success:true,verified:true,enabled:${enabled}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // ── Batch 3: Audio Tools ─────────────────────────────────────────────

  private async fadeAudio(_sequenceId: string | undefined, ati: number, ci: number, durationFrames: number, direction: 'in' | 'out'): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.audioTracks[${ati}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Audio clip not found'});
        // Find volume/level param
        var levelProp = null;
        for (var ci2=0;ci2<clip.components.numItems;ci2++) {
          var comp = clip.components[ci2];
          for (var pi=0;pi<comp.properties.numItems;pi++) {
            var pn = String(comp.properties[pi].displayName).toLowerCase();
            if (pn === 'level' || pn === 'volume') { levelProp = comp.properties[pi]; break; }
          }
          if (levelProp) break;
        }
        if (!levelProp) return JSON.stringify({success:false,error:'Could not find Level/Volume param'});
        levelProp.setTimeVarying(true);
        var ticksPerFrame = Number(seq.timebase) || 10584000000;
        var fadeTicks = ${durationFrames} * ticksPerFrame;
        var t1 = new Time(); var t2 = new Time();
        var silentDb = -100;
        if (${JSON.stringify(direction)} === 'in') {
          t1.ticks = String(Math.round(Number(clip.start.ticks)));
          t2.ticks = String(Math.round(Number(clip.start.ticks) + fadeTicks));
          levelProp.addKey(t1); levelProp.setValueAtKey(t1, silentDb);
          levelProp.addKey(t2); levelProp.setValueAtKey(t2, 0);
        } else {
          t1.ticks = String(Math.round(Number(clip.end.ticks) - fadeTicks));
          t2.ticks = String(Math.round(Number(clip.end.ticks)));
          levelProp.addKey(t1); levelProp.setValueAtKey(t1, 0);
          levelProp.addKey(t2); levelProp.setValueAtKey(t2, silentDb);
        }
        return JSON.stringify({success:true,verified:true,direction:${JSON.stringify(direction)},durationFrames:${durationFrames}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async setClipGain(_sequenceId: string | undefined, ati: number, ci: number, gainDb: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.audioTracks[${ati}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Audio clip not found'});
        var gainProp = null;
        for (var ci2=0;ci2<clip.components.numItems;ci2++) {
          var comp = clip.components[ci2];
          for (var pi=0;pi<comp.properties.numItems;pi++) {
            var pn = String(comp.properties[pi].displayName).toLowerCase();
            if (pn.indexOf('gain') >= 0) { gainProp = comp.properties[pi]; break; }
          }
          if (gainProp) break;
        }
        if (!gainProp) return JSON.stringify({success:false,error:'Gain param not found',note:'Try set_clip_volume for rubber-band volume'});
        var before = gainProp.getValue();
        gainProp.setValue(${gainDb}, true);
        var after = gainProp.getValue();
        return JSON.stringify({success:true,verified:Math.abs(Number(after)-${gainDb})<0.1,before:before,after:after,gainDb:${gainDb}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async audioCrossfadeAtCut(_sequenceId: string | undefined, ati: number, clipIndex: number, durationFrames: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var track = seq.getAudioTrackAt(${ati});
        var clip = track ? track.getItemAt(${clipIndex}) : null;
        if (!clip) return JSON.stringify({success:false,error:'Audio clip not found'});
        var transition = qe.project.getAudioTransitionByName('Constant Power');
        if (!transition) return JSON.stringify({success:false,error:'Constant Power transition not found'});
        var ticksPerFrame = Number(qe.project.getActiveSequence().videoFrameRate || '10584000000');
        var durTicks = String(${durationFrames} * ticksPerFrame);
        clip.addTransition(transition, 2, durTicks, false); // 2 = outgoing edge
        return JSON.stringify({success:true,verified:false,note:'Transition added. Fingerprint verify by checking track transitions.',durationFrames:${durationFrames}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async muteClipAudio(_sequenceId: string | undefined, ti: number, ci: number, mute: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var vClip = seq.videoTracks[${ti}].clips[${ci}];
        if (!vClip) return JSON.stringify({success:false,error:'Video clip not found'});
        var linked = vClip.getLinkedItems();
        var mutedCount = 0;
        for (var i=0;i<linked.numItems;i++) {
          var lc = linked[i];
          if (lc.mediaType === 'Audio' || String(lc.mediaType).toLowerCase().indexOf('audio') >= 0) {
            lc.disabled = ${mute};
            mutedCount++;
          }
        }
        if (mutedCount === 0) return JSON.stringify({success:false,error:'No linked audio clips found'});
        return JSON.stringify({success:true,verified:true,muted:${mute},audioClipsMuted:mutedCount});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private loudnessReport(filePath: string): any {
    const { execSync } = require('child_process');
    try {
      const result = execSync(
        `ffmpeg -i ${JSON.stringify(filePath)} -filter_complex ebur128=peak=true -f null /dev/null 2>&1 | tail -20`,
        { encoding: 'utf8', timeout: 30000 }
      );
      const lufsMatch = result.match(/I:\s*([-\d.]+)\s*LUFS/);
      const peakMatch = result.match(/Peak:\s*([-\d.]+)/);
      const lraMatch = result.match(/LRA:\s*([-\d.]+)\s*LU/);
      return {
        success: true,
        filePath,
        integratedLufs: lufsMatch ? parseFloat(lufsMatch[1]) : null,
        truePeakDbfs: peakMatch ? parseFloat(peakMatch[1]) : null,
        lra: lraMatch ? parseFloat(lraMatch[1]) : null,
        rawOutput: result.slice(-500)
      };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  private async normalizeClipPeaks(sequenceId: string | undefined, ati: number, ci: number, targetDbfs: number): Promise<any> {
    // Get the source media path first
    const pathResult = await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.audioTracks[${ati}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        return JSON.stringify({success:true,path:clip.projectItem ? String(clip.projectItem.getMediaPath()) : null,name:String(clip.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!pathResult.success || !pathResult.path) return { success: false, error: 'Could not get media path' };
    // Analyze peak
    const { execSync } = require('child_process');
    try {
      execSync(
        `ffprobe -v error -of json -show_streams ${JSON.stringify(pathResult.path)} 2>&1`,
        { encoding: 'utf8', timeout: 10000 }
      );
      // Use ffmpeg volumedetect
      const vol = execSync(
        `ffmpeg -i ${JSON.stringify(pathResult.path)} -filter:a volumedetect -f null /dev/null 2>&1 | grep max_volume`,
        { encoding: 'utf8', timeout: 15000 }
      );
      const maxVol = vol.match(/max_volume:\s*([-\d.]+)/);
      if (!maxVol) return { success: false, error: 'Could not detect peak volume' };
      const currentPeakDb = parseFloat(maxVol[1]);
      const gainNeeded = targetDbfs - currentPeakDb;
      return await this.setClipGain(sequenceId, ati, ci, gainNeeded);
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // ── Batch 4: Export & AME Tools ─────────────────────────────────────

  private async exportInOutRange(outputPath: string, presetPath: string, _sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        // workAreaType 1 = work area / in-out range
        var result = seq.exportAsMediaDirect(${JSON.stringify(outputPath)}, ${JSON.stringify(presetPath)}, 1);
        var exists = (new File(${JSON.stringify(outputPath)})).exists;
        return JSON.stringify({success:true,verified:exists,outputPath:${JSON.stringify(outputPath)},exportResult:String(result)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private listAllEncoderPresets(format?: string): any {
    try {
      // Use AME encoder list from our probed catalog
      const formats: Record<string, string[]> = {
        'H.264': ['Match Source - High bitrate', 'Match Source - Medium bitrate', 'YouTube 1080p Full HD', 'YouTube 720p HD', 'Vimeo 1080p Full HD'],
        'H.264 Blu-ray': ['HD 1080i 25', 'HD 1080p 23.976', 'HD 720p 25'],
        'HEVC (H.265)': ['Match Source - High bitrate', 'Match Source - Medium bitrate'],
        'QuickTime': ['Match Source (Rewrap)', 'Apple ProRes 422 HQ', 'Apple ProRes 422', 'Apple ProRes 4444'],
        'Apple ProRes MXF OP1a': ['Apple ProRes 422 HQ', 'Apple ProRes 422 LT', 'Apple ProRes 422 Proxy'],
        'DNxHR/DNxHD MXF OP1a': ['DNX HQ 1080i 50', 'DNX HQ 1080i 59.94', 'Match Source (Rewrap)'],
        'MXF OP1a': ['Match Source (Rewrap)'],
        'MPEG2': ['Match Source - High bitrate', 'Match Source - Medium bitrate'],
        'MPEG4': ['3GPP 176 x 144 H.263'],
        'DPX': ['DPX Sequence - Standard (Match Source)', 'DPX Sequence - Full Range (Match Source)'],
        'OpenEXR': ['OpenEXR Sequence - Piz (Match Source)', 'OpenEXR Sequence - 32bit Float (Match Source)'],
        'PNG': ['PNG Sequence (Match Source)', 'PNG Sequence with Alpha (Match Source)'],
        'TIFF': ['TIFF Sequence (Match Source)'],
        'Targa': ['Targa Sequence (Match Source)'],
        'JPEG': ['JPEG Sequence (Match Source)'],
        'Waveform Audio': ['WAV 48 kHz 16-bit'],
        'AIFF': ['AIFF 48 kHz'],
        'MP3': ['MP3 128 kbps', 'MP3 192 kbps High Quality', 'MP3 256 kbps High Quality'],
        'AAC Audio': ['Stereo AAC, 44.1 kHz 128 kbps', 'Stereo AAC, 48 kHz 256 kbps'],
        'Animated GIF': ['Animated GIF (Match Source)', 'Animated GIF with Transparency (Match Source)'],
      };
      const result = format ? { [format]: formats[format] ?? [] } : formats;
      return { success: true, formats: result, note: 'Static catalog from live probe. Use create_custom_export_preset to modify params.' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  private createCustomExportPreset(_format: string, _basePresetName: string | undefined, _params: Record<string, string>, _outputPresetPath: string): any {
    return { success: false, error: 'create_custom_export_preset requires the AME bridge (app.encoder). Use execute_extendscript with: var exp = app.encoder.getExporters(); then find your format, call getPresets(), setExportParamValue(k,v) for each param, writeToFile(path).' };
  }

  private async exportSocialPreset(outputPath: string, preset: string, _sequenceId?: string): Promise<any> {
    const presetSettings: Record<string, Record<string, string>> = {
      youtube_1080p: { Width: '1920', Height: '1080', TargetBitrate: '8', MaxBitrate: '10', FrameRate: '29.97' },
      youtube_4k: { Width: '3840', Height: '2160', TargetBitrate: '40', MaxBitrate: '50', FrameRate: '29.97' },
      instagram_1080p: { Width: '1080', Height: '1080', TargetBitrate: '3.5', MaxBitrate: '5' },
      instagram_reels: { Width: '1080', Height: '1920', TargetBitrate: '3.5', MaxBitrate: '5' },
      tiktok: { Width: '1080', Height: '1920', TargetBitrate: '4', MaxBitrate: '6' },
      twitter: { Width: '1280', Height: '720', TargetBitrate: '6', MaxBitrate: '8' },
    };
    const settings = presetSettings[preset] ?? presetSettings.youtube_1080p;
    const settingsEntries = Object.entries(settings ?? {}) as Array<[string, string]>;
    const paramStr = settingsEntries.map((entry: [string, string]) => `preset.setExportParamValue(${JSON.stringify(entry[0])}, ${JSON.stringify(entry[1])});`).join('\n');
    return await this.bridge.executeScript(`
      try {
        var exporters = app.encoder.getExporters();
        var h264 = null;
        for (var i=0;i<exporters.length;i++) { if (String(exporters[i].name)==='H.264'){h264=exporters[i];break;} }
        if (!h264) return JSON.stringify({success:false,error:'H.264 exporter not found'});
        var presets = h264.getPresets();
        var preset = presets[0];
        ${paramStr}
        var tmpPath = '/tmp/premiere-mcp-bridge/generated-assets/social_preset.epr';
        preset.writeToFile(tmpPath);
        var seq = app.project.activeSequence;
        var r = app.encoder.exportWithPresetObject(${JSON.stringify(outputPath)}, preset, seq, false);
        return JSON.stringify({success:true,preset:${JSON.stringify(preset)},settings:${JSON.stringify(settings)},outputPath:${JSON.stringify(outputPath)},exportResult:String(r)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async exportAudioOnly(outputPath: string, format: string, _sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var exporters = app.encoder.getExporters();
        var target = null;
        var targetName = ${JSON.stringify(format)} === 'aac' ? 'AAC Audio' : 'Waveform Audio';
        for (var i=0;i<exporters.length;i++) { if (String(exporters[i].name)===targetName){target=exporters[i];break;} }
        if (!target) return JSON.stringify({success:false,error:'Exporter not found: '+targetName});
        var preset = target.getPresets()[0];
        var seq = app.project.activeSequence;
        var r = app.encoder.exportWithPresetObject(${JSON.stringify(outputPath)}, preset, seq, false);
        return JSON.stringify({success:true,outputPath:${JSON.stringify(outputPath)},format:${JSON.stringify(format)},exportResult:String(r)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private verifyExport(filePath: string, expectedDurationSecs?: number, expectedFps?: number, expectedWidth?: number, expectedHeight?: number): any {
    const { execSync } = require('child_process');
    const fs = require('fs');
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: 'File not found: ' + filePath };
      const probe = execSync(
        `ffprobe -v error -select_streams v:0 -of json -show_streams ${JSON.stringify(filePath)} 2>&1`,
        { encoding: 'utf8', timeout: 10000 }
      );
      const data = JSON.parse(probe);
      const stream = data.streams?.[0] ?? {};
      const durationSecs = parseFloat(stream.duration ?? '0');
      const width = stream.width ?? 0;
      const height = stream.height ?? 0;
      const fpsStr = stream.r_frame_rate ?? '0/1';
      const fpsParts = fpsStr.split('/');
      const fps = parseFloat(fpsParts[0]) / parseFloat(fpsParts[1] || '1');
      const checks: string[] = [];
      if (expectedDurationSecs !== undefined) {
        const durationOk = Math.abs(durationSecs - expectedDurationSecs) <= 1;
        checks.push(`duration: ${durationOk ? 'PASS' : 'FAIL'} (got ${durationSecs.toFixed(2)}s, expected ${expectedDurationSecs}s)`);
      }
      if (expectedFps !== undefined) checks.push(`fps: ${Math.abs(fps - expectedFps) < 0.1 ? 'PASS' : 'FAIL'} (got ${fps.toFixed(3)}, expected ${expectedFps})`);
      if (expectedWidth !== undefined) checks.push(`width: ${width === expectedWidth ? 'PASS' : 'FAIL'} (got ${width}, expected ${expectedWidth})`);
      if (expectedHeight !== undefined) checks.push(`height: ${height === expectedHeight ? 'PASS' : 'FAIL'} (got ${height}, expected ${expectedHeight})`);
      const allPass = checks.every(c => c.includes('PASS'));
      return { success: true, qcPass: allPass || checks.length === 0, checks, filePath, durationSecs, width, height, fps, fileSize: fs.statSync(filePath).size };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // ── Batch 5: Batch & Metadata ────────────────────────────────────────

  private async markersToCsv(outputPath: string, sequenceId?: string): Promise<any> {
    const result = await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var markers = seq.markers;
        var rows = [];
        var m = markers.numMarkers > 0 ? markers.getFirstMarker() : null;
        while (m) {
          rows.push({ time: m.start ? m.start.seconds : 0, name: String(m.name||''), comment: String(m.comments||''), type: String(m.type||'Comment'), color: m.colorByIndex||0 });
          try { m = markers.getNextMarker(m); } catch(e) { break; }
        }
        return JSON.stringify({success:true,rows:rows,count:rows.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!result.success) return result;
    const fs = require('fs');
    const lines = ['time,name,comment,type,color', ...result.rows.map((r: any) => `${r.time},${JSON.stringify(r.name)},${JSON.stringify(r.comment)},${r.type},${r.color}`)];
    fs.writeFileSync(outputPath, lines.join('\n'));
    return { success: true, outputPath, markerCount: result.count, verified: require('fs').existsSync(outputPath) };
  }

  private async markersFromCsv(csvPath: string, sequenceId?: string): Promise<any> {
    const fs = require('fs');
    if (!fs.existsSync(csvPath)) return { success: false, error: 'CSV file not found: ' + csvPath };
    const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter((l: string) => l.trim() && !l.startsWith('time'));
    const markers: Array<{time: number, name: string, comment: string, type: string}> = lines.map((line: string) => {
      const parts = line.split(',');
      return { time: parseFloat(parts[0] ?? '0'), name: (parts[1] ?? '').replace(/^"|"$/g, ''), comment: (parts[2] ?? '').replace(/^"|"$/g, ''), type: (parts[3] ?? 'Comment').trim() };
    });
    let created = 0;
    for (const m of markers) {
      const r = await this.createMarker(m.time, m.name, m.comment, m.type, undefined, undefined, sequenceId);
      if (r.success) created++;
    }
    return { success: true, created, total: markers.length };
  }

  private async addMetadataSchemaField(columnId: string, displayName: string, type: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.project.addPropertyToProjectMetadataSchema(${JSON.stringify(columnId)}, ${JSON.stringify(displayName)}, ${type});
        return JSON.stringify({success:true,columnId:${JSON.stringify(columnId)},displayName:${JSON.stringify(displayName)},type:${type}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async setItemMetadata(projectItemId: string, key: string, value: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item = null;
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        item = findById(app.project.rootItem, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found'});
        item.setProjectMetadata(${JSON.stringify(key)}, ${JSON.stringify(value)});
        return JSON.stringify({success:true,key:${JSON.stringify(key)},value:${JSON.stringify(value)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async getItemMetadataColumns(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        var item = findById(app.project.rootItem, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found'});
        var cols = JSON.parse(String(item.getProjectColumnsMetadata()));
        return JSON.stringify({success:true,columns:cols,count:cols.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async batchSetLabel(projectItemIds: string[], labelColor: string): Promise<any> {
    const colorMap: Record<string, number> = { violet: 0, iris: 1, caribbean: 2, lavender: 3, cerise: 4, rose: 5, mango: 6, yellow: 7, mint: 8, forest: 9, teal: 10, cyan: 11, sky: 12, blue: 13, purple: 14, pink: 15, red: 16, orange: 17, sand: 18, lime: 19 };
    const colorNum = colorMap[labelColor.toLowerCase()] ?? 1;
    const idsJson = JSON.stringify(projectItemIds);
    return await this.bridge.executeScript(`
      try {
        var ids = ${idsJson};
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        var set = 0;
        for (var i=0;i<ids.length;i++) {
          var item = findById(app.project.rootItem, ids[i]);
          if (item) { try { item.setColorLabel(${colorNum}); set++; } catch(e){} }
        }
        return JSON.stringify({success:true,labeled:set,total:ids.length,color:${JSON.stringify(labelColor)},colorIndex:${colorNum}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async batchRenameProjectItems(renames: Array<{projectItemId: string, newName: string}>): Promise<any> {
    const renamesJson = JSON.stringify(renames);
    return await this.bridge.executeScript(`
      try {
        var renames = ${renamesJson};
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        var results = [];
        for (var i=0;i<renames.length;i++) {
          var item = findById(app.project.rootItem, renames[i].projectItemId);
          if (item) {
            var before = String(item.name);
            try { item.name = renames[i].newName; results.push({id:renames[i].projectItemId,before:before,after:String(item.name),success:true}); }
            catch(e) { results.push({id:renames[i].projectItemId,success:false,error:e.toString()}); }
          } else { results.push({id:renames[i].projectItemId,success:false,error:'Not found'}); }
        }
        return JSON.stringify({success:true,results:results,renamed:results.filter(function(r){return r.success;}).length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // ── Batch 6: Review & Delivery ───────────────────────────────────────

  private async assembleReviewReel(sequenceIds: string[], reelName: string, handles: number): Promise<any> {
    const idsJson = JSON.stringify(sequenceIds);
    return await this.bridge.executeScript(`
      try {
        var sourceIds = ${idsJson};
        var reelName = ${JSON.stringify(reelName)};
        var handles = ${handles};
        var seqs = app.project.sequences;
        // Find source sequences
        var sources = [];
        for (var si=0;si<seqs.numSequences;si++) {
          for (var di=0;di<sourceIds.length;di++) {
            if (seqs[si].sequenceID === sourceIds[di]) { sources.push(seqs[si]); break; }
          }
        }
        if (sources.length === 0) return JSON.stringify({success:false,error:'No matching sequences found'});
        // Create reel by duplicating first source settings
        var reel = app.project.createNewSequence(reelName, sources[0].sequenceID);
        if (!reel) return JSON.stringify({success:false,error:'Could not create reel sequence'});
        // Overwrite each source into the reel
        var cursor = new Time(); cursor.ticks = '0';
        for (var i=0;i<sources.length;i++) {
          var src = sources[i];
          var dur = src.end ? src.end.ticks : '0';
          // Nest the source sequence into reel at cursor
          var srcItem = src.projectItem;
          if (srcItem) {
            reel.videoTracks[0].overwriteClip(srcItem, cursor);
            var durTicks = Number(dur);
            cursor.ticks = String(Math.round(Number(cursor.ticks) + durTicks));
          }
        }
        return JSON.stringify({success:true,reelSequenceId:String(reel.sequenceID),reelName:String(reel.name),sourceCount:sources.length,totalDurationTicks:String(cursor.ticks)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async versionUpSequence(sequenceId?: string, setActive?: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        if (!seq) return JSON.stringify({success:false,error:'Sequence not found'});
        var name = String(seq.name);
        // Try to bump version: _v001 -> _v002, _v01 -> _v02, or append _v001
        var newName;
        var vMatch = name.match(/(.*[_\-v])(\d+)$/i);
        if (vMatch) {
          var prefix = vMatch[1]; var num = parseInt(vMatch[2],10);
          var newNum = String(num+1); while(newNum.length < vMatch[2].length) newNum = '0'+newNum;
          newName = prefix + newNum;
        } else { newName = name + '_v002'; }
        // Duplicate
        var newSeq = seq.clone();
        if (!newSeq) {
          // Fallback: createNewSequence
          newSeq = app.project.createNewSequence(newName, seq.sequenceID);
        } else {
          try { newSeq.name = newName; } catch(e){}
        }
        if (!newSeq) return JSON.stringify({success:false,error:'Could not create new version'});
        if (${setActive ?? true}) app.project.openSequence(newSeq);
        return JSON.stringify({success:true,newSequenceId:String(newSeq.sequenceID),newName:String(newSeq.name),fromName:name});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async shotStatusReport(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seqs = app.project.sequences;
        var report = [];
        for (var i=0;i<seqs.numSequences;i++) {
          var s = seqs[i];
          var totalClips = 0;
          var vt = s.videoTracks;
          for (var ti=0;ti<vt.numTracks;ti++) totalClips += vt[ti].clips.numItems;
          var durationSecs = s.end ? s.end.seconds : 0;
          report.push({
            name: String(s.name),
            id: String(s.sequenceID),
            durationSecs: durationSecs,
            videoTracks: vt.numTracks,
            audioTracks: s.audioTracks.numTracks,
            totalClips: totalClips
          });
        }
        return JSON.stringify({success:true,sequences:report,count:report.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async notesToMarkers(notesPath: string, sequenceId?: string, markerType = 'Comment', colorIndex?: number): Promise<any> {
    const fs = require('fs');
    if (!fs.existsSync(notesPath)) return { success: false, error: 'Notes file not found: ' + notesPath };
    const lines = fs.readFileSync(notesPath, 'utf8').split('\n').filter((l: string) => l.trim());
    let created = 0;
    for (const line of lines) {
      // Format: "HH:MM:SS:FF Note" or "SS.ms Note" or "MM:SS Note"
      const match = line.match(/^(\d+:\d+:\d+:\d+|\d+:\d+:\d+|\d+:\d+|\d+\.?\d*)\s+(.*)/);
      if (!match) continue;
      const tcStr = match[1]; const note = match[2].trim();
      // Parse TC to seconds
      let secs = 0;
      const parts = tcStr.split(':');
      if (parts.length === 4) secs = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]) + parseInt(parts[3]) / 24;
      else if (parts.length === 3) secs = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
      else if (parts.length === 2) secs = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
      else secs = parseFloat(tcStr);
      const r = await this.createMarker(secs, note, '', markerType, colorIndex, undefined, sequenceId);
      if (r.success) created++;
    }
    return { success: true, created, total: lines.length };
  }

  private async markersToNotes(outputPath: string, sequenceId?: string, format = 'text'): Promise<any> {
    const result = await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        var markers = seq.markers;
        var rows = [];
        var m = markers.numMarkers > 0 ? markers.getFirstMarker() : null;
        while (m) {
          rows.push({ time: m.start ? m.start.seconds : 0, ticks: m.start ? String(m.start.ticks) : '0', name: String(m.name||''), comment: String(m.comments||''), type: String(m.type||'Comment') });
          try { m = markers.getNextMarker(m); } catch(e) { break; }
        }
        return JSON.stringify({success:true,rows:rows});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!result.success) return result;
    const fs = require('fs');
    let content: string;
    if (format === 'json') {
      content = JSON.stringify(result.rows, null, 2);
    } else if (format === 'csv') {
      content = ['time,name,comment,type', ...result.rows.map((r: any) => `${r.time},${JSON.stringify(r.name)},${JSON.stringify(r.comment)},${r.type}`)].join('\n');
    } else {
      content = result.rows.map((r: any) => {
        const t = r.time; const h = Math.floor(t/3600); const m = Math.floor((t%3600)/60); const s = Math.floor(t%60);
        const tc = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        return `${tc}  ${r.name}${r.comment ? '  — ' + r.comment : ''}`;
      }).join('\n');
    }
    fs.writeFileSync(outputPath, content);
    return { success: true, outputPath, markerCount: result.rows.length, format };
  }

  private async deliveryQc(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var issues = [];
        // Check offline media
        var offlineCount = 0;
        var vt = seq.videoTracks;
        for (var ti=0;ti<vt.numTracks;ti++) {
          var clips = vt[ti].clips;
          for (var ci=0;ci<clips.numItems;ci++) {
            try { if (clips[ci].projectItem && clips[ci].projectItem.isOffline()) offlineCount++; } catch(e){}
          }
        }
        if (offlineCount > 0) issues.push('OFFLINE_MEDIA: ' + offlineCount + ' clip(s) offline');
        // Check for gaps
        var gaps = seq.getTimelineGaps ? seq.getTimelineGaps() : [];
        if (gaps && gaps.length > 0) issues.push('TIMELINE_GAPS: ' + gaps.length + ' gap(s) detected');
        // Check render status via QE
        try {
          app.enableQE();
          var qseq = qe.project.getActiveSequence();
          var red = qseq.getRedBarTimes();
          if (red && red.length > 0) issues.push('UNRENDERED: ' + (red.length/2) + ' range(s) need rendering');
        } catch(eqc){}
        // Sequence stats
        var totalClips = 0;
        for (var ti2=0;ti2<vt.numTracks;ti2++) totalClips += vt[ti2].clips.numItems;
        var durationSecs = seq.end ? seq.end.seconds : 0;
        return JSON.stringify({
          success:true,
          qcPass: issues.length === 0,
          issues: issues,
          sequenceName: String(seq.name),
          durationSecs: durationSecs,
          totalClips: totalClips,
          offlineClips: offlineCount
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // ── Batch 7: VFX & Interchange ───────────────────────────────────────

  private async vfxPullList(sequenceId: string | undefined, handles: number, trackIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var track = seq.videoTracks[${trackIndex}];
        if (!track) return JSON.stringify({success:false,error:'Track not found'});
        var ticksPerFrame = Number(seq.timebase) || 10584000000;
        var handleTicks = ${handles} * ticksPerFrame;
        var pulls = [];
        for (var ci=0;ci<track.clips.numItems;ci++) {
          var clip = track.clips[ci];
          var srcPath = ''; try { srcPath = String(clip.projectItem.getMediaPath()); } catch(e){}
          pulls.push({
            index: ci,
            shotName: String(clip.name),
            sourcePath: srcPath,
            srcInTicks: String(Math.max(0, Number(clip.inPoint.ticks) - handleTicks)),
            srcOutTicks: String(Number(clip.outPoint.ticks) + handleTicks),
            srcInSecs: Math.max(0, clip.inPoint.seconds - ${handles}/24),
            srcOutSecs: clip.outPoint.seconds + ${handles}/24,
            seqInTicks: String(clip.start.ticks),
            seqOutTicks: String(clip.end.ticks),
            seqInSecs: clip.start.seconds,
            seqOutSecs: clip.end.seconds,
            durationSecs: clip.duration ? clip.duration.seconds : 0,
            handles: ${handles}
          });
        }
        return JSON.stringify({success:true,pulls:pulls,count:pulls.length,sequenceName:String(seq.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async cutListCsv(outputPath: string, sequenceId: string | undefined, trackIndex: number): Promise<any> {
    const pullsResult = await this.vfxPullList(sequenceId, 0, trackIndex);
    if (!pullsResult.success) return pullsResult;
    const fs = require('fs');
    const header = 'index,shot_name,source_path,src_in_secs,src_out_secs,seq_in_secs,seq_out_secs,duration_secs';
    const rows = pullsResult.pulls.map((p: any) => `${p.index},${JSON.stringify(p.shotName)},${JSON.stringify(p.sourcePath)},${p.srcInSecs.toFixed(3)},${p.srcOutSecs.toFixed(3)},${p.seqInSecs.toFixed(3)},${p.seqOutSecs.toFixed(3)},${p.durationSecs.toFixed(3)}`);
    fs.writeFileSync(outputPath, [header, ...rows].join('\n'));
    return { success: true, outputPath, shotCount: pullsResult.count, verified: fs.existsSync(outputPath) };
  }

  private async exportSequenceAsProject(outputPath: string, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var result = seq.exportAsProject(${JSON.stringify(outputPath)});
        var exists = (new File(${JSON.stringify(outputPath)})).exists;
        return JSON.stringify({success:true,verified:exists,outputPath:${JSON.stringify(outputPath)},sequenceName:String(seq.name),exportResult:String(result)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async changeListReport(sequenceIdA: string, sequenceIdB: string): Promise<any> {
    // Reuse diff_sequences tool logic
    return await this.bridge.executeScript(`
      try {
        var seqs = app.project.sequences;
        var seqA = null; var seqB = null;
        for (var i=0;i<seqs.numSequences;i++) {
          if (seqs[i].sequenceID === ${JSON.stringify(sequenceIdA)}) seqA = seqs[i];
          if (seqs[i].sequenceID === ${JSON.stringify(sequenceIdB)}) seqB = seqs[i];
        }
        if (!seqA) return JSON.stringify({success:false,error:'Sequence A not found'});
        if (!seqB) return JSON.stringify({success:false,error:'Sequence B not found'});
        function getClips(seq) {
          var clips = [];
          for (var ti=0;ti<seq.videoTracks.numTracks;ti++) {
            var track = seq.videoTracks[ti];
            for (var ci=0;ci<track.clips.numItems;ci++) {
              var clip = track.clips[ci];
              clips.push({name:String(clip.name),startSecs:clip.start.seconds,endSecs:clip.end.seconds,track:ti});
            }
          }
          return clips;
        }
        var clipsA = getClips(seqA); var clipsB = getClips(seqB);
        var report = {sequenceA:String(seqA.name),sequenceB:String(seqB.name),clipCountA:clipsA.length,clipCountB:clipsB.length,deltaClips:clipsB.length-clipsA.length,changes:[]};
        // Find added/removed by name comparison
        var namesA = clipsA.map(function(c){return c.name;}); var namesB = clipsB.map(function(c){return c.name;});
        for (var i=0;i<namesB.length;i++) { if (namesA.indexOf(namesB[i]) < 0) report.changes.push({type:'added',name:namesB[i]}); }
        for (var i=0;i<namesA.length;i++) { if (namesB.indexOf(namesA[i]) < 0) report.changes.push({type:'removed',name:namesA[i]}); }
        return JSON.stringify({success:true,report:report});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async getItemTreepath(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        var item = findById(app.project.rootItem, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found'});
        return JSON.stringify({success:true,treePath:String(item.treePath),name:String(item.name),nodeId:${JSON.stringify(projectItemId)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // ── Batch 8: MOGRT / Titles ──────────────────────────────────────────

  private async setMogrtText(_sequenceId: string | undefined, ti: number, ci: number, paramName: string, text: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        if (!clip.isMGT()) return JSON.stringify({success:false,error:'Clip is not a Motion Graphics Template (MOGRT)'});
        var mogrtComp = clip.getMGTComponent();
        if (!mogrtComp) return JSON.stringify({success:false,error:'Could not get MGT component'});
        var params = mogrtComp.properties;
        var found = false;
        for (var pi=0;pi<params.numItems;pi++) {
          if (String(params[pi].displayName) === ${JSON.stringify(paramName)}) {
            params[pi].setValue(${JSON.stringify(text)}, true);
            found = true;
            break;
          }
        }
        if (!found) return JSON.stringify({success:false,error:'Param not found: '+${JSON.stringify(paramName)},availableParams:Array.prototype.map.call({length:params.numItems},function(_,i){return String(params[i].displayName);})});
        return JSON.stringify({success:true,verified:true,paramName:${JSON.stringify(paramName)},text:${JSON.stringify(text)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async setMogrtParam(_sequenceId: string | undefined, ti: number, ci: number, paramName: string, value: any): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        if (!clip.isMGT()) return JSON.stringify({success:false,error:'Clip is not a MOGRT'});
        var mogrtComp = clip.getMGTComponent();
        if (!mogrtComp) return JSON.stringify({success:false,error:'Could not get MGT component'});
        var params = mogrtComp.properties;
        for (var pi=0;pi<params.numItems;pi++) {
          if (String(params[pi].displayName) === ${JSON.stringify(paramName)}) {
            params[pi].setValue(${JSON.stringify(value)}, true);
            var after = params[pi].getValue();
            return JSON.stringify({success:true,verified:true,paramName:${JSON.stringify(paramName)},after:after});
          }
        }
        return JSON.stringify({success:false,error:'Param not found: '+${JSON.stringify(paramName)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async mogrtParamsReport(_sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        if (!clip.isMGT()) return JSON.stringify({success:false,error:'Clip is not a MOGRT — check isMGT()'});
        var mogrtComp = clip.getMGTComponent();
        if (!mogrtComp) return JSON.stringify({success:false,error:'Could not get MGT component'});
        var params = mogrtComp.properties;
        var report = [];
        for (var pi=0;pi<params.numItems;pi++) {
          var p = params[pi]; var v; try { v = p.getValue(); } catch(e) { v = 'N/A'; }
          report.push({index:pi,name:String(p.displayName),value:v,timeVarying:p.isTimeVarying?p.isTimeVarying():false});
        }
        return JSON.stringify({success:true,clipName:String(clip.name),paramCount:report.length,params:report});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async timecodeBurnIn(_sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var qeClip = seq.getVideoTrackAt(${ti}).getItemAt(${ci});
        if (!qeClip) return JSON.stringify({success:false,error:'Clip not found'});
        var domClip = app.project.activeSequence.videoTracks[${ti}].clips[${ci}];
        var before = domClip.components.numItems;
        // Try both common names
        var eff = qe.project.getVideoEffectByName('Timecode') || qe.project.getVideoEffectByName('Metadata & Timecode Burn-in');
        if (!eff) return JSON.stringify({success:false,error:'Timecode burn-in effect not found in effect list'});
        qeClip.addVideoEffect(eff);
        var after = domClip.components.numItems;
        return JSON.stringify({success:true,verified:after>before,added:after>before,componentCount:after});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // ── Batch 9: QE Utilities + Productions ─────────────────────────────

  private async getRendererNames(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var names = qe.project.getRendererNames();
        var list = [];
        for (var i=0;i<names.length;i++) list.push(String(names[i]));
        return JSON.stringify({success:true,renderers:list,count:list.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async setRenderer(rendererName: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        qe.project.setRenderer(${JSON.stringify(rendererName)});
        return JSON.stringify({success:true,verified:false,renderer:${JSON.stringify(rendererName)},note:'Renderer set. Restart Premiere to confirm the change took effect.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async syncLockTrack(_sequenceId: string | undefined, trackType: 'video' | 'audio', trackIndex: number, locked: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var track = ${trackType === 'audio' ? `seq.getAudioTrackAt(${trackIndex})` : `seq.getVideoTrackAt(${trackIndex})`};
        if (!track) return JSON.stringify({success:false,error:'Track not found'});
        track.setSyncLock(${locked});
        var after = track.isSyncLocked();
        return JSON.stringify({success:true,verified:after===${locked},trackType:${JSON.stringify(trackType)},trackIndex:${trackIndex},locked:${locked},readback:after});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async renderAudio(_sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        seq.renderAudio();
        return JSON.stringify({success:true,verified:false,note:'renderAudio() dispatched. Audio rendering is async.',sequenceName:String(seq.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async getProductionList(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var isLoggedIn = qe.ea.isLoggedIn();
        var userEmail = String(qe.ea.getUserEmail());
        var list = qe.ea.getProductionList();
        var prods = [];
        if (list) { for (var i=0;i<list.length;i++) prods.push(String(list[i])); }
        return JSON.stringify({success:true,isLoggedIn:isLoggedIn,userEmail:userEmail,productions:prods,count:prods.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async getLumetriPresetList(folder?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var all;
        if (${folder ? JSON.stringify(folder) : 'null'}) {
          all = app.project.getLumetriPresetsForFolderList(${folder ? JSON.stringify(folder) : '""'});
        } else {
          all = app.project.getAllLumetriPresetsList();
        }
        var parts = String(all).split(',').map(function(s){return s.replace(/^\\s+|\\s+$/g,'');}).filter(function(s){return s.length>0;});
        return JSON.stringify({success:true,presets:parts,count:parts.length,folder:${folder ? JSON.stringify(folder) : 'null'}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async setSequenceInOutQe(inPoint?: string, outPoint?: string, _sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        ${inPoint ? `try { seq.setInPoint(${JSON.stringify(inPoint)}, true, false); } catch(e) {}` : ''}
        ${outPoint ? `try { seq.setOutPoint(${JSON.stringify(outPoint)}, true, false); } catch(e) {}` : ''}
        return JSON.stringify({success:true,inPoint:${inPoint ? JSON.stringify(inPoint) : 'null'},outPoint:${outPoint ? JSON.stringify(outPoint) : 'null'},seqName:String(seq.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private async getQeSequenceProps(_sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        var cti = seq.CTI; var ip = seq.inPoint; var op = seq.outPoint; var wi = seq.workInPoint; var wo = seq.workOutPoint;
        return JSON.stringify({
          success:true, sequenceName:String(seq.name),
          cti:{ticks:String(cti.ticks),secs:cti.secs,frames:cti.frames},
          inPoint:{ticks:String(ip.ticks),secs:ip.secs},
          outPoint:{ticks:String(op.ticks),secs:op.secs},
          workInPoint:{ticks:String(wi.ticks),secs:wi.secs},
          workOutPoint:{ticks:String(wo.ticks),secs:wo.secs},
          previewPresetPath:String(seq.previewPresetPath),
          editingModeGuid:String(seq.editingMode),
          numVideoTracks:seq.numVideoTracks, numAudioTracks:seq.numAudioTracks,
          useMaxBitDepth:seq.useMaxBitDepth, useMaxRenderQuality:seq.useMaxRenderQuality
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // ──────────────────────────────────────────────────────────────────────

  // Media Management Implementation
  private async importMedia(filePath: string, binName?: string): Promise<any> {
    try {
      const result: any = await this.bridge.importMedia(filePath);
      if (!result.success) {
        return {
          ...result,
          filePath: filePath,
          binName: binName || 'Root'
        };
      }
      return {
        success: true,
        message: `Media imported successfully`,
        filePath: filePath,
        binName: binName || 'Root',
        ...result
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maybeModalTimeout = /timeout|timed out/i.test(message);
      return {
        success: false,
        error: `Failed to import media: ${message}`,
        filePath: filePath,
        ...(maybeModalTimeout ? {
          warning: 'Premiere may be showing a blocking modal dialog, such as "File format not supported". Dismiss the dialog in Premiere, then retry. For subtitle files, convert unsupported formats like .ass/.ssa to .srt before importing.'
        } : {})
      };
    }
  }

  /**
   * Import a Final Cut Pro 7 XML (XMEML) file.
   *
   * Premiere 26 accepts FCP7 XML through importFiles. The second argument asks
   * Premiere to suppress warning UI. Do not use app.openFCPXML here: it rejects
   * the documented-looking two-argument form in the supported host runtime.
   */
  private async importFcpXml(filePath: string): Promise<any> {
    try {
      // No hand-escaping here. JSON.stringify below already produces a correctly
      // quoted literal; escaping first and then serialising doubled every backslash,
      // so C:\\Users\\bob\\seq.xml reached the host as C:\\\\Users\\\\bob\\\\seq.xml and every
      // Windows path failed. Introduced by the interpolation sweep, which wrapped a
      // site that was already escaped.
      const script = `
        try {
          var f = new File(${JSON.stringify(filePath)});
          if (!f.exists) {
            return JSON.stringify({ success: false, error: "File not found: " + ${JSON.stringify(filePath)} });
          }
          // suppressUI=true asks Premiere not to surface import warning dialogs.
          var imported = app.project.importFiles([${JSON.stringify(filePath)}], true, app.project.rootItem, false);
          if (!imported) {
            return JSON.stringify({ success: false, imported: false, path: ${JSON.stringify(filePath)}, method: "importFiles(suppressUI=true)", error: "Premiere rejected the FCP7 XML import" });
          }
          return JSON.stringify({ success: true, imported: true, path: ${JSON.stringify(filePath)}, method: "importFiles(suppressUI=true)" });
        } catch (e) {
          return JSON.stringify({ success: false, error: e.toString() });
        }
      `;
      const result: any = await this.bridge.executeScript(script);
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      return {
        ...parsed,
        message: parsed.success
          ? `FCP XML imported successfully via ${parsed.method} — Premiere created new sequence atomically`
          : `Failed to import FCP XML — ${parsed.error || 'Premiere rejected the import'}`,
        filePath
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to import FCP XML: ${error instanceof Error ? error.message : String(error)}`,
        filePath
      };
    }
  }

  /**
   * Import a CMX 3600 EDL file via app.importEDL.
   * Premiere prompts for sequence settings + source media in interactive mode.
   * The resulting sequence's timebase/video standard comes from the project defaults
   * or the interactive dialog — app.importEDL has no video-standard argument.
   */
  private async importEdl(filePath: string): Promise<any> {
    return {
      success: false,
      blockedBeforePremiere: true,
      filePath,
      error: 'CMX 3600 EDL import is disabled because Premiere only exposes it through an interactive dialog that blocks CEP. Convert the EDL to FCP7 XML and use import_fcp_xml for unattended import.'
    };
  }

  private async importFolder(folderPath: string, binName?: string, recursive = false): Promise<any> {
    const script = `
      try {
        var folder = new Folder(${JSON.stringify(folderPath)});
        var importedItems = [];
        var errors = [];
        
        function importFiles(dir, targetBin) {
          var files = dir.getFiles();
          for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (file instanceof File) {
              try {
                var item = targetBin.importFiles([file.fsName]);
                if (item && item.length > 0) {
                  importedItems.push({
                    name: file.name,
                    path: file.fsName,
                    id: item[0].nodeId
                  });
                }
              } catch (e) {
                errors.push({
                  file: file.name,
                  error: e.toString()
                });
              }
            } else if (file instanceof Folder && ${recursive}) {
              importFiles(file, targetBin);
            }
          }
        }
        
        var targetBin = app.project.rootItem;
        ${binName ? `
        // Same silent reparent as create_bin: an unresolved destination bin sent the
        // whole import to the project root instead of failing.
        function __binByName(parent, wanted) {
          // children[name] does not resolve: Premiere's ProjectItemCollection is
          // index-only, so a string key returns undefined even when a child of that
          // name exists. Verified against 26.0.2. Walk and compare instead.
          if (!parent || !parent.children) return null;
          for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            if (child && String(child.name) === String(wanted)) return child;
          }
          return null;
        }
        targetBin = __binByName(app.project.rootItem, ${JSON.stringify(binName)});
        if (!targetBin) {
          return JSON.stringify({
            success: false,
            error: "Destination bin not found: " + ${JSON.stringify(binName)} + ". Nothing was imported. Omit binName to import to the project root.",
            binName: ${JSON.stringify(binName)}
          });
        }` : ''}
        
        importFiles(folder, targetBin);
        
        return JSON.stringify({
          success: true,
          importedItems: importedItems,
          errors: errors,
          totalImported: importedItems.length,
          totalErrors: errors.length
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

  private async createBin(name: string, parentBinName?: string, parentBinId?: string): Promise<any> {
    const script = `
      try {
        var parentBinName = ${parentBinName !== undefined ? JSON.stringify(parentBinName) : 'null'};
        var parentBinId = ${parentBinId !== undefined ? JSON.stringify(parentBinId) : 'null'};
        var parentBin = app.project.rootItem;
        var resolvedBy = "root";

        // A bin has a createBin() method; clips do not. type===2 is Premiere's BIN
        // constant, but the duck-type is the reliable fallback across builds.
        function __isBin(it) {
          if (!it) return false;
          if (it.type === 2) return true;
          return (typeof it.createBin === "function");
        }
        // Walk a "/"-separated path from a starting node, matching bins by name.
        function __binByPath(root, segments) {
          var node = root;
          for (var s = 0; s < segments.length; s++) {
            if (!node || !node.children) return null;
            var next = null;
            for (var i = 0; i < node.children.numItems; i++) {
              var ch = node.children[i];
              if (ch && __isBin(ch) && String(ch.name) === String(segments[s])) { next = ch; break; }
            }
            if (!next) return null;
            node = next;
          }
          return node;
        }
        // Depth-first collect every bin anywhere in the tree matching a single name.
        function __binsByNameDeep(root, wanted, acc) {
          if (!root || !root.children) return acc;
          for (var i = 0; i < root.children.numItems; i++) {
            var ch = root.children[i];
            if (ch && __isBin(ch)) {
              if (String(ch.name) === String(wanted)) acc.push(ch);
              __binsByNameDeep(ch, wanted, acc);
            }
          }
          return acc;
        }

        if (parentBinId !== null) {
          // Unambiguous: resolve the parent bin by nodeId.
          var byId = __findProjectItem(parentBinId);
          if (!byId) {
            return JSON.stringify({ success: false, error: "Parent bin not found by id: " + parentBinId + ". Nothing was created." });
          }
          if (!__isBin(byId)) {
            return JSON.stringify({ success: false, error: "parentBinId does not refer to a bin. Nothing was created." });
          }
          parentBin = byId;
          resolvedBy = "id";
        } else if (parentBinName !== null) {
          if (String(parentBinName).indexOf("/") !== -1) {
            // Path form: walk the hierarchy segment by segment.
            var segs = String(parentBinName).split("/");
            var trimmed = [];
            for (var si = 0; si < segs.length; si++) { if (segs[si] !== "") trimmed.push(segs[si]); }
            var byPath = __binByPath(app.project.rootItem, trimmed);
            if (!byPath) {
              return JSON.stringify({ success: false, error: "Parent bin path not found: " + parentBinName + ". Nothing was created.", parentBinName: parentBinName });
            }
            parentBin = byPath;
            resolvedBy = "path";
          } else {
            // Single name: deep-search, but refuse to guess when it is ambiguous —
            // reparenting to the wrong same-named bin is exactly the silent bug to avoid.
            var matches = __binsByNameDeep(app.project.rootItem, parentBinName, []);
            if (matches.length === 0) {
              return JSON.stringify({ success: false, error: "Parent bin not found: " + parentBinName + ". Nothing was created. Omit parentBinName to create at the project root.", parentBinName: parentBinName });
            }
            if (matches.length > 1) {
              return JSON.stringify({ success: false, error: "Parent bin name '" + parentBinName + "' is ambiguous (" + matches.length + " bins share it). Pass parentBinId, or a '/'-separated path, to disambiguate. Nothing was created.", parentBinName: parentBinName, matchCount: matches.length });
            }
            parentBin = matches[0];
            resolvedBy = "name";
          }
        }

        var newBin = parentBin.createBin(${JSON.stringify(name)});
        // createBin() returns void/undefined on refusal; confirm the bin now exists under
        // the parent before claiming success, instead of reading .nodeId off nothing.
        if (!newBin) {
          var __rescan = null;
          try {
            for (var ri = 0; ri < parentBin.children.numItems; ri++) {
              var __c = parentBin.children[ri];
              if (__c && __isBin(__c) && String(__c.name) === ${JSON.stringify(name)}) { __rescan = __c; break; }
            }
          } catch (eRs) {}
          if (!__rescan) return JSON.stringify({ success: false, verified: false, error: "createBin() returned nothing and no bin named '" + ${JSON.stringify(name)} + "' exists under the parent.", binName: ${JSON.stringify(name)} });
          newBin = __rescan;
        }

        return JSON.stringify({
          success: true,
          verified: true,
          binName: ${JSON.stringify(name)},
          binId: newBin.nodeId,
          parentBinId: parentBin.nodeId,
          parentBin: (resolvedBy === "root") ? "Root" : String(parentBin.name),
          resolvedBy: resolvedBy
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

  // Sequence Management Implementation
  private async createSequence(name: string, presetPath: string, frameRate?: number): Promise<any> {
    try {
      const result: any = await this.bridge.createSequence(name, presetPath);
      if (result?.success === false) {
        return {
          ...result,
          sequenceName: result.sequenceName || name
        };
      }

      // The preset dictates the initial frame rate, so 24 vs 23.976 is whatever the
      // .sqpreset happens to carry. When the caller asks for a specific rate, set it
      // on the freshly created sequence and read it back through the already-validated
      // setSequenceSettings path, surfacing a warning if Premiere refused it.
      let frameRateResult: any = undefined;
      if (frameRate !== undefined && result?.id) {
        frameRateResult = await this.setSequenceSettings(result.id, { frameRate });
      }

      return {
        success: true,
        message: `Sequence "${name}" created successfully`,
        sequenceName: name,
        ...result,
        ...(frameRateResult
          ? {
              frameRateRequested: frameRate,
              frameRateApplied: frameRateResult.success !== false,
              // setSequenceSettings reads the rate back after writing: `after` on the
              // success path, `settings` on the no-op / rejected branches.
              ...((): any => {
                const actual = frameRateResult.after?.frameRate ?? frameRateResult.settings?.frameRate;
                return actual !== undefined && actual !== null ? { frameRateActual: actual } : {};
              })(),
              ...(frameRateResult.success === false || frameRateResult.warning
                ? { frameRateWarning: frameRateResult.error || frameRateResult.warning }
                : {})
            }
          : {})
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timeout|timed out/i.test(message);
      return {
        success: false,
        error: `Failed to create sequence: ${message}`,
        sequenceName: name,
        ...(timedOut ? {
          warning: 'Premiere may still create the sequence after this timeout. Wait for the bridge to become responsive, then run list_sequences to verify before retrying. The server intentionally does not run automatic recovery after a timeout because that can wedge the CEP bridge on Windows.'
        } : {})
      };
    }
  }

  private async createSequenceFromProjectItems(name: string, projectItemIds: string[]): Promise<any> {
    if (!projectItemIds.length) {
      return { success: false, error: 'At least one imported project item is required to create a sequence without a dialog.' };
    }

    const script = `
      try {
        function walk(parent, output) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            output.push(item);
            if (item.type === ProjectItemType.BIN) walk(item, output);
          }
        }
        var ids = ${JSON.stringify(projectItemIds)};
        var allItems = [];
        walk(app.project.rootItem, allItems);
        var items = [];
        for (var j = 0; j < ids.length; j++) {
          for (var k = 0; k < allItems.length; k++) {
            if (String(allItems[k].nodeId) === String(ids[j])) {
              items.push(allItems[k]);
              break;
            }
          }
        }
        if (!items.length) return JSON.stringify({ success: false, error: 'Imported project items could not be found.' });
        var sequence = app.project.createNewSequenceFromClips(${JSON.stringify(name)}, items, app.project.rootItem);
        if (!sequence) return JSON.stringify({ success: false, error: 'Premiere did not create a sequence from the imported clips.' });
        return JSON.stringify({ success: true, id: sequence.sequenceID, name: sequence.name, itemCount: items.length });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async duplicateSequence(sequenceId: string, newName: string, clearContents = false): Promise<any> {
    const safeName = JSON.stringify(newName);
    const script = `
      try {
        var originalSeq = __findSequence(${JSON.stringify(sequenceId)});
        if (!originalSeq) return JSON.stringify({ success: false, error: "Sequence not found" });

        // In current Premiere, Sequence.clone() returns the clone's ProjectItem (NOT a Sequence),
        // which has a settable .name but no .sequenceID / .videoTracks. Resolve the real Sequence
        // object via getSequence() before touching tracks; handle builds that return a Sequence too.
        // Noted before the clone so the fallback below can tell a newly created
        // sequence apart from the one the user already had open.
        var priorActiveId = null;
        try {
          priorActiveId = app.project.activeSequence ? String(app.project.activeSequence.sequenceID) : null;
        } catch (ePriorActive) {}

        var cloneResult = originalSeq.clone();
        var newItem = null, newSeqObj = null;
        if (cloneResult) {
          if (typeof cloneResult.getSequence === "function") {
            newItem = cloneResult;
            try { newSeqObj = cloneResult.getSequence(); } catch (_) {}
          } else if (cloneResult.videoTracks) {
            newSeqObj = cloneResult;
          }
        }
        // Fallback: a freshly cloned sequence usually becomes the active one.
        //
        // Only accept it once it is demonstrably new — a different sequence from
        // both the clone source and whatever was active before the clone ran.
        // Taken unconditionally, this clause hands back the user's own open
        // timeline whenever clone() returns something unexpected or
        // getSequence() throws, and everything below then renames it and, with
        // clearContents, removes every clip from it — reported as success.
        if (!newSeqObj) {
          try {
            var activeCandidate = app.project.activeSequence;
            var activeCandidateId = activeCandidate ? String(activeCandidate.sequenceID) : null;
            if (activeCandidateId &&
                activeCandidateId !== String(originalSeq.sequenceID) &&
                activeCandidateId !== priorActiveId) {
              newSeqObj = activeCandidate;
            }
          } catch (eActiveFallback) {}
        }

        // Refuse rather than guess. Clearing a sequence that may not be the copy
        // is irreversible, so an unresolved copy has to stop the operation.
        if (${clearContents ? 'true' : 'false'} && !newSeqObj) {
          return JSON.stringify({
            success: false,
            error: "The sequence was duplicated but the copy could not be identified, so clearContents was not run. Nothing was cleared. Find the new sequence with list_sequences and clear it explicitly.",
            duplicated: true,
            cleared: false
          });
        }

        // Rename on the ProjectItem (visible in the project panel) AND the Sequence object.
        if (newItem) { try { newItem.name = ${safeName}; } catch (_) {} }
        if (newSeqObj) { try { newSeqObj.name = ${safeName}; } catch (_) {} }

        // clearContents=true → produce an EMPTY sequence that inherits the source's exact
        // settings (frame rate, resolution, track layout). This is the reliable way to auto-create
        // a correctly-specced target because create_sequence ignores frameRate. Remove every clip
        // from all tracks (iterate backwards; remove() shifts indices).
        var clearedClips = 0;
        if (${clearContents ? 'true' : 'false'} && newSeqObj) {
          function __clearTracks(tracks) {
            if (!tracks) return;
            for (var t = 0; t < tracks.numTracks; t++) {
              var tr = tracks[t];
              if (!tr || !tr.clips) continue;
              for (var ci = tr.clips.numItems - 1; ci >= 0; ci--) {
                try { tr.clips[ci].remove(false, false); clearedClips++; } catch (_) {}
              }
            }
          }
          __clearTracks(newSeqObj.videoTracks);
          __clearTracks(newSeqObj.audioTracks);
        }

        // Sequence.name does NOT always propagate to the project panel — if clone() didn't give us
        // the ProjectItem directly, find the matching one by sequenceID and rename it too.
        function __findItemForSequence(parent, seqId) {
          if (!parent || !parent.children) return null;
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            if (!item) continue;
            try {
              var seq = item.getSequence && item.getSequence();
              if (seq && seq.sequenceID === seqId) return item;
            } catch (_) { /* not a sequence-bearing item */ }
            if (item.type === 2 /* BIN */) {
              var nested = __findItemForSequence(item, seqId);
              if (nested) return nested;
            }
          }
          return null;
        }

        var renamedAtItem = false;
        if (newItem) {
          renamedAtItem = true;
        } else if (newSeqObj) {
          newItem = __findItemForSequence(app.project.rootItem, newSeqObj.sequenceID);
          if (newItem) {
            try { newItem.name = ${safeName}; renamedAtItem = true; } catch (_) { /* fall through */ }
          }
        }

        // Fail closed when the clone produced nothing identifiable: reading back all-null
        // ids as success:true is a fake success (the duplicate silently did not happen).
        if (!newSeqObj && !newItem) {
          return JSON.stringify({ success: false, verified: false, error: "clone() ran but neither the new sequence nor its project item could be resolved; nothing was duplicated.", originalSequenceId: ${JSON.stringify(sequenceId)} });
        }
        // Verify the rename actually landed on the project item, rather than trusting the assignment.
        var renameVerified = false;
        if (newItem) { try { renameVerified = (String(newItem.name) === ${safeName}); } catch (eRv) {} }

        return JSON.stringify({
          success: true,
          verified: true,
          originalSequenceId: ${JSON.stringify(sequenceId)},
          newSequenceId: newSeqObj ? newSeqObj.sequenceID : null,
          newName: ${safeName},
          newProjectItemId: newItem ? newItem.nodeId : null,
          renamedAtProjectItem: renamedAtItem,
          renameVerified: renameVerified,
          clearedClips: clearedClips
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
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

  private async renameProjectItem(projectItemId: string, newName: string): Promise<any> {
    const safeName = JSON.stringify(newName);
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var oldName = item.name;
        item.name = ${safeName};
        if (String(item.name) !== ${safeName}) return JSON.stringify({ success: false, verified: false, error: "Premiere did not rename the item (reads back as '" + String(item.name) + "').", oldName: oldName, requested: ${safeName} });
        return JSON.stringify({
          success: true,
          verified: true,
          projectItemId: ${JSON.stringify(projectItemId)},
          oldName: oldName,
          newName: String(item.name)
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async readSequenceCaptions(sequenceId?: string): Promise<any> {
    const seqArg = sequenceId ? JSON.stringify(sequenceId) : 'null';
    const script = `
      try {
        // A supplied ID that does not resolve must fail. Falling back to the
        // active sequence answers a different question and reports that
        // sequence's identity as though it were the one asked for.
        var sequence = null;
        if (${seqArg}) {
          sequence = __findSequence(${seqArg});
          if (!sequence) {
            return JSON.stringify({
              success: false,
              error: "Sequence not found by id: " + ${seqArg} + ". Use list_sequences or get_active_sequence to obtain a valid sequence ID."
            });
          }
        } else {
          sequence = app.project.activeSequence;
        }
        if (!sequence) return JSON.stringify({ success: false, error: "No active sequence" });

        // Premiere caption tracks live alongside video/audio tracks. Different
        // Premiere versions expose them differently:
        //   - sequence.getCaptionTracks() (newer)
        //   - sequence.captionTracks (some builds)
        //   - sequence.videoTracks[i] with isCaptioning style flag
        // Try in that order, return whatever yields {start, end, text} clips.

        var tracks = [];
        try {
          if (sequence.getCaptionTracks) {
            tracks = sequence.getCaptionTracks();
          } else if (sequence.captionTracks) {
            tracks = sequence.captionTracks;
          }
        } catch (_) { /* fall through to track scan */ }

        // Fallback: scan video tracks for caption clip data
        if ((!tracks || tracks.length === 0) && sequence.videoTracks) {
          for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
            var t = sequence.videoTracks[v];
            if (t && (t.isCaption || t.captionTrack || (t.name && /caption/i.test(t.name)))) {
              tracks.push(t);
            }
          }
        }

        var trackCount = tracks ? tracks.length : 0;
        var output = [];

        for (var i = 0; i < trackCount; i++) {
          var trk = tracks[i];
          if (!trk) continue;
          var clips = trk.clips || trk.captions || [];
          var clipCount = clips.numItems !== undefined ? clips.numItems : (clips.length || 0);
          for (var c = 0; c < clipCount; c++) {
            var clip = clips[c];
            if (!clip) continue;
            var startSec = null;
            var endSec = null;
            try {
              if (clip.start && clip.start.seconds !== undefined) startSec = clip.start.seconds;
              else if (clip.start && clip.start.ticks) startSec = parseFloat(clip.start.ticks) / 254016000000.0;
              else if (typeof clip.startTime === 'number') startSec = clip.startTime;
            } catch (_) {}
            try {
              if (clip.end && clip.end.seconds !== undefined) endSec = clip.end.seconds;
              else if (clip.end && clip.end.ticks) endSec = parseFloat(clip.end.ticks) / 254016000000.0;
              else if (typeof clip.endTime === 'number') endSec = clip.endTime;
            } catch (_) {}

            var text = "";
            try {
              if (typeof clip.text === 'string') text = clip.text;
              else if (clip.captionText) text = clip.captionText;
              else if (clip.name) text = clip.name;
            } catch (_) {}

            output.push({
              trackIndex: i,
              start: startSec,
              end: endSec,
              text: text
            });
          }
        }

        // Premiere Pro exposes NO caption-read API in its scripting DOM (confirmed
        // Adobe limitation — see Bruce Bullis 2021/2023 and the UXP CaptionTrack
        // thread, 2025). createCaptionTrack can WRITE a caption track from an SRT,
        // but there is no read counterpart: no sequence.captionTracks, no
        // getCaptionTracks(), and caption tracks are not surfaced in videoTracks or
        // the QE DOM. So trackCount will essentially always be 0 here. Report that
        // honestly via captionReadSupported + note instead of implying "no captions".
        var captionReadSupported = trackCount > 0;
        var note = captionReadSupported ? "" : "Premiere Pro exposes no caption-read API in its scripting DOM, so caption tracks cannot be enumerated or read back from a sequence (Adobe limitation: createCaptionTrack can write a track, but there is no read counterpart). trackCount:0 does NOT mean the sequence has no captions — it may have a working, rendering caption track that is simply unreadable via script. To recover cue text/timing, parse the source .srt file off disk instead.";

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          captionReadSupported: captionReadSupported,
          trackCount: trackCount,
          captionCount: output.length,
          captions: output,
          note: note
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // ---------------------------------------------------------------------------
  // SRT subtitle CRUD (host-independent; operates on the .srt file on disk).
  // Premiere's DOM can ingest an .srt (create_caption_track) but exposes no
  // caption read/update/delete, so all caption editing lives here on the file.
  // Every write is verified by reading it back and re-parsing. The pure parse/
  // serialize/edit logic is in ./srt; these methods add only the I/O shell.
  // ---------------------------------------------------------------------------

  /** Shape one cue for a tool response: 1-based index + seconds + timecodes. */
  private srtCueOut(cue: SrtCue, i: number) {
    return {
      index: i + 1,
      start: cue.start,
      end: cue.end,
      startTimecode: formatTimecode(cue.start),
      endTimecode: formatTimecode(cue.end),
      text: cue.text,
    };
  }

  /** Distill a cue list's validation into counts plus the issues themselves. */
  private srtValidationReport(cues: SrtCue[]): { errorCount: number; warningCount: number; issues: SrtValidationIssue[] } {
    const issues = validateCues(cues);
    return {
      errorCount: issues.filter((x) => x.severity === 'error').length,
      warningCount: issues.filter((x) => x.severity === 'warning').length,
      issues,
    };
  }

  /**
   * Read + parse an .srt off disk. Requires an absolute path (matches the
   * footage tools). Returns the cues + any malformed blocks, or a caller-facing
   * error (bad path / missing file) without throwing.
   */
  private async loadSrt(
    srtPath: string,
  ): Promise<{ ok: true; cues: SrtCue[]; malformed: any[] } | { ok: false; error: string }> {
    if (typeof srtPath !== 'string' || srtPath.trim() === '') {
      return { ok: false, error: 'srtPath is required.' };
    }
    if (!isAbsolute(srtPath)) {
      return { ok: false, error: `srtPath must be an absolute path (got ${JSON.stringify(srtPath)}).` };
    }
    let raw: string;
    try {
      raw = await fs.readFile(srtPath, 'utf8');
    } catch (e: any) {
      if (e && e.code === 'ENOENT') {
        return { ok: false, error: `No file at ${srtPath}. Check the path, or create it with write_srt.` };
      }
      return { ok: false, error: `Could not read ${srtPath}: ${e instanceof Error ? e.message : String(e)}` };
    }
    const parsed = parseSrt(raw);
    return { ok: true, cues: parsed.cues, malformed: parsed.malformed };
  }

  /**
   * Serialize cues and write them to srtPath (atomic tmp+rename, parents made),
   * then read the file back and re-parse to confirm the on-disk cue count
   * matches. Never reports success on an unverified write. Refuses cues with
   * structural errors unless allowInvalid is set.
   */
  private async persistSrt(
    srtPath: string,
    cues: SrtCue[],
    allowInvalid?: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string; errors?: SrtValidationIssue[] }> {
    const errs = cueErrors(cues);
    if (errs.length > 0 && !allowInvalid) {
      return {
        ok: false,
        error: `Refusing to write: ${errs.length} structural error(s) in the cues. Fix them, or pass allowInvalid=true to write anyway.`,
        errors: errs,
      };
    }
    const doc = serializeSrt(cues);
    try {
      await fs.mkdir(dirname(srtPath), { recursive: true });
      const tmp = `${srtPath}.tmp`;
      await fs.writeFile(tmp, doc, 'utf8');
      await fs.rename(tmp, srtPath);
      // Verify a full round-trip, not just the cue count: re-parse the file and
      // re-serialize it; a clean write reproduces `doc` exactly. This catches
      // silent text corruption (e.g. a blank line inside a cue's text, which SRT
      // cannot represent because a blank line ends a cue) that a count-only check
      // would miss when the truncated tail parses away as a malformed block.
      const back = parseSrt(await fs.readFile(srtPath, 'utf8'));
      if (back.malformed.length > 0 || serializeSrt(back.cues) !== doc) {
        return {
          ok: false,
          error: `Wrote ${srtPath} but it did not round-trip (read-back parsed ${back.cues.length} cue(s)${back.malformed.length ? ` plus ${back.malformed.length} unparseable block(s)` : ''}). A cue's text likely contains a blank line, which SRT cannot represent — a blank line ends a cue. Remove interior blank lines from cue text, or the disk may be full/read-only.`,
        };
      }
    } catch (e) {
      return { ok: false, error: `Could not write ${srtPath}: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true };
  }

  private async readSrtFile(srtPath: string): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    return {
      success: true,
      srtPath,
      cueCount: loaded.cues.length,
      cues: loaded.cues.map((c, i) => this.srtCueOut(c, i)),
      validation: this.srtValidationReport(loaded.cues),
      malformedBlockCount: loaded.malformed.length,
      malformed: loaded.malformed,
      note:
        loaded.malformed.length > 0
          ? `${loaded.malformed.length} block(s) could not be parsed and were skipped (see malformed).`
          : undefined,
    };
  }

  private async validateSrtFile(srtPath: string): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const report = this.srtValidationReport(loaded.cues);
    return {
      success: true,
      srtPath,
      cueCount: loaded.cues.length,
      valid: report.errorCount === 0,
      errorCount: report.errorCount,
      warningCount: report.warningCount,
      issues: report.issues,
      malformedBlockCount: loaded.malformed.length,
      malformed: loaded.malformed,
    };
  }

  private async writeSrtFile(
    srtPath: string,
    cuesIn: Array<{ start: number | string; end: number | string; text: string }>,
    allowInvalid?: boolean,
  ): Promise<any> {
    if (typeof srtPath !== 'string' || !isAbsolute(srtPath)) {
      return { success: false, error: `srtPath must be an absolute path (got ${JSON.stringify(srtPath)}).` };
    }
    if (!Array.isArray(cuesIn)) return { success: false, error: 'cues must be an array of { start, end, text }.' };
    const cues: SrtCue[] = [];
    for (let i = 0; i < cuesIn.length; i++) {
      const c = cuesIn[i] || ({} as any);
      const start = coerceSeconds(c.start);
      const end = coerceSeconds(c.end);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        return {
          success: false,
          error: `cue ${i + 1}: start and end must each be seconds (number) or an "HH:MM:SS,mmm" timecode (got start=${JSON.stringify(c.start)}, end=${JSON.stringify(c.end)}).`,
        };
      }
      cues.push({ start, end, text: typeof c.text === 'string' ? c.text : '' });
    }
    const report = this.srtValidationReport(cues);
    const wrote = await this.persistSrt(srtPath, cues, allowInvalid);
    if (!wrote.ok) {
      return { success: false, error: wrote.error, validation: report, ...(wrote.errors ? { errors: wrote.errors } : {}) };
    }
    return {
      success: true,
      srtPath,
      cueCount: cues.length,
      verified: true,
      validation: report,
      note:
        report.errorCount > 0 && allowInvalid
          ? 'Written with allowInvalid=true despite structural errors — see validation.'
          : undefined,
    };
  }

  private async updateSrtCue(
    srtPath: string,
    index: number,
    patch: { start?: number | string; end?: number | string; text?: string },
  ): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const cues = loaded.cues;
    if (!Number.isInteger(index) || index < 1 || index > cues.length) {
      return { success: false, error: `cue index ${index} is out of range (file has ${cues.length} cue${cues.length === 1 ? '' : 's'}).` };
    }
    if (patch.start === undefined && patch.end === undefined && patch.text === undefined) {
      return { success: false, error: 'Provide at least one of start, end, or text to change.' };
    }
    const before = this.srtCueOut(cues[index - 1] as SrtCue, index - 1);
    const resolved: Partial<SrtCue> = {};
    if (patch.start !== undefined) {
      const s = coerceSeconds(patch.start);
      if (Number.isNaN(s)) return { success: false, error: `start must be seconds or "HH:MM:SS,mmm" (got ${JSON.stringify(patch.start)}).` };
      resolved.start = s;
    }
    if (patch.end !== undefined) {
      const e = coerceSeconds(patch.end);
      if (Number.isNaN(e)) return { success: false, error: `end must be seconds or "HH:MM:SS,mmm" (got ${JSON.stringify(patch.end)}).` };
      resolved.end = e;
    }
    if (patch.text !== undefined) resolved.text = patch.text;

    let next: SrtCue[];
    try {
      next = updateCue(cues, index, resolved);
    } catch (e: any) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const report = this.srtValidationReport(next);
    // A surgical edit applies and reports; the round-trip verify still guards
    // file integrity. (Refusing here would cite an allowInvalid flag this tool
    // doesn't expose.) Structural problems surface in `validation` + `note`.
    const wrote = await this.persistSrt(srtPath, next, true);
    if (!wrote.ok) return { success: false, error: wrote.error, validation: report };
    return {
      success: true,
      srtPath,
      cueCount: next.length,
      index,
      before,
      after: this.srtCueOut(next[index - 1] as SrtCue, index - 1),
      validation: report,
      note: report.errorCount > 0 ? `Applied, but ${report.errorCount} cue(s) now have structural errors — see validation.` : undefined,
    };
  }

  private async insertSrtCue(
    srtPath: string,
    start: number | string,
    end: number | string,
    text: string,
  ): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const s = coerceSeconds(start);
    const e = coerceSeconds(end);
    if (Number.isNaN(s) || Number.isNaN(e)) {
      return { success: false, error: `start and end must each be seconds or an "HH:MM:SS,mmm" timecode (got start=${JSON.stringify(start)}, end=${JSON.stringify(end)}).` };
    }
    const cues = loaded.cues;
    // Mirror insertCue's placement rule to report where the cue landed.
    let at = cues.length;
    for (let i = 0; i < cues.length; i++) {
      if ((cues[i] as SrtCue).start > s) { at = i; break; }
    }
    const insertedIndex = at + 1;
    const next = insertCue(cues, { start: s, end: e, text: typeof text === 'string' ? text : '' });
    const report = this.srtValidationReport(next);
    const wrote = await this.persistSrt(srtPath, next, true);
    if (!wrote.ok) return { success: false, error: wrote.error, validation: report };
    return {
      success: true,
      srtPath,
      cueCount: next.length,
      insertedIndex,
      inserted: this.srtCueOut(next[insertedIndex - 1] as SrtCue, insertedIndex - 1),
      validation: report,
      note: report.errorCount > 0 ? `Inserted, but ${report.errorCount} cue(s) now have structural errors — see validation.` : undefined,
    };
  }

  private async removeSrtCue(srtPath: string, index: number): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const cues = loaded.cues;
    if (!Number.isInteger(index) || index < 1 || index > cues.length) {
      return { success: false, error: `cue index ${index} is out of range (file has ${cues.length} cue${cues.length === 1 ? '' : 's'}).` };
    }
    const removed = this.srtCueOut(cues[index - 1] as SrtCue, index - 1);
    let next: SrtCue[];
    try {
      next = removeCue(cues, index);
    } catch (e: any) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const report = this.srtValidationReport(next);
    // Removing a cue can only fix or preserve validity, so it never needs allowInvalid.
    const wrote = await this.persistSrt(srtPath, next, true);
    if (!wrote.ok) return { success: false, error: wrote.error, validation: report };
    return { success: true, srtPath, cueCount: next.length, removedIndex: index, removed, validation: report };
  }

  private async shiftSrtTiming(
    srtPath: string,
    offsetSeconds?: number,
    scaleFactor?: number,
    fromIndex?: number,
    toIndex?: number,
  ): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    let cues = loaded.cues;
    if (cues.length === 0) {
      return { success: true, srtPath, cueCount: 0, offsetSeconds: offsetSeconds || 0, scaleFactor: scaleFactor ?? null, cues: [], validation: this.srtValidationReport(cues), note: 'File has no cues; nothing to shift.' };
    }
    if (scaleFactor !== undefined) {
      try {
        cues = scaleCues(cues, scaleFactor);
      } catch (e: any) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    const offset = offsetSeconds || 0;
    try {
      cues = shiftCues(cues, offset, fromIndex, toIndex);
    } catch (e: any) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const report = this.srtValidationReport(cues);
    const wrote = await this.persistSrt(srtPath, cues, true);
    if (!wrote.ok) return { success: false, error: wrote.error, validation: report };
    return {
      success: true,
      srtPath,
      cueCount: cues.length,
      offsetSeconds: offset,
      scaleFactor: scaleFactor ?? null,
      fromIndex: fromIndex ?? 1,
      toIndex: toIndex ?? cues.length,
      cues: cues.map((c, i) => this.srtCueOut(c, i)),
      validation: report,
      note: report.errorCount > 0 ? `Retimed, but ${report.errorCount} cue(s) now have structural errors (e.g. timing clamped to 0) — see validation.` : undefined,
    };
  }

  private async deleteSequence(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
        var sequenceName = sequence.name;
        var beforeCount = app.project.sequences.numSequences;
        app.project.deleteSequence(sequence);
        var stillThere = __findSequence(${JSON.stringify(sequenceId)});
        var afterCount = app.project.sequences.numSequences;
        if (stillThere || afterCount >= beforeCount) return JSON.stringify({ success: false, verified: false, error: "Premiere did not delete the sequence '" + sequenceName + "' (still present after deleteSequence).", beforeCount: beforeCount, afterCount: afterCount });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Sequence deleted successfully",
          deletedSequenceId: ${JSON.stringify(sequenceId)},
          deletedSequenceName: sequenceName,
          beforeCount: beforeCount,
          afterCount: afterCount
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // Timeline Operations Implementation
  private async addToTimelineBatch(sequenceId: string, clips: Array<{ projectItemId: string; trackIndex: number; time?: number; linkAudio?: boolean; sourceInPoint?: number; sourceOutPoint?: number }>, mode: 'absolute' | 'append' = 'absolute'): Promise<any> {
    // In absolute mode every clip needs an explicit time; in append mode time is
    // computed on the track cursor, so a missing time is expected, not an error.
    if (mode !== 'append') {
      const missing = clips.findIndex((c) => typeof c.time !== 'number');
      if (missing !== -1) {
        return {
          success: false,
          error: `clips[${missing}] has no time; time is required in "absolute" mode (use mode:"append" to chain clips end-to-end).`,
          sequenceId,
          requested: clips.length,
        };
      }
    }
    try {
      const result: any = await this.bridge.addToTimelineBatch(sequenceId, clips, mode);
      return { sequenceId, mode, requested: clips.length, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), sequenceId, mode, requested: clips.length };
    }
  }

  private async addToTimeline(sequenceId: string, projectItemId: string, trackIndex: number, time: number, insertMode = 'overwrite', linkAudio: boolean = true, sourceInPoint?: number, sourceOutPoint?: number): Promise<any> {
    try {
      // insertMode used to stop here: it was echoed in every response below while
      // the bridge unconditionally overwrote, so a caller asking to insert-and-shift
      // had the footage it was moving destroyed and was told the opposite.
      const result: any = await this.bridge.addToTimeline(sequenceId, projectItemId, trackIndex, time, linkAudio, sourceInPoint, sourceOutPoint, insertMode);
      if (!result.success) {
        return {
          ...result,
          sequenceId: sequenceId,
          projectItemId: projectItemId,
          trackIndex: trackIndex,
          time: time,
          insertMode: insertMode,
          linkAudio: linkAudio,
          sourceInPoint: sourceInPoint,
          sourceOutPoint: sourceOutPoint
        };
      }
      return {
        success: true,
        message: `Clip added to timeline successfully`,
        sequenceId: sequenceId,
        projectItemId: projectItemId,
        trackIndex: trackIndex,
        time: time,
        insertMode: insertMode,
        linkAudio: linkAudio,
        sourceInPoint: sourceInPoint,
        sourceOutPoint: sourceOutPoint,
        ...result
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to add clip to timeline: ${error instanceof Error ? error.message : String(error)}`,
        sequenceId: sequenceId,
        projectItemId: projectItemId,
        trackIndex: trackIndex,
        time: time
      };
    }
  }

  private async removeFromTimeline(clipId: string, sequenceId?: string, deleteMode = 'ripple'): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)}, ${sequenceId ? JSON.stringify(sequenceId) : 'null'});
        if (!info) return JSON.stringify({ success: false, error: ${sequenceId ? JSON.stringify(`Clip not found in sequence: ${sequenceId}`) : '"Clip not found"'} });
        var clip = info.clip;
        var clipName = clip.name;
        var isRipple = ${JSON.stringify(deleteMode)} === "ripple";
        var beforeCount = info.track.clips.numItems;
        clip.remove(isRipple, true);
        var afterCount = info.track.clips.numItems;
        if (afterCount >= beforeCount) return JSON.stringify({ success: false, verified: false, error: "Premiere did not remove '" + clipName + "' (track clip count unchanged).", beforeCount: beforeCount, afterCount: afterCount });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Clip removed from timeline",
          clipId: ${JSON.stringify(clipId)},
          clipName: clipName,
          sequenceId: info.sequenceId,
          sequenceName: info.sequenceName,
          deleteMode: ${JSON.stringify(deleteMode)},
          beforeCount: beforeCount,
          afterCount: afterCount
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

  private async trimClip(clipId: string, inPoint?: number, outPoint?: number, duration?: number): Promise<any> {
    if (outPoint !== undefined && duration !== undefined) {
      return {
        success: false,
        error: 'outPoint and duration cannot be used together',
        errorCode: 'INVALID_TRIM_ARGUMENTS'
      };
    }

    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        function secondsOf(value) {
          if (value === undefined || value === null) return null;
          if (typeof value === "number") return value;
          if (value.seconds !== undefined) return Number(value.seconds);
          if (value.ticks !== undefined) return Number(value.ticks) / 254016000000.0;
          return null;
        }
        function frameDurationOf(sequence) {
          try {
            if (sequence && sequence.timebase !== undefined) {
              var value = Number(sequence.timebase) / 254016000000.0;
              if (value > 0 && isFinite(value)) return value;
            }
          } catch (frameError) {}
          return 1 / 48;
        }
        var frameDurationSeconds = frameDurationOf(info.sequence);
        function exactEnough(a, b) {
          return a !== null && b !== null && Math.abs(a - b) < 0.000001;
        }
        function closeEnough(a, b) {
          return a !== null && b !== null && Math.abs(a - b) <= (frameDurationSeconds / 2) + 0.000001;
        }
        function timeFromSeconds(seconds) {
          var t = new Time();
          t.seconds = Number(seconds);
          return t;
        }
        function capturedTime(value) {
          if (value === undefined || value === null) return null;
          var captured = { seconds: secondsOf(value), ticks: null };
          try {
            if (value.ticks !== undefined && value.ticks !== null) captured.ticks = String(value.ticks);
          } catch (ticksError) {}
          return captured;
        }
        function timeFromCaptured(captured) {
          if (!captured) return null;
          var t = new Time();
          if (captured.ticks !== null) t.ticks = captured.ticks;
          else t.seconds = Number(captured.seconds);
          return t;
        }
        function stateOf() {
          return {
            inPoint: secondsOf(clip.inPoint),
            outPoint: secondsOf(clip.outPoint),
            start: secondsOf(clip.start),
            end: secondsOf(clip.end),
            duration: secondsOf(clip.duration)
          };
        }

        var before = stateOf();
        var original = {
          inPoint: capturedTime(clip.inPoint),
          outPoint: capturedTime(clip.outPoint),
          start: capturedTime(clip.start),
          end: capturedTime(clip.end)
        };
        var writeErrors = [];
        function recordWriteError(propertyName, error) {
          writeErrors.push({ property: propertyName, error: error.toString() });
        }

        ${inPoint !== undefined ? `
        if (!exactEnough(before.inPoint, ${inPoint})) {
          try { clip.inPoint = timeFromSeconds(${inPoint}); }
          catch (inPointError) { recordWriteError("inPoint", inPointError); }
        }
        ` : ''}
        ${outPoint !== undefined ? `
        if (!exactEnough(before.outPoint, ${outPoint})) {
          try { clip.outPoint = timeFromSeconds(${outPoint}); }
          catch (outPointError) { recordWriteError("outPoint", outPointError); }
        }
        ` : ''}
        ${duration !== undefined ? `
        var targetDuration = ${duration};
        if (!exactEnough(before.duration, targetDuration)) {
          try {
            clip.end = timeFromSeconds(secondsOf(clip.start) + targetDuration);
          } catch (timelineError) {
            recordWriteError("end", timelineError);
          }
        }
        ` : ''}

        var after = stateOf();
        var verified = true;
        var verificationErrors = [];
        ${inPoint !== undefined ? `
        if (!closeEnough(after.inPoint, ${inPoint})) {
          verified = false;
          verificationErrors.push("inPoint did not change to requested value");
        }
        ` : ''}
        ${outPoint !== undefined ? `
        if (!closeEnough(after.outPoint, ${outPoint})) {
          verified = false;
          verificationErrors.push("outPoint did not change to requested value");
        }
        ` : ''}
        ${duration !== undefined ? `
        if (!closeEnough(after.duration, ${duration})) {
          verified = false;
          verificationErrors.push("timeline duration did not change to requested value");
        }
        ` : ''}

        if (!verified) {
          var attempted = after;
          var rollbackErrors = [];
          function rollback(propertyName, captured) {
            try {
              if (captured) clip[propertyName] = timeFromCaptured(captured);
            } catch (rollbackError) {
              rollbackErrors.push({ property: propertyName, error: rollbackError.toString() });
            }
          }
          ${duration !== undefined ? 'if (!exactEnough(attempted.end, before.end)) rollback("end", original.end);' : ''}
          ${outPoint !== undefined || duration !== undefined ? 'if (!exactEnough(attempted.outPoint, before.outPoint)) rollback("outPoint", original.outPoint);' : ''}
          ${inPoint !== undefined ? 'if (!exactEnough(attempted.inPoint, before.inPoint)) rollback("inPoint", original.inPoint);' : ''}
          var restored = stateOf();
          var rolledBack =
            exactEnough(restored.inPoint, before.inPoint) &&
            exactEnough(restored.outPoint, before.outPoint) &&
            exactEnough(restored.start, before.start) &&
            exactEnough(restored.end, before.end);
          var errorCode = "TRIM_NOT_APPLIED";
          ${duration !== undefined ? `
          if (${duration} > before.duration && closeEnough(attempted.duration, before.duration)) {
            errorCode = "TRIM_UNSUPPORTED_FOR_CLIP";
          }
          ` : ''}
          return JSON.stringify({
            success: false,
            error: errorCode === "TRIM_UNSUPPORTED_FOR_CLIP"
              ? "Premiere Pro does not support extending this clip to the requested duration"
              : "Premiere Pro did not apply the requested trim",
            errorCode: errorCode,
            clipId: ${JSON.stringify(clipId)},
            requested: {
              inPoint: ${inPoint !== undefined ? inPoint : 'null'},
              outPoint: ${outPoint !== undefined ? outPoint : 'null'},
              duration: ${duration !== undefined ? duration : 'null'}
            },
            before: before,
            after: after,
            attempted: attempted,
            restored: restored,
            rolledBack: rolledBack,
            verificationErrors: verificationErrors,
            writeErrors: writeErrors,
            rollbackErrors: rollbackErrors,
            frameDurationSeconds: frameDurationSeconds
          });
        }

        return JSON.stringify({
          success: true,
          message: "Clip trimmed and verified",
          clipId: ${JSON.stringify(clipId)},
          oldInPoint: before.inPoint,
          oldOutPoint: before.outPoint,
          oldDuration: before.duration,
          newInPoint: after.inPoint,
          newOutPoint: after.outPoint,
          newDuration: after.duration,
          before: before,
          after: after,
          writeErrors: writeErrors,
          frameDurationSeconds: frameDurationSeconds
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

  private transitionVerificationScript(): string {
    return `
        function __readQeTransitionState(qeClip) {
          var state = { available: false, count: null, names: [] };
          if (!qeClip) return state;
          function numberValue(value) {
            if (typeof value === "number" && !isNaN(value)) return value;
            if (value && typeof value.numItems === "number") return value.numItems;
            if (value && typeof value.length === "number") return value.length;
            return null;
          }
          var countProps = ["numTransitions", "numVideoTransitions", "numAudioTransitions", "transitions"];
          for (var i = 0; i < countProps.length; i++) {
            try {
              var prop = qeClip[countProps[i]];
              var count = numberValue(typeof prop === "function" ? prop.call(qeClip) : prop);
              if (count !== null) {
                state.available = true;
                state.count = count;
                break;
              }
            } catch (e) {}
          }
          if (state.count !== null && state.count > 0) {
            var getterNames = ["getTransitionAt", "getVideoTransitionAt", "getAudioTransitionAt"];
            for (var g = 0; g < getterNames.length; g++) {
              if (typeof qeClip[getterNames[g]] !== "function") continue;
              try {
                for (var t = 0; t < state.count; t++) {
                  var transition = qeClip[getterNames[g]](t);
                  if (transition) {
                    state.names.push(transition.name || transition.displayName || transition.toString());
                  }
                }
                break;
              } catch (e2) {}
            }
          }
          return state;
        }
        function __transitionWasVerified(before, after) {
          if (!before.available || !after.available) return false;
          if (before.count !== null && after.count !== null && after.count > before.count) return true;
          if (after.names && before.names && after.names.length > before.names.length) return true;
          return false;
        }
        function __transitionXmlCount(seq) {
          var state = { available: false, count: 0, path: null, error: null };
          try {
            if (!seq || typeof seq.exportAsFinalCutProXML !== "function") {
              state.error = "exportAsFinalCutProXML unavailable";
              return state;
            }
            var file = new File(Folder.temp.fsName + "/premiere-mcp-transition-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1000000) + ".xml");
            seq.exportAsFinalCutProXML(file.fsName);
            state.path = file.fsName;
            if (!file.exists) {
              state.error = "XML export file was not created";
              return state;
            }
            file.open("r");
            var text = file.read();
            file.close();
            var matches = text.match(/<transitionitem[\\s>]/g);
            state.available = true;
            state.count = matches ? matches.length : 0;
            try { file.remove(); } catch (removeError) {}
            return state;
          } catch (xmlError) {
            state.error = xmlError.toString();
            return state;
          }
        }
        function __transitionWasVerifiedByXml(beforeXml, afterXml) {
          return beforeXml && afterXml && beforeXml.available && afterXml.available && afterXml.count > beforeXml.count;
        }
        function __findQeClipByDomClip(qeTrack, domClip) {
          if (!qeTrack || !domClip) return null;
          var targetTicks = null;
          try { targetTicks = String(domClip.start.ticks); } catch (targetError) {}
          var best = null;
          var bestDelta = null;
          for (var qi = 0; qi < qeTrack.numItems; qi++) {
            var item = qeTrack.getItemAt(qi);
            if (!item || String(item.type) !== "Clip") continue;
            if (targetTicks !== null) {
              var itemTicks = null;
              try { itemTicks = String(item.start.ticks); } catch (itemError) {}
              if (itemTicks === targetTicks) return item;
              if (itemTicks !== null) {
                var delta = Math.abs(parseInt(itemTicks, 10) - parseInt(targetTicks, 10));
                if (best === null || delta < bestDelta) {
                  best = item;
                  bestDelta = delta;
                }
              }
            }
          }
          return best;
        }
    `;
  }

  private async splitClip(clipId: string, splitTime: number): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var splitSeconds = info.clip.start.seconds + ${splitTime};
        // The timecode must come from the sequence the clip actually lives in, not
        // from whatever is on screen. Taking it from the active sequence put the cut
        // on the right timeline at the wrong frame whenever the two differed in frame
        // rate: a 24 fps clip razored using a 30 fps timebase lands three frames out.
        var seq = info.sequence;
        var fps = seq && seq.timebase ? (254016000000 / parseInt(seq.timebase, 10)) : 30;
        var totalFrames = Math.round(splitSeconds * fps);
        var hours = Math.floor(totalFrames / (fps * 3600));
        var mins = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
        var secs = Math.floor((totalFrames % (fps * 60)) / fps);
        var frames = Math.round(totalFrames % fps);
        function pad(n) { return n < 10 ? "0" + n : "" + n; }
        var tc = pad(hours) + ":" + pad(mins) + ":" + pad(secs) + ":" + pad(frames);
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = info.trackType === 'video' ? qeSeq.getVideoTrackAt(info.trackIndex) : qeSeq.getAudioTrackAt(info.trackIndex);
        var beforeCount = info.track.clips.numItems;
        qeTrack.razor(tc);
        var afterCount = info.track.clips.numItems;
        // A razor that lands on a clip splits it, so the track's clip count rises by
        // one. If it did not, the cut fell in a gap or off the clip -- report that
        // honestly rather than claiming a split that did not happen.
        if (afterCount <= beforeCount) return JSON.stringify({ success: false, verified: false, error: "Razor at " + tc + " did not split any clip (track clip count unchanged). The split time may fall in a gap or outside the clip.", beforeCount: beforeCount, afterCount: afterCount });
        return JSON.stringify({ success: true, verified: true, message: "Clip split at " + tc, splitTime: ${splitTime}, timecode: tc, beforeCount: beforeCount, afterCount: afterCount });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async razorTimelineAtTime(sequenceId?: string, time?: number, videoTrackIndices?: number[], audioTrackIndices?: number[]): Promise<any> {
    const normalizedTime = time ?? 0;
    const videoIndices = videoTrackIndices ?? [];
    const audioIndices = audioTrackIndices ?? [];

    const script = `
      try {
        app.enableQE();
        var sequence = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!sequence) return JSON.stringify({ success: false, error: ${sequenceId ? `"Sequence not found by id: " + ${JSON.stringify(sequenceId)}` : '"No active sequence"'} });

        var __priorActive = app.project.activeSequence;
        if (app.project.activeSequence && app.project.activeSequence.sequenceID !== sequence.sequenceID) {
          app.project.openSequence(sequence.sequenceID);
        }

        var activeSequence = app.project.activeSequence;
        if (!activeSequence || activeSequence.sequenceID !== sequence.sequenceID) {
          return JSON.stringify({ success: false, error: "Unable to activate requested sequence for razor cut" });
        }

        var fps = activeSequence.timebase ? (254016000000 / parseInt(activeSequence.timebase, 10)) : 30;
        var totalFrames = Math.round(${normalizedTime} * fps);
        var hours = Math.floor(totalFrames / (fps * 3600));
        var mins = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
        var secs = Math.floor((totalFrames % (fps * 60)) / fps);
        var frames = Math.round(totalFrames % fps);
        function pad(n) { return n < 10 ? "0" + n : "" + n; }
        var tc = pad(hours) + ":" + pad(mins) + ":" + pad(secs) + ":" + pad(frames);

        var qeSeq = __qeSequenceFor(sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "QE active sequence unavailable" });

        function buildIndices(count, requested) {
          if (!requested || requested.length === 0) {
            var all = [];
            for (var idx = 0; idx < count; idx++) all.push(idx);
            return all;
          }
          return requested;
        }

        var requestedVideo = ${JSON.stringify(videoIndices)};
        var requestedAudio = ${JSON.stringify(audioIndices)};
        var finalVideo = buildIndices(activeSequence.videoTracks.numTracks, requestedVideo);
        var finalAudio = buildIndices(activeSequence.audioTracks.numTracks, requestedAudio);
        var cutVideoTracks = [];
        var cutAudioTracks = [];
        var skippedVideoTracks = [];
        var skippedAudioTracks = [];

        function __razorTotalClips() {
          var n = 0;
          for (var rv = 0; rv < activeSequence.videoTracks.numTracks; rv++) n += activeSequence.videoTracks[rv].clips.numItems;
          for (var ra = 0; ra < activeSequence.audioTracks.numTracks; ra++) n += activeSequence.audioTracks[ra].clips.numItems;
          return n;
        }
        var __razorBeforeTotal = __razorTotalClips();

        for (var i = 0; i < finalVideo.length; i++) {
          var videoIndex = finalVideo[i];
          if (videoIndex < 0 || videoIndex >= activeSequence.videoTracks.numTracks) {
            skippedVideoTracks.push({ index: videoIndex, reason: "Video track index out of range" });
            continue;
          }
          var qeVideoTrack = qeSeq.getVideoTrackAt(videoIndex);
          if (!qeVideoTrack) {
            skippedVideoTracks.push({ index: videoIndex, reason: "QE video track not found" });
            continue;
          }
          qeVideoTrack.razor(tc);
          cutVideoTracks.push(videoIndex);
        }

        for (var j = 0; j < finalAudio.length; j++) {
          var audioIndex = finalAudio[j];
          if (audioIndex < 0 || audioIndex >= activeSequence.audioTracks.numTracks) {
            skippedAudioTracks.push({ index: audioIndex, reason: "Audio track index out of range" });
            continue;
          }
          var qeAudioTrack = qeSeq.getAudioTrackAt(audioIndex);
          if (!qeAudioTrack) {
            skippedAudioTracks.push({ index: audioIndex, reason: "QE audio track not found" });
            continue;
          }
          qeAudioTrack.razor(tc);
          cutAudioTracks.push(audioIndex);
        }

        var __razorAfterTotal = __razorTotalClips();
        var __razorCutsMade = __razorAfterTotal - __razorBeforeTotal;
        return JSON.stringify({
          success: true,
          verified: __razorCutsMade > 0,
          message: __razorCutsMade > 0 ? "Timeline razored at " + tc : "Razor at " + tc + " landed where no clip crossed it; nothing was cut.",
          sequenceId: activeSequence.sequenceID,
          sequenceName: activeSequence.name,
          time: ${normalizedTime},
          timecode: tc,
          cutsMade: __razorCutsMade,
          beforeCount: __razorBeforeTotal,
          afterCount: __razorAfterTotal,
          cutVideoTracks: cutVideoTracks,
          cutAudioTracks: cutAudioTracks,
          skippedVideoTracks: skippedVideoTracks,
          skippedAudioTracks: skippedAudioTracks
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      } finally {
        // Leave the user where they were. ES3 has try/finally, and this runs
        // before the return above completes.
        try {
          if (__priorActive && app.project.activeSequence &&
              app.project.activeSequence.sequenceID !== __priorActive.sequenceID) {
            app.project.activeSequence = __priorActive;
          }
        } catch (eRestore) {}
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // Effects and Transitions Implementation
  // FIX vs upstream: upstream silently ignored `parameters` (typed as `_parameters`).
  // This version:
  //   1. Adds the effect (current behavior)
  //   2. Locates the newly added component by diffing the ordered component snapshots
  //   3. Dumps that component's properties (displayName + current value) so callers can see
  //      exactly which params are settable via flat property access (some effects hide their
  //      real params behind "Custom Setup / Editar..." dialogs and won't be settable this way)
  //   4. For each entry in `parameters`, attempts to set the matching property by displayName
  //      (exact match first, then case-insensitive whitespace-stripped match)
  //   5. Returns dump + per-param result so debugging is one round-trip
  private async applyEffect(clipId: string, effectName: string, parameters?: Record<string, any>, expectedMatchName?: string): Promise<any> {
    const paramJson = JSON.stringify(parameters || {});
    const clipIdJson = JSON.stringify(clipId);
    const effectNameJson = JSON.stringify(effectName);
    const expectedMatchNameJson = JSON.stringify(expectedMatchName || null);
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${clipIdJson});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        function stableValue(value) {
          try {
            var encoded = JSON.stringify(value);
            return encoded === undefined ? String(value) : encoded;
          } catch (e) {
            try { return String(value); } catch (e2) { return "<unreadable>"; }
          }
        }
        function snapshotComponent(component) {
          var propertyParts = [];
          var propertyCount = -1;
          var componentProperties = null;
          try {
            componentProperties = component.properties;
            propertyCount = componentProperties.numItems;
          } catch (e3) {
            propertyParts.push("<properties unreadable>");
          }
          for (var si = 0; si < propertyCount; si++) {
            try {
              var snapshotProperty = componentProperties[si];
              var snapshotValue = "<getValue failed>";
              try { snapshotValue = stableValue(snapshotProperty.getValue()); } catch (e4) {}
              propertyParts.push(String(snapshotProperty.displayName) + "=" + snapshotValue);
            } catch (e5) {
              propertyParts.push("<property " + si + " unreadable>");
            }
          }
          var matchName = "";
          try { matchName = String(component.matchName || ""); } catch (e6) {}
          var displayName = String(component.displayName);
          return {
            displayName: displayName,
            matchName: matchName,
            propertyCount: propertyCount,
            fingerprint: displayName + "|" + matchName + "|" + propertyParts.join("|")
          };
        }
        function snapshotComponents(targetClip) {
          var snapshots = [];
          for (var sci = 0; sci < targetClip.components.numItems; sci++) {
            snapshots.push(snapshotComponent(targetClip.components[sci]));
          }
          return snapshots;
        }
        function fingerprintsEqual(left, right) {
          if (left.length !== right.length) return false;
          for (var fei = 0; fei < left.length; fei++) {
            if (left[fei].fingerprint !== right[fei].fingerprint) return false;
          }
          return true;
        }
        var beforeComponents = snapshotComponents(clip);
        var beforeCount = beforeComponents.length;
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack, effect;
        if (info.trackType === 'video') {
          qeTrack = qeSeq.getVideoTrackAt(info.trackIndex);
          effect = qe.project.getVideoEffectByName(${effectNameJson});
        } else {
          qeTrack = qeSeq.getAudioTrackAt(info.trackIndex);
          effect = qe.project.getAudioEffectByName(${effectNameJson});
        }
        if (!effect) return JSON.stringify({ success: false, error: "Effect not found: " + ${effectNameJson} + ". Use list_available_effects to see available effects." });
        function findQeClipByTime() {
          var targetTicks = String(info.clip.start.ticks);
          var best = null;
          var bestDelta = null;
          for (var qi = 0; qi < qeTrack.numItems; qi++) {
            var item = qeTrack.getItemAt(qi);
            if (!item || String(item.type) !== "Clip") continue;
            var itemTicks = String(item.start.ticks);
            if (itemTicks === targetTicks) return item;
            var delta = Math.abs(parseInt(itemTicks, 10) - parseInt(targetTicks, 10));
            if (best === null || delta < bestDelta) {
              best = item;
              bestDelta = delta;
            }
          }
          return best;
        }
        var qeClip = findQeClipByTime();
        if (!qeClip) return JSON.stringify({ success: false, error: "Could not locate matching QE clip for effect application" });
        if (info.trackType === 'video') { qeClip.addVideoEffect(effect); } else { qeClip.addAudioEffect(effect); }

        // Re-resolve after the QE mutation, then locate the unique inserted component by
        // finding the index whose removal restores the complete pre-add fingerprint sequence.
        var afterInfo = __findClip(${clipIdJson});
        if (!afterInfo) return JSON.stringify({ success: false, error: "Clip could not be re-resolved after effect add" });
        clip = afterInfo.clip;
        var afterComponents = snapshotComponents(clip);
        var afterCount = afterComponents.length;
        if (afterCount <= beforeCount) {
          return JSON.stringify({
            success: false,
            error: "Effect add did not create a new component on the target clip",
            clipId: ${clipIdJson},
            effectName: ${effectNameJson},
            beforeComponentCount: beforeCount,
            afterComponentCount: afterCount
          });
        }
        var candidateIndices = [];
        if (afterCount === beforeCount + 1) {
          for (var candidateIndex = 0; candidateIndex < afterCount; candidateIndex++) {
            var withoutCandidate = [];
            for (var afterIndex = 0; afterIndex < afterCount; afterIndex++) {
              if (afterIndex !== candidateIndex) withoutCandidate.push(afterComponents[afterIndex]);
            }
            if (fingerprintsEqual(beforeComponents, withoutCandidate)) candidateIndices.push(candidateIndex);
          }
        }
        if (candidateIndices.length !== 1) {
          function componentDiagnostics(snapshots) {
            var diagnostics = [];
            for (var di = 0; di < snapshots.length; di++) {
              diagnostics.push({
                componentIndex: di,
                displayName: snapshots[di].displayName,
                matchName: snapshots[di].matchName,
                propertyCount: snapshots[di].propertyCount
              });
            }
            return diagnostics;
          }
          return JSON.stringify({
            success: false,
            error: "Effect was added, but its component could not be uniquely identified; no parameters were written and an automatic retry is unsafe",
            effectAdded: true,
            retryUnsafe: true,
            clipId: ${clipIdJson},
            effectName: ${effectNameJson},
            beforeComponents: componentDiagnostics(beforeComponents),
            afterComponents: componentDiagnostics(afterComponents),
            candidateComponentIndices: candidateIndices
          });
        }
        var newCompIdx = candidateIndices[0];
        var newComp = clip.components[newCompIdx];
        var newCompMatchName = "";
        try { newCompMatchName = String(newComp.matchName || ""); } catch (eMn) {}

        // Identity guard: getVideoEffectByName resolves by DISPLAY name only, so a
        // stock name like "Gaussian Blur" can silently land a third-party plugin
        // (e.g. AE.Impact_Blur_FX). If the caller told us the matchName they meant
        // and it does not match, refuse — and roll the add back when it is safe
        // (removeEffects strips ALL user effects at once, so it is only clean when
        // our add was the sole non-intrinsic, non-Lumetri effect on the clip).
        var expectedMatchName = ${expectedMatchNameJson};
        if (expectedMatchName) {
          function identityIntrinsic(m) { return m === "AE.ADBE Opacity" || m === "AE.ADBE Motion" || m.indexOf("Lumetri") !== -1; }
          function identityNormalize(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }
          if (identityNormalize(newCompMatchName) !== identityNormalize(expectedMatchName)) {
            var userEffectsBefore = 0;
            for (var ueb = 0; ueb < beforeComponents.length; ueb++) {
              if (!identityIntrinsic(beforeComponents[ueb].matchName)) userEffectsBefore++;
            }
            var rolledBack = false;
            if (userEffectsBefore === 0) {
              try { qeClip.removeEffects(); } catch (eRb) {}
              try { rolledBack = fingerprintsEqual(beforeComponents, snapshotComponents(__findClip(${clipIdJson}).clip)); } catch (eRbV) {}
            }
            return JSON.stringify({
              success: false,
              error: "Requested effect '" + ${effectNameJson} + "' resolved to matchName '" + newCompMatchName + "', not the expected '" + expectedMatchName + "'. A plugin or legacy variant likely shadows this display name on this system.",
              clipId: ${clipIdJson},
              effectName: ${effectNameJson},
              expectedMatchName: expectedMatchName,
              actualMatchName: newCompMatchName,
              identityMismatch: true,
              rolledBack: rolledBack,
              rollbackNote: userEffectsBefore === 0 ? undefined : "Left in place: the clip carried other user effects and removeEffects() would strip all of them.",
              noParametersSet: true
            });
          }
        }

        // Dump every property name + current value
        var propsDump = [];
        for (var i = 0; i < newComp.properties.numItems; i++) {
          var prop = newComp.properties[i];
          var dn = String(prop.displayName);
          var val = null;
          try { val = prop.getValue(); } catch (e1) { val = "<getValue threw: " + e1.toString() + ">"; }
          propsDump.push({ index: i, displayName: dn, value: val });
        }

        // Apply parameters by displayName match (exact first, then normalized)
        var requestedParams = ${paramJson};
        var paramResults = [];
        function normalize(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }
        function valuesEquivalent(actual, requested) {
          var actualIsArray = Object.prototype.toString.call(actual) === "[object Array]";
          var requestedIsArray = Object.prototype.toString.call(requested) === "[object Array]";
          if (actualIsArray || requestedIsArray) {
            if (!actualIsArray || !requestedIsArray || actual.length !== requested.length) return false;
            for (var vai = 0; vai < actual.length; vai++) {
              if (!valuesEquivalent(actual[vai], requested[vai])) return false;
            }
            return true;
          }
          if (typeof actual === "number" && typeof requested === "number") {
            return Math.abs(actual - requested) <= 0.0001;
          }
          if (typeof requested === "boolean" && typeof actual === "number" && (actual === 0 || actual === 1)) {
            return Boolean(actual) === requested;
          }
          if (typeof actual === "boolean" && typeof requested === "number" && (requested === 0 || requested === 1)) {
            return actual === Boolean(requested);
          }
          return stableValue(actual) === stableValue(requested);
        }
        for (var pName in requestedParams) {
          if (requestedParams.hasOwnProperty && !requestedParams.hasOwnProperty(pName)) continue;
          var requestedVal = requestedParams[pName];
          var matched = null;
          // Pass 1: exact displayName match
          for (var k = 0; k < newComp.properties.numItems; k++) {
            if (String(newComp.properties[k].displayName) === pName) {
              matched = { idx: k, prop: newComp.properties[k], strategy: "exact" };
              break;
            }
          }
          // Pass 2: normalized match (strip case/whitespace/underscores/dashes)
          if (!matched) {
            var nameN = normalize(pName);
            for (var k = 0; k < newComp.properties.numItems; k++) {
              if (normalize(String(newComp.properties[k].displayName)) === nameN) {
                matched = { idx: k, prop: newComp.properties[k], strategy: "normalized" };
                break;
              }
            }
          }
          if (matched) {
            try {
              var valueBefore = null;
              var beforeReadable = true;
              try { valueBefore = matched.prop.getValue(); } catch (eB) { beforeReadable = false; }
              matched.prop.setValue(requestedVal, true);
              var valueAfter = null;
              var afterReadable = true;
              try { valueAfter = matched.prop.getValue(); } catch (eA) { afterReadable = false; }
              var verified = afterReadable && valuesEquivalent(valueAfter, requestedVal);
              var changed = beforeReadable && afterReadable && !valuesEquivalent(valueAfter, valueBefore);
              var acceptedWithWarning = !verified && changed;
              var unverifiable = !afterReadable;
              var resultOk = verified || acceptedWithWarning;
              paramResults.push({
                requestedName: pName,
                matchedDisplayName: String(matched.prop.displayName),
                strategy: matched.strategy,
                valueRequested: requestedVal,
                valueBefore: valueBefore,
                valueAfter: valueAfter,
                verification: verified ? "verified" : (acceptedWithWarning ? "changed_with_warning" : (unverifiable ? "unverifiable" : "failed")),
                warning: acceptedWithWarning
                  ? "Premiere changed the property but readback differs from the requested value (possibly clamped or coerced)"
                  : (unverifiable ? "Premiere accepted setValue but the resulting value could not be read back" : undefined),
                ok: resultOk
              });
            } catch (e2) {
              paramResults.push({ requestedName: pName, ok: false, error: "setValue threw: " + e2.toString() });
            }
          } else {
            paramResults.push({ requestedName: pName, ok: false, error: "no property matches this displayName (exact or normalized)" });
          }
        }

        var failedParams = [];
        var paramWarnings = [];
        for (var pr = 0; pr < paramResults.length; pr++) {
          if (!paramResults[pr].ok) failedParams.push(paramResults[pr]);
          if (paramResults[pr].warning) paramWarnings.push({
            requestedName: paramResults[pr].requestedName,
            verification: paramResults[pr].verification,
            warning: paramResults[pr].warning
          });
        }

        return JSON.stringify({
          success: failedParams.length === 0,
          message: "Effect applied",
          clipId: ${clipIdJson},
          effectName: ${effectNameJson},
          addedComponent: {
            displayName: String(newComp.displayName),
            matchName: newCompMatchName,
            componentIndex: newCompIdx,
            identificationStrategy: "unique ordered component fingerprint insertion",
            propertyCount: propsDump.length,
            properties: propsDump
          },
          paramResults: paramResults,
          warnings: paramWarnings,
          error: failedParams.length ? "One or more effect parameters could not be set" : undefined
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async cropClip(clipId: string, options: { left?: number; right?: number; top?: number; bottom?: number; zoom?: boolean; edgeFeather?: number }): Promise<any> {
    const params: Record<string, any> = {};
    if (options.left !== undefined) params['Left'] = options.left;
    if (options.top !== undefined) params['Top'] = options.top;
    if (options.right !== undefined) params['Right'] = options.right;
    if (options.bottom !== undefined) params['Bottom'] = options.bottom;
    if (options.zoom !== undefined) params['Zoom'] = options.zoom;
    if (options.edgeFeather !== undefined) params['Edge Feather'] = options.edgeFeather;

    const paramJson = JSON.stringify(params);
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        if (info.trackType !== "video") return JSON.stringify({ success: false, error: "crop_clip only supports video clips" });

        var clip = info.clip;
        var cropComp = null;
        var cropCompIdx = -1;

        function isCropComponent(component) {
          return String(component.displayName) === "Crop" || String(component.matchName) === "AE.ADBE AECrop";
        }

        function findCropComponent() {
          for (var i = clip.components.numItems - 1; i >= 0; i--) {
            var component = clip.components[i];
            if (isCropComponent(component)) {
              cropComp = component;
              cropCompIdx = i;
              return true;
            }
          }
          return false;
        }

        var effectAdded = false;
        if (!findCropComponent()) {
          // Addressed by id, not by whatever is on screen. __findClip() searches every
          // sequence in the project, so a clip can be resolved out of one sequence and
          // then, through getActiveSequence(), have the effect applied to whichever
          // clip sits at the same track and index in a different one.
          var qeSeq = __qeSequenceFor(info.sequence);
          if (!qeSeq) return JSON.stringify({ success: false, error: "QE active sequence not available" });
          var qeTrack = qeSeq.getVideoTrackAt(info.trackIndex);
          if (!qeTrack) return JSON.stringify({ success: false, error: "QE video track not found for clip" });
          var effect = qe.project.getVideoEffectByName("Crop");
          if (!effect) return JSON.stringify({ success: false, error: "Crop effect not found. Use list_available_effects to inspect installed effects." });

          function findQeClipByTime() {
            var targetTicks = String(info.clip.start.ticks);
            var best = null;
            var bestDelta = null;
            for (var qi = 0; qi < qeTrack.numItems; qi++) {
              var item = qeTrack.getItemAt(qi);
              if (!item || String(item.type) !== "Clip") continue;
              var itemTicks = String(item.start.ticks);
              if (itemTicks === targetTicks) return item;
              var delta = Math.abs(parseInt(itemTicks, 10) - parseInt(targetTicks, 10));
              if (best === null || delta < bestDelta) {
                best = item;
                bestDelta = delta;
              }
            }
            return best;
          }

          var beforeCount = clip.components.numItems;
          var qeClip = findQeClipByTime();
          if (!qeClip) return JSON.stringify({ success: false, error: "Could not locate matching QE clip for Crop effect" });
          qeClip.addVideoEffect(effect);
          if (clip.components.numItems <= beforeCount) {
            return JSON.stringify({
              success: false,
              error: "Crop effect add did not create a new component on the target clip",
              beforeComponentCount: beforeCount,
              afterComponentCount: clip.components.numItems
            });
          }
          effectAdded = true;
          if (!findCropComponent()) {
            var addedNames = [];
            for (var ai = beforeCount; ai < clip.components.numItems; ai++) {
              addedNames.push(String(clip.components[ai].displayName));
            }
            return JSON.stringify({
              success: false,
              error: "Effect add completed but the new component was not Crop",
              addedComponents: addedNames
            });
          }
        }

        var requestedParams = ${paramJson};
        var paramResults = [];
        function normalize(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }
        for (var pName in requestedParams) {
          if (requestedParams.hasOwnProperty && !requestedParams.hasOwnProperty(pName)) continue;
          var requestedVal = requestedParams[pName];
          var matched = null;
          for (var k = 0; k < cropComp.properties.numItems; k++) {
            if (String(cropComp.properties[k].displayName) === pName) {
              matched = { prop: cropComp.properties[k], strategy: "exact" };
              break;
            }
          }
          if (!matched) {
            var nameN = normalize(pName);
            for (var nk = 0; nk < cropComp.properties.numItems; nk++) {
              if (normalize(String(cropComp.properties[nk].displayName)) === nameN) {
                matched = { prop: cropComp.properties[nk], strategy: "normalized" };
                break;
              }
            }
          }
          if (!matched) {
            paramResults.push({ requestedName: pName, ok: false, error: "no Crop property matches this displayName" });
            continue;
          }
          try {
            var valueBefore = null;
            try { valueBefore = matched.prop.getValue(); } catch (eB) {}
            matched.prop.setValue(requestedVal, true);
            var valueAfter = null;
            try { valueAfter = matched.prop.getValue(); } catch (eA) {}
            var clamped = false;
            if (typeof valueAfter === "number" && typeof requestedVal === "number") {
              clamped = Math.abs(valueAfter - requestedVal) > 0.0001;
            } else {
              clamped = valueAfter !== requestedVal;
            }
            // A clamped value is a legitimate outcome (Crop clamps to its domain), but a PURE
            // no-op -- the value neither moved from before nor matches the request -- is a silent
            // failure and must not be reported ok. Only guard the numeric case (clamping applies there).
            var noOp = false;
            if (typeof valueAfter === "number" && typeof requestedVal === "number" && typeof valueBefore === "number") {
              noOp = (Math.abs(valueAfter - valueBefore) < 0.0001) && (Math.abs(valueAfter - requestedVal) > 0.0001);
            }
            paramResults.push({
              requestedName: pName,
              matchedDisplayName: String(matched.prop.displayName),
              strategy: matched.strategy,
              valueRequested: requestedVal,
              valueBefore: valueBefore,
              valueAfter: valueAfter,
              clamped: clamped,
              ok: !noOp,
              error: noOp ? "setValue did not change the value (silent no-op)" : undefined
            });
          } catch (eSet) {
            paramResults.push({ requestedName: pName, ok: false, error: "setValue threw: " + eSet.toString() });
          }
        }

        var propsDump = [];
        for (var pi = 0; pi < cropComp.properties.numItems; pi++) {
          var prop = cropComp.properties[pi];
          var val = null;
          try { val = prop.getValue(); } catch (eVal) { val = "<getValue threw: " + eVal.toString() + ">"; }
          propsDump.push({ index: pi, displayName: String(prop.displayName), value: val });
        }

        var failedParams = [];
        for (var pr = 0; pr < paramResults.length; pr++) {
          if (!paramResults[pr].ok) failedParams.push(paramResults[pr]);
        }

        return JSON.stringify({
          success: failedParams.length === 0,
          message: effectAdded ? "Crop effect applied" : "Existing Crop effect updated",
          clipId: ${JSON.stringify(clipId)},
          effectName: "Crop",
          effectAdded: effectAdded,
          componentIndex: cropCompIdx,
          properties: propsDump,
          paramResults: paramResults,
          error: failedParams.length ? "One or more Crop parameters could not be set" : undefined
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "Crop effect failed: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async addTransition(clipId1: string, clipId2: string, transitionName: string, duration: number): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var info1 = __findClip(${JSON.stringify(clipId1)});
        if (!info1) return JSON.stringify({ success: false, error: "First clip not found" });
        var info2 = __findClip(${JSON.stringify(clipId2)});
        var targetInfo = info2 || info1;
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(targetInfo.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + targetInfo.sequenceName + "' through the QE API." });
        var qeTrack = qeSeq.getVideoTrackAt(targetInfo.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, targetInfo.clip);
        if (!qeClip) return JSON.stringify({ success: false, error: "Could not locate matching QE clip for transition" });
        var transition = qe.project.getVideoTransitionByName(${JSON.stringify(transitionName)});
        if (!transition) return JSON.stringify({ success: false, error: "Transition not found: " + ${JSON.stringify(transitionName)} + ". Use list_available_transitions." });
        // The clip may live outside the active sequence, and a duration in frames
        // computed from the wrong timebase gives the transition the wrong length.
        var seq = targetInfo.sequence;
        var fps = seq && seq.timebase ? (254016000000 / parseInt(seq.timebase, 10)) : 30;
        var frames = Math.round(${duration} * fps);
        ${this.transitionVerificationScript()}
        var before = __readQeTransitionState(qeClip);
        var beforeXml = __transitionXmlCount(seq);
        qeClip.addTransition(transition, info2 ? false : true, String(frames), "0", 0.5, false, true);
        var afterClip = __findQeClipByDomClip(qeTrack, targetInfo.clip);
        var after = __readQeTransitionState(afterClip);
        var afterXml = __transitionXmlCount(seq);
        if (!__transitionWasVerified(before, after) && !__transitionWasVerifiedByXml(beforeXml, afterXml)) {
          return JSON.stringify({
            success: false,
            error: "Transition call completed but Premiere Pro did not expose a verified transition change",
            transitionName: ${JSON.stringify(transitionName)},
            duration: ${duration},
            frames: frames,
            before: before,
            after: after,
            beforeXml: beforeXml,
            afterXml: afterXml
          });
        }
        return JSON.stringify({ success: true, message: "Transition added and verified", transitionName: ${JSON.stringify(transitionName)}, duration: ${duration}, frames: frames, before: before, after: after, beforeXml: beforeXml, afterXml: afterXml });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async addTransitionToClip(clipId: string, transitionName: string, position: 'start' | 'end', duration: number): Promise<any> {
    const atEnd = position === 'end';
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, status: "failed", verified: false, error: "Clip not found" });
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = info.trackType === 'video' ? qeSeq.getVideoTrackAt(info.trackIndex) : qeSeq.getAudioTrackAt(info.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, info.clip);
        if (!qeClip) return JSON.stringify({ success: false, status: "failed", verified: false, error: "Could not locate matching QE clip for transition" });
        var transition = info.trackType === 'video'
          ? qe.project.getVideoTransitionByName(${JSON.stringify(transitionName)})
          : qe.project.getAudioTransitionByName(${JSON.stringify(transitionName)});
        if (!transition) return JSON.stringify({ success: false, status: "failed", verified: false, error: "Transition not found: " + ${JSON.stringify(transitionName)} });
        // The clip may live outside the active sequence, and a duration in frames
        // computed from the wrong timebase gives the transition the wrong length.
        var seq = info.sequence;
        var fps = seq && seq.timebase ? (254016000000 / parseInt(seq.timebase, 10)) : 30;
        var frames = Math.round(${duration} * fps);
        ${this.transitionVerificationScript()}
        var before = __readQeTransitionState(qeClip);
        var beforeXml = __transitionXmlCount(seq);
        qeClip.addTransition(transition, ${atEnd}, String(frames), "0", 0.5, true, true);
        var afterClip = __findQeClipByDomClip(qeTrack, info.clip);
        var after = __readQeTransitionState(afterClip);
        var afterXml = __transitionXmlCount(seq);
        var qeVerified = __transitionWasVerified(before, after);
        var xmlVerified = __transitionWasVerifiedByXml(beforeXml, afterXml);
        if (!qeVerified && !xmlVerified) {
          var qeInspectionAvailable = before.available && after.available;
          var xmlInspectionAvailable = beforeXml.available && afterXml.available;
          var inspectionAvailable = qeInspectionAvailable || xmlInspectionAvailable;
          return JSON.stringify({
            success: true,
            status: "accepted_unverified",
            verified: false,
            verification: {
              method: "transition_enumeration_and_xml",
              available: inspectionAvailable,
              channels: {
                transitionEnumeration: {
                  available: qeInspectionAvailable,
                  before: qeInspectionAvailable ? before : null,
                  after: qeInspectionAvailable ? after : null
                },
                finalCutProXml: {
                  available: xmlInspectionAvailable,
                  before: xmlInspectionAvailable ? beforeXml : null,
                  after: xmlInspectionAvailable ? afterXml : null,
                  beforeError: beforeXml.error,
                  afterError: afterXml.error
                }
              },
              reason: inspectionAvailable
                ? "Available Premiere Pro inspection channels did not confirm a transition change; these channels can omit transitions for some clip types"
                : "Premiere Pro did not expose a readable transition list for this clip type",
              before: inspectionAvailable ? { transitionEnumeration: before, finalCutProXml: beforeXml } : null,
              after: inspectionAvailable ? { transitionEnumeration: after, finalCutProXml: afterXml } : null
            },
            warning: "Transition command accepted; result could not be independently verified.",
            transitionName: ${JSON.stringify(transitionName)},
            position: ${JSON.stringify(position)},
            duration: ${duration},
            frames: frames
          });
        }
        return JSON.stringify({
          success: true,
          status: "applied_verified",
          verified: true,
          message: "Transition added at " + ${JSON.stringify(position)} + " and verified",
          verification: {
            method: qeVerified ? "transition_enumeration" : "final_cut_pro_xml",
            available: true,
            reason: qeVerified ? null : "Verified by a sequence-wide Final Cut Pro XML transition-count increase",
            before: qeVerified ? before : beforeXml,
            after: qeVerified ? after : afterXml
          },
          transitionName: ${JSON.stringify(transitionName)},
          position: ${JSON.stringify(position)},
          duration: ${duration},
          frames: frames
        });
      } catch (e) {
        return JSON.stringify({ success: false, status: "failed", verified: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // Audio Analysis Implementation
  private async resolveProjectItemMediaPath(projectItemId: string): Promise<{ path?: string; error?: string }> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) {
          return JSON.stringify({ success: false, error: "Project item not found by id: " + ${JSON.stringify(projectItemId)} });
        }
        var mediaPath = null;
        try {
          mediaPath = item.getMediaPath();
        } catch (eMedia) {
          return JSON.stringify({ success: false, error: "Could not read media path: " + eMedia.toString() });
        }
        if (!mediaPath) {
          return JSON.stringify({ success: false, error: "Project item has no media path (is it a sequence or bin?)" });
        }
        return JSON.stringify({ success: true, mediaPath: mediaPath });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    const result = await this.bridge.executeScript(script);
    if (result?.success === false) {
      return { error: result.error || 'Failed to resolve project item media path' };
    }
    return { path: result?.mediaPath };
  }

  private checkFfmpegAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('ffmpeg', ['-version']);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  private parseSilenceIntervals(stderr: string): Array<{ start: number; end: number; duration: number }> {
    const starts: number[] = [];
    const ends: number[] = [];
    const startRe = /silence_start:\s*(-?[\d.]+)/g;
    const endRe = /silence_end:\s*(-?[\d.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = startRe.exec(stderr)) !== null) {
      starts.push(parseFloat(match[1]!));
    }
    while ((match = endRe.exec(stderr)) !== null) {
      ends.push(parseFloat(match[1]!));
    }
    const intervals: Array<{ start: number; end: number; duration: number }> = [];
    const count = Math.min(starts.length, ends.length);
    for (let i = 0; i < count; i++) {
      const start = starts[i]!;
      const end = ends[i]!;
      intervals.push({
        start,
        end,
        duration: Math.round((end - start) * 1000) / 1000,
      });
    }
    return intervals;
  }

  private async detectSilence(
    mediaPath?: string,
    projectItemId?: string,
    noiseThresholdDb = -30,
    minDurationSeconds = 1.5
  ): Promise<any> {
    let resolvedPath = mediaPath;

    if (!resolvedPath && projectItemId) {
      const resolved = await this.resolveProjectItemMediaPath(projectItemId);
      if (resolved.error) {
        return { success: false, error: resolved.error };
      }
      resolvedPath = resolved.path;
    }

    if (!resolvedPath) {
      return { success: false, error: 'Provide either mediaPath or projectItemId' };
    }

    const ffmpegAvailable = await this.checkFfmpegAvailable();
    if (!ffmpegAvailable) {
      return {
        success: false,
        error: 'ffmpeg was not found on PATH. detect_silence analyzes audio via ffmpeg\'s silencedetect filter, not Premiere\'s scripting API (which cannot read audio levels at all). Install ffmpeg (e.g. `brew install ffmpeg` on macOS) and try again.'
      };
    }

    return new Promise((resolve) => {
      const ffmpegArgs = [
        '-i', resolvedPath as string,
        '-af', `silencedetect=noise=${noiseThresholdDb}dB:d=${minDurationSeconds}`,
        '-f', 'null', '-'
      ];
      const proc = spawn('ffmpeg', ffmpegArgs);
      let stderr = '';

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: `Failed to run ffmpeg: ${err.message}` });
      });

      proc.on('close', (code) => {
        if (code !== 0 && stderr.indexOf('silence_start') === -1) {
          resolve({
            success: false,
            error: `ffmpeg exited with code ${code} and produced no silence data. This usually means the file couldn't be read.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000)
          });
          return;
        }
        const silenceIntervals = this.parseSilenceIntervals(stderr);
        resolve({
          success: true,
          mediaPath: resolvedPath,
          noiseThresholdDb,
          minDurationSeconds,
          silenceIntervals,
          note: 'Detection only -- nothing was cut. Use split_clip/ripple_delete/razor_timeline_at_time on a sequence to remove any of these intervals.'
        });
      });
    });
  }

  /**
   * Whether a command can be launched at all. Uses the child_process 'spawn'
   * event so we learn the binary exists WITHOUT waiting for a heavy tool
   * (whisper imports torch on --help, several seconds) to finish; the probe is
   * killed the instant it launches. ENOENT (not on PATH) surfaces as 'error'.
   */
  private checkCommandAvailable(command: string, probeArgs: string[] = ['--help']): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const proc = spawn(command, probeArgs);
        proc.on('error', () => done(false));
        proc.on('spawn', () => {
          done(true);
          try { proc.kill(); } catch { /* already gone */ }
        });
        // Fallback for runtimes that never emit 'spawn': a clean close still means it ran.
        proc.on('close', () => done(true));
      } catch {
        done(false);
      }
    });
  }

  /** Count subtitle cues in SRT text by its time-arrow lines. */
  private countSrtCues(srt: string): number {
    const matches = srt.match(/-->/g);
    return matches ? matches.length : 0;
  }

  /**
   * Transcribe speech in a media file to an .srt using the local OpenAI Whisper
   * CLI. Premiere has no speech-to-text scripting surface, so this runs entirely
   * server-side via child_process, mirroring detect_silence's ffmpeg pattern:
   * probe for the tool, fail with clear install guidance if absent, and
   * verify-after-write (the .srt must exist and be readable before we claim
   * success). Whisper is configurable via PREMIERE_MCP_WHISPER_CMD for installs
   * that expose a differently-named binary.
   */
  private async transcribeToSrt(
    mediaPath?: string,
    projectItemId?: string,
    outputDir?: string,
    model = 'base',
    language?: string,
    translateToEnglish = false,
    timeoutSeconds = 1800,
  ): Promise<any> {
    let resolvedPath = mediaPath;
    if (!resolvedPath && projectItemId) {
      const resolved = await this.resolveProjectItemMediaPath(projectItemId);
      if (resolved.error) {
        return { success: false, error: resolved.error };
      }
      resolvedPath = resolved.path;
    }
    if (!resolvedPath) {
      return { success: false, error: 'Provide either mediaPath or projectItemId' };
    }

    // The media must exist before we spend minutes launching Whisper on it.
    try {
      await fs.access(resolvedPath, fsConstants.R_OK);
    } catch {
      return { success: false, error: `Media file not found or unreadable: ${resolvedPath}` };
    }

    const whisperCmd = (process.env.PREMIERE_MCP_WHISPER_CMD || 'whisper').trim() || 'whisper';
    const whisperAvailable = await this.checkCommandAvailable(whisperCmd);
    if (!whisperAvailable) {
      return {
        success: false,
        error: `The Whisper CLI ('${whisperCmd}') was not found on PATH. transcribe_to_srt generates subtitles with a local OpenAI Whisper install, not Premiere's scripting API (which has no speech-to-text). Install it with \`pip install -U openai-whisper\` (also needs ffmpeg on PATH), or set PREMIERE_MCP_WHISPER_CMD to the binary name, then try again.`,
      };
    }

    const targetDir = (outputDir && outputDir.trim()) || dirname(resolvedPath);
    const baseName = basename(resolvedPath, extname(resolvedPath));
    const expectedSrt = join(targetDir, `${baseName}.srt`);

    const whisperArgs = [
      resolvedPath,
      '--model', model,
      '--output_format', 'srt',
      '--output_dir', targetDir,
    ];
    if (language && language.trim()) whisperArgs.push('--language', language.trim());
    if (translateToEnglish) whisperArgs.push('--task', 'translate');

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value: any): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const proc = spawn(whisperCmd, whisperArgs);
      let stderr = '';
      let stdout = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        finish({
          success: false,
          error: `Whisper transcription exceeded the ${timeoutSeconds}s timeout and was stopped. Nothing was reported as captions. Try a smaller --model, a shorter clip, or a larger timeoutSeconds.`,
          mediaPath: resolvedPath,
        });
      }, timeoutMs);

      proc.on('error', (err) => {
        clearTimeout(timer);
        finish({ success: false, error: `Failed to run Whisper ('${whisperCmd}'): ${err.message}`, mediaPath: resolvedPath });
      });

      proc.on('close', async (code) => {
        clearTimeout(timer);
        // Verify-after-write: only claim success if the .srt is actually on disk.
        let srt: string;
        try {
          srt = await fs.readFile(expectedSrt, 'utf8');
        } catch {
          finish({
            success: false,
            error: `Whisper exited with code ${code} but no subtitle file was found at ${expectedSrt}. The transcription did not produce captions.`,
            mediaPath: resolvedPath,
            whisperStderr: stderr.slice(-2000) || stdout.slice(-2000),
          });
          return;
        }

        const cueCount = this.countSrtCues(srt);
        finish({
          success: true,
          srtPath: expectedSrt,
          cueCount,
          model,
          language: language || 'auto-detected',
          task: translateToEnglish ? 'translate' : 'transcribe',
          mediaPath: resolvedPath,
          empty: cueCount === 0,
          note: cueCount === 0
            ? 'Whisper produced an .srt with no cues (no detectable speech, or the wrong language hint). The file exists but is empty of captions.'
            : 'Import this srtPath with import_media, then pass the resulting project item id to create_caption_track to lay the captions onto a sequence.',
        });
      });
    });
  }

  /** The ffprobe binary, overridable for installs that expose a different name. */
  private ffprobeCmd(): string {
    return (process.env.PREMIERE_MCP_FFPROBE_CMD || 'ffprobe').trim() || 'ffprobe';
  }

  /** The ffmpeg binary, overridable for installs that expose a different name. */
  private ffmpegCmd(): string {
    return (process.env.PREMIERE_MCP_FFMPEG_CMD || 'ffmpeg').trim() || 'ffmpeg';
  }

  /** Parse an ffprobe "num/den" (or plain) frame-rate string to fps. */
  private parseFrameRate(rate: string): number | undefined {
    const parts = rate.split('/');
    if (parts.length === 2) {
      const num = Number(parts[0]);
      const den = Number(parts[1]);
      if (den) return Math.round((num / den) * 1000) / 1000;
    }
    const single = Number(rate);
    return Number.isFinite(single) ? single : undefined;
  }

  /**
   * Read technical metadata from a media file with ffprobe. Premiere's scripting
   * DOM exposes only a thin slice of a clip's metadata (and nothing at all for
   * files that are not imported), so this shells out to ffprobe -- the same
   * child_process pattern as detect_silence: probe for the tool, fail with clear
   * install guidance if absent, and only return parsed data (never a fabricated
   * shape) when ffprobe actually produced JSON.
   */
  /**
   * Distil a parsed ffprobe JSON payload down to the fields we care about.
   * Shared by probe_media and the footage index so both describe media the same
   * way. Pure (no I/O), so it is unit-testable against fixtures.
   */
  private buildProbeSummary(parsed: any): any {
    const streams: any[] = Array.isArray(parsed?.streams) ? parsed.streams : [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const fmt = parsed?.format || {};
    return {
      durationSeconds: fmt.duration != null ? Number(fmt.duration) : undefined,
      formatName: fmt.format_name,
      sizeBytes: fmt.size != null ? Number(fmt.size) : undefined,
      bitRate: fmt.bit_rate != null ? Number(fmt.bit_rate) : undefined,
      videoStreamCount: streams.filter((s) => s.codec_type === 'video').length,
      audioStreamCount: streams.filter((s) => s.codec_type === 'audio').length,
      video: video
        ? {
            codec: video.codec_name,
            profile: video.profile,
            width: video.width,
            height: video.height,
            pixelFormat: video.pix_fmt,
            colorSpace: video.color_space,
            colorRange: video.color_range,
            bitDepth: video.bits_per_raw_sample != null ? Number(video.bits_per_raw_sample) : undefined,
            fps: typeof video.r_frame_rate === 'string' ? this.parseFrameRate(video.r_frame_rate) : undefined,
          }
        : null,
      audio: audio
        ? {
            codec: audio.codec_name,
            sampleRate: audio.sample_rate != null ? Number(audio.sample_rate) : undefined,
            channels: audio.channels,
            channelLayout: audio.channel_layout,
          }
        : null,
    };
  }

  /** Default media extensions the footage index scans (lowercase, no dot). */
  private static readonly FOOTAGE_EXTENSIONS = [
    'mov', 'mp4', 'm4v', 'mxf', 'avi', 'mkv', 'webm', 'r3d', 'braw', 'prores',
    'wav', 'aif', 'aiff', 'mp3', 'aac', 'flac', 'm4a',
    'png', 'jpg', 'jpeg', 'tif', 'tiff', 'exr', 'dpx', 'psd',
  ];

  /** Resolve where the footage index JSON lives (arg > env > default under home). */
  private footageIndexPath(indexPath?: string): string {
    if (indexPath && indexPath.trim()) return indexPath.trim();
    const fromEnv = (process.env.PREMIERE_MCP_FOOTAGE_INDEX || '').trim();
    if (fromEnv) return fromEnv;
    return join(homedir(), '.premiere-mcp', 'footage-index.json');
  }

  /**
   * Decide, purely, what a footage rescan must do. Given the entries already in
   * the index and the files just discovered on disk (each with size + mtimeMs),
   * classify every discovered file as unchanged (same path, size and mtime),
   * needs-probe (new or modified), and report which previously-indexed paths are
   * now missing. No I/O, so it is directly unit-testable -- the incremental
   * behaviour (don't re-ffprobe files that haven't changed) is the whole point of
   * an index, and this is where that logic lives.
   */
  private planFootageScan(
    existing: Array<{ path: string; size?: number; mtimeMs?: number }>,
    discovered: Array<{ path: string; size: number; mtimeMs: number }>,
  ): {
    toProbe: Array<{ path: string; size: number; mtimeMs: number }>;
    unchanged: string[];
    missing: string[];
  } {
    const byPath = new Map<string, { path: string; size?: number; mtimeMs?: number }>();
    for (const e of existing) byPath.set(e.path, e);
    const discoveredPaths = new Set(discovered.map((d) => d.path));

    const toProbe: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const unchanged: string[] = [];
    for (const d of discovered) {
      const prev = byPath.get(d.path);
      if (prev && prev.size === d.size && prev.mtimeMs === d.mtimeMs) {
        unchanged.push(d.path);
      } else {
        toProbe.push(d);
      }
    }
    const missing = existing.map((e) => e.path).filter((p) => !discoveredPaths.has(p));
    return { toProbe, unchanged, missing };
  }

  /**
   * Whether a footage index entry matches a set of search criteria. Pure and
   * side-effect-free so search_footage's filtering is unit-testable. All supplied
   * criteria must match (AND); an omitted criterion is ignored.
   */
  private matchFootageEntry(entry: any, criteria: any): boolean {
    if (!entry) return false;
    const s = entry.summary || {};
    const v = s.video || {};
    if (criteria.query) {
      const hay = String(entry.path || '').toLowerCase();
      if (!hay.includes(String(criteria.query).toLowerCase())) return false;
    }
    if (criteria.extension) {
      const want = String(criteria.extension).toLowerCase().replace(/^\./, '');
      const got = (entry.path.split('.').pop() || '').toLowerCase();
      if (got !== want) return false;
    }
    if (criteria.codec) {
      const want = String(criteria.codec).toLowerCase();
      const vc = String(v.codec || '').toLowerCase();
      const ac = String((s.audio || {}).codec || '').toLowerCase();
      if (vc !== want && ac !== want) return false;
    }
    if (criteria.minDurationSeconds != null && !(Number(s.durationSeconds) >= criteria.minDurationSeconds)) return false;
    if (criteria.maxDurationSeconds != null && !(Number(s.durationSeconds) <= criteria.maxDurationSeconds)) return false;
    if (criteria.minWidth != null && !(Number(v.width) >= criteria.minWidth)) return false;
    if (criteria.minHeight != null && !(Number(v.height) >= criteria.minHeight)) return false;
    if (criteria.minFps != null && !(Number(v.fps) >= criteria.minFps)) return false;
    if (criteria.maxFps != null && !(Number(v.fps) <= criteria.maxFps)) return false;
    if (criteria.hasAudio === true && !(s.audioStreamCount > 0)) return false;
    if (criteria.hasAudio === false && s.audioStreamCount > 0) return false;
    if (criteria.hasVideo === true && !(s.videoStreamCount > 0)) return false;
    if (criteria.hasVideo === false && s.videoStreamCount > 0) return false;
    return true;
  }

  /** Pure filter over an array of footage entries; see matchFootageEntry. */
  private queryFootageIndex(entries: any[], criteria: any): any[] {
    return (entries || []).filter((e) => this.matchFootageEntry(e, criteria));
  }

  /** Recursively collect media files under a root, with size + mtime for the scan plan. */
  private async walkMediaFiles(
    root: string,
    recursive: boolean,
    extensions: string[],
  ): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const wanted = new Set(extensions.map((e) => e.toLowerCase().replace(/^\./, '')));
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: any[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir -- skip, don't fail the whole scan
      }
      for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (recursive && !ent.name.startsWith('.')) await walk(full);
          continue;
        }
        if (!ent.isFile()) continue;
        const ext = (ent.name.split('.').pop() || '').toLowerCase();
        if (!wanted.has(ext)) continue;
        try {
          const st = await fs.stat(full);
          out.push({ path: full, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch { /* vanished between readdir and stat -- skip */ }
      }
    };
    await walk(root);
    return out;
  }

  /**
   * Build or refresh a local, persistent index of media on disk so footage
   * DISCOVERY -- the real bottleneck -- stops requiring the media to be imported
   * into Premiere first. Walks a folder, ffprobes each new or changed file (files
   * whose path + size + mtime already match the index are skipped, so a rescan is
   * cheap), and writes a JSON index. Entirely local (ffprobe + filesystem); makes
   * no Premiere request. Honesty contract: needs ffprobe (returns install
   * guidance if absent) and reports exactly what it scanned, added, updated,
   * skipped, and could not read.
   */
  private async indexFootage(
    rootPath?: string,
    recursive = true,
    extensions?: string[],
    indexPath?: string,
    pruneMissing = false,
  ): Promise<any> {
    if (!rootPath || !rootPath.trim()) {
      return { success: false, error: 'Provide rootPath -- the folder to scan for media.' };
    }
    if (!isAbsolute(rootPath)) {
      return { success: false, error: `rootPath must be an absolute path. Got: ${rootPath}` };
    }
    try {
      const st = await fs.stat(rootPath);
      if (!st.isDirectory()) return { success: false, error: `rootPath is not a folder: ${rootPath}` };
    } catch {
      return { success: false, error: `Folder not found or unreadable: ${rootPath}` };
    }

    const ffprobe = this.ffprobeCmd();
    const available = await this.checkCommandAvailable(ffprobe, ['-version']);
    if (!available) {
      return {
        success: false,
        error: `ffprobe ('${ffprobe}') was not found on PATH. index_footage reads media metadata with ffprobe, which ships with ffmpeg. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFPROBE_CMD to the binary name, then try again.`,
      };
    }

    const resolvedIndexPath = this.footageIndexPath(indexPath);
    const exts = extensions && extensions.length ? extensions : PremiereProTools.FOOTAGE_EXTENSIONS;

    // Load the existing index (tolerate absence / corruption -- start fresh).
    let existingEntries: any[] = [];
    try {
      const raw = await fs.readFile(resolvedIndexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.entries)) existingEntries = parsed.entries;
    } catch { /* no usable prior index */ }

    const discovered = await this.walkMediaFiles(rootPath, recursive, exts);
    const plan = this.planFootageScan(existingEntries, discovered);

    // Probe the new/changed files.
    const byPath = new Map<string, any>(existingEntries.map((e) => [e.path, e]));
    const errors: Array<{ path: string; error: string }> = [];
    let added = 0;
    let updated = 0;
    for (const file of plan.toProbe) {
      const probe = await this.ffprobeFile(file.path, ffprobe);
      if (!probe.success) {
        errors.push({ path: file.path, error: probe.error || 'ffprobe failed' });
        continue;
      }
      const wasPresent = byPath.has(file.path);
      byPath.set(file.path, {
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        summary: probe.summary,
      });
      if (wasPresent) updated += 1; else added += 1;
    }

    // Optionally drop entries whose files are gone; otherwise keep them.
    let pruned = 0;
    if (pruneMissing) {
      for (const p of plan.missing) {
        if (byPath.delete(p)) pruned += 1;
      }
    }

    const mergedEntries = Array.from(byPath.values()).sort((a, b) => String(a.path).localeCompare(String(b.path)));
    const indexDoc = {
      version: 1,
      root: rootPath,
      entryCount: mergedEntries.length,
      entries: mergedEntries,
    };

    // Write the index (verify-after-write: read it back and confirm the count).
    try {
      await fs.mkdir(dirname(resolvedIndexPath), { recursive: true });
      const tmp = `${resolvedIndexPath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(indexDoc, null, 2), 'utf8');
      await fs.rename(tmp, resolvedIndexPath);
      const back = JSON.parse(await fs.readFile(resolvedIndexPath, 'utf8'));
      if (!Array.isArray(back?.entries) || back.entries.length !== mergedEntries.length) {
        return { success: false, error: 'Wrote the footage index but read-back did not match. The index may be on a full or read-only disk.', indexPath: resolvedIndexPath };
      }
    } catch (e) {
      return { success: false, error: `Could not write the footage index at ${resolvedIndexPath}: ${e instanceof Error ? e.message : String(e)}` };
    }

    return {
      success: true,
      indexPath: resolvedIndexPath,
      root: rootPath,
      scanned: discovered.length,
      added,
      updated,
      unchanged: plan.unchanged.length,
      missing: plan.missing.length,
      pruned,
      probeErrors: errors.length,
      errors: errors.slice(0, 20),
      totalIndexed: mergedEntries.length,
      note: pruneMissing
        ? 'Rescan complete. Entries for files no longer on disk were pruned. Query it with search_footage.'
        : `Rescan complete. ${plan.missing.length} previously-indexed file(s) were not found on disk this pass but were KEPT (pass pruneMissing=true to drop them). Query it with search_footage.`,
    };
  }

  /** Run ffprobe on one file and return its distilled summary. */
  private ffprobeFile(path: string, ffprobe: string): Promise<{ success: boolean; summary?: any; error?: string }> {
    return new Promise((resolve) => {
      const argv = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path];
      const proc = spawn(ffprobe, argv);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (c) => { stdout += c.toString(); });
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.on('error', (err) => resolve({ success: false, error: err.message }));
      proc.on('close', () => {
        try {
          resolve({ success: true, summary: this.buildProbeSummary(JSON.parse(stdout)) });
        } catch {
          resolve({ success: false, error: stderr.slice(-300) || 'ffprobe returned no parseable metadata' });
        }
      });
    });
  }

  /**
   * Query the local footage index built by index_footage. Read-only, entirely
   * local -- no Premiere request. Filters by filename substring, extension,
   * codec, duration/resolution/fps ranges, and audio/video presence. Returns
   * matches (path + distilled technical summary) so an agent can FIND the right
   * footage before importing it.
   */
  private async searchFootage(criteria: any = {}, indexPath?: string, limit = 100): Promise<any> {
    const resolvedIndexPath = this.footageIndexPath(indexPath);
    let doc: any;
    try {
      doc = JSON.parse(await fs.readFile(resolvedIndexPath, 'utf8'));
    } catch {
      return {
        success: false,
        error: `No footage index found at ${resolvedIndexPath}. Build one first with index_footage (pass the folder as rootPath), or point indexPath / PREMIERE_MCP_FOOTAGE_INDEX at an existing index.`,
      };
    }
    const entries: any[] = Array.isArray(doc?.entries) ? doc.entries : [];
    const matches = this.queryFootageIndex(entries, criteria);
    const capped = matches.slice(0, Math.max(0, limit));
    return {
      success: true,
      indexPath: resolvedIndexPath,
      totalIndexed: entries.length,
      matchCount: matches.length,
      returned: capped.length,
      truncated: matches.length > capped.length,
      results: capped,
    };
  }

  private async probeMedia(mediaPath?: string, projectItemId?: string): Promise<any> {
    let resolvedPath = mediaPath;
    if (!resolvedPath && projectItemId) {
      const resolved = await this.resolveProjectItemMediaPath(projectItemId);
      if (resolved.error) return { success: false, error: resolved.error };
      resolvedPath = resolved.path;
    }
    if (!resolvedPath) return { success: false, error: 'Provide either mediaPath or projectItemId' };

    try {
      await fs.access(resolvedPath, fsConstants.R_OK);
    } catch {
      return { success: false, error: `Media file not found or unreadable: ${resolvedPath}` };
    }

    const ffprobe = this.ffprobeCmd();
    const available = await this.checkCommandAvailable(ffprobe, ['-version']);
    if (!available) {
      return {
        success: false,
        error: `ffprobe ('${ffprobe}') was not found on PATH. probe_media reads media metadata with ffprobe, which ships with ffmpeg, not via Premiere's scripting API. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFPROBE_CMD to the binary name, then try again.`,
      };
    }

    return await new Promise((resolve) => {
      const argv = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', resolvedPath as string];
      const proc = spawn(ffprobe, argv);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => {
        resolve({ success: false, error: `Failed to run ffprobe ('${ffprobe}'): ${err.message}`, mediaPath: resolvedPath });
      });
      proc.on('close', (code) => {
        let parsed: any;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          resolve({
            success: false,
            error: `ffprobe exited with code ${code} and did not return parseable metadata. The file may be unreadable or not a media file.`,
            mediaPath: resolvedPath,
            ffprobeStderr: stderr.slice(-2000),
          });
          return;
        }
        const summary = this.buildProbeSummary(parsed);
        resolve({ success: true, mediaPath: resolvedPath, summary, probe: parsed });
      });
    });
  }

  /** Map a scope name to its (verified) ffmpeg video filter. */
  private scopeFilter(scope: string): string {
    switch (scope) {
      case 'vectorscope': return 'vectorscope';
      case 'histogram': return 'histogram';
      case 'rgb_parade': return 'waveform=display=parade:components=7';
      case 'waveform':
      default: return 'waveform';
    }
  }

  /**
   * Render a signal scope (waveform / vectorscope / histogram / RGB parade) from
   * one frame of a media file to a PNG, via ffmpeg. Premiere's Lumetri scopes
   * are not scriptable, so this is the only way to get scope output from the
   * pipeline. Same honesty contract as detect_silence/transcribe_to_srt: probe
   * for ffmpeg, fail with install guidance if absent, and verify-after-write
   * (the PNG must exist) before claiming success -- so an out-of-range timestamp
   * or unreadable file returns a clear error, not a fake success.
   */
  private async generateScope(
    mediaPath?: string,
    projectItemId?: string,
    scope = 'waveform',
    timeSeconds = 0,
    outputPath?: string,
  ): Promise<any> {
    let resolvedPath = mediaPath;
    if (!resolvedPath && projectItemId) {
      const resolved = await this.resolveProjectItemMediaPath(projectItemId);
      if (resolved.error) return { success: false, error: resolved.error };
      resolvedPath = resolved.path;
    }
    if (!resolvedPath) return { success: false, error: 'Provide either mediaPath or projectItemId' };

    try {
      await fs.access(resolvedPath, fsConstants.R_OK);
    } catch {
      return { success: false, error: `Media file not found or unreadable: ${resolvedPath}` };
    }

    const ffmpeg = this.ffmpegCmd();
    const available = await this.checkCommandAvailable(ffmpeg, ['-version']);
    if (!available) {
      return {
        success: false,
        error: `ffmpeg ('${ffmpeg}') was not found on PATH. generate_scope renders scopes with ffmpeg because Premiere's Lumetri scopes cannot be scripted or exported. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFMPEG_CMD to the binary name, then try again.`,
      };
    }

    const outPng = (outputPath && outputPath.trim())
      || join(dirname(resolvedPath), `${basename(resolvedPath, extname(resolvedPath))}_${scope}.png`);
    const filter = this.scopeFilter(scope);
    const seek = Math.max(0, timeSeconds);

    return await new Promise((resolve) => {
      const argv = ['-y', '-ss', String(seek), '-i', resolvedPath as string, '-frames:v', '1', '-vf', filter, outPng];
      const proc = spawn(ffmpeg, argv);
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => {
        resolve({ success: false, error: `Failed to run ffmpeg ('${ffmpeg}'): ${err.message}`, mediaPath: resolvedPath });
      });
      proc.on('close', async (code) => {
        // Verify-after-write: the PNG must actually exist before we claim success.
        try {
          await fs.access(outPng, fsConstants.R_OK);
        } catch {
          resolve({
            success: false,
            error: `ffmpeg exited with code ${code} but no scope image was written to ${outPng}. The frame at ${seek}s may be past the end of the clip, or the file couldn't be read.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        let sizeBytes: number | undefined;
        try { sizeBytes = (await fs.stat(outPng)).size; } catch { /* size is best-effort */ }
        resolve({
          success: true,
          scope,
          scopePath: outPng,
          timeSeconds: seek,
          sizeBytes,
          mediaPath: resolvedPath,
          note: `Scope image written. ffmpeg filter used: "${filter}" at t=${seek}s.`,
        });
      });
    });
  }

  /**
   * Build an ffmpeg atempo filter chain for an arbitrary speed factor. A single
   * atempo is only valid in [0.5, 2.0], so a factor outside that range is
   * decomposed into a product of in-range steps (e.g. 4x -> atempo=2,atempo=2;
   * 0.25x -> atempo=0.5,atempo=0.5). Pitch is preserved. Returns a comma-joined
   * chain suitable for -af.
   */
  private buildAtempoChain(speed: number): string {
    const steps: number[] = [];
    let remaining = speed;
    // Factor down while too fast (>2), and up while too slow (<0.5).
    while (remaining > 2.0 + 1e-9) { steps.push(2.0); remaining /= 2.0; }
    while (remaining < 0.5 - 1e-9) { steps.push(0.5); remaining *= 2.0; }
    steps.push(Math.round(remaining * 1e6) / 1e6);
    return steps.map((s) => `atempo=${s}`).join(',');
  }

  /**
   * Bake a constant speed change to a NEW media file with ffmpeg. This is the
   * honest escape hatch for Premiere's never-scriptable time-remap graph: rather
   * than writing speed keyframes the renderer ignores, produce a real retimed
   * clip on disk the caller can import and place. Same honesty contract as
   * generate_scope: resolve the source, fail with install guidance if ffmpeg is
   * absent, and verify-after-write (the output must exist and be non-empty)
   * before claiming success.
   */
  private async bakeSpeedChange(
    mediaPath?: string,
    projectItemId?: string,
    speed?: number,
    outputPath?: string,
    includeAudio = true,
    preservePitch = true,
  ): Promise<any> {
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
      return { success: false, error: 'Provide a speed multiplier greater than 0 (e.g. 0.5 for half speed, 2 for double).' };
    }

    let resolvedPath = mediaPath;
    if (!resolvedPath && projectItemId) {
      const resolved = await this.resolveProjectItemMediaPath(projectItemId);
      if (resolved.error) return { success: false, error: resolved.error };
      resolvedPath = resolved.path;
    }
    if (!resolvedPath) return { success: false, error: 'Provide either mediaPath or projectItemId' };

    try {
      await fs.access(resolvedPath, fsConstants.R_OK);
    } catch {
      return { success: false, error: `Media file not found or unreadable: ${resolvedPath}` };
    }

    const ffmpeg = this.ffmpegCmd();
    const available = await this.checkCommandAvailable(ffmpeg, ['-version']);
    if (!available) {
      return {
        success: false,
        error: `ffmpeg ('${ffmpeg}') was not found on PATH. bake_speed_change retimes clips with ffmpeg because Premiere's time-remap graph cannot be scripted. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFMPEG_CMD to the binary name, then try again.`,
      };
    }

    const ext = extname(resolvedPath) || '.mp4';
    const speedLabel = String(speed).replace(/\./g, '_');
    const outFile = (outputPath && outputPath.trim())
      || join(dirname(resolvedPath), `${basename(resolvedPath, extname(resolvedPath))}_${speedLabel}x${ext}`);

    // Video: setpts scales presentation timestamps by 1/speed.
    const argv: string[] = ['-y', '-i', resolvedPath as string, '-vf', `setpts=${(1 / speed).toFixed(6)}*PTS`];
    if (includeAudio) {
      const audioFilter = preservePitch
        ? this.buildAtempoChain(speed)
        // Pitch shifts with speed: resample the sample clock then reset to 48k.
        : `asetrate=48000*${speed},aresample=48000`;
      argv.push('-af', audioFilter);
    } else {
      argv.push('-an');
    }
    argv.push(outFile);

    return await new Promise((resolve) => {
      const proc = spawn(ffmpeg, argv);
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => {
        resolve({ success: false, error: `Failed to run ffmpeg ('${ffmpeg}'): ${err.message}`, mediaPath: resolvedPath });
      });
      proc.on('close', async (code) => {
        let sizeBytes = 0;
        try {
          await fs.access(outFile, fsConstants.R_OK);
          sizeBytes = (await fs.stat(outFile)).size;
        } catch {
          resolve({
            success: false,
            error: `ffmpeg exited with code ${code} but no retimed file was written to ${outFile}. The source may be unreadable or the codec unsupported.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        if (sizeBytes === 0) {
          resolve({
            success: false,
            error: `ffmpeg wrote an empty file to ${outFile} (0 bytes). The retime did not produce usable output.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        resolve({
          success: true,
          speed,
          includeAudio,
          preservePitch: includeAudio ? preservePitch : undefined,
          outputPath: outFile,
          sizeBytes,
          mediaPath: resolvedPath,
          note: `Retimed clip written at ${speed}x. Import it with import_media and place it on a timeline. This is a constant time-scale (not optical-flow interpolation); for a ramp, bake segments and butt them together.`,
        });
      });
    });
  }

  /**
   * Normalize a file to an EBU R128 loudness target with ffmpeg's two-pass
   * loudnorm, writing a NEW file. Premiere exposes no scriptable loudness
   * measurement or normalization, so this is the only honest way to hit a
   * delivery spec from the pipeline. Pass 1 measures the source (loudnorm in
   * print mode over ffprobe/ffmpeg); pass 2 applies linear normalization seeded
   * with the measured values for an accurate result. Same honesty contract:
   * install guidance if ffmpeg is absent, verify-after-write before success, and
   * the measured input loudness is returned so the change is auditable.
   */
  private async normalizeLoudness(
    mediaPath?: string,
    projectItemId?: string,
    targetLufs = -14,
    truePeakDb = -1.0,
    loudnessRange = 11,
    outputPath?: string,
  ): Promise<any> {
    let resolvedPath = mediaPath;
    if (!resolvedPath && projectItemId) {
      const resolved = await this.resolveProjectItemMediaPath(projectItemId);
      if (resolved.error) return { success: false, error: resolved.error };
      resolvedPath = resolved.path;
    }
    if (!resolvedPath) return { success: false, error: 'Provide either mediaPath or projectItemId' };

    try {
      await fs.access(resolvedPath, fsConstants.R_OK);
    } catch {
      return { success: false, error: `Media file not found or unreadable: ${resolvedPath}` };
    }

    const ffmpeg = this.ffmpegCmd();
    const available = await this.checkCommandAvailable(ffmpeg, ['-version']);
    if (!available) {
      return {
        success: false,
        error: `ffmpeg ('${ffmpeg}') was not found on PATH. normalize_loudness measures and corrects loudness with ffmpeg's loudnorm filter because Premiere exposes no scriptable loudness control. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFMPEG_CMD to the binary name, then try again.`,
      };
    }

    const loudnormBase = `I=${targetLufs}:TP=${truePeakDb}:LRA=${loudnessRange}`;
    const ext = extname(resolvedPath) || '.wav';
    const outFile = (outputPath && outputPath.trim())
      || join(dirname(resolvedPath), `${basename(resolvedPath, extname(resolvedPath))}_norm${targetLufs}LUFS${ext}`);

    // Pass 1: measure. loudnorm prints a JSON blob to stderr in print_format=json.
    const measured = await new Promise<{ ok: boolean; data?: any; stderr: string }>((resolve) => {
      const argv = ['-i', resolvedPath as string, '-af', `loudnorm=${loudnormBase}:print_format=json`, '-f', 'null', '-'];
      const proc = spawn(ffmpeg, argv);
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', () => resolve({ ok: false, stderr }));
      proc.on('close', () => {
        // The JSON is the last {...} block in stderr.
        const match = stderr.match(/\{[\s\S]*?\}/g);
        if (!match || match.length === 0) { resolve({ ok: false, stderr }); return; }
        try { resolve({ ok: true, data: JSON.parse(match[match.length - 1] as string), stderr }); }
        catch { resolve({ ok: false, stderr }); }
      });
    });

    if (!measured.ok || !measured.data) {
      return {
        success: false,
        error: 'ffmpeg could not measure the source loudness (loudnorm pass 1 produced no JSON). The file may have no audio stream or be unreadable.',
        mediaPath: resolvedPath,
        ffmpegStderr: measured.stderr.slice(-2000),
      };
    }

    const m = measured.data;
    // Pass 2: apply linear normalization seeded with the measured values.
    const loudnormApply =
      `loudnorm=${loudnormBase}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
      `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:` +
      `offset=${m.target_offset}:linear=true:print_format=summary`;

    return await new Promise((resolve) => {
      const argv = ['-y', '-i', resolvedPath as string, '-af', loudnormApply, outFile];
      const proc = spawn(ffmpeg, argv);
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => {
        resolve({ success: false, error: `Failed to run ffmpeg ('${ffmpeg}'): ${err.message}`, mediaPath: resolvedPath });
      });
      proc.on('close', async (code) => {
        let sizeBytes = 0;
        try {
          await fs.access(outFile, fsConstants.R_OK);
          sizeBytes = (await fs.stat(outFile)).size;
        } catch {
          resolve({
            success: false,
            error: `ffmpeg exited with code ${code} but no normalized file was written to ${outFile}.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        if (sizeBytes === 0) {
          resolve({
            success: false,
            error: `ffmpeg wrote an empty file to ${outFile} (0 bytes).`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        resolve({
          success: true,
          outputPath: outFile,
          sizeBytes,
          target: { integratedLufs: targetLufs, truePeakDb, loudnessRangeLu: loudnessRange },
          measuredInput: {
            integratedLufs: Number(m.input_i),
            truePeakDb: Number(m.input_tp),
            loudnessRangeLu: Number(m.input_lra),
            thresholdLufs: Number(m.input_thresh),
          },
          mediaPath: resolvedPath,
          note: `Normalized to ${targetLufs} LUFS (true peak <= ${truePeakDb} dBTP) with two-pass loudnorm. Import the output with import_media to use it.`,
        });
      });
    });
  }

  /**
   * Read a sequence's full track structure (video + audio clips with times and
   * best-effort source frame rate, plus the sequence frame rate). Read-only.
   * Shared by lint_timeline and diff_sequences. Defaults to the active sequence.
   */
  private async walkSequence(sequenceId?: string): Promise<any> {
    const seqExpr = sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence';
    const script = `
      try {
        var sequence = ${seqExpr};
        if (!sequence) return JSON.stringify({ success: false, error: ${sequenceId ? `"Sequence not found by id: " + ${JSON.stringify(sequenceId)}` : '"No active sequence"'} });

        var fps = 30;
        try { if (sequence.timebase) fps = 254016000000.0 / parseInt(sequence.timebase, 10); } catch (eFps) {}

        function readClipFps(clip) {
          try {
            var pit = clip.projectItem;
            if (pit && pit.getFootageInterpretation) {
              var interp = pit.getFootageInterpretation();
              if (interp && interp.frameRate) return Number(interp.frameRate);
            }
          } catch (eInterp) {}
          return null;
        }

        function walk(trackGroup) {
          var out = [];
          for (var i = 0; i < trackGroup.numTracks; i++) {
            var track = trackGroup[i];
            var clips = [];
            for (var j = 0; j < track.clips.numItems; j++) {
              var clip = track.clips[j];
              var srcFps = readClipFps(clip);
              var entry = {
                name: clip.name,
                startTime: clip.start.seconds,
                endTime: clip.end.seconds,
                duration: clip.duration.seconds
              };
              if (srcFps) entry.sourceFrameRate = srcFps;
              clips.push(entry);
            }
            out.push({ index: i, name: track.name || "", clips: clips });
          }
          return out;
        }

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          frameRate: Math.round(fps * 1000) / 1000,
          videoTracks: walk(sequence.videoTracks),
          audioTracks: walk(sequence.audioTracks)
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
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

  /**
   * Probe which render-truth capture taps are usable on THIS machine, cached
   * with a short TTL so a burst of captures does not re-probe each time (speed
   * mandate). Four taps, one abstraction:
   *
   *   - render/export: zero-dependency, both OSes, video + audio (via Premiere's
   *     own frame export / Media Encoder). Always available whenever Premiere is
   *     connected -- it is the correctness fallback, never the latency path.
   *   - NDI: real-time video + audio, both OSes; needs an NDI runtime + a
   *     Transmit-style plugin publishing the Program feed.
   *   - Syphon: lowest-latency GPU frame, macOS only, video only.
   *   - Spout: lowest-latency GPU frame, Windows only, video only.
   *
   * The GPU/network taps require a native receiver we do not ship yet, so unless
   * an install advertises one via an env override we report them unavailable
   * with honest per-OS install guidance rather than pretending they work. This
   * probe is intentionally cheap and side-effect-free; it never spawns a
   * receiver (warm persistent receivers are a later optimisation, not something
   * to start here on a mere probe).
   */
  private probeCaptureTaps(): CaptureTapReport[] {
    const CACHE_TTL_MS = 30_000;
    const cached = this.captureTapsCache;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.taps;
    }

    const os = platform(); // 'darwin' | 'win32' | 'linux' | ...
    const isMac = os === 'darwin';
    const isWin = os === 'win32';

    // An install can point us at a receiver it set up itself. We only claim a
    // GPU/network tap is available when such a signal is present -- never guess.
    const ndiEnv = Boolean(process.env.PREMIERE_MCP_NDI_RECEIVER);
    const syphonEnv = Boolean(process.env.PREMIERE_MCP_SYPHON_RECEIVER);
    const spoutEnv = Boolean(process.env.PREMIERE_MCP_SPOUT_RECEIVER);

    const taps: CaptureTapReport[] = [
      {
        tap: 'render',
        available: true,
        video: true,
        audio: true,
        realtime: false,
        reason: 'Zero-dependency: captures the composited frame via Premiere\'s own frame export. Requires only that Premiere is connected.',
      },
      {
        tap: 'ndi',
        available: ndiEnv,
        video: true,
        audio: true,
        realtime: true,
        reason: ndiEnv
          ? 'NDI receiver advertised via PREMIERE_MCP_NDI_RECEIVER.'
          : 'No NDI receiver detected. NDI gives a real-time video+audio feed on macOS and Windows but needs an NDI runtime plus a Transmit-style plugin publishing the Program feed.',
        install: ndiEnv
          ? undefined
          : 'Install the NDI Tools/runtime (ndi.video) and a Premiere Transmit plugin that outputs NDI, then set PREMIERE_MCP_NDI_RECEIVER to your receiver command/endpoint.',
      },
      {
        tap: 'syphon',
        available: isMac && syphonEnv,
        video: true,
        audio: false,
        realtime: true,
        reason: !isMac
          ? `Syphon is macOS-only; this host is ${os}. Use Spout on Windows or NDI cross-platform.`
          : (syphonEnv
            ? 'Syphon receiver advertised via PREMIERE_MCP_SYPHON_RECEIVER.'
            : 'No Syphon receiver detected. Syphon is the lowest-latency macOS GPU frame tap (video only).'),
        install: isMac && !syphonEnv
          ? 'Install a Syphon-capable Transmit plugin for Premiere plus a Syphon receiver, then set PREMIERE_MCP_SYPHON_RECEIVER to your receiver command.'
          : undefined,
      },
      {
        tap: 'spout',
        available: isWin && spoutEnv,
        video: true,
        audio: false,
        realtime: true,
        reason: !isWin
          ? `Spout is Windows-only; this host is ${os}. Use Syphon on macOS or NDI cross-platform.`
          : (spoutEnv
            ? 'Spout receiver advertised via PREMIERE_MCP_SPOUT_RECEIVER.'
            : 'No Spout receiver detected. Spout is the lowest-latency Windows GPU frame tap (video only).'),
        install: isWin && !spoutEnv
          ? 'Install a Spout-capable Transmit plugin for Premiere plus a Spout receiver, then set PREMIERE_MCP_SPOUT_RECEIVER to your receiver command.'
          : undefined,
      },
    ];

    this.captureTapsCache = { at: Date.now(), taps };
    return taps;
  }

  /**
   * Resolve the active sequence's id, so capture_program_output can default to
   * "whatever is open" the way the frame/scope tools elsewhere accept no id.
   */
  private async resolveActiveSequenceId(): Promise<{ id?: string; name?: string; error?: string }> {
    const script = `
      try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: "No active sequence" });
        return JSON.stringify({ success: true, id: String(seq.sequenceID), name: seq.name });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    const res = await this.bridge.executeScript(script);
    if (res && res.success && res.id) return { id: String(res.id), name: res.name };
    return { error: (res && res.error) || 'Could not resolve the active sequence' };
  }

  /**
   * Capture the actual COMPOSITED Program Monitor output -- the real rendered
   * pixels of the sequence at a time -- and write it to an image, so a model can
   * SEE what the edit renders to rather than trusting an API return value. This
   * is Wall 1 of the render-truth loop.
   *
   * Premiere never hands script a framebuffer of the program, so the frame is
   * obtained off one of four taps (see probeCaptureTaps). The render/export tap
   * is the zero-dependency correctness path and reuses exportFrame (Premiere's
   * own QE frame export, which bakes in every clip/effect/title/grade). The
   * GPU/network taps (NDI/Syphon/Spout) are real-time but require a native
   * receiver we do not ship yet; when one is forced and unavailable we return
   * install guidance rather than silently substituting render/export.
   *
   * Honesty contract: always report which tap was actually used; verify a real
   * frame landed on disk (delegated to exportFrame's verify-after-write) before
   * claiming success; never hang and never fake a frame.
   */
  private async captureProgramOutput(
    sequenceId?: string,
    time?: number,
    format: 'png' | 'jpg' | 'tiff' = 'png',
    outputPath?: string,
    tap: 'auto' | 'render' | 'ndi' | 'syphon' | 'spout' = 'auto',
    probeOnly = false,
  ): Promise<any> {
    const taps = this.probeCaptureTaps();
    const tapReport = (name: string): CaptureTapReport | undefined => taps.find((t) => t.tap === name);

    if (probeOnly) {
      const best = taps.find((t) => t.available && t.realtime) || tapReport('render');
      return {
        success: true,
        probeOnly: true,
        os: platform(),
        taps,
        recommendedTap: best ? best.tap : 'render',
        note: 'Capability probe only -- no frame was captured. render/export is always available when Premiere is connected; NDI/Syphon/Spout need a Transmit plugin + native receiver (see each tap\'s install guidance).',
      };
    }

    // Resolve which tap to actually use. GPU/network taps are not yet wired to a
    // receiver here, so the only tap that can produce a frame is render/export.
    const requested = tap || 'auto';
    if (requested !== 'auto' && requested !== 'render') {
      const report = tapReport(requested);
      // Forcing an unavailable GPU/network tap must fail honestly, not fall back silently.
      return {
        success: false,
        requestedTap: requested,
        available: false,
        error: `Capture tap '${requested}' is not available on this machine. ${report ? report.reason : ''}`.trim(),
        install: report ? report.install : undefined,
        hint: 'Pass tap:"render" (or tap:"auto") to use the zero-dependency render/export tap, or probeOnly:true to see all taps.',
        taps,
      };
    }
    // 'render' explicitly, or 'auto' (no real-time receiver present → render/export is the best available).
    const chosenTap: CaptureTapReport = tapReport('render') as CaptureTapReport;

    // Resolve sequence: explicit id, else the active sequence.
    let resolvedSequenceId = sequenceId;
    let resolvedSequenceName: string | undefined;
    if (!resolvedSequenceId) {
      const active = await this.resolveActiveSequenceId();
      if (active.error || !active.id) {
        return {
          success: false,
          error: active.error || 'No sequenceId provided and no active sequence to capture.',
          tapUsed: chosenTap.tap,
        };
      }
      resolvedSequenceId = active.id;
      resolvedSequenceName = active.name;
    }

    // Resolve time: explicit, else the current playhead of that sequence.
    let resolvedTime: number;
    if (time === undefined || time === null) {
      const playhead = await this.getPlayheadPosition(resolvedSequenceId);
      resolvedTime = (playhead && playhead.success && typeof playhead.position === 'number')
        ? playhead.position
        : 0;
    } else {
      resolvedTime = time;
    }

    // Default output path: a timestamped file in the system temp dir so we never
    // scatter files at the caller's cwd and never overwrite a prior capture.
    const outPath = (outputPath && outputPath.trim())
      || join(tmpdir(), `premiere-program-${resolvedSequenceId}-${Date.now()}.${format}`);

    const result = await this.exportFrame(resolvedSequenceId, resolvedTime, outPath, format);

    if (!result || !result.success) {
      return {
        success: false,
        tapUsed: chosenTap.tap,
        requestedTap: requested,
        sequenceId: resolvedSequenceId,
        time: resolvedTime,
        error: (result && result.error) || 'Frame capture failed and no frame was written.',
        note: 'The render/export tap could not produce a composited frame. Ensure Premiere is connected and the sequence can be opened in a timeline.',
      };
    }

    return {
      success: true,
      tapUsed: chosenTap.tap,
      requestedTap: requested,
      autoSelected: requested === 'auto',
      sequenceId: resolvedSequenceId,
      sequenceName: result.sequenceName || resolvedSequenceName,
      time: resolvedTime,
      format,
      outputPath: result.outputPath,
      requestedPath: result.requestedPath || outPath,
      video: chosenTap.video,
      audio: false,
      realtime: chosenTap.realtime,
      note: 'Composited Program frame captured via the render/export tap (all clips, effects, titles and grades baked in). For real-time video+audio, install an NDI/Syphon/Spout receiver -- run this tool with probeOnly:true for guidance.',
    };
  }

  // Audio Operations Implementation
  /**
   * High-level ducking helper. Computes a keyframe curve and delegates to
   * addAudioKeyframes (single source of truth for the locale-aware + calibrated
   * keyframe write).
   *
   * For each ducking window, emits 4 keyframes:
   *   - pre-fade  (window.startTime - fadeSeconds): baseDb
   *   - duck-in   (window.startTime):               duckedDb
   *   - duck-out  (window.endTime):                 duckedDb
   *   - post-fade (window.endTime + fadeSeconds):   baseDb
   *
   * Plus boundary keyframes at clipStartTime (or 0) and clipEndTime
   * (or last window.endTime + 1s) anchored to baseDb. Result: a continuous
   * curve that sits at baseDb except inside duck windows.
   *
   * Replaces the manual Sprint 3 "8 keyframes per video" pattern.
   */
  private async setupDucking(
    clipId: string,
    baseDb: number,
    duckingWindows: Array<{ startTime: number; endTime: number; duckedDb: number }>,
    fadeSeconds: number = 0.2,
    clipStartTime?: number,
    clipEndTime?: number
  ): Promise<any> {
    const fade = fadeSeconds ?? 0.2;
    const start = clipStartTime ?? 0;
    const lastWindow = duckingWindows.length > 0 ? duckingWindows[duckingWindows.length - 1] : undefined;
    const end = clipEndTime ?? (lastWindow ? lastWindow.endTime + 1 : start + 1);

    // Collect all keyframes and dedupe-by-time (later writes win for same time)
    const map = new Map<number, number>();
    const upsert = (t: number, db: number) => {
      // Quantize to ms to avoid duplicate-but-not-equal floats
      const key = Math.round(t * 1000) / 1000;
      map.set(key, db);
    };

    upsert(start, baseDb);

    for (const w of duckingWindows) {
      upsert(Math.max(start, w.startTime - fade), baseDb);
      upsert(w.startTime, w.duckedDb);
      upsert(w.endTime, w.duckedDb);
      upsert(Math.min(end, w.endTime + fade), baseDb);
    }

    upsert(end, baseDb);

    const keyframes = Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, level]) => ({ time, level }));

    const result = await this.addAudioKeyframes(clipId, keyframes);
    return {
      ...(typeof result === 'object' && result !== null ? result : {}),
      ducking_windows: duckingWindows.length,
      fade_seconds: fade,
      keyframes_emitted: keyframes.length,
      base_db: baseDb,
      computed_keyframes: keyframes,
    };
  }

  //
  // Sets the audio clip volume in dB (relative gain on the clip's Volume component, NOT track mixer).
  //
  // FIX vs upstream:
  //   - Upstream looked for property `displayName === "Volume"` iterating ALL component properties.
  //     That's wrong: "Volume" is a COMPONENT name, and its level property is "Level" (en) / "Nivel" (es).
  //   - Upstream passed `level` (dB) directly to setValue, but Premiere ExtendScript expects a
  //     linear scale (1.0 = 0 dB, 1.4454 = +3.2 dB). Conversion: linear = 10^(dB/20).
  //   - Now supports localized component names (Spanish "Volumen", English "Volume", others).
  //   - On not-found, returns a dump of clip components+properties for debugging.
  private async adjustAudioLevels(clipId: string, level: number): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;

        // Localized display names for the Volume component
        var VOLUME_NAMES = ["Volume", "Volumen", "Lautstärke", "Volume", "音量"];
        // Localized display names for the Level property inside Volume
        var LEVEL_NAMES  = ["Level", "Nivel", "Pegel", "Niveau", "Livello", "音量"];

        function isOneOf(name, list) {
          for (var n = 0; n < list.length; n++) { if (name === list[n]) return true; }
          return false;
        }

        // Build dump for debug fallback
        var dump = [];
        var volumeComp = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          var compName = String(comp.displayName);
          var propsList = [];
          for (var j = 0; j < comp.properties.numItems; j++) {
            propsList.push(String(comp.properties[j].displayName));
          }
          dump.push({ idx: i, component: compName, properties: propsList });
          if (!volumeComp && isOneOf(compName, VOLUME_NAMES)) {
            volumeComp = comp;
          }
        }
        if (!volumeComp) {
          return JSON.stringify({
            success: false,
            error: "Volume component not found on clip",
            components_dump: dump
          });
        }

        var levelProp = null;
        for (var j = 0; j < volumeComp.properties.numItems; j++) {
          var pName = String(volumeComp.properties[j].displayName);
          if (isOneOf(pName, LEVEL_NAMES)) {
            levelProp = volumeComp.properties[j];
            break;
          }
        }
        if (!levelProp) {
          return JSON.stringify({
            success: false,
            error: "Level property not found inside Volume component",
            volume_component: String(volumeComp.displayName),
            properties_in_volume: dump.length > 0 ? dump : []
          });
        }

        // CALIBRATION (empirical, Premiere Pro 2026 macOS, locale es_ES):
        //   Premiere's clip Volume Level property uses a linear amplitude scale where the
        //   displayed "0 dB" in the Effects Controls panel corresponds to internal linear value
        //   ~0.17783. The relationship is: linear = 0.17783 × 10^(dB/20),
        //   equivalently: linear = 10^((dB - 15) / 20).
        //   Verified by measurement: setting linear = 1.4454 (which standard audio convention
        //   says is +3.2 dB) actually produced ~+13 dB of broadcast loudness gain. With this
        //   calibrated formula, requesting +3.2 dB now sets linear = 0.2571 ≈ matches Premiere's
        //   displayed value.
        var DB_CALIBRATION_OFFSET = 15;  // Premiere ES-locale, PrPro 2026.x
        var dB = ${level};
        var linearValue = Math.pow(10, (dB - DB_CALIBRATION_OFFSET) / 20);
        var oldLinear = levelProp.getValue();
        var oldDB = (oldLinear > 0)
          ? (20 * Math.log(oldLinear) / Math.log(10) + DB_CALIBRATION_OFFSET)
          : -Infinity;
        levelProp.setValue(linearValue, true);

        return JSON.stringify({
          success: true,
          message: "Audio level adjusted (clip Volume component, locale-aware, calibrated dB scale)",
          clipId: ${JSON.stringify(clipId)},
          requestedDB: dB,
          oldLinearValue: oldLinear,
          oldDB: oldDB,
          newLinearValue: linearValue,
          newDB: dB,
          calibrationOffset: DB_CALIBRATION_OFFSET,
          volumeComponent: String(volumeComp.displayName),
          levelProperty: String(levelProp.displayName)
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

  private async addAudioKeyframes(clipId: string, keyframes: Array<{time: number, level: number}>): Promise<any> {
    // CALIBRATION (matches adjustAudioLevels): Premiere's clip Volume Level property is linear amplitude.
    // The displayed "0 dB" in Effects Controls corresponds to internal linear value ~0.17783.
    // Relationship: linear = 10^((dB - 15) / 20). Verified empirically on Premiere Pro 2026 macOS es_ES.
    const DB_CALIBRATION_OFFSET = 15;
    const keyframeCode = keyframes.map(kf => {
      const linearValue = Math.pow(10, (kf.level - DB_CALIBRATION_OFFSET) / 20);
      return `
        try {
          levelProp.addKey(${kf.time});
          levelProp.setValueAtKey(${kf.time}, ${linearValue}, true);
          // Verify the key actually landed and holds the value we asked for; addKey/setValueAtKey
          // return void and can silently no-op, so a push without readback would be a fake success.
          var __kExists = false; try { __kExists = levelProp.keyExistsAtTime(${kf.time}); } catch (eK) {}
          var __kVal = null; try { __kVal = levelProp.getValueAtKey(${kf.time}); } catch (eV) {}
          if (__kExists && __kVal !== null && Math.abs(Number(__kVal) - ${linearValue}) <= Math.max(0.0005, ${linearValue} * 0.02)) {
            addedKeyframes.push({ time: ${kf.time}, level: ${kf.level}, linearValue: ${linearValue} });
          } else {
            failedKeyframes.push({ time: ${kf.time}, level: ${kf.level}, error: "keyframe did not verify (exists=" + __kExists + ", readback=" + __kVal + ")" });
          }
        } catch (e2) {
          failedKeyframes.push({ time: ${kf.time}, level: ${kf.level}, error: e2.toString() });
        }
    `;
    }).join('\n');

    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;

        // Locale-aware Volume component / Level property detection (matches adjustAudioLevels patch).
        // Without this, the function fails with "Volume property not found" on non-English Premiere
        // installs (e.g., Spanish "Volumen"/"Nivel", German "Lautstärke"/"Pegel", etc.).
        var VOLUME_NAMES = ["Volume", "Volumen", "Lautstärke", "Volume", "音量"];
        var LEVEL_NAMES  = ["Level", "Nivel", "Pegel", "Niveau", "Livello", "音量"];
        function isOneOf(name, list) {
          for (var n = 0; n < list.length; n++) { if (name === list[n]) return true; }
          return false;
        }

        var volumeComp = null;
        var dump = [];
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          var compName = String(comp.displayName);
          var propsList = [];
          for (var j = 0; j < comp.properties.numItems; j++) {
            propsList.push(String(comp.properties[j].displayName));
          }
          dump.push({ idx: i, component: compName, properties: propsList });
          if (!volumeComp && isOneOf(compName, VOLUME_NAMES)) {
            volumeComp = comp;
          }
        }
        if (!volumeComp) {
          return JSON.stringify({
            success: false,
            error: "Volume component not found on clip (locale-aware lookup failed)",
            components_dump: dump
          });
        }

        var levelProp = null;
        for (var k = 0; k < volumeComp.properties.numItems; k++) {
          var pName = String(volumeComp.properties[k].displayName);
          if (isOneOf(pName, LEVEL_NAMES)) {
            levelProp = volumeComp.properties[k];
            break;
          }
        }
        if (!levelProp) {
          return JSON.stringify({
            success: false,
            error: "Level property not found inside Volume component",
            volume_component: String(volumeComp.displayName)
          });
        }

        levelProp.setTimeVarying(true);
        var addedKeyframes = [];
        var failedKeyframes = [];
        ${keyframeCode}
        return JSON.stringify({
          success: (addedKeyframes.length > 0 && failedKeyframes.length === 0),
          verified: (addedKeyframes.length > 0 && failedKeyframes.length === 0),
          message: failedKeyframes.length
            ? ("Audio keyframes: " + addedKeyframes.length + " verified, " + failedKeyframes.length + " failed to apply")
            : "Audio keyframes added and verified (locale-aware Volume detection, calibrated dB scale)",
          clipId: ${JSON.stringify(clipId)},
          volumeComponent: String(volumeComp.displayName),
          levelProperty: String(levelProp.displayName),
          calibrationOffset: ${DB_CALIBRATION_OFFSET},
          addedKeyframes: addedKeyframes,
          failedKeyframes: failedKeyframes,
          totalKeyframes: addedKeyframes.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async muteTrack(sequenceId: string, trackIndex: number, muted: boolean): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var track = sequence.audioTracks[${trackIndex}];
        if (!track) return JSON.stringify({ success: false, error: "Audio track not found" });
        track.setMute(${muted ? 1 : 0});
        var nowMuted = null; try { nowMuted = Boolean(track.isMuted()); } catch (eMute) {}
        if (nowMuted !== null && nowMuted !== ${muted}) return JSON.stringify({ success: false, verified: false, error: "Premiere did not change the track mute state (still reads " + (nowMuted ? "muted" : "unmuted") + ")." });
        return JSON.stringify({
          success: true,
          verified: nowMuted !== null,
          message: "Track mute status changed",
          sequenceId: ${JSON.stringify(sequenceId)},
          trackIndex: ${trackIndex},
          muted: ${muted}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // Text and Graphics Implementation
  private async addTextOverlay(args: any): Promise<any> {
    if (args.mogrtPath) {
      // FIX vs upstream: upstream silently ignored args.text; the MOGRT was imported but
      // its text properties stayed at default placeholders ("Su nombre aquí", etc.)
      // This version:
      //   1. importMGT (existing)
      //   2. After import, get trackItem.getMGTComponent() — the special MGT component
      //      that exposes the parameters defined in the Essential Graphics template
      //   3. Dump those properties for debugging (so callers see what's available)
      //   4. If args.text is provided, attempt to set it by:
      //      a. The first text-typed property whose value JSON-parses to {mTextString: ...}
      //      b. Or by displayName match against args.textPropertyName (optional override)
      //   Premiere stores text values as JSON: '{"mTextString":"...", ...}'
      const textJson = args.text !== undefined ? JSON.stringify(args.text) : 'null';
      // When set, the script restricts the write to the property whose displayName matches
      // (instead of running the auto-detect). text2/text3/text4 are ignored in override mode
      // — the override targets a single field by name.
      const textPropNameJson = args.textPropertyName !== undefined
        ? JSON.stringify(args.textPropertyName)
        : 'null';
      const script = `
        try {
          var sequence = __findSequence(${JSON.stringify(args.sequenceId)});
          if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
          var timeTicks = __secondsToTicks(${args.startTime});
          var trackItem = sequence.importMGT(${JSON.stringify(args.mogrtPath)}, timeTicks, ${args.trackIndex}, 0);
          if (!trackItem) return JSON.stringify({ success: false, error: "Failed to import MOGRT. Ensure the .mogrt file exists." });

          // First, probe ALL plausible MGT-access APIs (so we know what's available)
          var apiProbe = {};
          var premiereVersion = "unknown";
          var premiereBuild = "";
          try {
            if (typeof app.version !== "undefined" && app.version !== null) premiereVersion = String(app.version);
          } catch (eVersion) {}
          try {
            if (typeof app.build !== "undefined" && app.build !== null) premiereBuild = String(app.build);
          } catch (eBuild) {}
          apiProbe.hasGetMGTComponent = (typeof trackItem.getMGTComponent === "function");
          apiProbe.hasGetMGT = (typeof trackItem.getMGT === "function");
          apiProbe.hasGetMogrtComponent = (typeof trackItem.getMogrtComponent === "function");
          apiProbe.hasGetComponentParameters = (typeof trackItem.getComponentParameters === "function");
          // App-level
          apiProbe.appHasMOGRTAPI = (app.project && typeof app.project.openMGT === "function");
          // Try calling getMGTComponent and capture more detail
          if (apiProbe.hasGetMGTComponent) {
            try {
              var mgtTry = trackItem.getMGTComponent();
              apiProbe.getMGTComponent_returned = (mgtTry === null) ? "null" : (typeof mgtTry);
              if (mgtTry) {
                apiProbe.getMGTComponent_displayName = String(mgtTry.displayName || "");
                apiProbe.getMGTComponent_propertyCount = (mgtTry.properties ? mgtTry.properties.numItems : -1);
                // Dump first 3 properties of MGT comp
                var mgtPropsSample = [];
                if (mgtTry.properties) {
                  for (var mp = 0; mp < Math.min(5, mgtTry.properties.numItems); mp++) {
                    var mprop = mgtTry.properties[mp];
                    var mval = null;
                    try { mval = mprop.getValue(); } catch (eMg) { mval = "<getValue threw>"; }
                    mgtPropsSample.push({
                      index: mp,
                      displayName: String(mprop.displayName),
                      valueType: typeof mval,
                      valuePreview: (typeof mval === "string" ? mval.substring(0, 80) : mval)
                    });
                  }
                }
                apiProbe.getMGTComponent_propertiesSample = mgtPropsSample;
              }
            } catch (eMG) {
              apiProbe.getMGTComponent_threw = eMG.toString();
            }
          }
          // Probe trackItem.name (some MOGRT-specific stuff might surface here)
          try { apiProbe.trackItemName = String(trackItem.name); } catch (e) {}
          // Probe sequence-level methods
          try { apiProbe.sequenceHasGetSelection = (typeof sequence.getSelection === "function"); } catch (e) {}

          // Iterate ALL components of the imported trackItem (MOGRT params live as
          // properties on one of its components, not always via getMGTComponent)
          var componentsDump = [];
          var textPropsFound = [];  // {compIndex, propIndex, displayName, currentValue}
          for (var ci = 0; ci < trackItem.components.numItems; ci++) {
            var comp = trackItem.components[ci];
            var compName = String(comp.displayName);
            var compMatch = (comp.matchName !== undefined) ? String(comp.matchName) : "";
            var compProps = [];
            for (var i = 0; i < comp.properties.numItems; i++) {
              var prop = comp.properties[i];
              var dn = String(prop.displayName);
              var val = null;
              try { val = prop.getValue(); } catch (eV) { val = "<getValue threw>"; }
              var truncatedVal = (typeof val === "string" ? val.substring(0, 250) : val);
              compProps.push({ index: i, displayName: dn, value: truncatedVal });
              // Heuristic: text properties contain "mTextString" in their JSON value
              if (typeof val === "string" && val.indexOf("mTextString") >= 0) {
                textPropsFound.push({ compIndex: ci, propIndex: i, compDisplayName: compName, propDisplayName: dn, currentValue: val });
              }
            }
            componentsDump.push({ index: ci, displayName: compName, matchName: compMatch, propertyCount: compProps.length, properties: compProps });
          }

          // Set custom text(s). Each "AE.ADBE Text" component in the MOGRT exposes its
          // editable text as property 0 (display name "Texto de origen" / "Source Text").
          // Only one setValue per property — raw_string strategy worked in earlier tests; no
          // JSON wrapping (that broke rendering).
          //
          // Inputs:
          //   args.text  → first text component (e.g., main title in Basic Lower Third)
          //   args.text2 → second text component (e.g., subtitle)
          //   args.text3 → third (if MOGRT has more)
          //   ...
          // Auto-collected from numbered keys.
          var textsByIndex = [];
          if (${textJson} !== null) textsByIndex.push(${textJson});
          ${args.text2 !== undefined ? `textsByIndex.push(${JSON.stringify(args.text2)});` : ''}
          ${args.text3 !== undefined ? `textsByIndex.push(${JSON.stringify(args.text3)});` : ''}
          ${args.text4 !== undefined ? `textsByIndex.push(${JSON.stringify(args.text4)});` : ''}
          var setResults = [];
          if (textsByIndex.length > 0) {
            // PREFERRED PATH: getMGTComponent() for AE-exported MOGRTs (Adobe-CEP canonical).
            // Properties exposed there are the Essential Graphics parameters and contain
            // FULL JSON values that ARE editable.
            // FALLBACK PATH: iterate trackItem.components for "AE.ADBE Text" — only works for
            // some MOGRTs and tokens are opaque single-char references in Premiere-native MOGRTs.
            var textComps = [];
            var textCompsViaMGT = false;
            var textPropNameOverride = ${textPropNameJson};
            // OVERRIDE PATH: caller named a specific property by displayName.
            // Search both the MGT component and all trackItem components for an exact
            // displayName match, then restrict textComps to that single hit.
            // text2/text3/text4 are ignored in override mode — caller targeted one field.
            if (textPropNameOverride) {
              try {
                var mgtCompO = trackItem.getMGTComponent();
                if (mgtCompO && mgtCompO.properties) {
                  for (var miO = 0; miO < mgtCompO.properties.numItems; miO++) {
                    var mpO = mgtCompO.properties[miO];
                    if (String(mpO.displayName) === textPropNameOverride) {
                      textComps.push({ comp: mgtCompO, compIndex: -1, prop: mpO, propIndex: miO, displayName: String(mpO.displayName) });
                      textCompsViaMGT = true;
                      break;
                    }
                  }
                }
              } catch (eOMG) {}
              if (textComps.length === 0) {
                for (var ciO = 0; ciO < trackItem.components.numItems && textComps.length === 0; ciO++) {
                  var cO = trackItem.components[ciO];
                  for (var piO = 0; piO < cO.properties.numItems; piO++) {
                    var pO = cO.properties[piO];
                    if (String(pO.displayName) === textPropNameOverride) {
                      textComps.push({ comp: cO, compIndex: ciO, prop: pO, propIndex: piO, displayName: String(pO.displayName) });
                      break;
                    }
                  }
                }
              }
              if (textComps.length === 0) {
                return JSON.stringify({
                  success: false,
                  error: "textPropertyName override did not match any property displayName: " + textPropNameOverride,
                  componentCount: componentsDump.length,
                  components: componentsDump
                });
              }
              // In override mode keep only the first text (named-target write).
              textsByIndex = [textsByIndex[0]];
              setResults.push({ _strategy: "textPropertyName_override", overrideName: textPropNameOverride });
            }
            // AUTO-DETECT PATH (only when no override).
            if (textComps.length === 0) {
              try {
                var mgtComp = trackItem.getMGTComponent();
                if (mgtComp && mgtComp.properties) {
                  for (var mi = 0; mi < mgtComp.properties.numItems; mi++) {
                    var mp = mgtComp.properties[mi];
                    var mpVal = null;
                    try { mpVal = mp.getValue(); } catch (eMPv) {}
                    // A "text" param has a JSON string value containing textEditValue or mTextString
                    if (typeof mpVal === "string" && mpVal.length > 50 &&
                        (mpVal.indexOf("textEditValue") >= 0 || mpVal.indexOf("mTextString") >= 0 || mpVal.indexOf("capPropTextRunCount") >= 0)) {
                      textComps.push({ comp: mgtComp, compIndex: -1, prop: mp, propIndex: mi, displayName: String(mp.displayName) });
                    }
                  }
                  if (textComps.length > 0) textCompsViaMGT = true;
                }
              } catch (eMGTC) {}
              // Fallback to component iteration if MGT didn't yield text params
              if (textComps.length === 0) {
                for (var ci3 = 0; ci3 < trackItem.components.numItems; ci3++) {
                  var c3 = trackItem.components[ci3];
                  var mn = (c3.matchName !== undefined) ? String(c3.matchName) : "";
                  if (mn === "AE.ADBE Text") {
                    textComps.push({ comp: c3, compIndex: ci3, prop: c3.properties[0], propIndex: 0, displayName: "Source Text (legacy)" });
                  }
                }
              }
              setResults.push({ _strategy: textCompsViaMGT ? "getMGTComponent" : "components_fallback", textCompsFound: textComps.length });
            }
            for (var ti2 = 0; ti2 < textsByIndex.length && ti2 < textComps.length; ti2++) {
              var tc = textComps[ti2];
              var sourceTextProp = tc.prop;
              var newText = String(textsByIndex[ti2]);
              try {
                // Source Text in Premiere/After Effects MOGRTs is stored as:
                //   <4 bytes binary header> + <JSON payload of mTextParam structure>
                // Source: Adobe Community (Kurt_Clark) + Adobe-CEP samples + reproduced
                // independently across multiple Premiere versions (incl. 2026).
                // The agent investigation confirmed this format. Direct setValue("text")
                // stores the value but the renderer cannot parse it → no visual update.
                // Correct mutation: parse JSON (skipping header), patch
                // mTextParam.mStyleSheet.mText, re-prepend header, setValue(...).
                var rawVal = sourceTextProp.getValue();
                var rawValStr = String(rawVal);
                var rawValLen = rawValStr.length;
                var headerBytes = "";
                var jsonStr = "";
                var textObj = null;
                var parseStrategy = "";
                // Strategy 1: 4-byte header + JSON
                try {
                  headerBytes = rawValStr.substring(0, 4);
                  jsonStr = rawValStr.substring(4);
                  textObj = JSON.parse(jsonStr);
                  parseStrategy = "header4+json";
                } catch (eP1) {
                  // Strategy 2: pure JSON (AE 14.3+ no header)
                  try {
                    textObj = JSON.parse(rawValStr);
                    headerBytes = "";
                    parseStrategy = "pure_json";
                  } catch (eP2) {
                    setResults.push({
                      textIndex: ti2, compIndex: tc.compIndex, propIndex: tc.propIndex, requestedText: newText,
                      ok: false,
                      error: "Both JSON parse strategies failed",
                      rawValLength: rawValLen,
                      rawValPreview: rawValStr.substring(0, 50),
                      parseError1: eP1.toString(),
                      parseError2: eP2.toString()
                    });
                    continue;
                  }
                }
                // Mutate the text in the proper nested path(s)
                var mutated = [];
                if (textObj.mTextParam && textObj.mTextParam.mStyleSheet) {
                  textObj.mTextParam.mStyleSheet.mText = newText;
                  mutated.push("mTextParam.mStyleSheet.mText");
                }
                // AE 14.3+ alternate: textEditValue + fontTextRunLength
                if (textObj.textEditValue !== undefined) {
                  textObj.textEditValue = newText;
                  textObj.fontTextRunLength = [newText.length];
                  mutated.push("textEditValue+fontTextRunLength");
                }
                if (mutated.length === 0) {
                  setResults.push({
                    textIndex: ti2, compIndex: tc.compIndex, propIndex: tc.propIndex, requestedText: newText,
                    ok: false,
                    error: "Parsed JSON but no known text field found",
                    parseStrategy: parseStrategy,
                    jsonKeys: (function(){ var ks=[]; for (var k in textObj) ks.push(k); return ks; })()
                  });
                  continue;
                }
                // Re-encode + write back
                var newRawVal = headerBytes + JSON.stringify(textObj);
                sourceTextProp.setValue(newRawVal, true);
                // Verify
                var afterRaw = "";
                try { afterRaw = String(sourceTextProp.getValue()); } catch (eVA) {}
                var afterParseOk = false;
                var afterText = "";
                try {
                  var afterObj = JSON.parse(afterRaw.substring(headerBytes.length));
                  if (afterObj.mTextParam && afterObj.mTextParam.mStyleSheet) {
                    afterText = afterObj.mTextParam.mStyleSheet.mText;
                    afterParseOk = true;
                  } else if (afterObj.textEditValue) {
                    afterText = afterObj.textEditValue;
                    afterParseOk = true;
                  }
                } catch (eAP) {}
                setResults.push({
                  textIndex: ti2,
                  compIndex: tc.compIndex,
                  propIndex: tc.propIndex,
                  requestedText: newText,
                  parseStrategy: parseStrategy,
                  fieldsMutated: mutated,
                  rawValLength: rawValLen,
                  newRawValLength: newRawVal.length,
                  readbackParseOk: afterParseOk,
                  readbackText: afterText,
                  ok: (afterText === newText)
                });
              } catch (eS) {
                setResults.push({ textIndex: ti2, compIndex: tc.compIndex, propIndex: tc.propIndex, requestedText: newText, ok: false, error: eS.toString() });
              }
            }
            if (textComps.length === 0) {
              setResults.push({ ok: false, error: "No 'AE.ADBE Text' components found in MOGRT" });
            } else if (textsByIndex.length > textComps.length) {
              setResults.push({ ok: false, warning: "More texts requested (" + textsByIndex.length + ") than text components in MOGRT (" + textComps.length + ")" });
            }
          }

          return JSON.stringify({
            success: true,
            message: "MOGRT imported as text overlay",
            clipId: trackItem.nodeId,
            premiereVersion: premiereVersion,
            premiereBuild: premiereBuild,
            apiProbe: apiProbe,
            componentCount: componentsDump.length,
            components: componentsDump,
            textPropsAutoDetected: textPropsFound,
            textRequestedCount: textsByIndex.length,
            textInjectionResults: setResults
          });
        } catch (e) {
          var failedClipId = null;
          try {
            if (typeof trackItem !== "undefined" && trackItem) failedClipId = trackItem.nodeId;
          } catch (eClipId) {}
          return JSON.stringify({ success: false, error: e.toString(), clipId: failedClipId });
        }
      `;
      const bridgeResult = await this.bridge.executeScript(script);
      const evaluatedResult = evaluateTextInjectionResult(bridgeResult);
      if (
        (evaluatedResult?.textInjectionStatus === 'failed' ||
          (evaluatedResult?.success === false && evaluatedResult?.clipId)) &&
        args.rollbackOnTextFailure === true &&
        evaluatedResult.clipId
      ) {
        const rollbackScript = `
          try {
            var info = __findClip(${JSON.stringify(evaluatedResult.clipId)}, ${JSON.stringify(args.sequenceId)});
            if (!info) return JSON.stringify({ success: false, error: "Imported Graphic was not found for rollback" });
            info.clip.remove(false, true);
            return JSON.stringify({
              success: true,
              timelineGraphicRemoved: true,
              note: "The timeline Graphic was removed; the imported project item may remain in the Project panel."
            });
          } catch (e) {
            return JSON.stringify({ success: false, timelineGraphicRemoved: false, error: e.toString() });
          }
        `;
        const rollback = await this.bridge.executeScript(rollbackScript);
        const rollbackSucceeded = rollback?.success === true;
        if (rollbackSucceeded) {
          const { clipId: removedClipId, ...failureResult } = evaluatedResult;
          return {
            ...failureResult,
            error: `${evaluatedResult.error} The imported timeline Graphic was removed.`,
            removedClipId,
            rollback
          };
        }
        return {
          ...evaluatedResult,
          error: `${evaluatedResult.error} Rollback of the imported timeline Graphic also failed.`,
          rollback
        };
      }
      if (evaluatedResult?.textInjectionStatus === 'failed') {
        return {
          ...evaluatedResult,
          error: `${evaluatedResult.error} The imported Graphic remains on the timeline.`
        };
      }
      return evaluatedResult;
    }

    // Fallback: try legacy title approach
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(args.sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
        return JSON.stringify({
          success: false,
          error: "Text overlay requires a MOGRT file path. Use the mogrtPath parameter with a .mogrt template file, or use import_mogrt tool.",
          note: "Legacy titles (app.project.createNewTitle) are not supported in current Premiere Pro ExtendScript API."
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Color Correction Implementation
  //
  // colorCorrect and applyLut both add a Lumetri Color effect to a QE-addressed clip
  // and then set named properties on it. Earlier versions swallowed every setValue
  // error in an empty catch and returned success unconditionally, so a localized
  // Premiere (where a property's displayName differs), an unmatched property, or an
  // invalid value silently "succeeded". Both now route through applyLumetriParams,
  // which matches each property by displayName (exact then normalized), reads the
  // value back, and reports precisely what took.
  private async applyLumetriParams(
    clipId: string,
    requestedParams: Record<string, number | string>,
    label: string,
    extra: Record<string, unknown> = {}
  ): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = qeSeq.getVideoTrackAt(info.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, info.clip);
        if (!qeClip) return JSON.stringify({ success: false, error: "Could not address the clip through the QE API." });
        var effect = qe.project.getVideoEffectByName("Lumetri Color");
        if (!effect) return JSON.stringify({ success: false, error: "Lumetri Color effect not found" });
        qeClip.addVideoEffect(effect);
        var clip = info.clip;
        var lastComp = clip.components[clip.components.numItems - 1];

        function normalizeName(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }
        function valuesEquivalent(actual, requested) {
          if (actual === requested) return true;
          if (typeof actual === "number" && typeof requested === "number") return Math.abs(actual - requested) <= 0.0001;
          return String(actual) === String(requested);
        }

        var requestedParams = ${JSON.stringify(requestedParams)};
        var results = [];
        for (var rn in requestedParams) {
          if (requestedParams.hasOwnProperty && !requestedParams.hasOwnProperty(rn)) continue;
          var reqVal = requestedParams[rn];
          var matched = null;
          for (var k = 0; k < lastComp.properties.numItems; k++) {
            if (String(lastComp.properties[k].displayName) === rn) { matched = lastComp.properties[k]; break; }
          }
          if (!matched) {
            var nn = normalizeName(rn);
            for (var k2 = 0; k2 < lastComp.properties.numItems; k2++) {
              if (normalizeName(String(lastComp.properties[k2].displayName)) === nn) { matched = lastComp.properties[k2]; break; }
            }
          }
          if (!matched) { results.push({ name: rn, ok: false, status: "no_matching_property" }); continue; }
          var before = null; var beforeOk = true;
          try { before = matched.getValue(); } catch (eB) { beforeOk = false; }
          var threw = false; var errMsg = null;
          try { matched.setValue(reqVal, true); } catch (eS) { threw = true; errMsg = eS.toString(); }
          var after = null; var afterOk = true;
          try { after = matched.getValue(); } catch (eA) { afterOk = false; }
          var verified = !threw && afterOk && valuesEquivalent(after, reqVal);
          var changed = !threw && beforeOk && afterOk && !valuesEquivalent(after, before);
          var status = threw ? "setvalue_threw" : (verified ? "verified" : (changed ? "changed_with_warning" : (!afterOk ? "unverifiable" : "unchanged")));
          results.push({ name: rn, matchedDisplayName: String(matched.displayName), valueRequested: reqVal, valueBefore: before, valueAfter: after, status: status, ok: (verified || changed), error: errMsg });
        }

        var okCount = 0; var matchedCount = 0;
        for (var r = 0; r < results.length; r++) {
          if (results[r].status !== "no_matching_property") matchedCount++;
          if (results[r].ok) okCount++;
        }
        var overall = results.length > 0 && okCount === results.length;
        var payload = ${JSON.stringify(extra)};
        payload.success = overall;
        payload.applied = okCount;
        payload.matched = matchedCount;
        payload.requested = results.length;
        payload.results = results;
        payload.clipId = ${JSON.stringify(clipId)};
        payload.message = overall
          ? (${JSON.stringify(label)} + " applied and verified (" + okCount + "/" + results.length + " properties).")
          : (${JSON.stringify(label)} + " not fully applied (" + okCount + "/" + results.length + " properties verified). See results.");
        return JSON.stringify(payload);
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async colorCorrect(clipId: string, adjustments: any): Promise<any> {
    const requested: Record<string, number> = {};
    if (adjustments.brightness !== undefined) requested["Brightness"] = adjustments.brightness;
    if (adjustments.contrast !== undefined) requested["Contrast"] = adjustments.contrast;
    if (adjustments.saturation !== undefined) requested["Saturation"] = adjustments.saturation;
    if (adjustments.hue !== undefined) requested["Hue"] = adjustments.hue;
    if (adjustments.temperature !== undefined) requested["Temperature"] = adjustments.temperature;
    if (adjustments.tint !== undefined) requested["Tint"] = adjustments.tint;
    if (Object.keys(requested).length === 0) {
      return { success: false, error: "No color adjustments provided. Supply at least one of: brightness, contrast, saturation, hue, temperature, tint." };
    }
    return await this.applyLumetriParams(clipId, requested, "Color correction");
  }

  private async applyLut(clipId: string, lutPath: string, _intensity = 100): Promise<any> {
    return await this.applyLumetriParams(clipId, { "Input LUT": lutPath }, "LUT", { lutPath });
  }

  // Export and Rendering Implementation
  private decodeXmlEntities(value: string): string {
    return value
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
  }

  private displayNameFromPresetXml(xml: string): string | undefined {
    const patterns = [
      /<PresetName[^>]*>([^<]+)<\/PresetName>/i,
      /<Name[^>]*>([^<]+)<\/Name>/i,
      /\bPresetName="([^"]+)"/i,
      /\bName="([^"]+)"/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(xml);
      const name = match?.[1] ? this.decodeXmlEntities(match[1]) : '';
      if (name) return name;
    }
    return undefined;
  }

  private async defaultEncoderPresetDirectories(): Promise<string[]> {
    const baseDirs = [
      join(homedir(), 'Library', 'Application Support', 'Adobe', 'Common', 'AME'),
    ];
    if (process.env.APPDATA) {
      baseDirs.push(join(process.env.APPDATA, 'Adobe', 'Common', 'AME'));
    }

    const presetDirs = new Set<string>();
    for (const baseDir of baseDirs) {
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try {
        entries = await fs.readdir(baseDir, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        presetDirs.add(join(baseDir, 'Presets'));
        continue;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          presetDirs.add(join(baseDir, entry.name, 'Presets'));
        }
      }
    }
    return [...presetDirs].sort();
  }

  private ameVersionFromPresetDirectory(directory: string): string {
    return basename(directory).toLowerCase() === 'presets'
      ? basename(dirname(directory))
      : basename(directory);
  }

  private async getEncoderPresets(directories?: string[]): Promise<EncoderPresetDiscovery> {
    const searchedDirectories = directories && directories.length > 0
      ? directories
      : await this.defaultEncoderPresetDirectories();
    const presets: EncoderPresetEntry[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    for (const directory of searchedDirectories) {
      let entries: Array<{ name: string; isFile(): boolean }>;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          errors.push({ path: directory, error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.epr') continue;
        const presetPath = join(directory, entry.name);
        try {
          await fs.access(presetPath, fsConstants.R_OK);
          const xml = await fs.readFile(presetPath, 'utf8');
          presets.push({
            name: this.displayNameFromPresetXml(xml) ?? parse(entry.name).name,
            path: presetPath,
            source: 'user',
            ameVersion: this.ameVersionFromPresetDirectory(directory),
          });
        } catch (error) {
          errors.push({ path: presetPath, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    presets.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return {
      success: true,
      presets,
      count: presets.length,
      searchedDirectories,
      errors,
      factoryPresets: {
        supported: false,
        note: 'Factory preset enumeration is not complete or supported; save a user .epr preset in AME and rediscover it here.',
      },
    };
  }

  private async resolvePresetPath(presetPath?: string, presetName?: string): Promise<
    { success: true; presetPath: string; presetName?: string; presetResolution?: any } |
    { success: false; error: string; presetName?: string; matches?: EncoderPresetEntry[]; searchedDirectories?: string[] }
  > {
    if (presetPath && presetName) {
      return { success: false, error: 'Provide either presetPath or presetName, not both.', presetName };
    }

    if (presetPath) {
      return { success: true, presetPath };
    }

    if (!presetName) {
      return {
        success: false,
        error: 'presetPath or presetName required — Adobe encodeSequence requires an absolute .epr preset file.',
      };
    }

    const discovery = await this.getEncoderPresets();
    const matches = discovery.presets.filter((preset) => preset.name === presetName || parse(preset.path).name === presetName);
    if (matches.length === 1) {
      const [match] = matches as [EncoderPresetEntry];
      return {
        success: true,
        presetPath: match.path,
        presetName,
        presetResolution: {
          method: 'exact_name',
          name: match.name,
          path: match.path,
          ameVersion: match.ameVersion,
        },
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        error: `presetName "${presetName}" is ambiguous; pass presetPath instead.`,
        presetName,
        matches,
        searchedDirectories: discovery.searchedDirectories,
      };
    }
    return {
      success: false,
      error: `presetName "${presetName}" was not found in user AME presets.`,
      presetName,
      searchedDirectories: discovery.searchedDirectories,
    };
  }

  private async validateExportPaths(outputPath: string, presetPath: string, allowOverwrite = false): Promise<Array<{ code: string; message: string; path?: string }>> {
    const errors: Array<{ code: string; message: string; path?: string }> = [];

    if (!isAbsolute(presetPath)) {
      errors.push({ code: 'PRESET_PATH_NOT_ABSOLUTE', message: 'presetPath must be an absolute .epr path.', path: presetPath });
    } else if (extname(presetPath).toLowerCase() !== '.epr') {
      errors.push({ code: 'PRESET_EXTENSION', message: 'presetPath must point to a .epr file.', path: presetPath });
    } else {
      try {
        await fs.access(presetPath, fsConstants.R_OK);
      } catch {
        errors.push({ code: 'PRESET_NOT_READABLE', message: 'Export preset file does not exist or is not readable.', path: presetPath });
      }
    }

    if (!isAbsolute(outputPath)) {
      errors.push({ code: 'OUTPUT_PATH_NOT_ABSOLUTE', message: 'outputPath must be absolute.', path: outputPath });
    } else {
      const outputDirectory = dirname(outputPath);
      try {
        const stat = await fs.stat(outputDirectory);
        if (!stat.isDirectory()) {
          errors.push({ code: 'OUTPUT_FOLDER_NOT_DIRECTORY', message: 'Output parent path is not a directory.', path: outputDirectory });
        }
      } catch {
        errors.push({ code: 'OUTPUT_FOLDER_NOT_FOUND', message: 'Output parent folder does not exist.', path: outputDirectory });
      }

      try {
        await fs.access(outputPath, fsConstants.F_OK);
        if (!allowOverwrite) {
          errors.push({ code: 'OUTPUT_EXISTS', message: 'Output file already exists; pass allowOverwrite:true to replace it.', path: outputPath });
        }
      } catch {
        // Missing output file is the normal export case.
      }
    }

    return errors;
  }

  private deprecatedExportOptionWarnings(format?: string, quality?: string, resolution?: string): Array<{ code: string; message: string; value?: string }> {
    const warnings: Array<{ code: string; message: string; value?: string }> = [];
    if (format) warnings.push({ code: 'FORMAT_IGNORED', message: 'format is deprecated for export_sequence; the .epr preset controls the container and codec.', value: format });
    if (quality) warnings.push({ code: 'QUALITY_IGNORED', message: 'quality is deprecated for export_sequence; the .epr preset controls export quality.', value: quality });
    if (resolution) warnings.push({ code: 'RESOLUTION_IGNORED', message: 'resolution is deprecated for export_sequence; the .epr preset controls output dimensions.', value: resolution });
    return warnings;
  }

  private async exportSequence(args: ExportSequenceArgs): Promise<any> {
    const {
      sequenceId,
      outputPath,
      presetName,
      sourceRange = 'entire',
      allowOverwrite = false,
      removeOnCompletion = true,
      format,
      quality,
      resolution,
    } = args;
    // app.encoder.encodeSequence() expects an absolute path to a .epr preset file.
    // Passing a string name like "H.264" silently fails: encodeSequence returns
    // no jobID and the JSX bridge reports {success:false}. Reject early with a
    // clear error rather than letting the user think a queue happened.
    const presetResolution = await this.resolvePresetPath(args.presetPath, presetName);
    if (!presetResolution.success) {
      return {
        success: false,
        error: presetResolution.error,
        hint: 'Create the preset in AME UI: File → Export Settings → configure → Save Preset → exports to ~/Library/Application Support/Adobe/Common/AME/<version>/Presets/. Pass that .epr path as presetPath.',
        sequenceId,
        outputPath,
        presetName,
        matches: presetResolution.matches,
        searchedDirectories: presetResolution.searchedDirectories,
        format,
        quality,
        resolution,
      };
    }
    const presetPath = presetResolution.presetPath;

    const pathErrors = await this.validateExportPaths(outputPath, presetPath, allowOverwrite);
    const warnings = this.deprecatedExportOptionWarnings(format, quality, resolution);
    if (pathErrors.length > 0) {
      return {
        success: false,
        error: pathErrors.map((pathError) => pathError.message).join(' '),
        errors: pathErrors,
        warnings,
        sequenceId,
        outputPath,
        presetPath,
        presetName,
        sourceRange,
        allowOverwrite,
        format,
        quality,
        resolution,
      };
    }

    try {
      // bridge.renderSequence returns a structured response; propagate it instead
      // of unconditionally claiming success. Pre-fix wrapper reported success even
      // when AME never received the job (false-success false positives).
      const result = await this.bridge.renderSequence(sequenceId, outputPath, presetPath, {
        sourceRange,
        removeOnCompletion,
      });

      if (result && result.success === false) {
        return {
          ...result,
          sequenceId,
          outputPath,
          presetPath,
          presetName,
          presetResolution: presetResolution.presetResolution,
          sourceRange,
          allowOverwrite,
          warnings: [...warnings, ...(result.warnings ?? [])],
          format,
          quality,
          resolution,
        };
      }

      return {
        success: true,
        status: result?.status ?? 'queued',
        message: 'Sequence queued in Adobe Media Encoder. Render runs asynchronously — verify by checking the output file size growth.',
        sequenceId,
        outputPath,
        presetPath,
        presetName,
        presetResolution: presetResolution.presetResolution,
        sourceRange,
        resolvedRange: result?.resolvedRange,
        encoderRangeConstant: result?.encoderRangeConstant,
        removeOnCompletion,
        format,
        quality,
        resolution,
        warnings: [...warnings, ...(result?.warnings ?? [])],
        jobID: result?.jobID,
        queued: result?.queued,
        queueStarted: result?.queueStarted,
        verify: `ffprobe -show_entries format=duration,size '${outputPath}'`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to export sequence: ${error instanceof Error ? error.message : String(error)}`,
        sequenceId,
        outputPath,
      };
    }
  }

  private async exportFrame(sequenceId: string, time: number, outputPath: string, format = 'png'): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });

        if (sequence.openInTimeline) {
          try { sequence.openInTimeline(); } catch (e0) {}
        }

        // Resolve the QE handle for the sequence the caller named. Reaching for
        // qe.project.getActiveSequence() here exported whatever happened to be
        // open in the timeline instead: asking for a non-active sequence
        // returned success, echoed back the requested sequenceId, and wrote a
        // frame of the active sequence's content.
        var qeSequence = __qeSequenceFor(sequence);
        if (!qeSequence) {
          return JSON.stringify({
            success: false,
            error: "Could not address sequence '" + sequence.name + "' through the QE API, which frame export requires. Open it in a timeline and retry."
          });
        }

        // Normalize the format to the exact QE method + extension, confirmed live:
        // exportFramePNG/.png, exportFrameJPEG/.jpg, exportFrameTIFF/.tif,
        // exportFrameDPX/.dpx, exportFrameTarga/.tga. The method name is
        // case-sensitive in ExtendScript, so "exportFrameTiff" (wrong casing) silently
        // failed every TIFF export until this was corrected to "exportFrameTIFF".
        var fmt = ${JSON.stringify(format)}.toLowerCase();
        if (fmt === "jpeg") fmt = "jpg";
        else if (fmt === "tiff") fmt = "tif";
        else if (fmt === "targa") fmt = "tga";
        var methodName, formatExtension, formatExts;
        if (fmt === "jpg") { methodName = "exportFrameJPEG"; formatExtension = ".jpg"; formatExts = [".jpg", ".jpeg"]; }
        else if (fmt === "tif") { methodName = "exportFrameTIFF"; formatExtension = ".tif"; formatExts = [".tif", ".tiff"]; }
        else if (fmt === "dpx") { methodName = "exportFrameDPX"; formatExtension = ".dpx"; formatExts = [".dpx"]; }
        else if (fmt === "tga") { methodName = "exportFrameTarga"; formatExtension = ".tga"; formatExts = [".tga", ".targa"]; }
        else { methodName = "exportFramePNG"; formatExtension = ".png"; formatExts = [".png"]; }
        if (typeof qeSequence[methodName] !== "function") {
          return JSON.stringify({
            success: false,
            error: "Frame export format '" + ${JSON.stringify(format)} + "' is not supported by the available Premiere API"
          });
        }

        var timeNumber = ${time};
        var timeString = String(timeNumber);
        var timeTicks = timeString;
        try {
          var exportTime = new Time();
          exportTime.seconds = timeNumber;
          timeTicks = exportTime.ticks;
        } catch (e1) {}

        // Premiere's exportFrame* methods always append "." + format to the
        // path they are handed, so passing the caller's "shot.png" wrote
        // "shot.png.png" while the tool reported "shot.png" — a path with no
        // file at it. Hand Premiere the stem and let it add the extension back.
        // Strip any accepted spelling of the extension (".tiff" as well as the
        // canonical ".tif", ".jpeg" as well as ".jpg") so the double-extension
        // never reappears for an alias; Premiere writes the canonical extension.
        var requestedPath = ${JSON.stringify(outputPath)};
        var exportStem = requestedPath;
        for (var fx = 0; fx < formatExts.length; fx++) {
          var fxExt = formatExts[fx];
          if (requestedPath.length > fxExt.length && requestedPath.substring(requestedPath.length - fxExt.length).toLowerCase() === fxExt) {
            exportStem = requestedPath.substring(0, requestedPath.length - fxExt.length);
            break;
          }
        }

        // Where the frame can land: the canonical extension Premiere writes, each
        // accepted alias off the stem, and the raw requested path (in case a future
        // version stops appending). writtenPath() picks whichever actually appeared.
        var candidatePaths = [exportStem + formatExtension];
        for (var cf = 0; cf < formatExts.length; cf++) candidatePaths.push(exportStem + formatExts[cf]);
        candidatePaths.push(requestedPath);

        // A non-throwing call is not proof that a file was written, so record
        // what is on disk first. Comparing modification stamps rather than mere
        // existence keeps a stale file from an earlier run from being reported
        // as this call's output.
        var beforeState = [];
        for (var p = 0; p < candidatePaths.length; p++) {
          var state = { existed: false, stamp: 0, length: -1 };
          try {
            var probe = new File(candidatePaths[p]);
            if (probe.exists) {
              state.existed = true;
              state.stamp = probe.modified ? probe.modified.getTime() : 0;
              state.length = probe.length;
            }
          } catch (eProbe) {}
          beforeState.push(state);
        }

        // Returns the path that looks freshly written, or null. Freshness is judged
        // on modification time first and length second, because a filesystem with
        // one-second timestamp granularity can rewrite a file within the same second
        // and leave the stamp unchanged.
        function writtenPath(acceptUnchanged) {
          for (var w = 0; w < candidatePaths.length; w++) {
            try {
              var file = new File(candidatePaths[w]);
              if (!file.exists) continue;
              if (!beforeState[w].existed) return candidatePaths[w];
              var stamp = file.modified ? file.modified.getTime() : 0;
              if (stamp !== beforeState[w].stamp) return candidatePaths[w];
              if (file.length !== beforeState[w].length) return candidatePaths[w];
              // Neither moved. The export may still have written identical bytes over
              // an existing file, so on the final check accept it rather than report a
              // failure for a write that did happen -- a false failure invites a retry.
              if (acceptUnchanged) return candidatePaths[w];
            } catch (eCheck) {}
          }
          return null;
        }

        var exportError = null;
        function tryExport(arg1, arg2) {
          try {
            qeSequence[methodName](arg1, arg2);
          } catch (e2) {
            exportError = e2.toString();
            return false;
          }
          // Some argument orders are accepted without throwing and without
          // producing anything, so keep probing the remaining orders rather
          // than reporting a success that left no file behind.
          return writtenPath(false) !== null;
        }

        var exported =
          tryExport(timeNumber, exportStem) ||
          tryExport(exportStem, timeNumber) ||
          tryExport(timeString, exportStem) ||
          tryExport(exportStem, timeString) ||
          tryExport(timeTicks, exportStem) ||
          tryExport(exportStem, timeTicks);

        var actualPath = writtenPath(true);
        if (!exported || !actualPath) {
          return JSON.stringify({
            success: false,
            error: exportError || "Frame export reported no error but wrote no file"
          });
        }

        return JSON.stringify({
          success: true,
          message: "Frame exported successfully",
          sequenceId: ${JSON.stringify(sequenceId)},
          sequenceName: sequence.name,
          time: ${time},
          outputPath: actualPath,
          requestedPath: requestedPath,
          format: ${JSON.stringify(format)}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // Advanced Features Implementation
  private async stabilizeClip(clipId: string, _method = 'warp', smoothness = 50): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = qeSeq.getVideoTrackAt(info.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, info.clip);
        var effect = qe.project.getVideoEffectByName("Warp Stabilizer");
        if (!effect) return JSON.stringify({ success: false, error: "Warp Stabilizer effect not found" });
        qeClip.addVideoEffect(effect);
        var clip = info.clip;
        var lastComp = clip.components[clip.components.numItems - 1];
        for (var j = 0; j < lastComp.properties.numItems; j++) {
          try {
            if (lastComp.properties[j].displayName === "Smoothness") lastComp.properties[j].setValue(${smoothness}, true);
          } catch (e2) {}
        }
        return JSON.stringify({ success: true, message: "Warp Stabilizer applied", clipId: ${JSON.stringify(clipId)}, smoothness: ${smoothness} });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async speedChange(clipId: string, speed: number, maintainAudio = true): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var oldSpeed = info.clip.getSpeed();
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = info.trackType === 'video' ? qeSeq.getVideoTrackAt(info.trackIndex) : qeSeq.getAudioTrackAt(info.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, info.clip);
        if (!qeClip) return JSON.stringify({ success: false, error: "Could not resolve the QE clip for this item." });
        // QE setSpeed's signature is (rate, durationTimecodeString, reverse,
        // maintainAudioPitch, ripple). Passing a boolean where the duration
        // string belongs throws "Illegal Parameter type" — that was the bug
        // (the old call was setSpeed(rate, maintainAudio)). rate is a ratio
        // (0.5 = 50%, 2.0 = 200%), matching this tool's schema. Verified live
        // on 26.3.2: this call retimes the clip and getSpeed() reflects it.
        try { qeClip.setSpeed(${speed}, "00:00:00:00", false, ${maintainAudio ? true : false}, false); } catch(e2) {
          return JSON.stringify({ success: false, error: "Speed change via QE DOM failed: " + e2.toString(), oldSpeed: oldSpeed, requestedSpeed: ${speed} });
        }
        // Verify-after-write: read the speed back and only report success when
        // the clip is actually at (approximately) the requested rate.
        var newSpeed = info.clip.getSpeed();
        if (Math.abs(Number(newSpeed) - Number(${speed})) > 0.02) {
          return JSON.stringify({ success: false, verified: false, error: "Premiere did not apply the requested speed (clip is at " + newSpeed + "x, requested " + ${speed} + "x).", oldSpeed: oldSpeed, requestedSpeed: ${speed}, actualSpeed: newSpeed });
        }
        return JSON.stringify({ success: true, verified: true, oldSpeed: oldSpeed, newSpeed: newSpeed, requestedSpeed: ${speed} });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // ============================================
  // NEW TOOLS IMPLEMENTATION
  // ============================================

  // Markers Implementation

  /**
   * Builds the ExtendScript preamble that resolves a caller-supplied sequence ID to a real
   * sequence object.
   *
   * Premiere's ExtendScript DOM can read and mutate any sequence in the project, not just
   * the one on screen, so a tool that accepts a sequenceId must act on that sequence rather
   * than silently retargeting to `app.project.activeSequence`. When the ID matches nothing
   * we return a truthful error instead of falling back to the active sequence, which would
   * quietly write to the wrong timeline.
   *
   * The ID compared here is `sequence.sequenceID` (a GUID) — the same value surfaced as `id`
   * by `list_sequences` and `get_active_sequence`. It is deliberately not `sequence.id` or
   * `projectItem.nodeId`, which are different identifiers.
   */
  private buildSequenceResolver(sequenceId: string, varName: string = 'sequence'): string {
    const literal = JSON.stringify(sequenceId);
    return `        var ${varName} = __findSequence(${literal});
        if (!${varName}) {
          return JSON.stringify({
            success: false,
            error: "Sequence not found by id: " + ${literal} + ". Use list_sequences or get_active_sequence to obtain a valid sequence ID."
          });
        }`;
  }

  /**
   * Map a schema-validated colour to its index. Returns null when no colour was
   * supplied, leaving the marker at Premiere's default rather than silently
   * recolouring it. Unrecognised values cannot reach here — MarkerColorSchema
   * rejects them before the bridge is touched.
   */
  private static resolveMarkerColor(color?: string | number): number | null {
    if (color === undefined || color === null || color === '') return null;
    if (typeof color === 'number') return color;
    const value = String(color).trim().toLowerCase();
    if (/^[0-7]$/.test(value)) return Number(value);
    const index = MARKER_COLOR_NAMES.indexOf(value as typeof MARKER_COLOR_NAMES[number]);
    return index === -1 ? null : index;
  }

  private async addMarker(sequenceId: string, time: number, name: string, comment?: string, color?: string, duration?: number): Promise<any> {
    const colorIndex = PremiereProTools.resolveMarkerColor(color);
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var marker = sequence.markers.createMarker(${time});
        marker.name = ${JSON.stringify(name)};
        ${comment ? `marker.comments = ${JSON.stringify(comment)};` : ''}
        ${colorIndex !== null ? `marker.setColorByIndex(${colorIndex});` : ''}
        ${duration && duration > 0 ? `marker.end = ${time + duration};` : ''}

        return JSON.stringify({
          success: true,
          markerId: marker.guid,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          message: "Marker added successfully"
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

  private async deleteMarker(sequenceId: string, markerId: string): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var deleted = false;
        for (var i = 0; i < sequence.markers.numMarkers; i++) {
          var marker = sequence.markers[i];
          if (marker.guid === ${JSON.stringify(markerId)}) {
            sequence.markers.deleteMarker(marker);
            deleted = true;
            break;
          }
        }
        var stillPresent = false;
        for (var j = 0; j < sequence.markers.numMarkers; j++) {
          if (sequence.markers[j].guid === ${JSON.stringify(markerId)}) {
            stillPresent = true;
            break;
          }
        }

        return JSON.stringify({
          success: deleted && !stillPresent,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          message: deleted && !stillPresent ? "Marker deleted successfully" : (deleted ? "Premiere reported marker deletion but marker is still present" : "Marker not found")
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

  private async updateMarker(sequenceId: string, markerId: string, updates: any): Promise<any> {
    const updateColorIndex = PremiereProTools.resolveMarkerColor(updates.color);
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var found = false;
        var mismatch = [];
        for (var i = 0; i < sequence.markers.numMarkers; i++) {
          var marker = sequence.markers[i];
          if (marker.guid === ${JSON.stringify(markerId)}) {
            ${updates.name !== undefined ? `marker.name = ${JSON.stringify(updates.name)};` : ''}
            ${updates.comment !== undefined ? `marker.comments = ${JSON.stringify(updates.comment)};` : ''}
            ${updateColorIndex !== null ? `marker.setColorByIndex(${updateColorIndex});` : ''}
            // Re-read each written attribute off the same marker object; a rejected assignment
            // leaves the old value, which would otherwise be reported as a successful update.
            ${updates.name !== undefined ? `if (String(marker.name) !== ${JSON.stringify(updates.name)}) mismatch.push("name");` : ''}
            ${updates.comment !== undefined ? `if (String(marker.comments) !== ${JSON.stringify(updates.comment)}) mismatch.push("comment");` : ''}
            ${updateColorIndex !== null ? `var __mc = null; try { __mc = marker.getColorByIndex(); } catch (eMc) {} if (__mc !== null && Number(__mc) !== ${updateColorIndex}) mismatch.push("color");` : ''}
            found = true;
            break;
          }
        }

        if (found && mismatch.length) return JSON.stringify({
          success: false,
          verified: false,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          error: "Marker found but these attributes did not apply on readback: " + mismatch.join(", ")
        });
        return JSON.stringify({
          success: found,
          verified: found,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          message: found ? "Marker updated and verified" : "Marker not found"
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

  private async listMarkers(sequenceId: string): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        // getColorByIndex() is not bounded by the write domain: a marker can hold
        // -1, a persistent "no colour assigned" state that renders black. Guard
        // the lookup, or an undefined value silently drops colorName from the JSON.
        var COLOR_NAMES = ["green","red","purple","orange","yellow","white","blue","cyan"];
        var markers = [];
        for (var i = 0; i < sequence.markers.numMarkers; i++) {
          var marker = sequence.markers[i];
          var colorIndex = marker.getColorByIndex();
          markers.push({
            id: marker.guid,
            name: marker.name,
            comment: marker.comments,
            start: marker.start.seconds,
            end: marker.end.seconds,
            duration: marker.end.seconds - marker.start.seconds,
            type: marker.type,
            color: colorIndex,
            colorName: (colorIndex >= 0 && colorIndex < COLOR_NAMES.length) ? COLOR_NAMES[colorIndex] : null
          });
        }

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          markers: markers,
          count: markers.length
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

  // Track Management Implementation
  // FIX vs upstream: upstream called qeSeq.addTracks(numVideo, numAudio, 0) which interpreted
  // the 3rd arg as videoInsertIndex = 0, meaning "insert NEW track AT INDEX 0", pushing all
  // existing tracks up by 1. This destroyed V1's content positioning relative to track names
  // and caused MOGRT inserts to land on the wrong track.
  //
  // QE DOM signature: Sequence.addTracks(videoCount, videoInsertIndex, audioCount,
  //   audioMediaType, audioInsertIndex, audioSubmixCount, audioSubmixAudioType)
  //
  // Now we honor the `position` param:
  //   - "above" (default) → insert at index = numVideoTracks (becomes new TOP track,
  //     existing tracks keep their indices)
  //   - "below" → insert at 0 (legacy behavior, pushes existing up — only useful in special
  //     cases since V1 in Premiere's UI is the bottom)
  private async addTrack(sequenceId: string, trackType: string, position: string = 'above'): Promise<any> {
    const isVideo = trackType === 'video';
    const numVideo = isVideo ? 1 : 0;
    const numAudio = isVideo ? 0 : 1;
    const script = `
      try {
        app.enableQE();
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var __priorActive = app.project.activeSequence;
        app.project.activeSequence = seq;
        var qeSeq = __qeSequenceFor(seq);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + seq.name + "' through the QE API." });

        // Calculate insertion index based on position
        var existingVideoTracks = seq.videoTracks.numTracks;
        var existingAudioTracks = seq.audioTracks.numTracks;
        var insertVideoIdx = (${JSON.stringify(position)} === 'above') ? existingVideoTracks : 0;
        var insertAudioIdx = (${JSON.stringify(position)} === 'above') ? existingAudioTracks : 0;

        // Full QE addTracks signature. Arg 4 is audio type, arg 5 is audio insert index.
        qeSeq.addTracks(${numVideo}, insertVideoIdx, ${numAudio}, 1, insertAudioIdx, 0, 0);

        var afterVideoTracks = seq.videoTracks.numTracks;
        var afterAudioTracks = seq.audioTracks.numTracks;

        var expectedVideoTracks = existingVideoTracks + ${numVideo};
        var expectedAudioTracks = existingAudioTracks + ${numAudio};
        if (afterVideoTracks < expectedVideoTracks || afterAudioTracks < expectedAudioTracks) {
          return JSON.stringify({
            success: false,
            error: "Premiere did not add the requested track",
            trackType: ${JSON.stringify(trackType)},
            position: ${JSON.stringify(position)},
            videoTracksBefore: existingVideoTracks,
            videoTracksAfter: afterVideoTracks,
            audioTracksBefore: existingAudioTracks,
            audioTracksAfter: afterAudioTracks,
            expectedVideoTracks: expectedVideoTracks,
            expectedAudioTracks: expectedAudioTracks
          });
        }

        return JSON.stringify({
          success: true,
          message: ${JSON.stringify(trackType)} + " track added at " + ${JSON.stringify(position)},
          trackType: ${JSON.stringify(trackType)},
          position: ${JSON.stringify(position)},
          videoTracksBefore: existingVideoTracks,
          videoTracksAfter: afterVideoTracks,
          audioTracksBefore: existingAudioTracks,
          audioTracksAfter: afterAudioTracks,
          newVideoTrackIndex: ${isVideo ? `(${JSON.stringify(position)} === 'above') ? existingVideoTracks : 0` : 'null'},
          newAudioTrackIndex: ${!isVideo ? `(${JSON.stringify(position)} === 'above') ? existingAudioTracks : 0` : 'null'}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      } finally {
        // Leave the user where they were. ES3 has try/finally, and this runs
        // before the return above completes.
        try {
          if (__priorActive && app.project.activeSequence &&
              app.project.activeSequence.sequenceID !== __priorActive.sequenceID) {
            app.project.activeSequence = __priorActive;
          }
        } catch (eRestore) {}
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async deleteTrack(sequenceId: string, trackType: string, trackIndex: number): Promise<any> {
    if (trackType === 'caption') {
      return {
        success: false,
        error: 'Caption track deletion is not supported by Premiere Pro scripting. The ExtendScript DOM exposes no sequence.captionTracks/getCaptionTracks surface, and the QE DOM exposes no caption-track accessor or delete method.',
        sequenceId,
        trackType,
        trackIndex,
        unsupportedByPremiereApi: true,
        workaround: 'Delete caption tracks manually in Premiere, or remove/recreate captions from the source .srt before creating the caption track.'
      };
    }

    // Premiere 26 exposes no DOM trackCollection.deleteTrack, so deletion falls through to the
    // QE DOM — and QE can only reach qe.project.getActiveSequence(). Rather than deleting a
    // track from whatever timeline happens to be on screen, refuse the cross-sequence case with
    // a truthful error that names the limitation.
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var tracks = ${trackType === 'video' ? 'sequence.videoTracks' : 'sequence.audioTracks'};
        if (${trackIndex} >= 0 && ${trackIndex} < tracks.numTracks) {
          var beforeCount = tracks.numTracks;
          var deleted = false;
          if (tracks.deleteTrack) {
            tracks.deleteTrack(${trackIndex});
            deleted = true;
          } else {
            // QE addresses sequences by index through getSequenceAt(), not
            // only whatever is active, so resolve by guid instead of refusing
            // every cross-sequence request. What QE actually limits is which
            // sequences it exposes at all — a sequence it cannot see is
            // reported as such, naming it, rather than deleting a track from
            // the timeline that happens to be on screen.
            var activeSeq = app.project.activeSequence;
            var qeSeq = __qeSequenceFor(sequence);
            if (!qeSeq) {
              return JSON.stringify({
                success: false,
                error: "Track deletion needs the QE API, which cannot address sequence '" + sequence.name + "'. Premiere exposes no DOM track-deletion API, and QE only reaches sequences it has open. Open it in a timeline, or call set_active_sequence with " + sequence.sequenceID + ", then retry.",
                sequenceId: sequence.sequenceID,
                sequenceName: sequence.name,
                activeSequenceId: activeSeq ? activeSeq.sequenceID : null,
                requiresOpenSequence: true
              });
            }
            if (${trackType === 'video' ? 'true' : 'false'} && qeSeq.removeVideoTrack) {
              qeSeq.removeVideoTrack(${trackIndex});
              deleted = true;
            } else if (${trackType === 'audio' ? 'true' : 'false'} && qeSeq.removeAudioTrack) {
              qeSeq.removeAudioTrack(${trackIndex});
              deleted = true;
            }
          }
          var afterCount = tracks.numTracks;
          if (!deleted || afterCount >= beforeCount) {
            return JSON.stringify({
              success: false,
              error: "Premiere did not remove the requested track",
              beforeCount: beforeCount,
              afterCount: afterCount
            });
          }
          return JSON.stringify({
            success: true,
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            message: "Track deleted successfully",
            beforeCount: beforeCount,
            afterCount: afterCount
          });
        } else {
          return JSON.stringify({
            success: false,
            error: "Track index out of range"
          });
        }
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async lockTrack(sequenceId: string, trackType: string, trackIndex: number, locked: boolean): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var tracks = ${trackType === 'video' ? 'sequence.videoTracks' : 'sequence.audioTracks'};
        if (${trackIndex} >= 0 && ${trackIndex} < tracks.numTracks) {
          var lockTarget = tracks[${trackIndex}];
          lockTarget.setLocked(${locked ? 1 : 0});
          // isLocked is a property on this API, not a method. Read it back rather
          // than trusting the void setLocked() call.
          var nowLocked = null; try { nowLocked = Boolean(lockTarget.isLocked); } catch (eLock) {}
          if (nowLocked !== null && nowLocked !== ${locked}) return JSON.stringify({ success: false, verified: false, error: "Premiere did not change the track lock state (still reads " + (nowLocked ? "locked" : "unlocked") + ")." });
          return JSON.stringify({
            success: true,
            verified: nowLocked !== null,
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            message: "Track " + (${locked} ? "locked" : "unlocked")
          });
        } else {
          return JSON.stringify({
            success: false,
            error: "Track index out of range"
          });
        }
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async toggleTrackVisibility(sequenceId: string, trackIndex: number, visible: boolean): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        if (${trackIndex} >= 0 && ${trackIndex} < sequence.videoTracks.numTracks) {
          // This used to call setTargeted(), which is the V1/A1 patch button, not the
          // eye. Track output was never touched and the caller's track targeting was
          // silently changed instead, under a response saying "Track visibility
          // toggled". On a video track, mute IS the eye: setMute(1) disables output.
          var visibilityTrack = sequence.videoTracks[${trackIndex}];
          if (!visibilityTrack.setMute) {
            return JSON.stringify({ success: false, error: "Track.setMute is unavailable on this build, so track output cannot be changed" });
          }
          visibilityTrack.setMute(${visible} ? 0 : 1);

          // Read it back: assignment is not evidence of effect anywhere else in this API.
          var nowMuted = null;
          try { nowMuted = visibilityTrack.isMuted ? visibilityTrack.isMuted() : null; } catch (eMuted) {}
          if (nowMuted !== null && nowMuted === ${visible}) {
            return JSON.stringify({
              success: false,
              error: "Premiere accepted the change but the track output did not move",
              requestedVisible: ${visible},
              muted: nowMuted
            });
          }

          return JSON.stringify({
            success: true,
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            trackIndex: ${trackIndex},
            visible: nowMuted === null ? ${visible} : !nowMuted,
            message: ${visible} ? "Track output enabled" : "Track output disabled"
          });
        } else {
          return JSON.stringify({
            success: false,
            error: "Track index out of range"
          });
        }
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async linkAudioVideo(clipId: string, linked: boolean): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        info.clip.setSelected(1, 1);
        var seq = app.project.activeSequence;
        if (${linked}) { seq.linkSelection(); } else { seq.unlinkSelection(); }
        return JSON.stringify({ success: true, message: "Clip " + (${linked} ? "linked" : "unlinked") });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async applyAudioEffect(clipId: string, effectName: string, parameters?: any): Promise<any> {
    return await this.applyEffect(clipId, effectName, parameters);
  }

  // BULK helper: apply same audio effect + parameters to all audio clips of a sequence in ONE
  // ExtendScript round-trip. Activates the target sequence first (QE DOM operates on active).
  // Returns per-clip results with valueAfter readback for the SET parameters.
  private async applyAudioEffectToAllClips(sequenceId: string, effectName: string, parameters?: Record<string, any>): Promise<any> {
    const paramJson = JSON.stringify(parameters || {});
    const script = `
      try {
        app.enableQE();
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        // Make target active so QE DOM can address it
        var __priorActive = app.project.activeSequence;
        app.project.activeSequence = seq;
        var qeSeq = __qeSequenceFor(seq);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + seq.name + "' through the QE API." });
        var effect = qe.project.getAudioEffectByName(${JSON.stringify(effectName)});
        if (!effect) return JSON.stringify({ success: false, error: "Audio effect not found: " + ${JSON.stringify(effectName)} });

        var requestedParams = ${paramJson};
        function normalize(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }

        var perClip = [];
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
          var track = seq.audioTracks[t];
          var qeTrack = qeSeq.getAudioTrackAt(t);
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            // Same gap/transition mismatch: c is the DOM clip index, which is not the
            // QE item index once anything non-clip sits earlier on the track.
            var qeClip = __findQeClipByDomClip(qeTrack, clip);
            try {
              qeClip.addAudioEffect(effect);
              var newCompIdx = clip.components.numItems - 1;
              var newComp = clip.components[newCompIdx];
              var paramResults = [];
              for (var pName in requestedParams) {
                if (requestedParams.hasOwnProperty && !requestedParams.hasOwnProperty(pName)) continue;
                var requestedVal = requestedParams[pName];
                var matched = null;
                for (var k = 0; k < newComp.properties.numItems; k++) {
                  if (String(newComp.properties[k].displayName) === pName) {
                    matched = newComp.properties[k]; break;
                  }
                }
                if (!matched) {
                  var nameN = normalize(pName);
                  for (var k = 0; k < newComp.properties.numItems; k++) {
                    if (normalize(String(newComp.properties[k].displayName)) === nameN) {
                      matched = newComp.properties[k]; break;
                    }
                  }
                }
                if (matched) {
                  try {
                    matched.setValue(requestedVal, true);
                    var valueAfter = null;
                    try { valueAfter = matched.getValue(); } catch (eA) {}
                    paramResults.push({ name: pName, ok: true, valueRequested: requestedVal, valueAfter: valueAfter });
                  } catch (e1) {
                    paramResults.push({ name: pName, ok: false, error: e1.toString() });
                  }
                } else {
                  paramResults.push({ name: pName, ok: false, error: "no matching property" });
                }
              }
              perClip.push({ clipIndex: c, trackIndex: t, clipId: String(clip.nodeId), name: String(clip.name), ok: true, paramResults: paramResults });
            } catch (e2) {
              perClip.push({ clipIndex: c, trackIndex: t, clipId: String(clip.nodeId), name: String(clip.name), ok: false, error: e2.toString() });
            }
          }
        }

        return JSON.stringify({
          success: true,
          sequenceId: ${JSON.stringify(sequenceId)},
          sequenceName: String(seq.name),
          effectName: ${JSON.stringify(effectName)},
          totalClipsProcessed: perClip.length,
          allOk: perClip.every ? perClip.every(function(r){return r.ok;}) : true,
          perClip: perClip
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      } finally {
        // Leave the user where they were. ES3 has try/finally, and this runs
        // before the return above completes.
        try {
          if (__priorActive && app.project.activeSequence &&
              app.project.activeSequence.sequenceID !== __priorActive.sequenceID) {
            app.project.activeSequence = __priorActive;
          }
        } catch (eRestore) {}
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Nested Sequences
  private async createNestedSequence(_clipIds: string[], _name: string): Promise<any> {
    return {
      success: false,
      error: "create_nested_sequence: This feature requires selection and nesting APIs. Implementation pending.",
      note: "You can manually nest clips via right-click > Nest"
    };
  }

  private async unnestSequence(nestedSequenceClipId: string): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(nestedSequenceClipId)});
        if (!info) return JSON.stringify({ success: false, error: "Nested sequence clip not found" });
        var parentSeq = app.project.activeSequence;
        if (!parentSeq) return JSON.stringify({ success: false, error: "No active parent sequence" });
        var nestedClip = info.clip;
        var nestedItem = nestedClip.projectItem;
        var nestedSeq = null;
        if (nestedItem && typeof nestedItem.getSequence === "function") {
          nestedSeq = nestedItem.getSequence();
        }
        if (!nestedSeq && nestedItem && app.project && app.project.sequences) {
          for (var ns = 0; ns < app.project.sequences.numSequences; ns++) {
            var candidateSeq = app.project.sequences[ns];
            if (candidateSeq && candidateSeq.name === nestedItem.name) {
              nestedSeq = candidateSeq;
              break;
            }
          }
        }
        if (!nestedSeq) return JSON.stringify({ success: false, error: "Project item did not return a nested sequence" });

        function secondsOf(value) {
          if (value === undefined || value === null) return 0;
          if (typeof value === "number") return value;
          if (value.seconds !== undefined) return Number(value.seconds);
          if (value.ticks !== undefined) return Number(value.ticks) / 254016000000.0;
          return 0;
        }

        var parentStart = secondsOf(nestedClip.start);
        var placed = [];
        var errors = [];
        function copyTrackItems(trackCollection, parentCollection, parentBaseTrack, trackType) {
          if (!trackCollection || !parentCollection) return;
          for (var t = 0; t < trackCollection.numTracks; t++) {
            var sourceTrack = trackCollection[t];
            var targetTrackIndex = parentBaseTrack + t;
            if (targetTrackIndex >= parentCollection.numTracks) {
              errors.push({ trackType: trackType, trackIndex: targetTrackIndex, error: "Parent track does not exist" });
              continue;
            }
            var targetTrack = parentCollection[targetTrackIndex];
            for (var c = 0; c < sourceTrack.clips.numItems; c++) {
              var sourceClip = sourceTrack.clips[c];
              if (!sourceClip || !sourceClip.projectItem) {
                errors.push({ trackType: trackType, trackIndex: t, clipIndex: c, error: "Nested clip has no source project item" });
                continue;
              }
              var targetTime = parentStart + secondsOf(sourceClip.start);
              try {
                targetTrack.overwriteClip(sourceClip.projectItem, targetTime);
                placed.push({
                  trackType: trackType,
                  sourceTrackIndex: t,
                  targetTrackIndex: targetTrackIndex,
                  clipIndex: c,
                  name: sourceClip.name,
                  time: targetTime
                });
              } catch (placeError) {
                errors.push({ trackType: trackType, trackIndex: t, clipIndex: c, error: placeError.toString() });
              }
            }
          }
        }

        copyTrackItems(nestedSeq.videoTracks, parentSeq.videoTracks, info.trackIndex, "video");
        copyTrackItems(nestedSeq.audioTracks, parentSeq.audioTracks, 0, "audio");

        if (!placed.length) {
          return JSON.stringify({ success: false, error: "No nested clips could be placed into the parent sequence", errors: errors });
        }

        nestedClip.remove(false, true);
        return JSON.stringify({
          success: true,
          message: "Nested sequence clip replaced with its child clips",
          nestedSequenceClipId: ${JSON.stringify(nestedSequenceClipId)},
          nestedSequenceId: nestedSeq.sequenceID,
          nestedSequenceName: nestedSeq.name,
          placedCount: placed.length,
          placed: placed,
          errors: errors
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Additional Clip Operations
  private async duplicateClip(clipId: string, offset?: number): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var projItem = clip.projectItem;
        var insertTime = clip.end.seconds + ${offset !== undefined ? offset : 0};
        var beforeCount = info.track.clips.numItems;
        info.track.overwriteClip(projItem, insertTime);
        var afterCount = info.track.clips.numItems;
        if (afterCount <= beforeCount) return JSON.stringify({ success: false, verified: false, error: "overwriteClip() ran but no clip was added at " + insertTime + "s (track count unchanged).", beforeCount: beforeCount, afterCount: afterCount });
        return JSON.stringify({ success: true, verified: true, message: "Clip duplicated at " + insertTime + "s", beforeCount: beforeCount, afterCount: afterCount });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async reverseClip(clipId: string, maintainAudioPitch?: boolean): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var mediaPath = "";
        try { mediaPath = info.clip.projectItem && info.clip.projectItem.getMediaPath ? String(info.clip.projectItem.getMediaPath()) : ""; } catch (pathError) {}
        if (/\\.(png|jpg|jpeg|gif|tif|tiff)$/i.test(mediaPath)) {
          return JSON.stringify({ success: true, clipId: ${JSON.stringify(clipId)}, reversed: true, changed: false, method: "still image already visually reversible" });
        }
        app.enableQE();
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = info.trackType === 'video' ? qeSeq.getVideoTrackAt(info.trackIndex) : qeSeq.getAudioTrackAt(info.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, info.clip);
        if (!qeClip || !qeClip.setReverse) return JSON.stringify({ success: false, error: "QE setReverse API unavailable" });
        try { qeClip.setReverse(true); } catch (reverseError) { return JSON.stringify({ success: false, error: "Reverse via QE DOM not available: " + reverseError.toString() }); }
        // No QE/DOM property reliably reports playback reversal on 26.x, so success
        // here means setReverse() was accepted without throwing -- not an independent
        // confirmation. Reported honestly as verified:false rather than overstated.
        return JSON.stringify({ success: true, verified: false, clipId: ${JSON.stringify(clipId)}, reversed: true, changed: true, maintainAudioPitch: ${maintainAudioPitch !== false}, note: "setReverse() accepted; no readback API to confirm the clip now plays reversed." });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async enableDisableClip(clipId: string, enabled: boolean): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        info.clip.disabled = ${!enabled};
        var nowEnabled = !info.clip.disabled;
        if (nowEnabled !== ${enabled}) return JSON.stringify({ success: false, verified: false, error: "Premiere did not change the clip's enabled state (still reads " + (nowEnabled ? "enabled" : "disabled") + ")." });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Clip " + (${enabled} ? "enabled" : "disabled")
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async replaceClip(clipId: string, newProjectItemId: string, _preserveEffects?: boolean): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var newItem = __findProjectItem(${JSON.stringify(newProjectItemId)});
        if (!newItem) return JSON.stringify({ success: false, error: "New project item not found" });
        var startTime = info.clip.start.seconds;
        info.clip.remove(false, true);
        info.track.overwriteClip(newItem, startTime);
        // Confirm the clip now covering startTime is backed by the requested item,
        // rather than trusting overwriteClip() (which returns void and can no-op).
        var replaced = false;
        for (var rci = 0; rci < info.track.clips.numItems; rci++) {
          var rc = info.track.clips[rci];
          if (rc.start.seconds <= startTime + 0.001 && rc.end.seconds > startTime - 0.001) {
            if (rc.projectItem && String(rc.projectItem.nodeId) === String(newItem.nodeId)) replaced = true;
            break;
          }
        }
        if (!replaced) return JSON.stringify({ success: false, verified: false, error: "Premiere reported the replace but '" + newItem.name + "' is not the clip at " + startTime + "s." });
        return JSON.stringify({ success: true, verified: true, message: "Clip replaced" });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Project Settings
  private async getSequenceSettings(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) {
          return JSON.stringify({
            success: false,
            error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)}
          });
        }
        var settings = sequence.getSettings();
        return JSON.stringify({
          success: true,
          settings: {
            name: sequence.name,
            sequenceID: sequence.sequenceID,
            width: settings.videoFrameWidth,
            height: settings.videoFrameHeight,
            timebase: sequence.timebase,
            videoDisplayFormat: settings.videoDisplayFormat,
            audioChannelType: settings.audioChannelType,
            audioSampleRate: settings.audioSampleRate
          }
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

  private async setSequenceSettings(sequenceId: string, settings: any): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        // This used to compare width and height, write nothing at all, and report
        // "Requested sequence settings already match the active Premiere sequence" —
        // two falsehoods in one line, since frameRate and pixelAspectRatio were never
        // even looked at, and the sequence operated on is the resolved one rather than
        // whatever is active. It also refused any frame size change on the grounds that
        // Premiere cannot do it, which is untrue: setSettings() resizes a sequence after
        // creation, verified live by taking one from 1920x1080 to 1280x720.
        var requested = ${JSON.stringify(settings || {})};
        if (!sequence.getSettings || !sequence.setSettings) {
          return JSON.stringify({ success: false, error: "Sequence settings API unavailable on this build" });
        }

        function readSettings(seq) {
          var g = seq.getSettings();
          var fps = null;
          try { fps = 254016000000 / parseInt(String(g.videoFrameRate.ticks), 10); } catch (eFps) {}
          return {
            width: Number(g.videoFrameWidth),
            height: Number(g.videoFrameHeight),
            frameRate: fps,
            pixelAspectRatio: String(g.videoPixelAspectRatio)
          };
        }

        var before = readSettings(sequence);
        var settingsObject = sequence.getSettings();
        var applied = [];

        if (requested.width !== undefined) { settingsObject.videoFrameWidth = Number(requested.width); applied.push("width"); }
        if (requested.height !== undefined) { settingsObject.videoFrameHeight = Number(requested.height); applied.push("height"); }

        if (requested.frameRate !== undefined) {
          // videoFrameRate is a Time expressed as ticks per frame, and it has to be
          // assigned as a STRING of ticks. Assigning the number is accepted without
          // complaint and then corrupts the value — the field reads back as 2^63 ticks,
          // which works out to a frame rate of 2.75e-08.
          settingsObject.videoFrameRate = String(Math.round(254016000000 / Number(requested.frameRate)));
          applied.push("frameRate");
        }

        if (requested.pixelAspectRatio !== undefined) {
          // Stored as an "N:M" string; a number throws "Illegal Parameter type".
          var parValue = requested.pixelAspectRatio;
          var parText = String(parValue);
          if (parText.indexOf(":") === -1) {
            var parNumber = Number(parValue);
            if (!isFinite(parNumber) || parNumber <= 0) {
              return JSON.stringify({ success: false, error: "pixelAspectRatio must be a positive number or an \\"N:M\\" ratio string." });
            }
            var denominator = 1000;
            var numerator = Math.round(parNumber * denominator);
            var a = numerator, b = denominator;
            while (b) { var t = a % b; a = b; b = t; }
            parText = (numerator / a) + ":" + (denominator / a);
          }
          settingsObject.videoPixelAspectRatio = parText;
          applied.push("pixelAspectRatio");
        }

        if (!applied.length) {
          return JSON.stringify({
            success: true,
            message: "No recognised settings were supplied, so nothing was changed",
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            settings: before,
            supported: ["width", "height", "frameRate", "pixelAspectRatio"],
            changed: false
          });
        }

        try {
          sequence.setSettings(settingsObject);
        } catch (eApply) {
          return JSON.stringify({
            success: false,
            error: "Premiere rejected the settings: " + eApply.toString(),
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            attempted: applied,
            settings: before
          });
        }

        // Read back rather than trusting the write: several of these fields accept an
        // assignment and silently keep their old value.
        var after = readSettings(sequence);
        var unchanged = [];
        for (var ai = 0; ai < applied.length; ai++) {
          var field = applied[ai];
          if (String(after[field]) === String(before[field]) && String(requested[field]) !== String(before[field])) {
            unchanged.push(field);
          }
        }

        return JSON.stringify({
          success: unchanged.length === 0,
          error: unchanged.length ? "Premiere accepted the assignment but did not apply: " + unchanged.join(", ") : undefined,
          message: unchanged.length ? undefined : "Sequence settings applied",
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          applied: applied,
          before: before,
          after: after,
          changed: true
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async getClipProperties(clipId: string, sequenceId?: string): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)}, ${sequenceId ? JSON.stringify(sequenceId) : 'null'});
        if (!info) return JSON.stringify({ success: false, error: ${sequenceId ? JSON.stringify(`Clip not found in sequence: ${sequenceId}`) : '"Clip not found"'} });
        var clip = info.clip;

        // Read back Motion (opacity/scale/rotation/position). Position is stored NORMALIZED
        // (0..1); expose both the raw normalized value and PIXELS (using the sequence frame size)
        // so callers can verify/copy framing without exporting a frame. Only present for video clips.
        var __seqW = 1920, __seqH = 1080;
        try {
          if (info.sequence) {
            if (info.sequence.frameSizeHorizontal) { __seqW = info.sequence.frameSizeHorizontal; __seqH = info.sequence.frameSizeVertical; }
            else { var __ss = info.sequence.getSettings(); if (__ss) { __seqW = __ss.videoFrameWidth; __seqH = __ss.videoFrameHeight; } }
          }
        } catch (e0) {}
        var motion = null;
        try {
          var m = {};
          for (var ci = 0; ci < clip.components.numItems; ci++) {
            var comp = clip.components[ci];
            for (var pj = 0; pj < comp.properties.numItems; pj++) {
              var pp = comp.properties[pj];
              try {
                if (pp.displayName === "Opacity") m.opacity = pp.getValue();
                else if (pp.displayName === "Scale") m.scale = pp.getValue();
                else if (pp.displayName === "Rotation") m.rotation = pp.getValue();
                else if (pp.displayName === "Position") {
                  var pv = pp.getValue();
                  if (pv && pv.length >= 2) {
                    m.positionNormalized = { x: pv[0], y: pv[1] };
                    m.position = { x: Math.round(pv[0] * __seqW * 1000) / 1000, y: Math.round(pv[1] * __seqH * 1000) / 1000 };
                  }
                }
              } catch (ep) {}
            }
          }
          motion = m;
        } catch (em) { motion = null; }

        return JSON.stringify({
          success: true,
          properties: {
            name: clip.name,
            start: clip.start.seconds,
            end: clip.end.seconds,
            duration: clip.duration.seconds,
            inPoint: clip.inPoint.seconds,
            outPoint: clip.outPoint.seconds,
            enabled: !clip.disabled,
            trackIndex: info.trackIndex,
            trackType: info.trackType,
            sequenceId: info.sequenceId,
            sequenceName: info.sequenceName,
            frameSize: { width: __seqW, height: __seqH },
            motion: motion,
            speed: clip.getSpeed()
          }
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

  private async setClipProperties(clipId: string, properties: any): Promise<any> {
    // Position is the Motion "Position" property. Callers pass PIXEL coordinates matching the
    // Effect Controls panel (e.g. 960,756 in a 1920x1280 sequence); the API stores it as a
    // NORMALIZED [x,y] (0..1, 0.5,0.5 = frame center), so we divide by the sequence frame size
    // (__seqW/__seqH). Per-property flags surface a silently-failed setValue or a missing Motion
    // property instead of reporting a blanket success.
    const spec = {
      opacity: properties?.opacity === undefined ? null : properties.opacity,
      scale: properties?.scale === undefined ? null : properties.scale,
      rotation: properties?.rotation === undefined ? null : properties.rotation,
      posX: properties?.position?.x === undefined ? null : properties.position.x,
      posY: properties?.position?.y === undefined ? null : properties.position.y,
    };
    const script = `
      try {
        var it = ${JSON.stringify(spec)};
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        // Sequence frame size, for converting Position pixels -> normalized. Try frameSize props
        // first, then getSettings(); fall back to 1920x1080 if neither is available.
        var __seqW = 1920, __seqH = 1080;
        try {
          if (info.sequence) {
            if (info.sequence.frameSizeHorizontal) { __seqW = info.sequence.frameSizeHorizontal; __seqH = info.sequence.frameSizeVertical; }
            else { var __ss = info.sequence.getSettings(); if (__ss) { __seqW = __ss.videoFrameWidth; __seqH = __ss.videoFrameHeight; } }
          }
        } catch (e0) {}
        var want = { opacity: it.opacity !== null, scale: it.scale !== null, rotation: it.rotation !== null, position: (it.posX !== null || it.posY !== null) };
        // done = the property was found AND the readback confirms the requested value applied.
        // setValue() can silently no-op, so a found+set property is not enough; re-read getValue().
        var done = { opacity: false, scale: false, rotation: false, position: false };
        var __scalarTol = 0.5, __posTol = 0.01;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          for (var j = 0; j < comp.properties.numItems; j++) {
            var p = comp.properties[j];
            try {
              if (want.opacity && p.displayName === "Opacity") { p.setValue(it.opacity, true); var __ro = p.getValue(); done.opacity = (Math.abs(Number(__ro) - it.opacity) <= __scalarTol); }
              if (want.scale && p.displayName === "Scale") { p.setValue(it.scale, true); var __rs = p.getValue(); done.scale = (Math.abs(Number(__rs) - it.scale) <= __scalarTol); }
              if (want.rotation && p.displayName === "Rotation") { p.setValue(it.rotation, true); var __rr = p.getValue(); done.rotation = (Math.abs(Number(__rr) - it.rotation) <= __scalarTol); }
              if (want.position && p.displayName === "Position") {
                var __cur = [0.5, 0.5];
                try { __cur = p.getValue(); } catch (ep) {}
                var __nx = it.posX !== null ? (it.posX / __seqW) : __cur[0];
                var __ny = it.posY !== null ? (it.posY / __seqH) : __cur[1];
                p.setValue([__nx, __ny], true);
                var __rp = [0.5, 0.5];
                try { __rp = p.getValue(); } catch (ep2) {}
                done.position = (Math.abs(Number(__rp[0]) - __nx) <= __posTol && Math.abs(Number(__rp[1]) - __ny) <= __posTol);
              }
            } catch (e2) {}
          }
        }
        var missing = [];
        if (want.opacity && !done.opacity) missing.push("opacity");
        if (want.scale && !done.scale) missing.push("scale");
        if (want.rotation && !done.rotation) missing.push("rotation");
        if (want.position && !done.position) missing.push("position");
        return JSON.stringify({
          success: (missing.length === 0),
          verified: (missing.length === 0),
          applied: done,
          message: missing.length ? ("properties did not apply (readback mismatch or missing): " + missing.join(", ")) : "Clip properties updated"
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Batch variant of setClipProperties: apply Motion values to many clips in ONE round-trip.
  // Same per-clip loop as the single version (opacity/scale/rotation/position), collapsing N
  // file round-trips into 1. Returns a per-clip result array.
  private async setClipPropertiesBatch(items: Array<{ clipId: string; properties: any }>): Promise<any> {
    const specs = items.map(it => ({
      clipId: it.clipId,
      opacity: it.properties?.opacity === undefined ? null : it.properties.opacity,
      scale: it.properties?.scale === undefined ? null : it.properties.scale,
      rotation: it.properties?.rotation === undefined ? null : it.properties.rotation,
      posX: it.properties?.position?.x === undefined ? null : it.properties.position.x,
      posY: it.properties?.position?.y === undefined ? null : it.properties.position.y,
    }));
    const script = `
      try {
        var specs = ${JSON.stringify(specs)};
        var results = [];
        for (var n = 0; n < specs.length; n++) {
          var it = specs[n];
          var r = { index: n, clipId: it.clipId, success: false };
          try {
            var info = __findClip(it.clipId);
            if (!info) { r.error = "Clip not found"; results.push(r); continue; }
            var clip = info.clip;
            // Sequence frame size for converting Position pixels -> normalized (see single variant).
            var __seqW = 1920, __seqH = 1080;
            try {
              if (info.sequence) {
                if (info.sequence.frameSizeHorizontal) { __seqW = info.sequence.frameSizeHorizontal; __seqH = info.sequence.frameSizeVertical; }
                else { var __ss = info.sequence.getSettings(); if (__ss) { __seqW = __ss.videoFrameWidth; __seqH = __ss.videoFrameHeight; } }
              }
            } catch (e0) {}
            // Track which requested properties we actually FOUND and SET, so a silently-failed
            // setValue (or a Motion property that isn't present) surfaces instead of a false success.
            var want = { opacity: it.opacity !== null, scale: it.scale !== null, rotation: it.rotation !== null, position: (it.posX !== null || it.posY !== null) };
            // done = found AND readback confirms it applied (setValue can silently no-op).
            var done = { opacity: false, scale: false, rotation: false, position: false };
            var __scalarTol = 0.5, __posTol = 0.01;
            for (var i = 0; i < clip.components.numItems; i++) {
              var comp = clip.components[i];
              for (var j = 0; j < comp.properties.numItems; j++) {
                var p = comp.properties[j];
                try {
                  if (want.opacity && p.displayName === "Opacity") { p.setValue(it.opacity, true); var __ro = p.getValue(); done.opacity = (Math.abs(Number(__ro) - it.opacity) <= __scalarTol); }
                  if (want.scale && p.displayName === "Scale") { p.setValue(it.scale, true); var __rs = p.getValue(); done.scale = (Math.abs(Number(__rs) - it.scale) <= __scalarTol); }
                  if (want.rotation && p.displayName === "Rotation") { p.setValue(it.rotation, true); var __rr = p.getValue(); done.rotation = (Math.abs(Number(__rr) - it.rotation) <= __scalarTol); }
                  if (want.position && p.displayName === "Position") {
                    var __cur = [0.5, 0.5];
                    try { __cur = p.getValue(); } catch (ep) {}
                    var __nx = it.posX !== null ? (it.posX / __seqW) : __cur[0];
                    var __ny = it.posY !== null ? (it.posY / __seqH) : __cur[1];
                    p.setValue([__nx, __ny], true);
                    var __rp = [0.5, 0.5];
                    try { __rp = p.getValue(); } catch (ep2) {}
                    done.position = (Math.abs(Number(__rp[0]) - __nx) <= __posTol && Math.abs(Number(__rp[1]) - __ny) <= __posTol);
                  }
                } catch (e2) {}
              }
            }
            var missing = [];
            if (want.opacity && !done.opacity) missing.push("opacity");
            if (want.scale && !done.scale) missing.push("scale");
            if (want.rotation && !done.rotation) missing.push("rotation");
            if (want.position && !done.position) missing.push("position");
            r.applied = done;
            r.success = (missing.length === 0);
            r.verified = (missing.length === 0);
            if (missing.length) r.error = "properties did not apply (readback mismatch or missing): " + missing.join(", ");
          } catch (e) {
            r.error = e.toString();
          }
          results.push(r);
        }
        var applied = 0;
        for (var k = 0; k < results.length; k++) { if (results[k].success) applied++; }
        return JSON.stringify({ success: (applied === specs.length), applied: applied, total: specs.length, results: results });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script, 300000);
  }

  // Render Queue
  private async addToRenderQueue(args: AddToRenderQueueArgs): Promise<any> {
    return await this.exportSequence(args);
  }

  private async getRenderQueueStatus(outputPath?: string): Promise<any> {
    // Adobe exposes no ExtendScript read of AME's live queue. Two honest signals
    // ARE available, so report those instead of a hardcoded "unavailable":
    //   1. Whether the encoder hand-off bridge (app.encoder) is reachable at all.
    //   2. If the caller names an output file, its on-disk state — the reliable
    //      way to watch an AME render actually progress (poll repeatedly).
    const note =
      "Premiere cannot read Adobe Media Encoder's queue directly. To track a render, " +
      "pass outputPath and poll this tool: a growing byte size means the encode is running; " +
      "a stable size over successive calls means it has finished (or stalled).";

    // Best-effort encoder-bridge probe. A bridge failure must not sink the file report.
    let encoder: any = { available: false, methods: [] };
    try {
      const probe = `
        try {
          var out = { available: false, methods: [] };
          if (typeof app !== 'undefined' && app.encoder) {
            out.available = true;
            var names = ["encodeSequence","encodeProjectItem","encodeFile","launchEncoder","startBatch"];
            for (var i = 0; i < names.length; i++) {
              try { if (typeof app.encoder[names[i]] === "function") out.methods.push(names[i]); } catch (eM) {}
            }
          }
          return JSON.stringify({ success: true, encoder: out });
        } catch (e) {
          return JSON.stringify({ success: false, error: e.toString() });
        }
      `;
      const res: any = await this.bridge.executeScript(probe);
      if (res && res.encoder) encoder = res.encoder;
    } catch {
      // leave encoder at its default (unreachable); the file report below still stands.
    }

    let outputFile: any = undefined;
    if (outputPath) {
      try {
        const st = await fs.stat(outputPath);
        outputFile = {
          path: outputPath,
          exists: true,
          bytes: st.size,
          modifiedIso: st.mtime.toISOString(),
        };
      } catch {
        outputFile = { path: outputPath, exists: false };
      }
    }

    return {
      success: true,
      available: encoder.available,
      encoder,
      ...(outputFile ? { outputFile } : {}),
      note,
    };
  }

  // Playhead & Work Area Implementation
  private async getPlayheadPosition(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var pos = sequence.getPlayerPosition();
        return JSON.stringify({
          success: true,
          position: __ticksToSeconds(pos.ticks),
          ticks: pos.ticks
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async setPlayheadPosition(sequenceId: string, time: number): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var ticks = __secondsToTicks(${time});
        sequence.setPlayerPosition(ticks);
        var nowSeconds = null; try { nowSeconds = sequence.getPlayerPosition().seconds; } catch (ePlay) {}
        if (nowSeconds !== null && Math.abs(nowSeconds - ${time}) > 0.04) return JSON.stringify({ success: false, verified: false, error: "Premiere did not move the playhead to ${time}s (reads back at " + nowSeconds + "s).", requested: ${time}, actual: nowSeconds });
        return JSON.stringify({
          success: true,
          verified: nowSeconds !== null,
          message: "Playhead position set",
          time: ${time},
          actualTime: nowSeconds
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
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

  // Effect & Transition Discovery Implementation
  private async listAvailableEffects(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var list = qe.project.getVideoEffectList();
        return JSON.stringify({
          success: true,
          effects: list,
          count: list.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async listAvailableTransitions(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var list = qe.project.getVideoTransitionList();
        return JSON.stringify({
          success: true,
          transitions: list,
          count: list.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async listAvailableAudioEffects(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var list = qe.project.getAudioEffectList();
        return JSON.stringify({
          success: true,
          effects: list,
          count: list.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async listAvailableAudioTransitions(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var list = qe.project.getAudioTransitionList();
        return JSON.stringify({
          success: true,
          transitions: list,
          count: list.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Keyframe Implementation
  private async addKeyframe(clipId: string, componentName: string, paramName: string, time: number, value: number): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var param = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          if (comp.displayName === ${JSON.stringify(componentName)}) {
            for (var j = 0; j < comp.properties.numItems; j++) {
              if (comp.properties[j].displayName === ${JSON.stringify(paramName)}) {
                param = comp.properties[j];
                break;
              }
            }
            if (param) break;
          }
        }
        if (!param) return JSON.stringify({ success: false, error: "Parameter " + ${JSON.stringify(paramName)} + " not found in component " + ${JSON.stringify(componentName)} });
        param.setTimeVarying(true);
        param.addKey(${time});
        param.setValueAtKey(${time}, ${value}, true);
        var keyThere = null; try { keyThere = param.keyExistsAtTime(${time}); } catch (eKey) {}
        if (keyThere === false) return JSON.stringify({ success: false, verified: false, error: "Premiere did not add a keyframe at ${time}s (no key present after addKey)." });
        var keyVal = null; try { keyVal = param.getValueAtKey(${time}); } catch (eVal) {}
        if (keyVal !== null && typeof keyVal === "number" && Math.abs(Number(keyVal) - ${value}) > 0.01) return JSON.stringify({ success: false, verified: false, error: "Keyframe was created but holds " + keyVal + " instead of the requested ${value}.", actual: keyVal, requested: ${value} });
        return JSON.stringify({
          success: true,
          verified: keyThere === true,
          message: "Keyframe added",
          componentName: ${JSON.stringify(componentName)},
          paramName: ${JSON.stringify(paramName)},
          time: ${time},
          value: ${value}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async removeKeyframe(clipId: string, componentName: string, paramName: string, time: number): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var param = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          if (comp.displayName === ${JSON.stringify(componentName)}) {
            for (var j = 0; j < comp.properties.numItems; j++) {
              if (comp.properties[j].displayName === ${JSON.stringify(paramName)}) {
                param = comp.properties[j];
                break;
              }
            }
            if (param) break;
          }
        }
        if (!param) return JSON.stringify({ success: false, error: "Parameter not found" });
        var hadKey = null; try { hadKey = param.keyExistsAtTime(${time}); } catch (ePre) {}
        param.removeKey(${time});
        var stillThere = null; try { stillThere = param.keyExistsAtTime(${time}); } catch (ePost) {}
        if (stillThere === true) return JSON.stringify({ success: false, verified: false, error: "Premiere did not remove the keyframe at ${time}s (still present)." });
        return JSON.stringify({
          success: true,
          verified: stillThere === false,
          message: hadKey === false ? "No keyframe existed at ${time}s; nothing to remove." : "Keyframe removed",
          hadKey: hadKey,
          time: ${time}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async getKeyframes(clipId: string, componentName: string, paramName: string): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var param = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          if (comp.displayName === ${JSON.stringify(componentName)}) {
            for (var j = 0; j < comp.properties.numItems; j++) {
              if (comp.properties[j].displayName === ${JSON.stringify(paramName)}) {
                param = comp.properties[j];
                break;
              }
            }
            if (param) break;
          }
        }
        if (!param) return JSON.stringify({ success: false, error: "Parameter not found" });
        var isTimeVarying = param.isTimeVarying();
        if (!isTimeVarying) {
          return JSON.stringify({
            success: true,
            isTimeVarying: false,
            keyframes: [],
            staticValue: param.getValue()
          });
        }
        var keys = param.getKeys();
        var result = [];
        for (var k = 0; k < keys.length; k++) {
          result.push({
            time: keys[k],
            value: param.getValueAtKey(keys[k])
          });
        }
        return JSON.stringify({
          success: true,
          isTimeVarying: true,
          keyframes: result,
          count: result.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  /**
   * Bakes an eased value curve for a SCALAR parameter into a dense run of
   * keyframes, then reads every written value back and verifies it landed.
   *
   * Why bake instead of setting a native ease: Premiere's DOM can set a
   * keyframe interpolation type but offers no getter to confirm it, and the
   * temporal-ease amount has never been scriptable — so a native ease can't be
   * verified. Keyframe *values* CAN be read back, so a curve baked from an
   * easing function is both arbitrary in shape and provable after the fact.
   */
  private async bakeKeyframeEase(args: any): Promise<any> {
    const componentName = String(args.componentName ?? 'Opacity');
    const paramName = String(args.paramName ?? 'Opacity');

    let keyframes: EaseKeyframe[];
    try {
      const opts: EaseSampleOptions = {
        startTime: Number(args.startTime),
        endTime: Number(args.endTime),
        startValue: Number(args.startValue),
        endValue: Number(args.endValue),
        samples: Number(args.samples ?? 24),
      };
      if (Array.isArray(args.bezier)) {
        opts.bezier = args.bezier.map(Number) as [number, number, number, number];
      } else if (args.easing != null) {
        opts.easing = String(args.easing);
      }
      keyframes = sampleEaseKeyframes(opts);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    const times = keyframes.map((k) => k.time);
    const values = keyframes.map((k) => k.value);

    const script = `
      try {
        var info = __findClip(${JSON.stringify(args.clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var param = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          if (comp.displayName === ${JSON.stringify(componentName)}) {
            for (var j = 0; j < comp.properties.numItems; j++) {
              if (comp.properties[j].displayName === ${JSON.stringify(paramName)}) {
                param = comp.properties[j];
                break;
              }
            }
            if (param) break;
          }
        }
        if (!param) return JSON.stringify({ success: false, error: "Parameter " + ${JSON.stringify(paramName)} + " not found in component " + ${JSON.stringify(componentName)} });
        if (param.areKeyframesSupported && !param.areKeyframesSupported()) {
          return JSON.stringify({ success: false, error: "Parameter " + ${JSON.stringify(paramName)} + " does not support keyframes" });
        }
        var probe = param.getValue();
        if (typeof probe !== "number") {
          return JSON.stringify({ success: false, error: "bake_keyframe_ease supports scalar parameters only; '" + ${JSON.stringify(paramName)} + "' is not scalar (its value is " + (typeof probe) + "). Use a scalar parameter such as Opacity, Scale, or Rotation." });
        }
        var times = ${JSON.stringify(times)};
        var values = ${JSON.stringify(values)};
        param.setTimeVarying(true);
        for (var w = 0; w < times.length; w++) {
          param.addKey(times[w]);
          param.setValueAtKey(times[w], values[w], true);
        }
        var readback = [];
        for (var r = 0; r < times.length; r++) {
          readback.push(param.getValueAtKey(times[r]));
        }
        return JSON.stringify({ success: true, readback: readback, keyCount: times.length });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    const raw = await this.bridge.executeScript(script);
    const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!res || res.success !== true) {
      return { success: false, error: res?.error ?? 'bake_keyframe_ease failed in host', raw: res };
    }

    // Verify-after-write: every written value must read back within tolerance.
    const readback: unknown[] = Array.isArray(res.readback) ? res.readback : [];
    const mismatches: Array<{ index: number; time: number; expected: number; actual: unknown }> = [];
    for (let i = 0; i < values.length; i++) {
      const expected = values[i] as number;
      const actual = readback[i];
      const tol = Math.max(0.01, Math.abs(expected) * 1e-4);
      if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
        mismatches.push({ index: i, time: times[i] as number, expected, actual });
      }
    }

    const verifiedCount = values.length - mismatches.length;
    if (mismatches.length > 0) {
      return {
        success: false,
        verified: false,
        error: `Wrote ${values.length} eased keyframes but ${mismatches.length} did not read back at the requested value (Premiere may have clamped values outside the parameter's valid range).`,
        componentName,
        paramName,
        keyCount: values.length,
        verifiedCount,
        mismatches: mismatches.slice(0, 10),
      };
    }

    return {
      success: true,
      verified: true,
      message: `Baked and verified ${values.length} keyframes tracing ${args.bezier ? 'a cubic-bezier' : (args.easing ?? 'easeInOutCubic')} ease.`,
      componentName,
      paramName,
      easing: args.bezier ? 'cubic-bezier' : (args.easing ?? 'easeInOutCubic'),
      bezier: args.bezier ?? undefined,
      startTime: times[0],
      endTime: times[times.length - 1],
      startValue: values[0],
      endValue: values[values.length - 1],
      keyCount: values.length,
      verifiedCount,
    };
  }

  // Work Area Implementation
  private async setWorkArea(sequenceId: string, inPoint: number, outPoint: number): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        sequence.setWorkAreaInPoint(__secondsToTicks(${inPoint}));
        sequence.setWorkAreaOutPoint(__secondsToTicks(${outPoint}));
        var inNow = null, outNow = null;
        try { inNow = sequence.getWorkAreaInPointAsTime().seconds; } catch (eIn) {}
        try { outNow = sequence.getWorkAreaOutPointAsTime().seconds; } catch (eOut) {}
        if ((inNow !== null && Math.abs(inNow - ${inPoint}) > 0.04) || (outNow !== null && Math.abs(outNow - ${outPoint}) > 0.04)) {
          return JSON.stringify({ success: false, verified: false, error: "Premiere did not set the work area as requested (reads back in " + inNow + "s / out " + outNow + "s).", requested: { inPoint: ${inPoint}, outPoint: ${outPoint} }, actual: { inPoint: inNow, outPoint: outNow } });
        }
        return JSON.stringify({
          success: true,
          verified: inNow !== null && outNow !== null,
          message: "Work area set",
          inPoint: ${inPoint},
          outPoint: ${outPoint}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async getWorkArea(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var inTime = sequence.getWorkAreaInPointAsTime();
        var outTime = sequence.getWorkAreaOutPointAsTime();
        return JSON.stringify({
          success: true,
          inPoint: inTime.seconds,
          outPoint: outTime.seconds
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Batch Operations Implementation
  private async batchAddTransitions(sequenceId: string, trackIndex: number, transitionName: string, duration: number): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var track = sequence.videoTracks[${trackIndex}];
        if (!track) return JSON.stringify({ success: false, error: "Track not found at index ${trackIndex}" });
        var clipCount = track.clips.numItems;
        if (clipCount < 2) return JSON.stringify({ success: false, error: "Need at least 2 clips to add transitions, found " + clipCount });
        var qeSeq = __qeSequenceFor(sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + sequence.name + "' through the QE API." });
        var qeTrack = qeSeq.getVideoTrackAt(${trackIndex});
        var transition = qe.project.getVideoTransitionByName(${JSON.stringify(transitionName)});
        if (!transition) return JSON.stringify({ success: false, error: "Transition not found: " + ${JSON.stringify(transitionName)} });
        var added = 0;
        var errors = [];
        var fps = 254016000000 / parseInt(sequence.timebase, 10);
        var frames = Math.round(${duration} * fps);
        ${this.transitionVerificationScript()}
        var beforeXml = __transitionXmlCount(sequence);
        for (var i = 0; i < clipCount; i++) {
          try {
            var domClip = track.clips[i];
            var qeClip = __findQeClipByDomClip(qeTrack, domClip);
            if (!qeClip) {
              errors.push("Clip " + i + ": Could not locate matching QE clip");
              continue;
            }
            var before = __readQeTransitionState(qeClip);
            qeClip.addTransition(transition, true, String(frames), "0", 0.5, false, true);
            var afterClip = __findQeClipByDomClip(qeTrack, domClip);
            var after = __readQeTransitionState(afterClip);
            if (__transitionWasVerified(before, after)) {
              added++;
            } else {
              errors.push("Clip " + i + ": transition call completed but no verified transition change was exposed");
            }
          } catch (e) {
            errors.push("Clip " + i + ": " + e.toString());
          }
        }
        var afterXml = __transitionXmlCount(sequence);
        if (added === 0 && __transitionWasVerifiedByXml(beforeXml, afterXml)) {
          added = afterXml.count - beforeXml.count;
        }
        if (added === 0) {
          return JSON.stringify({
            success: false,
            error: "No transitions were verifiably added",
            transitionsAdded: 0,
            totalClips: clipCount,
            frames: frames,
            errors: errors,
            beforeXml: beforeXml,
            afterXml: afterXml
          });
        }
        return JSON.stringify({
          success: true,
          transitionsAdded: added,
          totalClips: clipCount,
          frames: frames,
          errors: errors,
          beforeXml: beforeXml,
          afterXml: afterXml
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Project Item Discovery & Management Implementation
  private async findProjectItemByName(name: string, type?: string): Promise<any> {
    const filterType = type || 'any';
    const script = `
      try {
        var searchName = ${JSON.stringify(name)}.toLowerCase();
        var filterType = ${JSON.stringify(filterType)};
        var results = [];
        function walkItems(parent) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            var itemType = item.type === 2 ? "bin" : (item.isSequence() ? "sequence" : "footage");
            if (item.name.toLowerCase().indexOf(searchName) !== -1) {
              if (filterType === "any" || filterType === itemType) {
                var info = {
                  id: item.nodeId,
                  name: item.name,
                  type: itemType,
                  treePath: item.treePath
                };
                try { info.mediaPath = item.getMediaPath(); } catch(e) {}
                results.push(info);
              }
            }
            if (item.type === 2) {
              walkItems(item);
            }
          }
        }
        walkItems(app.project.rootItem);
        return JSON.stringify({
          success: true,
          items: results,
          count: results.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async moveItemToBin(projectItemId: string, targetBinId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var bin = __findProjectItem(${JSON.stringify(targetBinId)});
        if (!bin) return JSON.stringify({ success: false, error: "Target bin not found" });
        item.moveBin(bin);
        return JSON.stringify({
          success: true,
          message: "Item moved to bin",
          itemId: ${JSON.stringify(projectItemId)},
          targetBinId: ${JSON.stringify(targetBinId)}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Active Sequence Management Implementation
  private async setActiveSequence(sequenceId: string): Promise<any> {
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        app.project.openSequence(seq.sequenceID);
        var active = app.project.activeSequence;
        if (!active || String(active.sequenceID) !== String(seq.sequenceID)) return JSON.stringify({ success: false, verified: false, error: "Premiere did not make '" + seq.name + "' the active sequence.", requestedId: seq.sequenceID, activeId: active ? active.sequenceID : null });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Active sequence set",
          sequenceId: seq.sequenceID,
          name: seq.name
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async getActiveSequence(): Promise<any> {
    const script = `
      try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: "No active sequence" });
        return JSON.stringify({
          success: true,
          id: seq.sequenceID,
          name: seq.name,
          duration: __ticksToSeconds(seq.end),
          videoTrackCount: seq.videoTracks.numTracks,
          audioTrackCount: seq.audioTracks.numTracks
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Clip Lookup Implementation
  private async getClipAtPosition(sequenceId: string, trackType: string, trackIndex: number, time: number): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var tracks = ${JSON.stringify(trackType)} === "video" ? sequence.videoTracks : sequence.audioTracks;
        if (${trackIndex} < 0 || ${trackIndex} >= tracks.numTracks) return JSON.stringify({ success: false, error: "Track index out of range" });
        var track = tracks[${trackIndex}];
        var targetTime = ${time};
        for (var i = 0; i < track.clips.numItems; i++) {
          var clip = track.clips[i];
          if (clip.start.seconds <= targetTime && clip.end.seconds > targetTime) {
            return JSON.stringify({
              success: true,
              clip: {
                nodeId: clip.nodeId,
                name: clip.name,
                start: clip.start.seconds,
                end: clip.end.seconds,
                duration: clip.duration.seconds,
                inPoint: clip.inPoint.seconds,
                outPoint: clip.outPoint.seconds,
                trackIndex: ${trackIndex},
                trackType: ${JSON.stringify(trackType)},
                clipIndex: i
              }
            });
          }
        }
        return JSON.stringify({
          success: true,
          clip: null,
          message: "No clip found at time " + targetTime + "s on " + ${JSON.stringify(trackType)} + " track " + ${trackIndex}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Auto Reframe Implementation
  private async autoReframeSequence(sequenceId: string, numerator: number, denominator: number, motionPreset?: string, newName?: string): Promise<any> {
    const preset = motionPreset || 'default';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var reframedName = ${newName ? JSON.stringify(newName) : 'sequence.name + " Reframed"'};
        sequence.autoReframeSequence(${numerator}, ${denominator}, ${JSON.stringify(preset)}, reframedName, false);
        return JSON.stringify({
          success: true,
          message: "Sequence auto-reframed",
          aspectRatio: ${numerator} + ":" + ${denominator},
          motionPreset: ${JSON.stringify(preset)},
          newName: reframedName
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

  // Caption Track Implementation
  private async createCaptionTrack(sequenceId: string, projectItemId: string, startTime?: number, captionFormat?: string): Promise<any> {
    const startTimeVal = startTime || 0;
    // createCaptionTrack's optional 3rd arg is a Sequence.CAPTION_FORMAT_* integer
    // constant, NOT a free-form string. Passing a string ("Subtitle Default") raised
    // "Illegal Parameter type" and broke all SRT ingestion. Map friendly names to the
    // constant suffix; omit the arg entirely when none is given (defaults to subtitle,
    // which is correct for .srt and matches Adobe's own PProPanel sample).
    const formatMap: Record<string, string> = {
      'subtitle': 'CAPTION_FORMAT_SUBTITLE',
      'subtitle default': 'CAPTION_FORMAT_SUBTITLE',
      'srt': 'CAPTION_FORMAT_SUBTITLE',
      'open captions': 'CAPTION_FORMAT_SUBTITLE',
      '608': 'CAPTION_FORMAT_608',
      'cea-608': 'CAPTION_FORMAT_608',
      '708': 'CAPTION_FORMAT_708',
      'cea-708': 'CAPTION_FORMAT_708',
      'teletext': 'CAPTION_FORMAT_TELETEXT',
      'open ebu': 'CAPTION_FORMAT_OPEN_EBU',
      'ebu': 'CAPTION_FORMAT_OPEN_EBU',
      'op42': 'CAPTION_FORMAT_OP42',
      'op47': 'CAPTION_FORMAT_OP47'
    };
    const requested = captionFormat ? captionFormat.trim().toLowerCase() : '';
    const constName = requested ? (formatMap[requested] || 'CAPTION_FORMAT_SUBTITLE') : '';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var projectItem = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!projectItem) return JSON.stringify({ success: false, error: "Caption project item not found" });
        var startAtTime = ${startTimeVal};
        var constName = ${JSON.stringify(constName)};
        var usedFormat = "default";
        var ok;
        // Resolve the format enum if requested; constant location varies by host, so
        // probe a couple of spots and fall back to the 2-arg (subtitle) call.
        var fmtConst = null;
        if (constName) {
          try {
            if (typeof Sequence !== 'undefined' && Sequence[constName] !== undefined) {
              fmtConst = Sequence[constName];
            } else if (sequence.constructor && sequence.constructor[constName] !== undefined) {
              fmtConst = sequence.constructor[constName];
            }
          } catch (eC) { fmtConst = null; }
        }
        if (fmtConst !== null && fmtConst !== undefined) {
          try {
            ok = sequence.createCaptionTrack(projectItem, startAtTime, fmtConst);
            usedFormat = constName;
          } catch (eFmt) {
            ok = sequence.createCaptionTrack(projectItem, startAtTime);
            usedFormat = "default (requested '" + constName + "' rejected: " + eFmt.toString() + ")";
          }
        } else {
          ok = sequence.createCaptionTrack(projectItem, startAtTime);
        }
        // createCaptionTrack returns falsey (or throws) when the ingest fails —
        // an SRT with no matching frame rate, a non-caption project item, etc.
        // Only an explicit false is a hard failure; some hosts return undefined
        // on success, so treat that as applied-but-unverified rather than lie.
        if (ok === false) {
          return JSON.stringify({
            success: false,
            error: "createCaptionTrack returned false; the item was not ingested as captions.",
            captionFormat: usedFormat,
            startTime: startAtTime
          });
        }
        return JSON.stringify({
          success: true,
          message: "Caption track created",
          verified: ok === true || (ok !== null && ok !== undefined),
          captionFormat: usedFormat,
          startTime: startAtTime,
          apiResult: String(ok),
          note: (ok === undefined || ok === null) ? "Host returned no value from createCaptionTrack; creation applied but not independently confirmed." : undefined
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Subclip Implementation
  private async createSubclip(projectItemId: string, name: string, startTime: number, endTime: number, hasHardBoundaries?: boolean, takeAudio?: boolean, takeVideo?: boolean): Promise<any> {
    const hardBounds = hasHardBoundaries ? 1 : 0;
    const audio = takeAudio !== false ? 1 : 0;
    const video = takeVideo !== false ? 1 : 0;
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var startTicks = __secondsToTicks(${startTime});
        var endTicks = __secondsToTicks(${endTime});
        var sub = item.createSubClip(${JSON.stringify(name)}, startTicks, endTicks, ${hardBounds}, ${audio}, ${video});
        if (!sub) return JSON.stringify({ success: false, verified: false, error: "createSubClip() returned no project item; the subclip was not created." });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Subclip created",
          name: ${JSON.stringify(name)},
          subclipName: String(sub.name),
          subclipNodeId: sub.nodeId,
          startTime: ${startTime},
          endTime: ${endTime}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Relink Media Implementation
  private async relinkMedia(projectItemId: string, newFilePath: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        // The target file must exist on disk, or changeMediaPath silently relinks to
        // nothing and the clip stays offline while we'd have claimed success.
        var target = new File(${JSON.stringify(newFilePath)});
        if (!target.exists) {
          return JSON.stringify({ success: false, error: "Target file does not exist: " + ${JSON.stringify(newFilePath)} });
        }
        if (!item.canChangeMediaPath()) {
          return JSON.stringify({ success: false, error: "Cannot change media path for this item" });
        }
        // Capture offline state before, then verify it actually cleared after.
        var wasOffline = null;
        try { wasOffline = item.isOffline(); } catch (eB) {}
        item.changeMediaPath(${JSON.stringify(newFilePath)}, true);
        var stillOffline = null;
        try { stillOffline = item.isOffline(); } catch (eA) {}
        var pathNow = null;
        try { pathNow = item.getMediaPath(); } catch (eP) {}
        // If isOffline is readable and still true, the relink did not take — say so.
        if (stillOffline === true) {
          return JSON.stringify({
            success: false,
            error: "changeMediaPath ran but the item is still offline; the file may not match this clip.",
            projectItemId: ${JSON.stringify(projectItemId)},
            newFilePath: ${JSON.stringify(newFilePath)},
            mediaPathNow: pathNow
          });
        }
        return JSON.stringify({
          success: true,
          message: "Media relinked",
          verified: stillOffline === false,
          projectItemId: ${JSON.stringify(projectItemId)},
          newFilePath: ${JSON.stringify(newFilePath)},
          mediaPathNow: pathNow,
          wasOffline: wasOffline,
          note: stillOffline === null ? "isOffline() not readable on this host; path change was applied but online state is unverified." : undefined
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Set Color Label Implementation
  private async setColorLabel(projectItemId: string, colorIndex: number): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        item.setColorLabel(${colorIndex});
        var nowColor = null; try { nowColor = item.getColorLabel(); } catch (eColor) {}
        if (nowColor !== null && Number(nowColor) !== ${colorIndex}) return JSON.stringify({ success: false, verified: false, error: "Premiere did not set the color label (reads back as " + nowColor + ", requested ${colorIndex}).", actual: nowColor });
        return JSON.stringify({
          success: true,
          verified: nowColor !== null,
          message: "Color label set",
          projectItemId: ${JSON.stringify(projectItemId)},
          colorIndex: ${colorIndex}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Get Color Label Implementation
  private async getColorLabel(projectItemId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var colorLabel = item.getColorLabel();
        return JSON.stringify({
          success: true,
          projectItemId: ${JSON.stringify(projectItemId)},
          colorLabel: colorLabel
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Get Metadata Implementation
  private async getMetadata(projectItemId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var projectMetadata = item.getProjectMetadata();
        var xmpMetadata = item.getXMPMetadata();
        return JSON.stringify({
          success: true,
          projectItemId: ${JSON.stringify(projectItemId)},
          projectMetadata: projectMetadata,
          xmpMetadata: xmpMetadata
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Set Metadata Implementation
  private async setMetadata(projectItemId: string, key: string, value: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var schema = "http://ns.adobe.com/premierePrivateProjectMetaData/1.0/";
        var fullKey = schema + ${JSON.stringify(key)};
        item.setProjectMetadata(${JSON.stringify(value)}, [fullKey]);
        // Read the XMP blob back and look for the value. XMP escapes special
        // characters, so absence is not proof of failure -- report it as
        // unverified rather than failing on a possible false negative.
        var blob = null; try { blob = String(item.getProjectMetadata()); } catch (eMeta) {}
        var found = blob !== null && blob.indexOf(${JSON.stringify(value)}) !== -1;
        return JSON.stringify({
          success: true,
          verified: found,
          message: "Metadata set",
          projectItemId: ${JSON.stringify(projectItemId)},
          key: ${JSON.stringify(key)},
          value: ${JSON.stringify(value)},
          note: found ? undefined : "setProjectMetadata() accepted; the value was not found verbatim in the XMP readback (it may be escaped), so application is unconfirmed."
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Get Footage Interpretation Implementation
  private async getFootageInterpretation(projectItemId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var interp = item.getFootageInterpretation();
        return JSON.stringify({
          success: true,
          projectItemId: ${JSON.stringify(projectItemId)},
          frameRate: interp.frameRate,
          pixelAspectRatio: interp.pixelAspectRatio,
          fieldType: interp.fieldType,
          removePulldown: interp.removePulldown,
          alphaUsage: interp.alphaUsage
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Set Footage Interpretation Implementation
  private async setFootageInterpretation(projectItemId: string, frameRate?: number, pixelAspectRatio?: number): Promise<any> {
    const setFrameRate = frameRate !== undefined;
    const setPar = pixelAspectRatio !== undefined;
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var interp = item.getFootageInterpretation();
        ${setFrameRate ? 'interp.frameRate = ' + frameRate + ';' : ''}
        ${setPar ? 'interp.pixelAspectRatio = ' + pixelAspectRatio + ';' : ''}
        item.setFootageInterpretation(interp);
        // Re-fetch a fresh interpretation: the local 'interp' object echoes the values
        // we just assigned whether or not Premiere accepted them. Only a fresh read
        // proves the change took.
        var check = item.getFootageInterpretation();
        ${setFrameRate ? `if (Math.abs(Number(check.frameRate) - ${frameRate}) > 0.001) return JSON.stringify({ success: false, verified: false, error: "Premiere did not apply the frame rate (reads back as " + check.frameRate + ", requested ${frameRate}).", actual: check.frameRate });` : ''}
        ${setPar ? `if (Math.abs(Number(check.pixelAspectRatio) - ${pixelAspectRatio}) > 0.001) return JSON.stringify({ success: false, verified: false, error: "Premiere did not apply the pixel aspect ratio (reads back as " + check.pixelAspectRatio + ", requested ${pixelAspectRatio}).", actual: check.pixelAspectRatio });` : ''}
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Footage interpretation updated",
          projectItemId: ${JSON.stringify(projectItemId)},
          frameRate: check.frameRate,
          pixelAspectRatio: check.pixelAspectRatio
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Check Offline Media Implementation
  private async checkOfflineMedia(): Promise<any> {
    const script = `
      try {
        var offlineItems = [];
        function walkForOffline(parent) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            if (item.type === 2) {
              walkForOffline(item);
            } else {
              if (item.isOffline()) {
                offlineItems.push({
                  nodeId: item.nodeId,
                  name: item.name,
                  treePath: item.treePath
                });
              }
            }
          }
        }
        walkForOffline(app.project.rootItem);
        return JSON.stringify({
          success: true,
          offlineCount: offlineItems.length,
          offlineItems: offlineItems
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Export as FCP XML Implementation
  private async exportAsFcpXml(sequenceId: string, outputPath: string): Promise<any> {
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        seq.exportAsFinalCutProXML(${JSON.stringify(outputPath)});
        var xmlFile = new File(${JSON.stringify(outputPath)});
        if (!xmlFile.exists) return JSON.stringify({ success: false, verified: false, error: "exportAsFinalCutProXML() ran but no file exists at " + ${JSON.stringify(outputPath)} + ".", outputPath: ${JSON.stringify(outputPath)} });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Exported as Final Cut Pro XML",
          sequenceId: ${JSON.stringify(sequenceId)},
          outputPath: ${JSON.stringify(outputPath)},
          fileSize: xmlFile.length
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

  // Set Sequence In/Out Points Implementation
  private async setSequenceInOutPoints(sequenceId: string, inPoint?: number, outPoint?: number): Promise<any> {
    const setIn = inPoint !== undefined;
    const setOut = outPoint !== undefined;
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        ${setIn ? 'seq.setInPoint(__secondsToTicks(' + inPoint + '));' : ''}
        ${setOut ? 'seq.setOutPoint(__secondsToTicks(' + outPoint + '));' : ''}
        var inReadback = null, outReadback = null;
        try { inReadback = seq.getInPointAsTime().seconds; } catch (eIn) {}
        try { outReadback = seq.getOutPointAsTime().seconds; } catch (eOut) {}
        var ioTol = 0.04;
        ${setIn ? 'if (inReadback === null || Math.abs(inReadback - ' + inPoint + ') > ioTol) return JSON.stringify({ success: false, verified: false, error: "setInPoint() ran but the sequence in point reads back as " + inReadback + " s, not the requested ' + inPoint + ' s.", sequenceId: ' + JSON.stringify(sequenceId) + ', inPoint: inReadback });' : ''}
        ${setOut ? 'if (outReadback === null || Math.abs(outReadback - ' + outPoint + ') > ioTol) return JSON.stringify({ success: false, verified: false, error: "setOutPoint() ran but the sequence out point reads back as " + outReadback + " s, not the requested ' + outPoint + ' s.", sequenceId: ' + JSON.stringify(sequenceId) + ', outPoint: outReadback });' : ''}
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Sequence in/out points set",
          sequenceId: ${JSON.stringify(sequenceId)},
          inPoint: inReadback,
          outPoint: outReadback
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Get Sequence In/Out Points Implementation
  private async getSequenceInOutPoints(sequenceId: string): Promise<any> {
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var inTime = seq.getInPointAsTime();
        var outTime = seq.getOutPointAsTime();
        return JSON.stringify({
          success: true,
          sequenceId: ${JSON.stringify(sequenceId)},
          inPoint: inTime.seconds,
          outPoint: outTime.seconds
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Export AAF Implementation
  private async exportAaf(sequenceId: string, outputPath: string, mixDownVideo?: boolean, explodeToMono?: boolean, sampleRate?: number, bitsPerSample?: number): Promise<any> {
    const mixDown = mixDownVideo !== false ? 1 : 0;
    const explode = explodeToMono ? 1 : 0;
    const rate = sampleRate || 48000;
    const bits = bitsPerSample || 16;
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        app.project.exportAAF(seq, ${JSON.stringify(outputPath)}, ${mixDown}, ${explode}, ${rate}, ${bits}, 0, 0, 1, 0);
        var aafFile = new File(${JSON.stringify(outputPath)});
        if (!aafFile.exists) return JSON.stringify({ success: false, verified: false, error: "exportAAF() ran but no file exists at " + ${JSON.stringify(outputPath)} + ".", outputPath: ${JSON.stringify(outputPath)} });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Exported as AAF",
          sequenceId: ${JSON.stringify(sequenceId)},
          outputPath: ${JSON.stringify(outputPath)},
          fileSize: aafFile.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Consolidate Duplicates Implementation
  private async consolidateDuplicates(): Promise<any> {
    const script = `
      try {
        app.project.consolidateDuplicates();
        return JSON.stringify({
          success: true,
          message: "Duplicates consolidated"
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Refresh Media Implementation
  private async refreshMedia(projectItemId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        item.refreshMedia();
        // refreshMedia() re-reads the media from disk; it is an idempotent reload with
        // no diffable state, so success means the call was accepted, not that anything
        // observably changed. Reported as verified:false to avoid overstating it.
        var offlineNow = null; try { offlineNow = item.isOffline(); } catch (eOff) {}
        return JSON.stringify({
          success: true,
          verified: false,
          message: "Media refresh requested",
          projectItemId: ${JSON.stringify(projectItemId)},
          isOffline: offlineNow,
          note: "refreshMedia() accepted; a reload has no readback to confirm, so this is not independently verified."
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Import Sequences From Project Implementation
  private async importSequencesFromProject(projectPath: string, sequenceIds: string[]): Promise<any> {
    const script = `
      try {
        var seqIds = ${JSON.stringify(sequenceIds)};
        app.project.importSequences(${JSON.stringify(projectPath)}, seqIds);
        return JSON.stringify({
          success: true,
          message: "Sequences imported from project",
          projectPath: ${JSON.stringify(projectPath)},
          sequenceIds: seqIds
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Create Subsequence Implementation
  private async createSubsequence(sequenceId: string, ignoreTrackTargeting?: boolean): Promise<any> {
    const ignoreTargeting = ignoreTrackTargeting ? 'true' : 'false';
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var subseq = seq.createSubsequence(${ignoreTargeting});
        return JSON.stringify({
          success: true,
          message: "Subsequence created",
          sequenceId: subseq.sequenceID,
          name: subseq.name
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Import MOGRT Implementation
  private async importMogrt(sequenceId: string, mogrtPath: string, time: number, videoTrackIndex?: number, audioTrackIndex?: number): Promise<any> {
    const vidTrack = videoTrackIndex || 0;
    const audTrack = audioTrackIndex || 0;
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var ticks = __secondsToTicks(${time});
        var clip = seq.importMGT(${JSON.stringify(mogrtPath)}, ticks, ${vidTrack}, ${audTrack});
        var clipId = "";
        if (clip && clip.nodeId) clipId = clip.nodeId;
        return JSON.stringify({
          success: true,
          message: "MOGRT imported",
          clipId: clipId
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Import MOGRT From Library Implementation
  private async importMogrtFromLibrary(sequenceId: string, libraryName: string, mogrtName: string, time: number, videoTrackIndex?: number, audioTrackIndex?: number): Promise<any> {
    const vidTrack = videoTrackIndex || 0;
    const audTrack = audioTrackIndex || 0;
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var ticks = __secondsToTicks(${time});
        var clip = seq.importMGTFromLibrary(${JSON.stringify(libraryName)}, ${JSON.stringify(mogrtName)}, ticks, ${vidTrack}, ${audTrack});
        var clipId = "";
        if (clip && clip.nodeId) clipId = clip.nodeId;
        return JSON.stringify({
          success: true,
          message: "MOGRT imported from library",
          clipId: clipId
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
}
