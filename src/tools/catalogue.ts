import { z } from 'zod';
import type { MCPTool } from './tool-types.js';
import { EASING_NAMES, MAX_EASE_SAMPLES } from './easing.js';
import { PRPROJ_SUPPORTED_FORMAT_VERSIONS, SURGERY_ENV_FLAG } from './prproj-surgery.js';
import { TRANSACTION_TOOL_NAME, transactSequenceEditsSchema } from './transactions.js';
import {
  motionStyleSchema,
  clipPlanSchema,
  MarkerColorSchema,
  MARKER_COLOR_DESCRIPTION,
} from './catalogue-schemas.js';

/**
 * The locally-declared half of the tool catalogue: every tool this file registers,
 * in registration order. Pure data -- it reads no state and calls nothing on the
 * server, which is why it can live outside the class. Order is load-bearing: the
 * catalogue count and the docs-drift tests both key off it.
 *
 * Extracted from PremiereProTools.buildLocalTools() verbatim. Entries were moved,
 * not rewritten; the section comments are the originals.
 */
export function buildToolCatalogue(): MCPTool[] {
  return [
    // Discovery Tools (NEW)
    {
      name: 'list_project_items',
      description:
        'Lists the media items, sequences and bins in the project, a page at a time (200 by default) so a big show project does not flood the reply. Filter by name, type or bin; nextOffset gets the next page.',
      inputSchema: z.object({
        includeBins: z
          .boolean()
          .optional()
          .describe('Whether to include bin information in the results'),
        includeMetadata: z
          .boolean()
          .optional()
          .describe('Whether to include detailed metadata for each item'),
        limit: z.number().optional().describe('Items per page (default 200, max 2000)'),
        offset: z
          .number()
          .optional()
          .describe('Start of the page; use nextOffset from the previous reply'),
        nameContains: z
          .string()
          .optional()
          .describe('Only items whose name contains this (case-insensitive)'),
        type: z.enum(['footage', 'sequence']).optional().describe('Only footage or only sequences'),
        binPath: z.string().optional().describe('Only items inside this bin, e.g. "Renders/SH010"'),
      }),
    },
    {
      name: 'list_sequences',
      description:
        'Lists all sequences in the current Premiere Pro project with their IDs, names, and basic properties.',
      inputSchema: z.object({}),
    },
    {
      name: 'list_sequence_tracks',
      description:
        'Lists all video and audio tracks in a specific sequence with their properties and clips.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The sequence ID (GUID) to list tracks for, as returned in the "id" field by list_sequences or get_active_sequence. Defaults to the active sequence.',
          ),
      }),
    },
    {
      name: 'get_project_info',
      description:
        'Gets comprehensive information about the current project including name, path, settings, and status.',
      inputSchema: z.object({}),
    },
    {
      name: 'verify_premiere_connection',
      description:
        'Read-only readiness check for the live CEP bridge and Premiere Pro host. Run this before an editing workflow to confirm the bridge responds and report the Premiere version, project, and active sequence without changing the project.',
      inputSchema: z.object({}),
    },
    {
      name: 'get_capabilities',
      description:
        'Reports the local MCP runtime, installed bridge status, tool/resource/prompt catalog sizes, and supported versus experimental integration surfaces. Set checkConnection to true to run the read-only live Premiere connection check; otherwise no Premiere request is made. Set probeLocalTools to true to live-test the local backends this build relies on for capabilities Premiere cannot provide -- ffmpeg, ffprobe, the Whisper speech-to-text CLI, and the render-truth capture taps -- so you know which tools will actually work on THIS machine before calling them.',
      inputSchema: z.object({
        checkConnection: z
          .boolean()
          .optional()
          .describe(
            'When true, run verify_premiere_connection and include its live result. Defaults to false so capability discovery is fast and non-invasive.',
          ),
        probeLocalTools: z
          .boolean()
          .optional()
          .describe(
            'When true, spawn-probe the local ffmpeg/ffprobe/Whisper backends and the capture taps, reporting availability, the env override, what each unlocks, and install guidance when absent. Defaults to false.',
          ),
      }),
    },
    {
      name: 'validate_project_for_export',
      description:
        'Runs a non-destructive export readiness audit for the active or requested sequence. Checks timeline content, offline media, missing export preset/output folder inputs, gaps, markers, and basic audio/video track state before an agent queues an export.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('Optional sequence ID to validate. Defaults to the active sequence.'),
        outputPath: z
          .string()
          .optional()
          .describe(
            'Optional intended export output path. When provided, the parent folder is checked.',
          ),
        presetPath: z
          .string()
          .optional()
          .describe(
            'Optional Adobe Media Encoder .epr preset path. When provided, the file is checked.',
          ),
        requireNonEmptyTimeline: z
          .boolean()
          .optional()
          .describe('When true, an empty timeline is an error. Defaults to true.'),
        checkGaps: z
          .boolean()
          .optional()
          .describe('When true, timeline gaps are reported as warnings. Defaults to true.'),
      }),
    },
    {
      name: 'get_encoder_presets',
      description:
        'Discovers readable user Adobe Media Encoder .epr presets from local AME preset folders. Factory preset enumeration is not claimed complete.',
      inputSchema: z.object({
        directories: z
          .array(z.string())
          .optional()
          .describe(
            'Optional absolute directories to scan instead of the default user AME preset folders. Intended for tests and advanced setups.',
          ),
      }),
    },
    {
      name: 'build_motion_graphics_demo',
      description:
        'Generates clean demo stills, creates a sequence, lays the shots out on the timeline, adds dissolves, and applies subtle scale animation for a polished minimalist ad-style demo.',
      inputSchema: z.object({
        sequenceName: z
          .string()
          .optional()
          .describe('Optional sequence name. Defaults to "Apple Like Motion Demo".'),
      }),
    },
    {
      name: 'assemble_product_spot',
      description:
        'Builds a production-oriented promo timeline from real media assets. Supports either template defaults or an explicit clipPlan for LLM-directed pacing, transitions, motion, trims, and per-clip effects.',
      inputSchema: z.object({
        sequenceName: z.string().describe('Name for the new sequence'),
        assetPaths: z
          .array(z.string())
          .min(1)
          .describe('Absolute paths to video or image assets in playback order'),
        clipDuration: z
          .number()
          .optional()
          .describe(
            'Default placement duration in seconds for stills and rough spacing for assets. Defaults to 4.0',
          ),
        videoTrackIndex: z.number().optional().describe('Target video track index. Defaults to 0'),
        transitionName: z
          .string()
          .optional()
          .describe(
            'Default transition when clipPlan does not override it. Defaults to "Cross Dissolve" in template mode.',
          ),
        transitionDuration: z
          .number()
          .optional()
          .describe('Transition duration in seconds. Defaults to 0.5'),
        motionStyle: motionStyleSchema
          .optional()
          .describe(
            'Fallback motion style when clipPlan does not override it. Defaults to "alternate" in template mode.',
          ),
        clipPlan: z
          .array(clipPlanSchema)
          .optional()
          .describe(
            'Optional explicit edit plan. When provided, each step can override timing, track, transition, motion, trim, effects, and color.',
          ),
      }),
    },
    {
      name: 'build_brand_spot_from_mogrt_and_assets',
      description:
        'Builds a branded ad assembly from real media assets, supports optional MOGRT overlay, and allows explicit clipPlan control. Default polish is optional so creative direction can come from LLM planning instead of hardcoded passes.',
      inputSchema: z.object({
        sequenceName: z.string().describe('Name for the new sequence'),
        assetPaths: z
          .array(z.string())
          .min(1)
          .describe('Absolute paths to source assets in edit order'),
        mogrtPath: z
          .string()
          .optional()
          .describe('Optional absolute path to a .mogrt title or branding template'),
        clipDuration: z
          .number()
          .optional()
          .describe('Default spacing in seconds for asset placement. Defaults to 4.0'),
        videoTrackIndex: z
          .number()
          .optional()
          .describe('Base video track for the main assets. Defaults to 0'),
        titleTrackIndex: z
          .number()
          .optional()
          .describe('Video track for the optional MOGRT overlay. Defaults to 1'),
        titleStartTime: z
          .number()
          .optional()
          .describe('Timeline start time in seconds for the optional MOGRT. Defaults to 0.4'),
        transitionName: z
          .string()
          .optional()
          .describe(
            'Default transition when clipPlan does not override it. Defaults to "Cross Dissolve" in template mode.',
          ),
        transitionDuration: z
          .number()
          .optional()
          .describe('Transition duration in seconds. Defaults to 0.5'),
        motionStyle: motionStyleSchema
          .optional()
          .describe(
            'Fallback motion style when clipPlan does not override it. Defaults to "alternate" in template mode.',
          ),
        clipPlan: z
          .array(clipPlanSchema)
          .optional()
          .describe(
            'Optional explicit edit plan. Reuses assemble_product_spot clipPlan semantics.',
          ),
        applyDefaultPolish: z
          .boolean()
          .optional()
          .describe(
            'Whether to apply the legacy light polish pass (blur + small color tweak). Defaults to false.',
          ),
      }),
    },

    // Project Management
    {
      name: 'create_project',
      description:
        'Creates a new Adobe Premiere Pro project. Use this when the user wants to start a new video editing project from scratch.',
      inputSchema: z.object({
        name: z.string().describe('The name for the new project, e.g., "My Summer Vacation"'),
        location: z
          .string()
          .describe(
            'The absolute directory path where the project file should be saved, e.g., "/Users/user/Documents/Videos"',
          ),
      }),
    },
    {
      name: 'open_project',
      description: 'Opens an existing Adobe Premiere Pro project from a specified file path.',
      inputSchema: z.object({
        path: z.string().describe('The absolute path to the .prproj file to open'),
      }),
    },
    {
      name: 'save_project',
      description: 'Saves the currently active Adobe Premiere Pro project.',
      inputSchema: z.object({}),
    },
    {
      name: 'save_project_as',
      description: 'Saves the current project with a new name and location.',
      inputSchema: z.object({
        name: z.string().describe('The new name for the project'),
        location: z
          .string()
          .describe('The absolute directory path where the project should be saved'),
      }),
    },
    {
      name: 'close_project',
      description:
        'Closes the current project. Verified: reports whether the project was saved before closing.',
      inputSchema: z.object({
        saveFirst: z
          .boolean()
          .optional()
          .describe('Save the project before closing. Default false.'),
        closeIfLast: z
          .boolean()
          .optional()
          .describe('Close Premiere if this is the last open project. Default false.'),
      }),
    },
    {
      name: 'list_open_projects',
      description:
        'Lists all currently open Premiere Pro projects with their names, paths, and sequence counts. Verified via app.projects collection.',
      inputSchema: z.object({}),
    },
    {
      name: 'list_recent_projects',
      description:
        'Lists recently modified Premiere Pro project files on disk, sorted by modification time. Excludes Auto-Save copies. Uses Spotlight (mdfind) — returns paths, names, and modification dates.',
      inputSchema: z.object({
        limit: z.number().optional().describe('Maximum number of results. Default 10.'),
        excludeAutosave: z
          .boolean()
          .optional()
          .describe('Exclude Adobe Premiere Pro Auto-Save files. Default true.'),
      }),
    },

    // Clipboard
    {
      name: 'read_clipboard',
      description:
        'Reads the current macOS system clipboard as text. Useful for reading timecodes, clip names, or any text the user copied. Verified via Node.js pbpaste.',
      inputSchema: z.object({}),
    },
    {
      name: 'write_clipboard',
      description:
        'Writes text to the macOS system clipboard. Useful for exporting timecodes, marker lists, clip metadata, or any text for pasting elsewhere. Verified via Node.js pbcopy.',
      inputSchema: z.object({
        text: z.string().describe('The text to write to the clipboard'),
      }),
    },

    // Render status and preview rendering
    {
      name: 'get_sequence_render_status',
      description:
        'Returns the render bar status of the active sequence: which time ranges are fully rendered (green), partially rendered (yellow), unrendered (red), or empty (no content). Verified via QE getGreenBarTimes/getRedBarTimes/getYellowBarTimes.',
      inputSchema: z.object({
        sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      }),
    },
    {
      name: 'render_sequence_previews',
      description:
        "Renders preview files for the active sequence's unrendered segments (equivalent to Sequence > Render In to Out). Uses QE renderPreview(). Does not export media — writes to the preview cache only.",
      inputSchema: z.object({
        sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
        renderAll: z
          .boolean()
          .optional()
          .describe(
            'Render all segments including yellow bars. Default false (red/unrendered only).',
          ),
      }),
    },

    // Essential Sound
    {
      name: 'set_essential_sound_category',
      description:
        'Assigns an Essential Sound category to a project item. Categories: "dialog", "music", "sfx", "ambience". Verified: setProjectMetadata writes ESP.Tag and related keys. The panel will reflect the category after the next project refresh.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The nodeId of the project item to categorize'),
        category: z
          .enum(['dialog', 'music', 'sfx', 'ambience'])
          .describe('The Essential Sound category'),
      }),
    },

    // Source monitor upgrade
    {
      name: 'open_project_item_in_source',
      description:
        'Opens a project item in the Source Monitor by passing the DOM ProjectItem directly. More reliable than open_in_source which uses file paths. Optionally cues to a timecode. Verified via app.sourceMonitor.openProjectItem().',
      inputSchema: z.object({
        projectItemId: z
          .string()
          .describe('The nodeId of the project item to open in the Source Monitor'),
        timecode: z
          .string()
          .optional()
          .describe('Optional timecode to cue to after opening (e.g. "00:00:01:00")'),
      }),
    },

    // Navigation & Playback
    {
      name: 'go_to_sequence_start',
      description:
        'Moves the playhead to the start of the active sequence (frame 0). Verified via setPlayerPosition.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'go_to_sequence_end',
      description:
        'Moves the playhead to the last frame of the active sequence. Verified via setPlayerPosition + sequence end time.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'go_to_in_point',
      description: 'Moves the playhead to the sequence in-point.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'go_to_out_point',
      description: 'Moves the playhead to the sequence out-point.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'step_frames',
      description:
        'Moves the playhead by a number of frames (positive = forward, negative = backward). Verified via setPlayerPosition.',
      inputSchema: z.object({
        frames: z.number().describe('Frames to step. Positive = forward, negative = backward.'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_playback_state',
      description:
        'Returns whether the timeline is currently playing, the playback speed, and the current playhead position.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },

    // Trimming & Edit Point Operations
    {
      name: 'ripple_trim_in',
      description:
        'Ripple-trims the head of a clip to the current playhead (Q-key equivalent): removes the material before the playhead, keeps the clip where it starts, and moves everything after it left on every track so sync holds. Linked audio is trimmed with it. Refuses if the playhead is outside the clip or a clip on another track spans the edit. Verified by start/end/in readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based video track index'),
        clipIndex: z.number().describe('0-based clip index on the track'),
      }),
    },
    {
      name: 'ripple_trim_out',
      description:
        'Ripple-trims the tail of a clip to the current playhead (W-key equivalent): removes the material after the playhead and moves everything later left on every track so sync holds. Linked audio is trimmed with it. Verified by start/end/in readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based video track index'),
        clipIndex: z.number().describe('0-based clip index on the track'),
      }),
    },
    {
      name: 'extend_edit',
      description:
        'Moves the nearest edit point of the clip to the current playhead (E-key equivalent). An abutting neighbour is rolled so no gap or overlap opens; linked audio/video moves with it. Refuses when the media has no handle left (extending past the media would play black). Verified by start/end/in readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based video track index'),
        clipIndex: z.number().describe('0-based clip index whose nearest edge to extend'),
      }),
    },
    {
      name: 'nudge_clip',
      description:
        'Nudges a clip and its linked audio/video ±N frames on the timeline (Alt+Left/Right equivalent). Refuses when the destination is occupied. Verified by start readback of every linked item.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based video track index'),
        clipIndex: z.number().describe('0-based clip index'),
        frames: z.number().describe('Frames to nudge. Positive = forward, negative = backward.'),
      }),
    },

    // J-Cut and L-Cut
    {
      name: 'j_cut',
      description:
        'Creates a J-cut: the linked audio of clip N starts the given number of frames before its picture (audio leads video), rolling the audio edit so the previous audio clip gives up the same span. Refuses when the audio has no head handle. Verified by start/end/in readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        videoTrackIndex: z.number().describe('0-based video track index'),
        clipIndex: z.number().describe('0-based index of the clip whose audio should lead'),
        frames: z.number().describe('How many frames earlier the audio should start'),
      }),
    },
    {
      name: 'l_cut',
      description:
        'Creates an L-cut: the linked audio of clip N runs the given number of frames past its picture (audio trails video), rolling the audio edit so the next audio clip gives up the same span. Refuses when the audio has no tail handle. Verified by start/end/in readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        videoTrackIndex: z.number().describe('0-based video track index'),
        clipIndex: z.number().describe('0-based index of the clip whose audio should trail'),
        frames: z.number().describe('How many frames later the audio should end'),
      }),
    },

    // Three-point edit
    {
      name: 'three_point_edit',
      description:
        'Classic 3-point edit: opens a source clip, sets source in/out, then inserts or overwrites at the sequence playhead. Verified: sourceMonitor.openProjectItem + setInPoint/setOutPoint confirmed working.',
      inputSchema: z.object({
        projectItemId: z.string().describe('Source clip nodeId'),
        sourceIn: z.string().optional().describe('Source in-point timecode (e.g. "00:00:01:00")'),
        sourceOut: z.string().optional().describe('Source out-point timecode'),
        sequenceTimecode: z
          .string()
          .optional()
          .describe('Where to place in sequence. Defaults to current playhead.'),
        mode: z
          .enum(['insert', 'overwrite'])
          .optional()
          .describe('Edit mode. Default "overwrite".'),
        videoTrackIndex: z.number().optional().describe('Target video track. Default 0.'),
        audioTrackIndex: z.number().optional().describe('Target audio track. Default 0.'),
      }),
    },

    // Gap operations
    {
      name: 'close_gap_at',
      description:
        'Closes the gap containing a time by moving every later clip on every track left by the gap length. Only gaps empty on ALL video and audio tracks are closed, so sync holds; anything narrower is refused. Verified by reading back every moved clip start.',
      inputSchema: z.object({
        timecode: z.string().describe('A time inside the gap: HH:MM:SS:FF, or a number of seconds'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'close_all_gaps',
      description:
        'Closes every gap that is empty on all tracks (the one before the first clip only with includeLeadingGap), latest first, by moving later clips left. Verified by rescanning for gaps and reading back every moved clip start.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z
          .number()
          .optional()
          .describe(
            'Ignored: only gaps empty on every track are closed, because closing one track alone breaks sync. Kept for compatibility.',
          ),
        includeLeadingGap: z
          .boolean()
          .optional()
          .describe(
            'Also close the empty time before the first clip. Default false, because that offset is often deliberate (slate, countdown, leader).',
          ),
      }),
    },
    {
      name: 'delete_empty_tracks',
      description:
        'Removes all empty video and/or audio tracks from the active sequence. Verified via QE removeEmptyVideoTracks/removeEmptyAudioTracks.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        video: z.boolean().optional().describe('Remove empty video tracks. Default true.'),
        audio: z.boolean().optional().describe('Remove empty audio tracks. Default true.'),
      }),
    },

    // Timeline selection operations
    {
      name: 'get_sequence_selection',
      description:
        'Returns the currently selected clips in the active sequence timeline. Confirmed via Sequence.getSelection().',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'set_sequence_selection',
      description:
        'Selects specific clips in the sequence timeline by track/clip index pairs. Confirms selection via getSelection() readback.',
      inputSchema: z.object({
        clips: z
          .array(
            z.object({
              trackIndex: z.number(),
              clipIndex: z.number(),
            }),
          )
          .describe('List of clips to select by track+clip index'),
        sequenceId: z.string().optional(),
      }),
    },

    // Marker operations (using MarkerCollection)
    {
      name: 'create_marker',
      description:
        'Creates a sequence marker at a given timecode with optional name, comment, type, and color. Uses the confirmed MarkerCollection.createMarker() API.',
      inputSchema: z.object({
        timecode: z.number().describe('Marker time in seconds'),
        name: z.string().optional().describe('Marker name'),
        comment: z.string().optional().describe('Marker comment/notes'),
        type: z
          .enum(['Comment', 'Chapter', 'Segmentation', 'WebLink', 'FLVCuePoint', 'Named'])
          .optional()
          .describe('Marker type. Default Comment.'),
        colorIndex: z.number().min(0).max(7).optional().describe('Color index 0-7'),
        durationSeconds: z.number().optional().describe('Duration in seconds for ranged markers'),
        sequenceId: z.string().optional(),
      }),
    },

    // ── Batch 1: Lumetri Numeric Control ─────────────────────────────────
    {
      name: 'lumetri_basic_set',
      description:
        'Sets Lumetri Color basic correction values on a clip: exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation. Verified via param readback.',
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
      }),
    },
    {
      name: 'lumetri_creative_set',
      description:
        'Sets Lumetri Color creative adjustments: faded film, sharpen, vibrance, saturation.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        fadedFilm: z.number().optional().describe('0 to 100'),
        sharpen: z.number().optional().describe('0 to 100'),
        vibrance: z.number().optional().describe('-100 to 100'),
        saturation: z.number().optional().describe('0 to 200'),
      }),
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
      }),
    },
    {
      name: 'lumetri_report',
      description:
        'Reads all named Lumetri Color parameter values from a clip and returns them as JSON. Useful for copying grades.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
      }),
    },
    {
      name: 'copy_grade',
      description:
        'Copies the full Lumetri Color grade state from a source clip and returns it as a JSON blob for use with paste_grade_to_clips.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional().describe('Source video track, default 0'),
        clipIndex: z.number().optional().describe('Source clip index, default 0'),
      }),
    },
    {
      name: 'paste_grade_to_clips',
      description:
        'Pastes a Lumetri grade (from copy_grade) to one or more target clips specified by track/clip index pairs.',
      inputSchema: z.object({
        gradeJson: z
          .string()
          .describe('JSON string from copy_grade containing param indices and values'),
        targets: z
          .array(z.object({ trackIndex: z.number(), clipIndex: z.number() }))
          .describe('Target clips'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'auto_white_balance',
      description:
        'Triggers Lumetri auto white balance on a clip by setting the Auto Tone Analytics Data param with mAutoTonePressed:true.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
      }),
    },
    {
      name: 'set_lut_interpolation',
      description:
        'Sets the project-wide LUT interpolation method. 0=linear, 1=tetrahedral (default). Verified via getLUTInterpolationMethod readback.',
      inputSchema: z.object({
        method: z.number().min(0).max(1).describe('0=linear, 1=tetrahedral'),
      }),
    },

    // ── Batch 2: Motion, Transform, Layout ────────────────────────────────
    {
      name: 'flip_horizontal',
      description:
        'Flips a clip horizontally by applying the Horizontal Flip effect. Verified by component readback; a clip already carrying the effect is reported as already flipped.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
      }),
    },
    {
      name: 'flip_vertical',
      description:
        'Flips a clip vertically by applying the Vertical Flip effect. Verified by component readback; a clip already carrying the effect is reported as already flipped.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
      }),
    },
    {
      name: 'fade_in_video',
      description:
        'Adds an opacity fade-in to a clip: keyframe at 0% at the clip start, 100% at the specified frame offset. Verified via keyframe readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        durationFrames: z.number().describe('Number of frames for the fade-in'),
      }),
    },
    {
      name: 'fade_out_video',
      description:
        'Adds an opacity fade-out to a clip: 100% at durationFrames before the end, 0% at the last frame. Verified via keyframe readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        durationFrames: z.number().describe('Number of frames for the fade-out'),
      }),
    },
    {
      name: 'reset_transform',
      description:
        'Resets all Motion component properties (position, scale, rotation, anchor) to their defaults.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
      }),
    },
    {
      name: 'match_transform',
      description:
        'Copies all Motion component values from a source clip to one or more target clips.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        sourceTrackIndex: z.number().describe('Source video track'),
        sourceClipIndex: z.number().describe('Source clip index'),
        targets: z
          .array(z.object({ trackIndex: z.number(), clipIndex: z.number() }))
          .describe('Target clips'),
      }),
    },
    {
      name: 'letterbox',
      description:
        'Applies letterbox bars by setting Motion component crop top/bottom values. Use aspect e.g. "2.39:1" or explicit cropPercent.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        aspect: z
          .string()
          .optional()
          .describe('Target aspect ratio e.g. "2.39:1", "2.35:1", "1.85:1"'),
        cropPercent: z
          .number()
          .optional()
          .describe('Explicit crop percent for top AND bottom (0-50)'),
      }),
    },
    {
      name: 'ken_burns',
      description:
        'Applies a Ken Burns (slow push/pan) effect by adding position and scale keyframes at the start and end of the clip.',
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
      }),
    },
    {
      name: 'set_clip_scale_to_frame_size',
      description:
        'Applies scale-to-frame-size to ONE clip via QE, confirmed by a qeClip.scaleToFrameSize readback. To normalise a whole track or a list of clips in a single call, use set_scale_to_frame_size_batch instead of looping this.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        enabled: z.boolean().optional().describe('Default true'),
      }),
    },
    {
      name: 'set_scale_to_frame_size_batch',
      description:
        'Applies scale-to-frame-size to MANY clips in one call — a whole video track, every video track, or an explicit clip-id list. Each clip is confirmed by a qeClip.scaleToFrameSize readback and reported individually in applied[]/failed[]/unverified[], so a partial result is visible rather than averaged into one success. QE items are matched to clips by start time, not index, so gaps and transitions on the track do not shift the target.',
      inputSchema: z.object({
        enabled: z
          .boolean()
          .optional()
          .describe(
            'Default true. Passed to QE setScaleToFrameSize() as an explicit boolean — that method throws "Not Enough Parameters" when called with no argument, so there is no implicit default at the Premiere level.',
          ),
        sequenceId: z
          .string()
          .optional()
          .describe('Sequence to act on. Defaults to the active sequence.'),
        trackIndex: z
          .number()
          .optional()
          .describe('0-based video track index. Omit to cover EVERY video track in the sequence.'),
        clipIds: z
          .array(z.string())
          .optional()
          .describe(
            'Only touch these clip nodeIds. Ids not found in the scanned tracks are reported in notFoundClipIds[] and make the call unsuccessful, rather than being ignored.',
          ),
      }),
    },

    // ── Batch 3: Audio Tools ──────────────────────────────────────────────
    {
      name: 'fade_in_audio',
      description:
        'Adds a volume fade-in to an audio clip: keyframe at -∞ dB at start, 0 dB at durationFrames. Verified via keyframe readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        audioTrackIndex: z.number().optional().describe('Audio track index, default 0'),
        clipIndex: z.number().optional().describe('Clip index, default 0'),
        durationFrames: z.number().describe('Fade-in duration in frames'),
      }),
    },
    {
      name: 'fade_out_audio',
      description: 'Adds a volume fade-out to an audio clip. Verified via keyframe readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        audioTrackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        durationFrames: z.number().describe('Fade-out duration in frames'),
      }),
    },
    {
      name: 'set_clip_gain',
      description:
        'Sets the clip gain (dB) on an audio clip. Distinct from the rubber-band volume. Verified via Level param readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        audioTrackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        gainDb: z.number().describe('Gain in dB, e.g. -6 to reduce by 6dB'),
      }),
    },
    {
      name: 'audio_crossfade_at_cut',
      description:
        'Adds a Constant Power audio crossfade at the out-point of the given audio clip. The transition is proven by readback — QE transition enumeration first, the transition count in an FCP XML export as a fallback — and a crossfade that did not appear is reported as a failure with the reason, not as an unverified success.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        audioTrackIndex: z.number().optional().describe('Audio track index, default 0'),
        clipIndex: z
          .number()
          .describe('Index of the FIRST clip — transition goes between this and the next'),
        durationFrames: z.number().optional().describe('Transition duration in frames, default 15'),
      }),
    },
    {
      name: 'mute_clip_audio',
      description:
        'Mutes/unmutes the audio for a linked video clip by disabling its linked audio clip.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional().describe('Video track index, default 0'),
        clipIndex: z.number().optional().describe('Clip index, default 0'),
        mute: z.boolean().optional().describe('True to mute, false to unmute. Default true.'),
      }),
    },
    {
      name: 'loudness_report',
      description:
        'Analyzes the loudness of a media file using ffmpeg ebur128 filter. Returns integrated LUFS, true peak, and LRA.',
      inputSchema: z.object({
        filePath: z.string().describe('Absolute path to the audio/video file to analyze'),
      }),
    },
    {
      name: 'normalize_clip_peaks',
      description:
        'Analyzes a media file peak level and sets the clip gain to normalize to a target dBFS. Verified via gain readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        audioTrackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        targetDbfs: z.number().optional().describe('Target peak in dBFS, default -1'),
      }),
    },

    // ── Batch 4: Export & AME Tools ───────────────────────────────────────
    {
      name: 'export_in_out_range',
      description:
        'Exports only the in/out marked range of the active sequence using exportAsMediaDirect with work area mode.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute output file path'),
        presetPath: z.string().describe('Absolute path to .epr preset file'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'list_all_encoder_presets',
      description:
        'Returns the full catalog of AME export formats and their available presets (24 formats, 300+ presets). Verified via app.encoder.getExporters().',
      inputSchema: z.object({
        format: z
          .string()
          .optional()
          .describe('Filter to a specific format name e.g. "H.264". Returns all if omitted.'),
      }),
    },
    {
      name: 'create_custom_export_preset',
      description:
        'Creates a custom AME export preset by taking a base preset and modifying specific params. Writes a .epr file. Returns the preset file path.',
      inputSchema: z.object({
        format: z
          .string()
          .describe('Exporter format name, e.g. "H.264", "QuickTime", "H.265 (HEVC)"'),
        basePresetName: z
          .string()
          .optional()
          .describe('Base preset name to modify. Uses first preset if omitted.'),
        params: z
          .record(z.string(), z.string())
          .describe('Params to set, e.g. {"TargetBitrate":"8","Width":"1920","Height":"1080"}'),
        outputPresetPath: z.string().describe('Absolute path to write the .epr file'),
      }),
    },
    {
      name: 'export_social_preset',
      description:
        'Exports the active sequence using a named social media preset. Presets: youtube_1080p, youtube_4k, instagram_1080p, instagram_reels, tiktok, twitter.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute output file path'),
        preset: z
          .enum([
            'youtube_1080p',
            'youtube_4k',
            'instagram_1080p',
            'instagram_reels',
            'tiktok',
            'twitter',
          ])
          .describe('Social preset name'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'export_audio_only',
      description: 'Exports just the audio mix of the active sequence as WAV or AAC.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute output path (.wav or .aac)'),
        format: z.enum(['wav', 'aac']).optional().describe('Format, default wav'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'verify_export',
      description:
        'Verifies an exported media file using ffprobe: checks duration, fps, resolution vs expected. Returns a QC pass/fail.',
      inputSchema: z.object({
        filePath: z.string().describe('Absolute path to the exported file to verify'),
        expectedDurationSecs: z
          .number()
          .optional()
          .describe('Expected duration in seconds (tolerance ±1s)'),
        expectedFps: z.number().optional().describe('Expected frame rate'),
        expectedWidth: z.number().optional(),
        expectedHeight: z.number().optional(),
      }),
    },

    // ── Batch 5: Batch & Metadata ─────────────────────────────────────────
    {
      name: 'markers_to_csv',
      description:
        'Exports all sequence markers to a CSV file: time, name, comment, type, color. Verified via seq.markers enumeration.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute path to write the CSV file'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'markers_from_csv',
      description:
        'Creates sequence markers from a CSV file with columns: time (seconds), name, comment, type.',
      inputSchema: z.object({
        csvPath: z
          .string()
          .describe('Absolute path to a CSV file with columns: time,name,comment,type'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'add_metadata_schema_field',
      description:
        'Adds a custom metadata column to the project schema. Type: 0=string, 1=integer, 2=real, 3=boolean. Verified via addPropertyToProjectMetadataSchema.',
      inputSchema: z.object({
        columnId: z.string().describe('Unique column ID e.g. "mcp.shotCode"'),
        displayName: z.string().describe('Column display name'),
        type: z.number().min(0).max(3).optional().describe('0=string (default)'),
      }),
    },
    {
      name: 'set_item_metadata',
      description:
        'Sets a project metadata value on a project item by nodeId. Verified via setProjectMetadata.',
      inputSchema: z.object({
        projectItemId: z.string().describe('Project item nodeId'),
        key: z.string().describe('Metadata key e.g. "mcp.shotCode" or built-in column ID'),
        value: z.string().describe('Value to set'),
      }),
    },
    {
      name: 'get_item_metadata_columns',
      description:
        'Returns all project panel column values for a project item (name, label, media type, custom fields, etc.). Verified via getProjectColumnsMetadata.',
      inputSchema: z.object({
        projectItemId: z.string().describe('Project item nodeId'),
      }),
    },
    {
      name: 'batch_set_label',
      description: 'Sets the color label on multiple project items at once.',
      inputSchema: z.object({
        projectItemIds: z.array(z.string()).describe('Array of project item nodeIds'),
        labelColor: z.string().describe('Label color name e.g. "Iris", "Cerulean", "Lavender"'),
      }),
    },
    {
      name: 'batch_rename_project_items',
      description: 'Renames multiple project items by nodeId.',
      inputSchema: z.object({
        renames: z.array(z.object({ projectItemId: z.string(), newName: z.string() })),
      }),
    },

    // ── Batch 6: Review & Delivery ────────────────────────────────────────
    {
      name: 'assemble_review_reel',
      description:
        'Assembles a gap-free review reel from a list of sequences. Creates a new sequence and overwrites each source sequence content sequentially. Critical for daily VFX review. Verified via sequence structure diff.',
      inputSchema: z.object({
        sequenceIds: z.array(z.string()).describe('Ordered list of sequence IDs to assemble'),
        reelName: z.string().describe('Name for the new reel sequence'),
        handles: z
          .number()
          .optional()
          .describe('Optional handle frames to add before/after each sequence'),
      }),
    },
    {
      name: 'version_up_sequence',
      description:
        'Duplicates the active (or specified) sequence and bumps its version suffix (_v001 → _v002, or appends _v001). Returns the new sequence ID and name.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('Sequence to version up. Defaults to active sequence.'),
        setActive: z.boolean().optional().describe('Set the new version as active. Default true.'),
      }),
    },
    {
      name: 'shot_status_report',
      description:
        'Returns a status board of all sequences in the project with their name, label color, track count, duration, and clip count.',
      inputSchema: z.object({}),
    },
    {
      name: 'notes_to_markers',
      description:
        'Creates sequence markers from a newline-delimited notes file. Format per line: "HH:MM:SS:FF Note text" or "SS.ms Note text".',
      inputSchema: z.object({
        notesPath: z.string().describe('Absolute path to the notes text file'),
        sequenceId: z.string().optional(),
        markerType: z.string().optional().describe('Default Comment'),
        colorIndex: z.number().optional().describe('Color index 0-7'),
      }),
    },
    {
      name: 'markers_to_notes',
      description:
        'Exports all sequence markers to a formatted text file for sharing with directors/supervisors.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute path to write the notes file'),
        sequenceId: z.string().optional(),
        format: z.enum(['text', 'csv', 'json']).optional().describe('Default text'),
      }),
    },
    {
      name: 'delivery_qc',
      description:
        'Runs a quick QC check on the active sequence: checks for offline media, reports unrendered ranges, checks for gaps, counts tracks. Returns a QC report.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
      }),
    },

    // ── Batch 7: VFX & Interchange ────────────────────────────────────────
    {
      name: 'vfx_pull_list',
      description:
        'Generates a VFX pull list from the active sequence: clip name, source path, source in/out TC, sequence in/out TC, duration, handles. Returns JSON array.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        handles: z.number().optional().describe('Handle frames to add each side, default 8'),
        trackIndex: z.number().optional().describe('Video track to pull from, default 0'),
      }),
    },
    {
      name: 'cut_list_csv',
      description:
        'Exports the active sequence as a cut list CSV: shot name, source TC in, source TC out, sequence TC in, sequence TC out, duration.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute path to write the CSV'),
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional().describe('Video track to use, default 0'),
      }),
    },
    {
      name: 'export_sequence_as_project',
      description:
        'Exports the active sequence as a standalone .prproj file. Verified via seq.exportAsProject().',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute path for the output .prproj file'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'change_list_report',
      description:
        'Compares two sequences and returns a human-readable change list: added/removed/moved clips, timing changes.',
      inputSchema: z.object({
        sequenceIdA: z.string().describe('First sequence ID (older version)'),
        sequenceIdB: z.string().describe('Second sequence ID (newer version)'),
      }),
    },
    {
      name: 'get_item_treepath',
      description:
        'Returns the full project panel tree path for a project item (including bin hierarchy). Verified via item.treePath.',
      inputSchema: z.object({
        projectItemId: z.string().describe('Project item nodeId'),
      }),
    },

    // ── Batch 8: MOGRT / Titles ───────────────────────────────────────────
    {
      name: 'set_mogrt_text',
      description:
        'Sets text content on a MOGRT (Motion Graphics Template) clip. Finds the clip by track/index and updates a text param by display name.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional().describe('Video track index, default 0'),
        clipIndex: z.number().optional().describe('Clip index, default 0'),
        paramName: z.string().describe('The text param display name to set'),
        text: z.string().describe('The new text value'),
      }),
    },
    {
      name: 'set_mogrt_param',
      description:
        'Sets a parameter value on a MOGRT clip (text, color, number). Finds param by display name.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        paramName: z.string().describe('The param display name'),
        value: z.union([z.string(), z.number(), z.boolean()]).describe('The new value'),
      }),
    },
    {
      name: 'mogrt_params_report',
      description:
        'Lists all exposed parameters of a MOGRT clip with their names, types, and current values.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
      }),
    },
    {
      name: 'timecode_burn_in',
      description:
        'Applies the "Timecode" (Metadata & Timecode Burn-in) video effect to a clip for review copies. Verified via QE addVideoEffect + component fingerprint.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
      }),
    },

    // ── Batch 9: QE utilities + Productions ──────────────────────────────
    {
      name: 'get_renderer_names',
      description:
        'Returns the list of available renderers (GPU/software) from Premiere. Verified via qe.project.getRendererNames().',
      inputSchema: z.object({}),
    },
    {
      name: 'set_renderer',
      description:
        'Sets the active GPU renderer by name. Verified via qe.project.setRenderer() + readback.',
      inputSchema: z.object({
        rendererName: z.string().describe('Renderer name from get_renderer_names'),
      }),
    },
    {
      name: 'sync_lock_track',
      description:
        'Sets or clears sync lock on a timeline track. Verified via QE track.setSyncLock() + isSyncLocked() readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackType: z.enum(['video', 'audio']).describe('Track type'),
        trackIndex: z.number().describe('0-based track index'),
        locked: z.boolean().describe('True to lock, false to unlock'),
      }),
    },
    {
      name: 'render_audio',
      description:
        'Renders audio preview files for the active sequence. Equivalent to Sequence > Render Audio. Verified via QE seq.renderAudio().',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_production_list',
      description:
        'Returns the list of Adobe Productions (Team Projects) available to the logged-in user. Verified via qe.ea.getProductionList().',
      inputSchema: z.object({}),
    },
    {
      name: 'get_lumetri_preset_list',
      description:
        'Returns all 325 Lumetri preset names available in the project. Verified via app.project.getAllLumetriPresetsList().',
      inputSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe('Filter to a preset folder name e.g. "Creative", "Cinematic"'),
      }),
    },
    {
      name: 'set_sequence_in_out_qe',
      description:
        'Sets the sequence in/out points using QE (more reliable than DOM for non-standard timecodes).',
      inputSchema: z.object({
        inPoint: z.string().optional().describe('In point timecode e.g. "00:00:01:00"'),
        outPoint: z.string().optional().describe('Out point timecode'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_qe_sequence_props',
      description:
        'Returns QE sequence properties: CTI, in/out points, work area, preview preset, editing mode GUID, render flags.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
      }),
    },

    // ── Batch A: Navigation & monitoring ──────────────────────────────────
    {
      name: 'go_to_next_marker',
      description: 'Moves playhead to the next sequence marker after the current position.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'go_to_prev_marker',
      description: 'Moves playhead to the previous sequence marker before the current position.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'go_to_timecode',
      description:
        'Moves the playhead to a specific timecode string (e.g. "00:00:05:00") in the active sequence.',
      inputSchema: z.object({
        timecode: z.string().describe('Timecode e.g. "00:00:05:00"'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'play_in_to_out',
      description: 'Sets playhead to in-point and starts playback.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'get_edit_point_list',
      description:
        'Returns all cut points on all tracks as a list of {track, clip, name, startSecs, endSecs}.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        videoOnly: z.boolean().optional(),
      }),
    },
    {
      name: 'detect_settings_mismatch',
      description:
        "Compares each clip's source fps/size to the sequence settings. Returns list of mismatching clips.",
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'count_tracks_used',
      description: 'Returns which tracks have content vs are empty, with clip counts per track.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'sequence_thumbnail_strip',
      description:
        'Extracts N evenly-spaced frame thumbnails from a video file path as JPEGs. Returns array of output file paths.',
      inputSchema: z.object({
        filePath: z.string().describe('Source video file path'),
        count: z.number().optional().describe('Number of thumbnails. Default 10.'),
        outputDir: z
          .string()
          .optional()
          .describe('Output directory. Default /tmp/premiere-mcp-bridge/generated-assets/'),
      }),
    },

    // ── Batch B: QE clip operations ────────────────────────────────────────
    {
      name: 'set_clip_reverse',
      description:
        'Reverses a clip on the timeline using QE setReverse(). Verified via clip.reversed property.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        reverse: z.boolean(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'set_frame_blend_qe',
      description:
        'Enables/disables frame blending on a clip via QE setFrameBlend(). Verified via clip.frameBlend property.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        enabled: z.boolean(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'set_time_interpolation_type',
      description:
        'Sets time interpolation type on a clip: 0=frame sampling, 1=frame blend, 2=optical flow.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        type: z.number().min(0).max(2),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'set_clip_border_color',
      description: 'Sets the border color of a clip via QE setBorderColor(). Pass RGB 0-255.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        r: z.number(),
        g: z.number(),
        b: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'set_clip_border_width',
      description: 'Sets the border width of a clip via QE setBorderWidth().',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        width: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'rename_timeline_clip',
      description:
        'Renames a clip on the timeline via QE setName(). Verified via DOM clip.name readback.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        name: z.string(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_qe_component_params',
      description:
        "Returns all parameter names and values for a clip's effect component at the given index, using QE getParamList/getParamValue.",
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        componentIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'set_qe_component_param',
      description:
        "Sets a parameter value on a clip's effect component by name using QE setParamValue(). Works where DOM setValue() fails.",
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        componentIndex: z.number(),
        paramName: z.string(),
        value: z.string().describe('Value as string'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'remove_effect_at_index',
      description:
        'Removes a specific effect component from a clip by component index, using QE QEComponent.remove(). Does not affect Motion/Opacity.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        componentIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'reorder_effects',
      description:
        'Reorders the effect stack on a clip by specifying the new component order as a list of display names. Serializes params, removes, re-adds in new order.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        newOrder: z.array(z.string()).describe('Component displayNames in desired order'),
        sequenceId: z.string().optional(),
      }),
    },

    // ── Batch C: Audio effect control ──────────────────────────────────────
    {
      name: 'apply_audio_effect_qe',
      description:
        'Applies an audio effect to a clip on the timeline by effect name using QE addAudioEffect(). Verified: fingerprints component count before/after.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        effectName: z.string(),
        audioTrack: z.boolean().optional().describe('True for audio track. Default true.'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'denoise_clip',
      description: 'Applies Adaptive Noise Reduction to an audio clip via QE.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'list_audio_effects_on_clip',
      description:
        'Lists all audio effect components on an audio clip with their QE parameter names.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'audio_peaks_report',
      description:
        'Analyzes audio peak and RMS levels of a media file using ffprobe astats filter. Returns per-channel stats.',
      inputSchema: z.object({ filePath: z.string().describe('Path to the audio/video file') }),
    },
    {
      name: 'apply_dynamics',
      description: 'Applies Dynamics Processing audio effect to an audio clip via QE.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'set_track_volume_keyframes',
      description:
        'Adds volume automation keyframes to an audio track by setting level values at specific timecodes.',
      inputSchema: z.object({
        trackIndex: z.number(),
        keyframes: z.array(
          z.object({ timeSecs: z.number(), level: z.number().describe('dB value') }),
        ),
        sequenceId: z.string().optional(),
      }),
    },

    // ── Batch D: Caption tools ──────────────────────────────────────────────
    {
      name: 'export_captions_to_srt',
      description:
        'Reads captions from the active sequence and writes them as an SRT file. Uses read_sequence_captions then formats as SRT.',
      inputSchema: z.object({
        outputPath: z.string().describe('Output .srt file path'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'caption_qc_report',
      description:
        'Validates an SRT file: checks CPS (chars/sec), line length, overlapping/missing cues. Returns list of violations.',
      inputSchema: z.object({
        srtPath: z.string(),
        maxCps: z.number().optional().describe('Max chars per second. Default 17.'),
        maxLineLength: z.number().optional().describe('Max chars per line. Default 42.'),
      }),
    },
    {
      name: 'caption_qc_fix',
      description:
        'Auto-fixes common SRT issues: splits cues over the CPS limit, enforces minimum gap between cues. Writes fixed file.',
      inputSchema: z.object({
        srtPath: z.string(),
        outputPath: z.string().optional().describe('Output path. Default: overwrites input.'),
        maxCps: z.number().optional(),
        minGapMs: z.number().optional().describe('Min gap between cues in ms. Default 80.'),
      }),
    },
    {
      name: 'captions_from_transcript_json',
      description:
        'Converts a Whisper-format JSON transcript (with word-level timestamps) into an SRT file.',
      inputSchema: z.object({
        jsonPath: z.string().describe('Path to Whisper JSON transcript'),
        outputPath: z.string().describe('Output .srt file path'),
        maxCps: z.number().optional(),
        maxLineLength: z.number().optional(),
      }),
    },
    {
      name: 'srt_diff',
      description: 'Compares two SRT files and returns a diff: added, removed, and changed cues.',
      inputSchema: z.object({ srtPathA: z.string(), srtPathB: z.string() }),
    },
    {
      name: 'captions_to_markers',
      description:
        'Creates sequence markers from an SRT file — one marker per cue with the cue text as the marker comment.',
      inputSchema: z.object({
        srtPath: z.string(),
        sequenceId: z.string().optional(),
        markerType: z.string().optional().describe('Marker type. Default Comment.'),
      }),
    },

    // ── Batch E: Project lifecycle ──────────────────────────────────────────
    {
      name: 'open_fcp_xml',
      description:
        'Opens a Final Cut Pro XML file into a new sequence. Confirmed: app.openFCPXML(path, sequenceName).',
      inputSchema: z.object({
        filePath: z.string(),
        sequenceName: z.string().optional().describe('Name for the resulting sequence'),
      }),
    },
    {
      name: 'get_project_stats',
      description:
        'Returns a summary of the project: sequence count, total clips, bin count, codec mix, total media duration.',
      inputSchema: z.object({}),
    },
    {
      name: 'write_sidecar_file',
      description:
        'Writes a sidecar file adjacent to the project. Confirmed: app.project.writeSidecarFile(name, ext, content).',
      inputSchema: z.object({
        fileName: z.string(),
        fileExtension: z.string(),
        contents: z.string(),
      }),
    },
    {
      name: 'get_ea_login_status',
      description:
        'Returns the current Creative Cloud / Productions login status via qe.ea.isLoggedIn() and getUserEmail().',
      inputSchema: z.object({}),
    },
    {
      name: 'list_sequences_by_name',
      description:
        'Searches all sequences by name pattern (case-insensitive contains). Returns matching sequence IDs and names.',
      inputSchema: z.object({
        pattern: z.string().describe('Search pattern (case-insensitive substring)'),
      }),
    },

    // ── Batch F: Sequence & timeline utilities ──────────────────────────────
    {
      name: 'set_sequence_in_out_from_clips',
      description:
        'Sets the sequence work area to span all content on V1 (first clip start → last clip end).',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'get_bin_tree',
      description:
        'Returns the full project bin hierarchy as a nested JSON tree with bin names, IDs, and item counts.',
      inputSchema: z.object({
        includeItems: z
          .boolean()
          .optional()
          .describe('Include individual items in each bin. Default false.'),
      }),
    },
    {
      name: 'find_clips_with_effect',
      description:
        'Searches all sequences for clips that have a specific effect by display name. Returns clip locations.',
      inputSchema: z.object({
        effectName: z.string().describe('Effect displayName to search for'),
      }),
    },
    {
      name: 'effect_stack_report',
      description:
        'Returns all effects on a clip with their parameter names and values as a structured report.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'enable_disable_effect',
      description: 'Enables or disables a specific effect component on a clip by display name.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        effectName: z.string(),
        enabled: z.boolean(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'batch_add_audio_crossfades',
      description:
        'Adds Constant Power audio crossfades at every cut on all audio tracks in the active sequence.',
      inputSchema: z.object({
        durationSeconds: z
          .number()
          .optional()
          .describe('Crossfade duration in seconds. Default 0.5.'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'flush_sequence_cache',
      description: 'Flushes the QE sequence cache via qe.seq.flushCache().',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'set_render_preview_quality',
      description:
        'Sets the sequence preview quality: max render quality flag and preview frame size.',
      inputSchema: z.object({
        useMaxQuality: z.boolean().optional(),
        presetPath: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        sequenceId: z.string().optional(),
      }),
    },

    // ── Batch G: Clip property utilities ───────────────────────────────────
    {
      name: 'get_clip_color_space',
      description: 'Returns the original and override color space of a project item.',
      inputSchema: z.object({ projectItemId: z.string() }),
    },
    {
      name: 'set_clip_color_space',
      description:
        'Sets the color space override on a project item (same as set_color_space_override). Pass a name from get_item_color_management overrideColorSpaceList, e.g. "Rec. 709", "Rec. 2100 PQ". Verified by readback.',
      inputSchema: z.object({ projectItemId: z.string(), colorSpaceName: z.string() }),
    },
    {
      name: 'get_clip_info_extended',
      description:
        'Returns comprehensive clip info: speed, reverse state, color space, in/out points, linked items, effect count, marker count, type flags.',
      inputSchema: z.object({ projectItemId: z.string() }),
    },
    {
      name: 'batch_relink_by_pattern',
      description:
        'Relinks offline project items by transforming their paths: replace oldPrefix with newPrefix. Reports how many items were relinked.',
      inputSchema: z.object({ oldPrefix: z.string(), newPrefix: z.string() }),
    },
    {
      name: 'set_item_poster_frame',
      description: 'Sets the poster frame timecode on a project item via setStartTime.',
      inputSchema: z.object({ projectItemId: z.string(), timeSecs: z.number() }),
    },

    // ── Batch H: Effects shortcuts ──────────────────────────────────────────
    {
      name: 'blur_clip',
      description:
        'Applies Gaussian Blur effect to a clip with a specified amount. Uses QE addVideoEffect + setParamValue. Verified pattern.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        amount: z.number().describe('Blur amount'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'sharpen_clip',
      description: 'Applies Unsharp Mask effect to a clip via QE.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        amount: z.number().optional().describe('Sharpening amount. Default 50.'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'enable_disable_all_effects',
      description:
        'Enables or disables all applied effects on a clip (skips built-in Motion/Opacity/Time Remapping).',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        enabled: z.boolean(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'remove_all_effects_qe',
      description:
        'Removes all applied effects from a clip via QE removeEffects(). Does not remove built-in Motion/Opacity.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'apply_lut_to_clip',
      description:
        'Same as apply_lut, addressed by track/clip index: selects the Lumetri Input LUT dropdown entry whose render matches the .cube, verified against ffmpeg lut3d.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        lutPath: z.string().describe('Absolute path to the .cube LUT file'),
        sequenceId: z.string().optional(),
        installIfMissing: z
          .boolean()
          .optional()
          .describe(
            'Copy an unlisted LUT into the user LUT folder (needs a Premiere restart). Default false.',
          ),
      }),
    },
    {
      name: 'list_effects_on_clip_qe',
      description:
        'Lists all effect components on a clip using the QE getComponentAt/getParamList path. Returns component names and param lists.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'timecode_to_frames',
      description:
        'Converts a timecode string to frame number and seconds at the active sequence frame rate. Pure computation.',
      inputSchema: z.object({
        timecode: z.string(),
        frameRate: z
          .number()
          .optional()
          .describe('Frame rate override. Default: active sequence fps.'),
      }),
    },
    {
      name: 'frames_to_timecode',
      description:
        'Converts a frame number to a timecode string at the active sequence frame rate. Pure computation.',
      inputSchema: z.object({ frames: z.number(), frameRate: z.number().optional() }),
    },

    // ── Final batches: motion/layout, speed, color, markers, export, source, sequence, project, verify ──

    // Motion & layout
    {
      name: 'pip_layout',
      description:
        'Places a clip as picture-in-picture in a corner at a given size. Sets Motion Position and Scale. Args: trackIndex, clipIndex, corner (top-left/top-right/bottom-left/bottom-right), sizePercent (default 25).',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        corner: z
          .enum(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
          .default('top-right'),
        sizePercent: z.number().default(25),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'grid_layout',
      description:
        "Arranges clips in a 2x2 or 3x3 grid by setting Position and Scale on each clip's Motion component.",
      inputSchema: z.object({
        clips: z.array(z.object({ trackIndex: z.number(), clipIndex: z.number() })),
        cols: z.number().default(2),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'split_screen_layout',
      description:
        'Arranges 2 or 3 clips side-by-side horizontally or vertically using crop and position params.',
      inputSchema: z.object({
        clips: z.array(z.object({ trackIndex: z.number(), clipIndex: z.number() })),
        orientation: z.enum(['horizontal', 'vertical']).default('horizontal'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'reset_motion_to_defaults',
      description:
        'Resets all Motion component params to defaults: Position (0.5,0.5), Scale 100, Rotation 0, Anchor (0.5,0.5), Uniform Scale true.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'align_clips_spatial',
      description:
        'Aligns selected clips spatially by setting their Position param: left/center/right (X axis) or top/middle/bottom (Y axis).',
      inputSchema: z.object({
        clips: z.array(z.object({ trackIndex: z.number(), clipIndex: z.number() })),
        alignment: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'safe_area_check',
      description:
        'Returns action-safe (10%) and title-safe (20%) bounds in pixels for the active sequence. Pure computation from frameSizeH/V.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'set_clip_crop',
      description:
        'Sets clip crop via Motion component params (Crop Left/Top/Right/Bottom, each 0–100%).',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        left: z.number().default(0),
        top: z.number().default(0),
        right: z.number().default(0),
        bottom: z.number().default(0),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'keyframe_zoom_in',
      description:
        'Animates clip scale from 100% to targetScale% over the clip duration using two keyframes.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        targetScale: z.number().default(120),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'keyframe_zoom_out',
      description: 'Animates clip scale from targetScale% to 100% over the clip duration.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        startScale: z.number().default(120),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'toggle_uniform_scale',
      description: "Toggles the Uniform Scale checkbox on a clip's Motion component.",
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        uniformScale: z.boolean(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'distribute_clips_evenly',
      description: 'Moves N clips to evenly-spaced positions within a time range on a given track.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndices: z.array(z.number()),
        startSecs: z.number(),
        endSecs: z.number(),
        sequenceId: z.string().optional(),
      }),
    },

    // Speed & time
    {
      name: 'rate_stretch_to_fill',
      description:
        'Stretches/compresses a clip to exactly fill its available gap or a target duration using QE setSpeed. Verified: setSpeed(ratio,...) confirmed working.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        targetDurationSecs: z
          .number()
          .optional()
          .describe('Target duration. Omit to fill gap to next clip.'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'fit_clip_duration',
      description:
        'Sets a clip to an exact target duration by speed change (default) or by trimming the out point.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        targetSeconds: z.number(),
        method: z.enum(['speed', 'trim']).default('speed'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'verify_speed_duration',
      description:
        'Reads clip.getSpeed() and clip.duration, reports actual vs expected duration and whether the speed applied correctly.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        expectedSpeedPercent: z.number().optional(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_clip_speed_info',
      description:
        'Returns speed, duration, isReversed, frameBlend, timeInterpolationType for a clip.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'remove_time_remap',
      description: 'Resets clip speed to 100% via QE setSpeed(1.0,...). Useful after speed ramps.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'slowmo_quality_report',
      description:
        "Given a source file's FPS and a target speed%, reports whether playback will judder and recommends Optical Flow if needed. Pure computation.",
      inputSchema: z.object({ sourceFps: z.number(), targetSpeedPercent: z.number() }),
    },
    {
      name: 'speed_ramp_bake',
      description:
        'Renders the clip at the specified speed to a temp file via ffmpeg, imports it, and replaces the timeline clip. Permanent bake.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        speedPercent: z.number(),
        outputDir: z.string().describe('Directory for the baked file'),
        sequenceId: z.string().optional(),
      }),
    },

    // Color depth
    {
      name: 'lumetri_hsl_secondary_set',
      description:
        'Sets Lumetri HSL Secondary keying params: showMask, invertMask, temperature, tint, contrast, saturation. All confirmed scriptable via setValue.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        showMask: z.boolean().optional(),
        invertMask: z.boolean().optional(),
        temperature: z.number().optional(),
        tint: z.number().optional(),
        contrast: z.number().optional(),
        saturation: z.number().optional(),
        denoise: z.number().optional(),
        blur: z.number().optional(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'broadcast_safe_check',
      description:
        'Runs ffprobe signalstats on a media file to detect illegal luma/chroma levels. Returns frame count with levels outside 0-100 IRE.',
      inputSchema: z.object({
        mediaPath: z.string().describe('Absolute path to media file to check'),
      }),
    },
    {
      name: 'extract_palette',
      description:
        'Uses ffmpeg palettegen to extract the dominant colors from a clip. Returns array of hex color strings.',
      inputSchema: z.object({
        mediaPath: z.string(),
        startSecs: z.number().optional().default(0),
        durationSecs: z.number().optional().default(10),
        colorCount: z.number().optional().default(8),
      }),
    },
    {
      name: 'set_color_space_override',
      description:
        'Sets the override color space on a project item. Pass a name from get_item_color_management overrideColorSpaceList, e.g. "Rec. 709", "Rec. 2100 HLG". Verified by readback. An override cannot be cleared by script; set it back to the original instead.',
      inputSchema: z.object({ projectItemId: z.string(), colorSpaceName: z.string() }),
    },
    {
      name: 'match_shot_color',
      description:
        'Copies the Lumetri grade from a source clip to a target clip (reads all params from source, applies to target).',
      inputSchema: z.object({
        sourceTrackIndex: z.number(),
        sourceClipIndex: z.number(),
        targetTrackIndex: z.number(),
        targetClipIndex: z.number(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'grade_snapshot',
      description:
        'Saves all readable Lumetri params for a clip to a JSON file for later restoration or reference.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        outputPath: z.string().describe('Absolute path for the JSON output file'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'false_color_frame',
      description:
        'Exports a single frame with a false-color exposure visualization via ffmpeg. Args: mediaPath, timeSecs, outputPath.',
      inputSchema: z.object({
        mediaPath: z.string(),
        timeSecs: z.number(),
        outputPath: z.string(),
      }),
    },

    // Markers
    {
      name: 'duration_marker_add',
      description:
        'Creates a ranged (duration) sequence marker with a start time and duration in seconds.',
      inputSchema: z.object({
        startSecs: z.number(),
        durationSecs: z.number(),
        name: z.string().optional(),
        comment: z.string().optional(),
        type: z.enum(['Comment', 'Chapter', 'Segmentation', 'WebLink']).optional(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'set_marker_type',
      description: 'Updates the type of an existing sequence marker found by approximate timecode.',
      inputSchema: z.object({
        timeSecs: z.number(),
        type: z.enum(['Comment', 'Chapter', 'Segmentation', 'WebLink', 'FLVCuePoint', 'Named']),
        toleranceSecs: z.number().optional().default(0.1),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'todo_marker_report',
      description:
        'Returns all sequence markers whose name or comment contains "TODO" (case-insensitive). Useful for review tracking.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'chapter_markers_to_youtube',
      description:
        'Formats all Chapter markers in the active sequence as a YouTube description timestamps block. Returns the text string.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'copy_markers_between_sequences',
      description:
        'Copies all markers from one sequence to another, preserving times, names, types, and comments.',
      inputSchema: z.object({ sourceSequenceId: z.string(), targetSequenceId: z.string() }),
    },
    {
      name: 'marker_to_subclip',
      description:
        "Creates a subclip from a sequence marker's time range. The subclip is created from the first clip on V1 that overlaps the marker.",
      inputSchema: z.object({
        markerName: z.string().describe('Name of the ranged marker to use'),
        projectItemId: z.string().describe('Source project item nodeId to subclip'),
        sequenceId: z.string().optional(),
      }),
    },

    // Export completions
    {
      name: 'export_gif',
      description:
        'Creates an animated GIF from a time range in a media file using ffmpeg palettegen+paletteuse pipeline.',
      inputSchema: z.object({
        mediaPath: z.string(),
        startSecs: z.number().default(0),
        durationSecs: z.number().default(5),
        fps: z.number().default(15),
        width: z.number().default(640),
        outputPath: z.string(),
      }),
    },
    {
      name: 'export_stills_batch',
      description:
        'Exports a JPEG frame at each sequence marker position using ffmpeg. Returns array of output paths.',
      inputSchema: z.object({
        mediaPath: z.string().describe('Source media file path to extract frames from'),
        outputDir: z.string(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'export_thumbnail',
      description:
        'Exports a single frame at the current playhead position. Tries QE exportFrameJPEG, falls back to capture_frame.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute output path (.jpg or .png)'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'list_export_presets',
      description:
        'Lists all .epr preset files in the Adobe AME presets directory. Returns name and path for each.',
      inputSchema: z.object({
        filter: z
          .string()
          .optional()
          .describe('Filter presets by name (case-insensitive substring)'),
      }),
    },
    {
      name: 'get_export_progress',
      description:
        'Returns the current AME encode queue status: whether encoding is complete, file extension in use.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'export_edl',
      description:
        'Exports the active sequence as a CMX3600 EDL file. Uses FCPXML as an intermediate format, converted on the Node.js side.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute output path for the .edl file'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'export_per_marker_segments',
      description:
        'REPORT ONLY -- this does NOT export anything. It lists the Chapter markers in the sequence with their start/end ticks so you can drive the exports yourself; presetPath, outputDir and filePrefix are accepted but ignored. For an export that actually writes files, use export_per_marker_range (marker PAIRS) or call export_in_out_range per range.',
      inputSchema: z.object({
        presetPath: z.string().describe('Path to .epr preset file'),
        outputDir: z.string(),
        filePrefix: z.string().optional().default('segment'),
        sequenceId: z.string().optional(),
      }),
    },

    // Source & logging
    {
      name: 'log_clip',
      description:
        'Opens a project item in the Source Monitor, sets in/out points, name, and color label in one call.',
      inputSchema: z.object({
        projectItemId: z.string(),
        inPoint: z.string().optional().describe('Timecode e.g. "00:00:01:00"'),
        outPoint: z.string().optional(),
        name: z.string().optional(),
        labelColor: z.number().optional().describe('Label color index 0-7'),
      }),
    },
    {
      name: 'create_subclips_from_markers',
      description:
        'Creates a subclip for each ranged marker on a project item. Subclip names = marker names.',
      inputSchema: z.object({ projectItemId: z.string().describe('Source project item nodeId') }),
    },
    {
      name: 'hover_scrub_frames',
      description:
        'Extracts N evenly-spaced thumbnail JPEGs from a media file using ffmpeg. Returns array of paths.',
      inputSchema: z.object({
        mediaPath: z.string(),
        count: z.number().default(6),
        outputDir: z.string(),
      }),
    },
    {
      name: 'compare_takes',
      description:
        'Extracts a frame at 50% duration from each of two project items for visual comparison. Returns two image paths.',
      inputSchema: z.object({
        projectItemId1: z.string(),
        projectItemId2: z.string(),
        outputDir: z.string(),
      }),
    },
    {
      name: 'get_source_clip_info',
      description:
        'Returns info about what is currently loaded in the Source Monitor: item name, path, in/out points, duration.',
      inputSchema: z.object({}),
    },
    {
      name: 'batch_log_from_csv',
      description:
        'Reads a CSV file (name, inTimecode, outTimecode, label columns) and sets in/out + label on matching project items.',
      inputSchema: z.object({
        csvPath: z.string().describe('Absolute path to CSV file'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'storyboard_bin_to_sequence',
      description:
        'Takes all footage items in a bin, in project-panel order, and assembles them onto V1 of a sequence via sequential overwrite edits. The bin is resolved by binId, a "/"-separated path, or a deep-searched name; an ambiguous or missing bin places nothing. Reports the bin actually used and refuses (placed:0) when it holds no footage.',
      inputSchema: z.object({
        binName: z
          .string()
          .describe(
            'Source bin by name. Use a "/"-separated path ("Scenes/Scene 008/SC008_0710") for a nested bin, or a single name to deep-search the tree (ambiguous single names are rejected rather than guessed).',
          ),
        binId: z
          .string()
          .optional()
          .describe(
            'Bin nodeId -- the unambiguous way to target a nested bin, e.g. the binId returned by create_bin. Takes precedence over binName.',
          ),
        sequenceId: z.string().optional().describe('Target sequence. Defaults to active sequence.'),
        startAtSecs: z.number().optional().default(0),
      }),
    },

    // Sequence utilities
    {
      name: 'snap_clips_to_grid',
      description:
        'Ensures all clip start times align to whole-frame boundaries. Reports any clips that were moved.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'conform_sequence_settings',
      description: 'Copies frame rate, resolution, and field type from one sequence to another.',
      inputSchema: z.object({ sourceSequenceId: z.string(), targetSequenceId: z.string() }),
    },
    {
      name: 'get_sequence_info_extended',
      description:
        'Returns comprehensive sequence info: name, ID, duration, fps, resolution, track counts, clip counts, marker counts, work area, preview codec path.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'select_clips_in_time_range',
      description:
        'Selects all clips that overlap a time range on specified tracks (or all video tracks if omitted).',
      inputSchema: z.object({
        startSecs: z.number(),
        endSecs: z.number(),
        trackIndices: z.array(z.number()).optional(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'find_unused_sequences',
      description:
        'Lists all sequences in the project that are not nested inside any other sequence.',
      inputSchema: z.object({}),
    },
    {
      name: 'batch_enable_disable_clips',
      description: 'Enables or disables all clips on a track within a time range.',
      inputSchema: z.object({
        trackIndex: z.number(),
        enabled: z.boolean(),
        startSecs: z.number().optional(),
        endSecs: z.number().optional(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_all_markers',
      description:
        'Returns all markers across all sequences in the project as a flat list with sequence name, marker name, time, type.',
      inputSchema: z.object({}),
    },
    {
      name: 'clear_work_area',
      description: 'Resets the sequence work area to span the full sequence duration.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'set_sequence_zero_point',
      description:
        'Sets the sequence start timecode (zero point) e.g. "01:00:00:00" for broadcast.',
      inputSchema: z.object({ timecode: z.string(), sequenceId: z.string().optional() }),
    },
    {
      name: 'sequence_from_markers',
      description:
        'Creates a new subsequence for each pair of Chapter markers, duplicating the sequence and trimming to each range.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        markerType: z.string().optional().default('Chapter'),
      }),
    },

    // Clip info & project utilities
    {
      name: 'get_project_item_info_extended',
      description:
        'Returns comprehensive project item info: name, path, type, duration, fps, resolution, colorSpace, embeddedLUTID, proxyPath, marker count, treePath.',
      inputSchema: z.object({ projectItemId: z.string() }),
    },
    {
      name: 'verify_media_online',
      description:
        "Checks if a project item's source file exists on disk. Returns exists, path, and file size.",
      inputSchema: z.object({ projectItemId: z.string() }),
    },
    {
      name: 'get_bin_contents_recursive',
      description:
        'Returns all items in a bin and all of its sub-bins as a flat list with their tree paths. The bin is resolved by binId, a "/"-separated path, or a deep-searched name; a name that does not resolve is an ERROR -- it does NOT silently fall back to listing the whole project. The response reports the bin actually walked as binId/binName/scope.',
      inputSchema: z.object({
        binName: z
          .string()
          .optional()
          .describe(
            'Bin to recurse. Use a "/"-separated path ("Scenes/Scene 008/SC008_0710") for a nested bin, or a single name to deep-search the tree (ambiguous single names are rejected rather than guessed). Omit to list the whole project.',
          ),
        binId: z
          .string()
          .optional()
          .describe(
            'Bin nodeId -- the unambiguous way to target a nested bin, e.g. the binId returned by create_bin. Takes precedence over binName.',
          ),
      }),
    },
    {
      name: 'find_clips_by_source',
      description:
        'Finds all timeline clips across all sequences that reference a given project item by nodeId.',
      inputSchema: z.object({ projectItemId: z.string() }),
    },
    {
      name: 'batch_relink_by_prefix',
      description:
        'For all offline items whose path starts with oldPrefix, attempts to relink by replacing with newPrefix.',
      inputSchema: z.object({ oldPrefix: z.string(), newPrefix: z.string() }),
    },
    {
      name: 'set_interpretation_frame_rate',
      description:
        'Sets an override frame rate on a project item. Confirmed via item.setOverrideFrameRate(fps).',
      inputSchema: z.object({ projectItemId: z.string(), frameRate: z.number() }),
    },
    {
      name: 'get_item_xmp_metadata',
      description:
        'Returns the full XMP metadata XML string from a project item. Useful for reading all metadata fields.',
      inputSchema: z.object({ projectItemId: z.string() }),
    },
    {
      name: 'project_media_report',
      description:
        'Returns a comprehensive project media report: total clips, total duration, codec mix, frame rate mix, resolution mix, offline count.',
      inputSchema: z.object({}),
    },
    {
      name: 'get_proxy_status',
      description: 'For each clip in the active sequence, reports hasProxy and proxyPath.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    // ── Gap closure from docs/API-COVERAGE-MATRIX.md ────────────────────────
    // Each of these exposes a live-reflected API symbol that no tool previously
    // called. They were found by diffing docs/VERIFIED-API-SURFACE.md against the
    // catalogue, which is how app.getEnableProxies() should have been caught.
    {
      name: 'get_app_state',
      description:
        'Reports application-level state in one call: whether a document is open, the open project view IDs, the current project-panel selection, app version/build/path, and whether proxy playback is enabled. Read-only.',
      inputSchema: z.object({}),
    },
    {
      name: 'refresh_ui',
      description:
        'Forces Premiere to refresh its UI (app.refresh()). Useful after scripted changes that the panels have not picked up. Returns success only if the call did not throw; there is no readback for a UI repaint, so verified is not claimed.',
      inputSchema: z.object({}),
    },
    {
      name: 'get_project_panel_selection',
      description:
        'Returns the items currently selected in the Project panel, for the current view or a named view. Uses app.getProjectViewSelection / getCurrentProjectViewSelection — distinct from get_sequence_selection, which reads the TIMELINE selection.',
      inputSchema: z.object({
        viewId: z
          .string()
          .optional()
          .describe('Project view GUID from get_app_state. Defaults to the current view.'),
      }),
    },
    {
      name: 'set_project_panel_selection',
      description:
        'Selects items in the Project panel by nodeId. Verifies by reading the selection back and comparing counts.',
      inputSchema: z.object({
        projectItemIds: z.array(z.string()).describe('nodeIds of project items to select'),
        viewId: z.string().optional().describe('Project view GUID. Defaults to the current view.'),
      }),
    },
    {
      name: 'get_project_panel_columns',
      description:
        "Reads the PROJECT-level Project-panel metadata blob (column layout/config) via app.project.getProjectPanelMetadata(). NOTE: this is a different API from get_project_panel_metadata, which despite its name reads a single ITEM's metadata via ProjectItem.getProjectMetadata(). Use this one for panel column configuration.",
      inputSchema: z.object({}),
    },
    {
      name: 'set_project_panel_columns',
      description:
        'Writes the PROJECT-level Project-panel metadata blob via app.project.setProjectPanelMetadata(). Reads the blob back and reports verified:false if it did not change. Pass a blob previously obtained from get_project_panel_columns.',
      inputSchema: z.object({
        metadata: z.string().describe('The panel metadata blob to write'),
      }),
    },
    {
      name: 'get_location_copy_settings',
      description:
        "Reports the project's Adobe/shared location copy settings: isAdobeLocationCopyEnabled, isSharedLocationCopyEnabled, and the configured shared location path. These govern where Premiere copies media for collaboration.",
      inputSchema: z.object({}),
    },
    {
      name: 'set_location_copy_settings',
      description:
        'Enables Adobe location copy, enables shared location copy, or disables copy-to-location entirely. Reads the flags back and reports verified accordingly.',
      inputSchema: z.object({
        mode: z
          .enum(['adobe', 'shared', 'disabled'])
          .describe(
            'adobe = enableAdobeLocationCopy, shared = enableSharedLocationCopy, disabled = disableCopyToLocationSetting',
          ),
      }),
    },
    {
      name: 'get_color_management_options',
      description:
        'Reports the color-management capabilities and current values for this build: supported graphics white luminance values, current luminance, supported LUT interpolation methods, and the current method. Read this before calling set_graphics_white_luminance or set_lut_interpolation so you pass a value the build accepts.',
      inputSchema: z.object({}),
    },
    {
      name: 'set_log_color_management',
      description:
        'Turns log color management on or off for the project (app.project.setLogColorManagement). There is no getter for this flag, so verified is not claimed — the call is reported as dispatched.',
      inputSchema: z.object({ enabled: z.boolean() }),
    },
    {
      name: 'export_project_as_fcp_xml',
      description:
        'Exports the ENTIRE PROJECT as Final Cut Pro XML via app.project.exportFinalCutProXML(). Distinct from export_as_fcp_xml, which exports a single SEQUENCE via Sequence.exportAsFinalCutProXML(). Verifies the file exists on disk afterwards.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute path for the .xml file'),
        suppressUI: z
          .boolean()
          .optional()
          .describe('Suppress Premiere UI during export. Default true.'),
      }),
    },
    {
      name: 'pause_growing_file',
      description:
        "Pauses or resumes Premiere's growing-file monitoring (app.project.pauseGrowing). Relevant when ingesting media that is still being written. No getter exists, so verified is not claimed.",
      inputSchema: z.object({ paused: z.boolean() }),
    },
    {
      name: 'get_clip_flags',
      description:
        'Reports the boolean/positional flags on a timeline clip that other tools do not surface: isSpeedReversed, parentTrackIndex, isSelected, isAdjustmentLayer, isMGT, disabled, mediaType, and the clip matchName. Read-only.',
      inputSchema: z.object({
        trackIndex: z.number().describe('0-based video track index'),
        clipIndex: z.number().describe('0-based clip index'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_item_color_management',
      description:
        "Reports a project item's full color-management state: original/override color space, the list of valid override color spaces, embedded and input LUT IDs, and whether the media is color managed. Read this before set_clip_color_space so the name you pass is accepted.",
      inputSchema: z.object({ projectItemId: z.string() }),
    },
    {
      name: 'set_item_pixel_aspect_ratio',
      description:
        "Overrides a project item's pixel aspect ratio (ProjectItem.setOverridePixelAspectRatio). Takes a numerator and denominator. No direct getter for the override exists, so the call is reported as dispatched rather than verified.",
      inputSchema: z.object({
        projectItemId: z.string(),
        numerator: z.number().describe('PAR numerator, e.g. 1'),
        denominator: z.number().describe('PAR denominator, e.g. 1'),
      }),
    },
    {
      name: 'find_items_matching_media_path',
      description:
        "Finds project items whose media path matches a substring, using ProjectItem.findItemsMatchingMediaPath() on the root item. This is the DOM's own matcher; find_items_by_media_path walks the tree manually instead. Useful for locating every item that references one source file.",
      inputSchema: z.object({
        pathSubstring: z.string().describe('Substring of the media path to match'),
        ignoreSubclips: z
          .boolean()
          .optional()
          .describe('Exclude subclips from results. Default false.'),
      }),
    },
    {
      name: 'get_item_video_components',
      description:
        'Returns the ComponentCollection attached to a project item via ProjectItem.videoComponents() — the MASTER clip effects, which are distinct from the per-timeline-clip components that list_clip_effects reports. Master clip effects apply everywhere the item is used.',
      inputSchema: z.object({ projectItemId: z.string() }),
    },
    {
      name: 'find_keyframe_near_time',
      description:
        'Navigates keyframes on an effect parameter: reports the nearest, next, and previous keyframe to a given time, whether a keyframe exists exactly at that time, whether the param has any keyframes, and the interpolated value at that time. Uses ComponentParam findNearestKey/findNextKey/findPreviousKey/keyExistsAtTime/isEmpty/getValueAtTime. Read-only.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        componentIndex: z.number().describe('Index into clip.components'),
        paramIndex: z.number().describe('Index into component.properties'),
        timeSeconds: z.number().describe('Time to search around, in seconds'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_encoder_state',
      description:
        'Reports Adobe Media Encoder integration state: the last export media folder, and the count of available exporters. Read-only; does not launch AME.',
      inputSchema: z.object({}),
    },
    {
      name: 'set_encoder_xmp_options',
      description:
        'Controls whether AME writes XMP metadata embedded in the output file and/or as a sidecar (app.encoder.setEmbeddedXMPEnabled / setSidecarXMPEnabled). No getters exist for these flags, so the calls are reported as dispatched.',
      inputSchema: z.object({
        embedded: z.boolean().optional().describe('Embed XMP in the output file'),
        sidecar: z.boolean().optional().describe('Write a sidecar XMP file'),
      }),
    },
    {
      name: 'get_qe_project_info',
      description:
        'QE-level project introspection not available through the documented DOM: project size on disk, the undo stack index, and how many metadata cache entries are still pending indexing. Read-only.',
      inputSchema: z.object({}),
    },
    {
      name: 'create_bin_qe',
      description:
        'Creates a bin via the QE API (qe.project.newBin), optionally a smart bin (newSmartBin). An alternative to create_bin when the DOM path misbehaves; verifies by counting root items before and after.',
      inputSchema: z.object({
        name: z.string(),
        smart: z
          .boolean()
          .optional()
          .describe('Create a smart bin instead of a regular bin. Default false.'),
      }),
    },
    {
      name: 'import_media_qe',
      description:
        'Imports a media file via the QE API (qe.project.import), which accepts an isNumberedStills flag for image sequences. Verifies by counting project items before and after. Alternative route to import_media.',
      inputSchema: z.object({
        filePath: z.string().describe('Absolute path to the media file'),
        numberedStills: z
          .boolean()
          .optional()
          .describe('Treat as a numbered still sequence. Default false.'),
      }),
    },
    {
      name: 'get_qe_sequence_settings',
      description:
        'Reports QE-only sequence settings that the DOM does not expose: the preset list, multicam state, audio frame rate, audio/video display formats, field type, PAR, editing mode GUID, and preview codec. Read-only.',
      inputSchema: z.object({}),
    },
    {
      name: 'get_qe_clip_settings',
      description:
        'Reports QE-only clip settings the DOM does not expose: anti-alias quality, border colour and width, start/end percent, scale-to-frame-size, switch sources, static clip gain, frame blend and time interpolation type. Read-only.',
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
      }),
    },
    {
      name: 'set_track_lock_qe',
      description:
        'Locks or unlocks a single track via the QE track API (setLock), verifying against the DOM track isLocked() readback. Complements lock_track.',
      inputSchema: z.object({
        trackIndex: z.number(),
        locked: z.boolean(),
        audio: z
          .boolean()
          .optional()
          .describe('Target an audio track instead of video. Default false.'),
      }),
    },
    {
      name: 'get_media_processing_status',
      description:
        'Reports whether Premiere is still working on a media item: indexing, audio conforming, audio peak generation, pending state, whether it contains a speech track, its metadata size, and offline state. Use this to tell "playback is slow because Premiere is still ingesting" apart from a real performance problem. Read-only, via QEProjectItem.',
      inputSchema: z.object({
        trackIndex: z
          .number()
          .optional()
          .describe('Video track of a timeline clip whose project item to inspect. Default 0.'),
        clipIndex: z.number().optional().describe('Clip index on that track. Default 0.'),
      }),
    },
    {
      name: 'link_media_qe',
      description:
        'Relinks a project item to a media file via QEProjectItem.linkMedia(). Verifies by reading isOffline() back afterwards. An alternative to relink_media.',
      inputSchema: z.object({
        trackIndex: z.number().optional().describe('Video track of the timeline clip. Default 0.'),
        clipIndex: z.number().optional().describe('Clip index. Default 0.'),
        mediaPath: z.string().describe('Absolute path to the media file to link'),
        renameClip: z
          .boolean()
          .optional()
          .describe('Rename the clip to match the new media. Default false.'),
      }),
    },
    {
      name: 'create_proxy_qe',
      description:
        'Creates a proxy for a project item via QEProjectItem.createProxy(). Note that generating a proxy does NOT switch playback to it — call set_proxies_enabled(true) as well, which is the usual reason proxies appear to have no effect.',
      inputSchema: z.object({
        trackIndex: z.number().optional().describe('Video track of the timeline clip. Default 0.'),
        clipIndex: z.number().optional().describe('Clip index. Default 0.'),
        presetPath: z.string().describe('Absolute path to the ingest/proxy preset (.epr)'),
      }),
    },
    {
      name: 'open_item_in_source_qe',
      description:
        'Opens a project item in the Source Monitor via QEProjectItem.openInSource() — a zero-argument QE route that avoids the path handling in open_in_source.',
      inputSchema: z.object({
        trackIndex: z.number().optional().describe('Video track of the timeline clip. Default 0.'),
        clipIndex: z.number().optional().describe('Clip index. Default 0.'),
      }),
    },
    {
      name: 'get_production_info',
      description:
        'Reports Productions / Team Projects status using only READ-ONLY qe.ea calls: login state, user identity, whether this is a Production, share/sync command availability, unshared changes, local media presence, archived production list, invite list, admin flag, and remote server build. Does not mutate any cloud state.',
      inputSchema: z.object({}),
    },
    {
      name: 'get_cloud_queue_info',
      description:
        "Reports read-only state from Premiere's cloud task queue dispatcher (qe.tqm): active region, supported regions, and the queue list object type. Does NOT log in, create queues, or fetch auth tokens. Exploratory — this surface is undocumented.",
      inputSchema: z.object({}),
    },
    {
      name: 'attach_sequence_custom_property',
      description:
        'Attaches a custom key/value property to a sequence via Sequence.attachCustomProperty(). Useful for stamping pipeline metadata (shot code, version, status) onto a sequence. No getter exists for these properties, so the call is reported as dispatched rather than verified.',
      inputSchema: z.object({
        key: z.string(),
        value: z.string(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_proxies_enabled',
      description:
        'Reports whether Premiere is currently PLAYING BACK proxies (the global Toggle Proxies state). This is separate from whether proxies are attached: a clip can have a proxy attached and still play at full resolution because the toggle is off, which is the usual reason "I made proxies but playback is still slow". Pair with get_proxy_status (attachment) to tell the two apart.',
      inputSchema: z.object({}),
    },
    {
      name: 'set_proxies_enabled',
      description:
        'Turns proxy playback on or off globally — the scripted equivalent of the Toggle Proxies button. Attaching proxies alone does not switch playback to them; this is what does. Verifies by reading the flag back.',
      inputSchema: z.object({
        enabled: z
          .boolean()
          .describe('true = play proxies, false = play full-resolution originals'),
      }),
    },

    // Verification & introspection
    {
      name: 'timeline_fingerprint',
      description:
        'Computes a structural checksum of the active sequence (clip positions + names hash). Changes if anything moves or is renamed.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'snapshot_state',
      description:
        'Saves the current sequence structure (all clip positions, names, effects count) to a JSON file for later comparison.',
      inputSchema: z.object({ outputPath: z.string(), sequenceId: z.string().optional() }),
    },
    {
      name: 'assert_clips_unchanged',
      description:
        'Compares the current sequence state to a previously saved snapshot JSON. Returns a diff of any changes.',
      inputSchema: z.object({ snapshotPath: z.string(), sequenceId: z.string().optional() }),
    },
    {
      name: 'get_app_property',
      description: 'Reads an application-level property via app.properties.getProperty(key).',
      inputSchema: z.object({ key: z.string() }),
    },
    {
      name: 'set_app_property',
      description:
        'Sets an application-level property via app.properties.setProperty(key, value) with readback verification.',
      inputSchema: z.object({ key: z.string(), value: z.string() }),
    },
    {
      name: 'get_autosave_settings',
      description:
        "Reads Premiere's Auto Save preferences (enabled, interval in minutes, max project versions, also-save-current-project, save-to-cloud) plus the auto-save folder. Wraps the BE.Prefs.AutoSave.* keys so callers do not have to know them. Read-only.",
      inputSchema: z.object({}),
    },
    {
      name: 'set_autosave_settings',
      description:
        "Sets Premiere's Auto Save preferences with per-key readback verification. IMPORTANT: app.properties writes the LIVE preference; Premiere only flushes preferences to its prefs file on a graceful quit, so a crash or force-quit before then reverts the change. Set persistToPrefsFile (default true) to also rewrite the single matching tag in the prefs file on disk, backed up first, so both stores agree. A running auto-save timer may not re-read the interval until the next cycle.",
      inputSchema: z.object({
        enabled: z
          .boolean()
          .optional()
          .describe('BE.Prefs.AutoSave.DoSave — master Auto Save switch.'),
        intervalMinutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe('Minutes between auto-saves.'),
        maxVersions: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('How many auto-save versions to keep before the oldest is discarded.'),
        alsoSaveCurrentProject: z
          .boolean()
          .optional()
          .describe(
            'Also save the open project itself, not just a copy into the Auto-Save folder.',
          ),
        saveToCloud: z.boolean().optional().describe('Auto-save backups to Creative Cloud.'),
        persistToPrefsFile: z
          .boolean()
          .optional()
          .describe(
            "Also write the value into Premiere's prefs file on disk so a force-quit cannot revert it. Default true.",
          ),
      }),
    },
    {
      name: 'project_file_inspect',
      description:
        'Reads a .prproj FILE ON DISK without opening it in Premiere, and reports its format version, whether it is gzip-compressed, a structural node census (including ObjectUID definition counts that match what Premiere reports for sequences/master clips/bins), the SHA-256, and whether the container round-trips byte-identically. Optionally counts occurrences of literal strings, which is how you find a unique match before editing. Read-only: opens nothing, writes nothing, and works while Premiere is closed. Useful for auditing archived projects, finding which project references a media path, or checking a cut without waiting for Premiere to load it.',
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe('Absolute path to a .prproj file. Any other extension is refused.'),
        countStrings: z
          .array(z.string())
          .optional()
          .describe(
            'Literal strings to count occurrences of in the project XML. Use this to confirm a find string is unique before calling project_file_edit.',
          ),
        xmlExcerptAround: z
          .string()
          .optional()
          .describe(
            'Return a short XML excerpt around the first occurrence of this literal, so you can see the surrounding markup before editing.',
          ),
      }),
    },
    {
      name: 'project_file_edit',
      description: `Edits a .prproj FILE ON DISK by literal string replacement, writing the result to a NEW file. This reaches project state that ExtendScript cannot (Premiere exposes no scripted menu bus), but it is deliberately hard to misuse and is DISABLED by default: set ${SURGERY_ENV_FLAG}=1 to enable. Refuses unless every invariant holds: both paths must end in .prproj; the output path must not already exist and is never overwritten, even if it appears mid-edit (never edits in place); neither file may be open in Premiere (checked against the running host, not self-certified); the format version must be recognised (${[...PRPROJ_SUPPORTED_FORMAT_VERSIONS].join(', ')}); re-encoding the untouched container must reproduce the original bytes exactly; each replacement must match its expectedMatches count exactly (there is no replace-all), and all are applied in one pass over the original; the structural node census must be unchanged, and without allowMarkupEdit so must every element's open/close counts; and the written file is re-read and compared. Whether Premiere will actually LOAD the result is reported as unverified unless you open it — XML validity is not acceptance. Use dryRun first.`,
      inputSchema: z.object({
        sourcePath: z.string().describe('Absolute path to the .prproj to read. Never modified.'),
        outputPath: z.string().describe('Absolute path to write. Must not already exist.'),
        replacements: z
          .array(
            z.object({
              find: z
                .string()
                .min(1)
                .describe(
                  "Literal text to find in the project XML. Not a regex. A raw < or > is refused unless allowMarkupEdit is set. Must not contain, be contained in, or overlap another replacement's find.",
                ),
              replace: z
                .string()
                .describe(
                  'Literal replacement. A bare & is refused — write &amp;. A raw < or > is refused unless allowMarkupEdit is set, since that is editing markup rather than text.',
                ),
              expectedMatches: z
                .number()
                .int()
                .min(1)
                .max(100000)
                .optional()
                .describe(
                  'Required match count. Default 1. A different actual count refuses the whole edit.',
                ),
              allowMarkupEdit: z
                .boolean()
                .optional()
                .describe(
                  'Permit raw < or > in find or replace, i.e. restructuring the XML rather than changing text. Default false.',
                ),
            }),
          )
          .min(1)
          .max(200)
          .describe(
            'Replacements to apply. Every match count is checked against the original document, and all replacements are then applied in a single pass over that same original, so replaced text is never rescanned: [A->B, B->C] turns A into B and B into C. A find contained in another find, or matches of two finds that overlap, are refused rather than resolved by order.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'Validate every invariant and report the match counts and census without writing anything. Default false.',
          ),
        allowCensusChange: z
          .boolean()
          .optional()
          .describe(
            'Permit the structural node census to change. Default false. Only set this when you intend to add or remove structure and have inspected the diff.',
          ),
      }),
    },
    {
      name: 'get_panel_visibility',
      description:
        'Returns the visibility state of key Premiere panels using app.isWindowVisible().',
      inputSchema: z.object({
        panels: z
          .array(z.string())
          .optional()
          .describe(
            'Panel names to check. Default: Timeline, Source Monitor, Program Monitor, Effects, Lumetri Color.',
          ),
      }),
    },
    {
      name: 'api_surface_report',
      description:
        'Returns a static report of the confirmed API surface: QE clip methods, QE sequence methods, confirmed DOM methods, and the honest wall of inaccessible features.',
      inputSchema: z.object({}),
    },

    // QE final tools
    {
      name: 'apply_morph_cut',
      description:
        "Applies a Morph Cut transition at a clip's out-point using QE, then verifies the transition by readback (QE transition enumeration, falling back to the transition count in an FCP XML export). Reports the transition as verified and the background frame ANALYSIS as separately unverified — until the analysis renders, the cut plays as a dissolve. Poll get_sequence_render_status.",
      inputSchema: z.object({
        trackIndex: z.number(),
        clipIndex: z.number(),
        durationFrames: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Transition length in frames. Default: one second of the sequence timebase.'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'set_preview_quality',
      description:
        'Sets sequence preview render quality: maxRenderQuality (bool), maxBitDepth (bool), previewWidth/Height. Uses QE sequence methods.',
      inputSchema: z.object({
        maxRenderQuality: z.boolean().optional(),
        maxBitDepth: z.boolean().optional(),
        previewWidth: z.number().optional(),
        previewHeight: z.number().optional(),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_ea_user_info',
      description:
        'Returns the logged-in Adobe/Premiere account info via qe.ea: email, username, and login status.',
      inputSchema: z.object({}),
    },
    {
      name: 'import_project_items',
      description:
        'Imports items from another .prproj file into the current project via QE importProject.',
      inputSchema: z.object({
        projectPath: z.string().describe('Absolute path to .prproj file'),
        includeSequences: z.boolean().optional().default(true),
      }),
    },
    {
      name: 'qe_sequence_info',
      description:
        'Returns all QE-level sequence properties: CTI, inPoint, outPoint, workInPoint, workOutPoint, editingMode GUID, track counts, preview codec, quality flags.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'render_needs_preview',
      description:
        'Quick check: does the active sequence have any unrendered (red/yellow) segments? Returns a simple bool plus counts.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'open_fcp_xml_project',
      description:
        'Opens an FCP XML file as a new project via app.openFCPXML(path, sequenceName). Confirmed on 26.3.2.',
      inputSchema: z.object({
        xmlPath: z.string(),
        sequenceName: z.string().optional().default(''),
      }),
    },

    // Media Management
    {
      name: 'import_media',
      description:
        'Imports a media file (video, audio, image) into the current Premiere Pro project. Target a nested bin with binId (a bin nodeId, unambiguous — preferred) or binName, which also accepts a "/"-separated path. An unresolvable bin fails without importing; the bin actually used is read back in the response as binId/binName/treePath. A file already in the project is reported with alreadyImported=true and is NOT moved into the requested bin.',
      inputSchema: z.object({
        filePath: z.string().describe('The absolute path to the media file to import'),
        binName: z
          .string()
          .optional()
          .describe(
            'Destination bin by name. Use a "/"-separated path ("Scenes/Scene 008/SC008_0710") for a nested bin, or a single name to deep-search the tree (ambiguous single names are rejected rather than guessed). Omit to import to the project root.',
          ),
        binId: z
          .string()
          .optional()
          .describe(
            'Destination bin nodeId — the unambiguous way to target a nested bin, e.g. the binId returned by create_bin. Takes precedence over binName.',
          ),
      }),
    },
    {
      name: 'import_fcp_xml',
      description:
        'Imports a Final Cut Pro 7 XML (XMEML) file into the current project. Premiere creates a new sequence with the cuts/clips defined in the XML. The import requests Premiere UI suppression, but malformed or unsupported XML can still be rejected by Premiere. Use legacy FCP7 XML, not modern FCPXML 1.x from Final Cut Pro X.',
      inputSchema: z.object({
        filePath: z
          .string()
          .describe('The absolute path to the FCP7 XML file (.xml extension typical)'),
      }),
    },
    {
      name: 'import_edl',
      description:
        "Reports that CMX 3600 EDL import is unavailable through this dialog-safe MCP server. Premiere's EDL API opens an interactive sequence/source-media dialog that blocks CEP. Use import_fcp_xml for unattended timeline interchange instead.",
      inputSchema: z.object({
        filePath: z.string().describe('The absolute path to the .edl file'),
      }),
    },
    {
      name: 'import_folder',
      description:
        'Imports all media files from a folder into the current Premiere Pro project. Target a nested bin with binId (a bin nodeId, unambiguous — preferred, e.g. straight from create_bin) or binName, which also accepts a "/"-separated path. An unresolvable or ambiguous bin fails before anything is imported; the bin actually used is reported back.',
      inputSchema: z.object({
        folderPath: z.string().describe('The absolute path to the folder containing media files'),
        binName: z
          .string()
          .optional()
          .describe(
            'Destination bin by name. Use a "/"-separated path ("Scenes/Scene 008/SC008_0710") for a nested bin, or a single name to deep-search the tree (ambiguous single names are rejected). Omit to import to the project root.',
          ),
        recursive: z.boolean().optional().describe('Whether to import from subfolders recursively'),
        binId: z
          .string()
          .optional()
          .describe(
            'Destination bin nodeId — the unambiguous way to target a nested bin. Takes precedence over binName.',
          ),
      }),
    },
    {
      name: 'create_bin',
      description:
        'Creates a new bin (folder) in the project panel to organize media. Nest it by naming a parent: parentBinId (a bin nodeId, unambiguous — preferred) or parentBinName. parentBinName resolves a nested bin too — pass a "/"-separated path like "Scenes/Scene-008" to walk the hierarchy, or a single name to search the whole tree (which fails safely if two bins share that name rather than reparenting to the wrong one).',
      inputSchema: z.object({
        name: z.string().describe('The name for the new bin'),
        parentBinName: z
          .string()
          .optional()
          .describe(
            'Parent bin to create this bin inside, by name. Use a "/"-separated path ("Scenes/Scene-008") for a nested parent, or a single name to deep-search the tree (ambiguous single names are rejected). Ignored if parentBinId is given.',
          ),
        parentBinId: z
          .string()
          .optional()
          .describe(
            'Parent bin nodeId — the unambiguous way to target a nested bin. Takes precedence over parentBinName.',
          ),
      }),
    },

    // Sequence Management
    {
      name: 'create_sequence',
      description:
        "Creates a new sequence from a specific installed .sqpreset file without opening Premiere's New Sequence dialog. For footage-driven edits, prefer create_sequence_from_clips; for an empty copy of an existing sequence, use duplicate_sequence with clearContents=true.",
      inputSchema: z.object({
        name: z.string().describe('The name for the new sequence'),
        presetPath: z
          .string()
          .describe(
            'Absolute path to an installed Premiere .sqpreset sequence preset. Required so Premiere does not show the native New Sequence dialog.',
          ),
        frameRate: z
          .number()
          .optional()
          .describe(
            'Optional frames per second (e.g. 23.976, 24, 25, 30). The preset sets the initial rate; when given, the new sequence is set to this rate afterward and the actual rate is read back and reported (fixes the classic 24 vs 23.976 mismatch). A warning is returned if Premiere does not accept it.',
          ),
      }),
    },
    {
      name: 'duplicate_sequence',
      description:
        "Creates a copy of an existing sequence with a new name. Set clearContents=true to get an EMPTY copy that inherits the source sequence's exact settings (frame rate, resolution, track layout) — the reliable way to auto-create a correctly-specced blank target, since create_sequence ignores frame rate.",
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence to duplicate. Defaults to the active sequence.'),
        newName: z.string().describe('The name for the new sequence copy'),
        clearContents: z
          .boolean()
          .optional()
          .describe(
            "When true, remove all clips from the copy so it is empty but keeps the source's frame rate/resolution/track layout. Default false (full copy).",
          ),
      }),
    },
    {
      name: 'delete_sequence',
      description: 'Deletes a sequence from the project.',
      inputSchema: z.object({
        sequenceId: z.string().describe('The ID of the sequence to delete'),
      }),
    },

    // Recovery Boundary — cheap, explicit snapshots before risky work.
    {
      name: 'create_recovery_checkpoint',
      description:
        'Takes a recovery snapshot of a sequence by cloning it into a tagged copy named "[recovery] <label> @ <timestamp>". Use this BEFORE a risky or bulk edit so you can get the pre-edit state back with restore_recovery_checkpoint. The snapshot travels with the project (it is a real sequence), so it survives save/close/reopen without any external store. Non-destructive: the source sequence is untouched. Set PREMIERE_MCP_AUTO_CHECKPOINT=1 to have bulk/destructive operations do this automatically.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe(
            'ID of the sequence to snapshot. Defaults to the active sequence when omitted.',
          ),
        label: z
          .string()
          .optional()
          .describe(
            'Short human label recorded in the checkpoint name (e.g. "before ripple cleanup"). Defaults to "checkpoint".',
          ),
      }),
    },
    {
      name: 'list_recovery_checkpoints',
      description:
        'Lists the recovery checkpoints in the project — every sequence whose name carries the "[recovery]" tag — with each one\'s parsed label and creation timestamp, most recent first. Use this to find a snapshot to restore_recovery_checkpoint, or to prune old ones with delete_sequence.',
      inputSchema: z.object({
        labelContains: z
          .string()
          .optional()
          .describe(
            'Optional case-insensitive substring; only checkpoints whose label contains it are returned.',
          ),
      }),
    },
    {
      name: 'restore_recovery_checkpoint',
      description:
        "Restores a recovery checkpoint by cloning it into a fresh working sequence (optionally made active), leaving the checkpoint itself intact so it can be restored again. This does NOT surgically rewind the original sequence in place — Premiere offers no safe API for that — it hands you a clean copy of the snapshot to continue from. Pass the checkpoint's sequence ID from list_recovery_checkpoints.",
      inputSchema: z.object({
        checkpointSequenceId: z
          .string()
          .describe(
            'The sequence ID of the checkpoint to restore (from list_recovery_checkpoints).',
          ),
        newName: z
          .string()
          .optional()
          .describe(
            'Name for the restored working sequence. Defaults to the checkpoint\'s label with " (restored)" appended.',
          ),
        setActive: z
          .boolean()
          .optional()
          .describe('Open the restored sequence as the active timeline. Default true.'),
      }),
    },

    // Timeline Operations
    {
      name: 'add_to_timeline',
      description:
        'Adds a media clip from the project panel to a sequence timeline at a specific track and time.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe(
            'The ID of the sequence (timeline) to add the clip to. Defaults to the active sequence.',
          ),
        projectItemId: z.string().describe('The ID of the project item (clip) to add'),
        trackIndex: z.number().describe('The index of the video or audio track (0-based)'),
        time: z
          .number()
          .describe('The time in seconds where the clip should be placed on the timeline'),
        insertMode: z
          .enum(['overwrite', 'insert'])
          .optional()
          .describe('Whether to overwrite existing content or insert and shift'),
        linkAudio: z
          .boolean()
          .optional()
          .describe(
            "When false, removes the auto-linked audio counterpart that Premiere places on audio tracks for video-track clips. Useful for video overlays whose source media (e.g. Remotion .mov outputs) carry silent PCM that would overwrite existing audio. Default true (preserves Premiere's native linking behavior).",
          ),
        sourceInPoint: z
          .number()
          .optional()
          .describe(
            'Source IN point in seconds — the start of the sub-range to pull from the source (footage or sequence). Replicates marking an in point in the Source monitor. Requires sourceOutPoint. When omitted, the whole source (or its current marks) is placed.',
          ),
        sourceOutPoint: z
          .number()
          .optional()
          .describe(
            'Source OUT point in seconds — the end of the sub-range to pull from the source. Replicates marking an out point in the Source monitor. Requires sourceInPoint.',
          ),
      }),
    },
    {
      name: 'add_to_timeline_batch',
      description:
        'Places MANY clips onto one sequence in a single round-trip — the fast path for rebuilding a whole edit (e.g. a Descript/EDL stringout). Equivalent to calling add_to_timeline (overwrite) once per clip, but ~50x faster because it loops inside one ExtendScript pass instead of one file round-trip per clip. Each clip supports per-clip linkAudio and sourceInPoint/sourceOutPoint (Source-monitor in/out). Returns a per-clip result array so one bad clip does not sink the batch, plus an aggregate status: top-level success is true ONLY when every clip placed; status is "success" | "partial" | "failure" with placed/failed/total counts.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe(
            'The ID of the sequence (timeline) to add clips to. Defaults to the active sequence.',
          ),
        mode: z
          .enum(['absolute', 'append'])
          .optional()
          .describe(
            'Placement mode. "absolute" (default) uses each clip\'s time. "append" ignores time and lays clips end-to-end with NO gaps: each clip on a given track starts exactly where the previous one ends (seeded from that track\'s existing content), chained off the placed clip\'s real frame-aligned end so float-second rounding cannot open a 1-frame gap. Use append to rebuild a continuous stringout.',
          ),
        clips: z
          .array(
            z.object({
              projectItemId: z
                .string()
                .describe('The ID of the project item (clip / multicam) to add'),
              trackIndex: z.number().describe('The index of the video or audio track (0-based)'),
              time: z
                .number()
                .optional()
                .describe(
                  'Timeline position in seconds where the clip is placed (overwrite). Required in "absolute" mode; ignored in "append" mode.',
                ),
              linkAudio: z
                .boolean()
                .optional()
                .describe(
                  "When false, removes the auto-linked audio counterpart Premiere places on audio tracks for a video-track clip whose source carries an embedded audio stream (prevents overwriting existing audio in overlay/rebuild workflows). Default true (preserves Premiere's native linking).",
                ),
              sourceInPoint: z
                .number()
                .optional()
                .describe('Source IN point in seconds (requires sourceOutPoint)'),
              sourceOutPoint: z
                .number()
                .optional()
                .describe('Source OUT point in seconds (requires sourceInPoint)'),
            }),
          )
          .describe('Ordered list of clips to place. All use overwrite mode.'),
      }),
    },
    {
      name: 'remove_from_timeline',
      description:
        'Removes a clip from the timeline. Pass sequenceId when the clip ID came from list_sequence_tracks for a non-active sequence.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip on the timeline to remove'),
        sequenceId: z
          .string()
          .optional()
          .describe(
            'Optional sequence ID to search. If omitted, searches the active sequence first, then all sequences.',
          ),
        deleteMode: z
          .enum(['ripple', 'lift'])
          .optional()
          .describe('Whether to ripple delete (close gap) or lift (leave gap)'),
      }),
    },
    {
      name: 'move_clip',
      description:
        'Moves a clip along the timeline, keeping it on its current track. To move a clip to a different track, use move_clip_to_track: on this Premiere build that is a reinsert that gives the clip a new id and refuses an occupied destination unless overwrite:true, so it is deliberately a separate call rather than an option here.',
      inputSchema: z
        .object({
          clipId: z.string().describe('The ID of the clip to move'),
          newTime: z.number().describe('The new time position in seconds'),
          // .strict() so a leftover newTrackIndex is an error rather than being
          // silently dropped. Zod strips unknown keys by default, which would have
          // let a caller migrating from the old signature keep passing it and keep
          // believing the clip changed track.
        })
        .strict(),
    },
    {
      name: 'trim_clip',
      description:
        'Trims a clip (and its linked audio/video) to new SOURCE in/out points, or to a timeline duration, keeping every remaining frame where it was on the timeline. Snaps to the frame grid, refuses trims past the media or into a neighbour, and restores the clip if Premiere does not apply the edit.',
      inputSchema: z
        .object({
          clipId: z.string().describe('The ID of the clip on the timeline to trim'),
          inPoint: z
            .number()
            .optional()
            .describe('The new in point in seconds from the start of the clip'),
          outPoint: z
            .number()
            .optional()
            .describe(
              'The new out point in seconds from the start of the clip; cannot be combined with duration',
            ),
          duration: z
            .number()
            .optional()
            .describe(
              'Alternative: set the desired timeline duration in seconds; cannot be combined with outPoint',
            ),
        })
        .refine((value) => value.outPoint === undefined || value.duration === undefined, {
          message: 'outPoint and duration cannot be used together',
        }),
    },
    {
      name: 'split_clip',
      description: 'Splits a clip at a specific time point, creating two separate clips.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip to split'),
        splitTime: z
          .number()
          .describe(
            'Where to cut, in seconds from the START OF THE CLIP (not the sequence). Must be inside the clip.',
          ),
      }),
    },
    {
      name: 'razor_timeline_at_time',
      description:
        'Cuts across multiple tracks in a sequence at an absolute timeline time. If no track arrays are provided, all video and audio tracks are cut.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('Optional sequence ID. Defaults to the active sequence.'),
        time: z.number().describe('Absolute timeline time in seconds where the cut should occur.'),
        videoTrackIndices: z
          .array(z.number().int().min(0))
          .optional()
          .describe('Optional video track indices to cut. Defaults to all video tracks.'),
        audioTrackIndices: z
          .array(z.number().int().min(0))
          .optional()
          .describe('Optional audio track indices to cut. Defaults to all audio tracks.'),
      }),
    },

    // Effects and Transitions
    {
      name: 'apply_effect',
      description:
        "Applies a visual or audio effect to a clip, identifies the exact newly created component (reporting its matchName), and verifies parameter readbacks. Effects resolve by display name only, so a stock name can silently resolve to a third-party plugin; pass expectedMatchName to enforce the effect's identity and fail (rolling back when safe) on a mismatch.",
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip to apply the effect to'),
        effectName: z
          .string()
          .describe('The name of the effect to apply (e.g., "Gaussian Blur", "Lumetri Color")'),
        parameters: z
          .record(z.string(), z.any())
          .optional()
          .describe("Key-value pairs for the effect's parameters"),
        expectedMatchName: z
          .string()
          .optional()
          .describe(
            'Optional identity guard: the effect\'s internal matchName (e.g. "AE.ADBE Gaussian Blur 2"). If the landed effect\'s matchName differs, the add fails and is rolled back when it is the only user effect on the clip.',
          ),
      }),
    },
    {
      name: 'crop_clip',
      description:
        "Crops a timeline clip using Premiere Pro's built-in Crop video effect. Reuses an existing Crop effect on the clip when present; otherwise adds one. Omitted parameters keep their current/default values.",
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the timeline video clip to crop'),
        left: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Percent to crop from the left edge (0-100)'),
        right: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Percent to crop from the right edge (0-100)'),
        top: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Percent to crop from the top edge (0-100)'),
        bottom: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Percent to crop from the bottom edge (0-100)'),
        zoom: z
          .boolean()
          .optional()
          .describe('Crop effect Zoom toggle: scales the cropped image back up to fill the frame'),
        edgeFeather: z.number().min(0).optional().describe('Edge Feather amount in pixels'),
      }),
    },
    {
      name: 'add_transition',
      description:
        'Adds a transition (e.g., cross dissolve) between two adjacent clips on the timeline.',
      inputSchema: z.object({
        clipId1: z.string().describe('The ID of the first clip (outgoing)'),
        clipId2: z.string().describe('The ID of the second clip (incoming)'),
        transitionName: z
          .string()
          .describe('The name of the transition to add (e.g., "Cross Dissolve")'),
        duration: z.number().describe('The duration of the transition in seconds'),
      }),
    },
    {
      name: 'add_transition_to_clip',
      description:
        'Adds a transition to the beginning or end of a single clip. Check status and verified in the result: accepted_unverified means Premiere accepted the command but inspection could not prove the edit, so do not retry automatically.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        transitionName: z.string().describe('The name of the transition'),
        position: z
          .enum(['start', 'end'])
          .describe('Whether to add the transition at the start or end of the clip'),
        duration: z.number().describe('The duration of the transition in seconds'),
      }),
    },

    // Audio Operations
    {
      name: 'adjust_audio_levels',
      description: 'Adjusts the volume (gain) of an audio clip on the timeline.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the audio clip to adjust'),
        level: z
          .number()
          .describe('The new audio level in decibels (dB). Can be positive or negative.'),
      }),
    },

    // Audio Analysis
    {
      name: 'detect_silence',
      description:
        "Analyzes a media file's audio for silent stretches using ffmpeg's silencedetect filter, run locally via child_process -- NOT via Premiere's scripting API, which has no audio-level/RMS reading capability at all (confirmed: every audio tool in this codebase only writes levels, never reads them). Requires ffmpeg on PATH; returns an explicit error if it is not found rather than failing silently. This is DETECTION ONLY -- it does not cut or modify anything. Use the returned intervals with split_clip/ripple_delete/razor_timeline_at_time if you want to remove the silence.",
      inputSchema: z
        .object({
          mediaPath: z
            .string()
            .optional()
            .describe('Direct filesystem path to the media file to analyze'),
          projectItemId: z
            .string()
            .optional()
            .describe(
              'Project item ID to resolve to a media path instead of passing mediaPath directly',
            ),
          noiseThresholdDb: z
            .number()
            .optional()
            .describe(
              'Silence threshold in dBFS, e.g. -30 (default -30). Audio quieter than this is considered silent.',
            ),
          minDurationSeconds: z
            .number()
            .optional()
            .describe(
              'Minimum duration in seconds for a quiet stretch to be reported as silence (default 1.5)',
            ),
        })
        .refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId',
        }),
    },
    {
      name: 'add_audio_keyframes',
      description: 'Adds keyframes to audio levels for dynamic volume changes.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the audio clip'),
        keyframes: z
          .array(
            z.object({
              time: z.number().describe('Time in seconds'),
              level: z.number().describe('Audio level in dB'),
            }),
          )
          .describe('Array of keyframe data'),
      }),
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
              startTime: z
                .number()
                .describe('When to begin ducking, in seconds (clip-source-time absolute)'),
              endTime: z.number().describe('When to recover from ducking, in seconds'),
              duckedDb: z
                .number()
                .describe('Lower level in dB during this window (e.g. -38 for narrative pause)'),
            }),
          )
          .describe(
            'Windows where the clip should duck below baseDb. Empty array = sustained baseDb only.',
          ),
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
          .describe(
            'Clip end time anchor for last keyframe; if omitted, last duck window endTime + 1s is used',
          ),
      }),
    },
    {
      name: 'mute_track',
      description: 'Mutes or unmutes an entire audio track.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        trackIndex: z.number().describe('The index of the audio track'),
        muted: z.boolean().describe('Whether to mute (true) or unmute (false) the track'),
      }),
    },

    // Text and Graphics
    {
      name: 'add_text_overlay',
      description:
        'Adds a text layer (title) over the video timeline. Requires a MOGRT (.mogrt) template file path. Supports up to 4 text fields (text, text2, text3, text4) — each populates the Nth "AE.ADBE Text" component in the MOGRT (e.g., for Basic Lower Third: text=main title, text2=subtitle).',
      inputSchema: z.object({
        text: z
          .string()
          .describe('Text for the first AE text component in the MOGRT (typically the main title)'),
        text2: z
          .string()
          .optional()
          .describe('Text for the second AE text component (e.g., subtitle of a lower third)'),
        text3: z.string().optional().describe('Text for the third AE text component (if present)'),
        text4: z.string().optional().describe('Text for the fourth AE text component (if present)'),
        sequenceId: z
          .string()
          .optional()
          .describe('The sequence to add the text to. Defaults to the active sequence.'),
        trackIndex: z
          .number()
          .describe(
            'The video track to place the text on (0-indexed; create the track first via add_track if needed)',
          ),
        startTime: z.number().describe('The time in seconds when the text should appear'),
        duration: z
          .number()
          .describe(
            "How long the text should remain on screen in seconds (best-effort; the MOGRT's natural duration may take precedence)",
          ),
        mogrtPath: z
          .string()
          .optional()
          .describe('Absolute path to a .mogrt template file (required for text overlays)'),
        textPropertyName: z
          .string()
          .optional()
          .describe(
            'Override: explicit displayName of the property to write into. When set, only `text` is written (text2/text3/text4 are ignored) and the call fails if no property with that displayName exists. Use only when auto-detection picks the wrong field.',
          ),
        rollbackOnTextFailure: z
          .boolean()
          .optional()
          .describe(
            'If true, remove the imported timeline Graphic when every requested text write fails. Defaults to false; the imported project item may remain in the Project panel.',
          ),
      }),
    },

    // Color Correction
    {
      name: 'color_correct',
      description: 'Applies basic color correction adjustments to a video clip.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip to color correct'),
        brightness: z
          .number()
          .optional()
          .describe(
            'Mapped to Lumetri EXPOSURE, which is the closest equivalent — Lumetri has no parameter called Brightness on this build',
          ),
        exposure: z
          .number()
          .optional()
          .describe('Lumetri Exposure (stops). Same parameter as brightness; prefer this name'),
        contrast: z.number().optional().describe('Contrast adjustment'),
        saturation: z.number().optional().describe('Saturation, where 100 is neutral'),
        vibrance: z
          .number()
          .optional()
          .describe('Vibrance — saturation weighted toward less-saturated tones'),
        hue: z
          .number()
          .optional()
          .describe(
            'NOT AVAILABLE: Lumetri Basic Correction exposes no Hue parameter on this build. Passing it returns an explicit unsupported result rather than silently doing nothing',
          ),
        highlights: z
          .number()
          .optional()
          .describe('Adjustment for the brightest parts of the image'),
        shadows: z.number().optional().describe('Adjustment for the darkest parts of the image'),
        whites: z.number().optional().describe('White point adjustment'),
        blacks: z.number().optional().describe('Black point adjustment'),
        temperature: z.number().optional().describe('Color temperature adjustment'),
        tint: z.number().optional().describe('Tint adjustment'),
      }),
    },
    {
      name: 'apply_lut',
      description:
        "Puts a .cube LUT in the clip's Lumetri Input LUT slot and verifies it by render: Input LUT is a dropdown set by index, so each entry is rendered and the one matching ffmpeg's lut3d of the ungraded frame is kept. Takes several seconds. A LUT Premiere does not list cannot be selected; installIfMissing copies it into the user LUT folder (restart Premiere, then rerun).",
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        lutPath: z.string().describe('Absolute path to the .cube LUT file'),
        intensity: z
          .number()
          .optional()
          .describe('Ignored: Input LUT has no intensity control. Kept for compatibility.'),
        installIfMissing: z
          .boolean()
          .optional()
          .describe(
            "If the LUT is not in Premiere's list, copy it to ~/Library/Application Support/Adobe/Common/LUTs/Input (needs a Premiere restart). Default false.",
          ),
      }),
    },

    // Export and Rendering
    {
      name: 'export_sequence',
      description:
        'Renders and exports a sequence to a video file. This is for creating the final video.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence to export. Defaults to the active sequence.'),
        outputPath: z
          .string()
          .describe('The absolute path where the final video file will be saved'),
        presetPath: z
          .string()
          .optional()
          .describe(
            'Absolute path to an export preset file (.epr). Required unless presetName uniquely resolves through get_encoder_presets.',
          ),
        presetName: z
          .string()
          .optional()
          .describe(
            'Exact user preset display name or filename stem. Must resolve to exactly one discovered .epr preset.',
          ),
        sourceRange: z
          .enum(['entire', 'in_out', 'work_area'])
          .optional()
          .describe(
            'Export source range. Defaults to entire. Requested ranges are never silently substituted.',
          ),
        allowOverwrite: z
          .boolean()
          .optional()
          .describe('Allow writing to an existing output file. Defaults to false.'),
        removeOnCompletion: z
          .boolean()
          .optional()
          .describe(
            'Pass AME removeOnCompletion. Defaults to true to preserve existing queue behavior.',
          ),
        format: z
          .enum(['mp4', 'mov', 'avi', 'h264', 'prores'])
          .optional()
          .describe('Deprecated hint only; the .epr preset controls codec/container.'),
        quality: z
          .enum(['low', 'medium', 'high', 'maximum'])
          .optional()
          .describe('Deprecated hint only; the .epr preset controls quality.'),
        resolution: z
          .string()
          .optional()
          .describe('Deprecated hint only; the .epr preset controls resolution.'),
      }),
    },
    {
      name: 'export_frame',
      description:
        "Exports a single frame from a sequence as an image file. Supported formats (all verified against Premiere's QE exporters): png, jpg/jpeg, tiff/tif, dpx, tga/targa.",
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        time: z.number().describe('The time in seconds to export the frame from'),
        outputPath: z.string().describe('The absolute path where the image file will be saved'),
        format: z
          .enum(['png', 'jpg', 'jpeg', 'tiff', 'tif', 'dpx', 'tga', 'targa'])
          .optional()
          .describe('The image format (default png)'),
      }),
    },

    // Markers
    {
      name: 'add_marker',
      description:
        'Adds a marker to the specified sequence for navigation or notes. The sequence does not have to be the active one.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The sequence ID (GUID) to add the marker to, as returned in the "id" field by list_sequences or get_active_sequence. Defaults to the active sequence.',
          ),
        time: z.number().describe('The time in seconds where the marker should be placed'),
        name: z.string().describe('The name/label for the marker'),
        comment: z.string().optional().describe('Optional comment or description for the marker'),
        color: MarkerColorSchema.optional().describe(MARKER_COLOR_DESCRIPTION),
        duration: z
          .number()
          .optional()
          .describe('Duration in seconds for a span marker (0 for point marker)'),
      }),
    },
    {
      name: 'delete_marker',
      description:
        'Deletes a marker from the specified sequence. The sequence does not have to be the active one.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence. Defaults to the active sequence.',
          ),
        markerId: z.string().min(1).describe('The ID of the marker to delete'),
      }),
    },
    {
      name: 'update_marker',
      description:
        "Updates an existing marker's properties in the specified sequence. The sequence does not have to be the active one.",
      inputSchema: z.object({
        sequenceId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence. Defaults to the active sequence.',
          ),
        markerId: z.string().min(1).describe('The ID of the marker to update'),
        name: z.string().optional().describe('New name for the marker'),
        comment: z.string().optional().describe('New comment'),
        color: MarkerColorSchema.optional().describe(`New colour. ${MARKER_COLOR_DESCRIPTION}`),
      }),
    },
    {
      name: 'list_markers',
      description:
        'Lists all markers in the specified sequence. The sequence does not have to be the active one.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence. Defaults to the active sequence.',
          ),
      }),
    },

    // Track Management
    {
      name: 'add_track',
      description: 'Adds a new video or audio track to the sequence.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        trackType: z.enum(['video', 'audio']).describe('Type of track to add'),
        position: z
          .enum(['above', 'below'])
          .optional()
          .describe('Where to add the track relative to existing tracks'),
      }),
    },
    {
      name: 'delete_track',
      description:
        'Deletes a video or audio track from the specified sequence. The sequence does not have to be the active one, but it does have to be open in Premiere: there is no DOM track-deletion API, so this falls through to the QE DOM, which only reaches sequences Premiere has open. A sequence QE cannot address is reported by name rather than deleted from the wrong timeline. Caption track deletion is accepted by the schema but returns an explicit unsupported result because Premiere Pro exposes no caption-track delete/read API to scripting.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence. Defaults to the active sequence.',
          ),
        trackType: z.enum(['video', 'audio', 'caption']).describe('Type of track'),
        trackIndex: z.number().describe('The index of the track to delete'),
      }),
    },
    {
      name: 'lock_track',
      description:
        'Locks or unlocks a track to prevent/allow editing. The sequence does not have to be the active one.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence. Defaults to the active sequence.',
          ),
        trackType: z.enum(['video', 'audio']).describe('Type of track'),
        trackIndex: z.number().describe('The index of the track'),
        locked: z.boolean().describe('Whether to lock (true) or unlock (false)'),
      }),
    },
    {
      name: 'toggle_track_visibility',
      description:
        'Shows or hides a video track by toggling its output (the eye icon) in the specified sequence. The sequence does not have to be the active one. This is track OUTPUT, not track targeting -- use set_target_track for the V1/A1 patch buttons.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The sequence ID (GUID) as returned in the "id" field by list_sequences or get_active_sequence. Defaults to the active sequence.',
          ),
        trackIndex: z.number().describe('The index of the video track'),
        visible: z.boolean().describe('Whether to show (true) or hide (false)'),
      }),
    },

    {
      name: 'link_audio_video',
      description: 'Links or unlinks audio and video components of a clip.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        linked: z.boolean().describe('Whether to link (true) or unlink (false)'),
      }),
    },
    {
      name: 'apply_audio_effect',
      description: 'Applies an audio effect to a clip.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the audio clip'),
        effectName: z
          .string()
          .describe('Name of the audio effect (e.g., "Compressor", "EQ", "Reverb")'),
        parameters: z.record(z.string(), z.any()).optional().describe('Effect parameters'),
      }),
    },
    {
      name: 'apply_audio_effect_to_all_clips',
      description:
        'Bulk: applies a single audio effect to ALL audio clips of a sequence in one ExtendScript call. Returns per-clip results. Saves N MCP roundtrips when calibrating or applying same chain.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe(
            'Target sequence ID (must be the active sequence in Premiere). Defaults to the active sequence.',
          ),
        effectName: z
          .string()
          .describe(
            'Audio effect display name (e.g., "Limitador forzado", "Compresor multibanda")',
          ),
        parameters: z
          .record(z.string(), z.any())
          .optional()
          .describe('Effect parameters by displayName (exact or normalized)'),
      }),
    },

    // Additional Clip Operations
    {
      name: 'duplicate_clip',
      description: 'Duplicates a clip on the timeline.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip to duplicate'),
        offset: z
          .number()
          .optional()
          .describe(
            'Time offset in seconds for the duplicate (default: places immediately after original)',
          ),
      }),
    },
    {
      name: 'reverse_clip',
      description: 'Reverses the playback of a clip.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip to reverse'),
        maintainAudioPitch: z
          .boolean()
          .optional()
          .describe('Whether to maintain audio pitch (default: true)'),
      }),
    },
    {
      name: 'enable_disable_clip',
      description: 'Enables or disables a clip on the timeline.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        enabled: z.boolean().describe('Whether to enable (true) or disable (false)'),
      }),
    },
    {
      name: 'replace_clip',
      description: 'Replaces a clip on the timeline with another media item.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip to replace'),
        newProjectItemId: z.string().describe('The ID of the new project item to use'),
        preserveEffects: z
          .boolean()
          .optional()
          .describe('Whether to keep effects and settings (default: true)'),
      }),
    },

    // Project Settings
    {
      name: 'get_sequence_settings',
      description: 'Gets the settings for a sequence (resolution, framerate, etc.).',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
      }),
    },
    {
      name: 'set_sequence_settings',
      description:
        'Updates sequence settings. Applies width, height, frameRate and pixelAspectRatio, reads the values back afterwards, and reports any field Premiere accepted but did not actually change. Frame size CAN be changed after creation, contrary to an earlier note in this codebase.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        settings: z
          .object({
            width: z.number().optional().describe('Frame width in pixels'),
            height: z.number().optional().describe('Frame height in pixels'),
            frameRate: z.number().optional().describe('Frames per second, e.g. 23.976, 25, 30'),
            // Premiere stores this as an "N:M" string. A bare number is converted to the
            // nearest exact ratio (1.5 becomes "3:2"), but the string form is accepted
            // directly so callers can name a ratio Premiere already uses, such as "10:11".
            pixelAspectRatio: z
              .union([z.number(), z.string()])
              .optional()
              .describe(
                'Pixel aspect ratio, either a number (1, 1.5, 2) or an "N:M" string ("1:1", "4:3", "10:11")',
              ),
          })
          .describe('Settings to update'),
      }),
    },
    {
      name: 'get_clip_properties',
      description:
        'Gets detailed properties of a clip, INCLUDING current Motion values (opacity/scale/rotation/position). Position is returned both normalized (0..1) and in PIXELS (`motion.position`, using the sequence frame size) so you can verify or copy framing without exporting a frame. Pass sequenceId when the clip ID came from list_sequence_tracks for a non-active sequence.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        sequenceId: z
          .string()
          .optional()
          .describe(
            'Optional sequence ID to search. If omitted, searches the active sequence first, then all sequences.',
          ),
      }),
    },
    {
      name: 'set_clip_properties',
      description: 'Sets Motion properties of a clip (opacity, scale, rotation, position).',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        properties: z
          .object({
            opacity: z.number().optional().describe('Opacity 0-100'),
            scale: z.number().optional().describe('Scale percentage'),
            rotation: z.number().optional().describe('Rotation in degrees'),
            position: z
              .object({
                x: z.number().optional(),
                y: z.number().optional(),
              })
              .optional()
              .describe(
                'Position in PIXELS matching the Effect Controls panel (e.g. 960,640 = center of a 1920x1280 sequence). Converted to the normalized API value internally using the clip sequence frame size.',
              ),
          })
          .describe('Properties to set'),
      }),
    },
    {
      name: 'set_clip_properties_batch',
      description:
        'Applies Motion properties (opacity/scale/rotation/position) to MANY clips in a single round-trip — the fast path for per-speaker framing across a whole rebuilt edit. ~50x faster than one set_clip_properties call per clip. Returns a per-clip result array; each result carries an `applied` map ({opacity,scale,rotation,position}) and `success` is true only when EVERY requested property was actually found and set (a missing Motion property is reported, not silently ignored).',
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              clipId: z.string().describe('The ID of the clip'),
              properties: z
                .object({
                  opacity: z.number().optional().describe('Opacity 0-100'),
                  scale: z.number().optional().describe('Scale percentage'),
                  rotation: z.number().optional().describe('Rotation in degrees'),
                  position: z
                    .object({
                      x: z.number().optional(),
                      y: z.number().optional(),
                    })
                    .optional()
                    .describe(
                      'Position in PIXELS matching the Effect Controls panel (converted to the normalized API value internally using the clip sequence frame size)',
                    ),
                })
                .describe('Properties to set for this clip'),
            }),
          )
          .describe('List of clip + properties pairs'),
      }),
    },

    // Render Queue
    {
      name: 'add_to_render_queue',
      description: 'Adds a sequence to the Adobe Media Encoder render queue.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence to render. Defaults to the active sequence.'),
        outputPath: z.string().describe('Output file path'),
        presetPath: z.string().optional().describe('Export preset file path'),
        presetName: z
          .string()
          .optional()
          .describe(
            'Exact user preset display name or filename stem. Must resolve to exactly one discovered .epr preset.',
          ),
        sourceRange: z
          .enum(['entire', 'in_out', 'work_area'])
          .optional()
          .describe('Export source range. Defaults to entire.'),
        allowOverwrite: z
          .boolean()
          .optional()
          .describe('Allow writing to an existing output file. Defaults to false.'),
        removeOnCompletion: z
          .boolean()
          .optional()
          .describe('Pass AME removeOnCompletion. Defaults to true.'),
        startImmediately: z
          .boolean()
          .optional()
          .describe('Whether to start rendering immediately (default: false)'),
      }),
    },
    {
      name: 'get_render_queue_status',
      description:
        "Reports live render/encode status. Probes the Premiere encoder bridge (app.encoder) to report whether AME hand-off is reachable, and — when an outputPath is given — polls that file on disk (exists, size, last-modified) so a render in progress can actually be tracked. Adobe exposes no direct read of AME's own queue; output-file polling is the reliable signal.",
      inputSchema: z.object({
        outputPath: z
          .string()
          .optional()
          .describe(
            'Absolute path to a render/export output file to poll. Reports whether it exists yet, its current byte size, and last-modified time — call repeatedly to watch a render grow to completion.',
          ),
      }),
    },

    // Advanced Features
    {
      name: 'stabilize_clip',
      description: 'Applies video stabilization to reduce camera shake.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip to stabilize'),
        method: z.enum(['warp', 'subspace']).optional().describe('Stabilization method'),
        smoothness: z.number().optional().describe('Stabilization smoothness (0-100)'),
      }),
    },
    {
      name: 'speed_change',
      description: 'Changes the playback speed of a clip.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        speed: z.number().describe('Speed multiplier (0.1 = 10% speed, 2.0 = 200% speed)'),
        maintainAudio: z
          .boolean()
          .optional()
          .describe('Whether to maintain audio pitch when changing speed'),
      }),
    },

    // Playhead & Work Area
    {
      name: 'get_playhead_position',
      description: 'Gets the current playhead (CTI) position in the specified sequence.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
      }),
    },
    {
      name: 'set_playhead_position',
      description: 'Sets the playhead (CTI) position in the specified sequence.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        time: z.number().describe('The time in seconds to move the playhead to'),
      }),
    },
    {
      name: 'get_selected_clips',
      description: 'Gets all currently selected clips in the specified sequence.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
      }),
    },

    // Effect & Transition Discovery
    {
      name: 'list_available_effects',
      description: 'Lists all available video effects in Premiere Pro.',
      inputSchema: z.object({}),
    },
    {
      name: 'list_available_transitions',
      description: 'Lists all available video transitions in Premiere Pro.',
      inputSchema: z.object({}),
    },
    {
      name: 'list_available_audio_effects',
      description: 'Lists all available audio effects in Premiere Pro.',
      inputSchema: z.object({}),
    },
    {
      name: 'list_available_audio_transitions',
      description: 'Lists all available audio transitions in Premiere Pro.',
      inputSchema: z.object({}),
    },

    // Keyframes
    {
      name: 'add_keyframe',
      description: 'Adds a keyframe to a clip component parameter at a specific time.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        componentName: z
          .string()
          .describe('The display name of the component (e.g., "Motion", "Opacity")'),
        paramName: z
          .string()
          .describe('The display name of the parameter (e.g., "Position", "Scale")'),
        time: z.number().describe('The time in seconds for the keyframe'),
        value: z.number().describe('The value to set at this keyframe'),
      }),
    },
    {
      name: 'remove_keyframe',
      description: 'Removes a keyframe from a clip component parameter at a specific time.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        componentName: z.string().describe('The display name of the component'),
        paramName: z.string().describe('The display name of the parameter'),
        time: z.number().describe('The time in seconds of the keyframe to remove'),
      }),
    },
    {
      name: 'get_keyframes',
      description: 'Gets all keyframes for a clip component parameter.',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        componentName: z.string().describe('The display name of the component'),
        paramName: z.string().describe('The display name of the parameter'),
      }),
    },
    {
      name: 'bake_keyframe_ease',
      description:
        'Animates a SCALAR clip parameter (e.g. Opacity, Scale, Rotation) from a start value to an end value along an eased curve, by baking a dense run of keyframes whose values trace the easing shape. This is the honest path to eased motion: Premiere lets script SET a keyframe interpolation type but exposes no getter to read it back, and never exposed the temporal-ease amount to script at all — so a native "set the ease" call cannot be verified. Baked keyframe VALUES are readable back, so every written point is verified. Supports Penner easings and a CSS-style cubic-bezier. Scalar parameters only (multi-dimensional params like Position are refused).',
      inputSchema: z.object({
        clipId: z.string().describe('The ID of the clip'),
        componentName: z
          .string()
          .default('Opacity')
          .describe('The display name of the component (e.g., "Motion", "Opacity")'),
        paramName: z
          .string()
          .default('Opacity')
          .describe(
            'The display name of the scalar parameter to animate (e.g., "Opacity", "Scale", "Rotation")',
          ),
        startTime: z.number().describe('Clip-local start time in seconds'),
        endTime: z
          .number()
          .describe('Clip-local end time in seconds (must be greater than startTime)'),
        startValue: z.number().describe('Parameter value at startTime'),
        endValue: z.number().describe('Parameter value at endTime'),
        easing: z
          .enum(EASING_NAMES as [string, ...string[]])
          .default('easeInOutCubic')
          .describe('Named easing curve; ignored when bezier is provided'),
        bezier: z
          .array(z.number())
          .length(4)
          .optional()
          .describe(
            'CSS-style cubic-bezier [x1, y1, x2, y2]; overrides easing. x1 and x2 must be within [0, 1]',
          ),
        samples: z
          .number()
          .int()
          .min(1)
          .max(MAX_EASE_SAMPLES)
          .default(24)
          .describe('Number of segments between the endpoints; keyframes written = samples + 1'),
      }),
    },

    // Work Area
    {
      name: 'set_work_area',
      description: 'Sets the work area in/out points for a sequence.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        inPoint: z.number().describe('The in point in seconds'),
        outPoint: z.number().describe('The out point in seconds'),
      }),
    },
    {
      name: 'get_work_area',
      description: 'Gets the work area in/out points for a sequence.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
      }),
    },

    // Batch Operations
    {
      name: 'batch_add_transitions',
      description:
        'Adds a transition to all clip boundaries on a track. Useful for quickly adding cross dissolves or other transitions between every clip.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        trackIndex: z.number().describe('The video track index (0-based)'),
        transitionName: z.string().describe('The name of the transition (e.g., "Cross Dissolve")'),
        duration: z.number().describe('The duration of each transition in seconds'),
      }),
    },

    // Project Item Discovery & Management
    {
      name: 'find_project_item_by_name',
      description:
        'Searches for project items by name. Useful for finding media files, sequences, or bins.',
      inputSchema: z.object({
        name: z.string().describe('The name to search for (case-insensitive partial match)'),
        type: z
          .enum(['footage', 'sequence', 'bin', 'any'])
          .optional()
          .describe('Filter by item type'),
      }),
    },
    {
      name: 'move_item_to_bin',
      description: 'Moves a project item into a different bin (folder).',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item to move'),
        targetBinId: z.string().describe('The ID of the destination bin'),
      }),
    },

    // Active Sequence Management
    {
      name: 'set_active_sequence',
      description: 'Sets the active sequence in the project.',
      inputSchema: z.object({
        sequenceId: z.string().describe('The ID of the sequence to activate'),
      }),
    },
    {
      name: 'get_active_sequence',
      description: 'Gets information about the currently active sequence.',
      inputSchema: z.object({}),
    },

    // Clip Lookup
    {
      name: 'get_clip_at_position',
      description: 'Gets the clip at a specific time position on a track.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        trackType: z.enum(['video', 'audio']).describe('The type of track'),
        trackIndex: z.number().describe('The track index (0-based)'),
        time: z.number().describe('The time position in seconds'),
      }),
    },

    // Auto Reframe
    {
      name: 'auto_reframe_sequence',
      description:
        'Automatically reframes a sequence to a new aspect ratio using AI-powered motion tracking.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence to reframe. Defaults to the active sequence.'),
        numerator: z.number().describe('Aspect ratio numerator (e.g., 9 for 9:16)'),
        denominator: z.number().describe('Aspect ratio denominator (e.g., 16 for 9:16)'),
        motionPreset: z
          .enum(['slower', 'default', 'faster'])
          .optional()
          .describe('Motion tracking speed preset'),
        newName: z.string().optional().describe('Name for the reframed sequence'),
      }),
    },

    // Scene Edit Detection
    {
      name: 'detect_scene_edits',
      description: 'Detects scene changes in selected clips and optionally adds cuts or markers.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        action: z
          .enum(['ApplyCuts', 'CreateMarkers'])
          .optional()
          .describe('Action to take at detected edit points'),
        applyCutsToLinkedAudio: z
          .boolean()
          .optional()
          .describe('Whether to apply cuts to linked audio'),
        sensitivity: z
          .string()
          .optional()
          .describe('Detection sensitivity (e.g., "Low", "Medium", "High")'),
        allowUnsafeSynchronous: z
          .boolean()
          .optional()
          .describe(
            'Actually invoke Premiere scene detection synchronously; can block CEP for a long time',
          ),
      }),
    },

    // Captions
    {
      name: 'transcribe_to_srt',
      description:
        "Transcribes a media file's speech to an .srt subtitle file using a LOCAL OpenAI Whisper install (the `whisper` CLI), run via child_process -- NOT via Premiere, which has no speech-to-text scripting API at all. This fills the gap before create_caption_track: Premiere can ingest an .srt but cannot generate one. Requires the whisper CLI on PATH (`pip install -U openai-whisper`, plus ffmpeg); returns an explicit error with install guidance if it is not found rather than failing silently. Verifies the .srt was actually written and reports its path and cue count. Whisper is CPU/GPU-heavy and can take minutes on long files. Typical chain: transcribe_to_srt -> import_media (the returned srtPath) -> create_caption_track (the imported item id).",
      inputSchema: z
        .object({
          mediaPath: z
            .string()
            .optional()
            .describe('Direct filesystem path to the audio/video file to transcribe'),
          projectItemId: z
            .string()
            .optional()
            .describe(
              'Project item ID to resolve to a media path instead of passing mediaPath directly',
            ),
          outputDir: z
            .string()
            .optional()
            .describe(
              "Directory to write the .srt into. Defaults to the media file's own directory. The file is named <mediaBasename>.srt.",
            ),
          model: z
            .string()
            .optional()
            .describe(
              'Whisper model size: tiny, base, small, medium, large (default "base"). Larger = more accurate but much slower.',
            ),
          language: z
            .string()
            .optional()
            .describe(
              'Spoken language hint, e.g. "en" or "English". Omit to let Whisper auto-detect.',
            ),
          translateToEnglish: z
            .boolean()
            .optional()
            .describe(
              'When true, transcribe AND translate the speech into English subtitles (Whisper task=translate). Default false = transcribe in the original language.',
            ),
          timeoutSeconds: z
            .number()
            .optional()
            .describe(
              'Hard cap on the transcription run in seconds (default 1800 = 30 min). On timeout the process is killed and an error is returned.',
            ),
        })
        .refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId',
        }),
    },
    {
      name: 'create_caption_track',
      description:
        'Creates a caption track on a sequence from an imported caption/subtitle file (e.g. an .srt imported via import_media). Pass the SRT project item ID directly.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        projectItemId: z
          .string()
          .describe('The ID of the caption file project item (e.g. an imported .srt)'),
        startTime: z
          .number()
          .optional()
          .describe('Offset in seconds from the start of the sequence. Defaults to 0.'),
        captionFormat: z
          .string()
          .optional()
          .describe(
            'Optional caption format. Omit for subtitles (default, correct for .srt). Accepts: "subtitle", "608", "708", "teletext", "open ebu", "op42", "op47".',
          ),
      }),
    },
    {
      name: 'read_sequence_captions',
      description:
        'Reads caption tracks of a sequence, returning each caption clip as { start, end, text } in seconds. IMPORTANT: Premiere Pro exposes no caption-read API in its scripting DOM, so in practice this returns trackCount:0 / captions:[] even when the sequence HAS a working caption track. The response field captionReadSupported:false (plus note) signals this — a 0 result does NOT mean the sequence has no captions. To read cue text/timing, parse the source .srt file directly instead (see read_srt).',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('Optional sequence ID. Defaults to the active sequence.'),
      }),
    },
    // SRT subtitle CRUD — the honest way to READ and EDIT captions. Premiere's
    // DOM can ingest an .srt (create_caption_track) but exposes NO read/update/
    // delete API for caption tracks, so all caption editing happens on the .srt
    // file itself, on disk, before (re-)ingest. These tools are host-independent
    // (no Premiere request) and verify every write by reading it back.
    {
      name: 'read_srt',
      description:
        'Reads and parses an .srt subtitle file off disk into structured cues [{ index, start, end, startTimecode, endTimecode, text }] with start/end in seconds. This is the caption READ path Premiere itself cannot provide (read_sequence_captions is blocked by an Adobe DOM limitation). Robust to a UTF-8 BOM, CRLF/CR/LF endings, a missing index line, and WebVTT-style position tokens. Also returns a validation report (overlaps, zero-duration cues, empty text, out-of-order) and any malformed blocks it had to skip — nothing is dropped silently. Entirely local; no Premiere request.',
      inputSchema: z.object({
        srtPath: z.string().describe('Absolute path to the .srt file to read.'),
      }),
    },
    {
      name: 'validate_srt',
      description:
        'Reads an .srt file and returns ONLY a QC report on its cues without modifying anything: structural errors (negative time, zero/negative-duration cues) and quality warnings (overlapping cues, out-of-chronological-order starts, empty text), plus a count of malformed blocks. Read-only; no Premiere request. Use before create_caption_track to catch captions that would render wrong.',
      inputSchema: z.object({
        srtPath: z.string().describe('Absolute path to the .srt file to validate.'),
      }),
    },
    {
      name: 'write_srt',
      description:
        'Writes a complete .srt file from a full list of cues, replacing any existing file at the path. Cues are renumbered sequentially from 1 and written in canonical `HH:MM:SS,mmm --> HH:MM:SS,mmm` form. Refuses to write cues with structural errors (e.g. end not after start) unless allowInvalid=true, and always verifies by reading the file back and re-parsing it. Creates parent directories as needed. Host-independent; no Premiere request. Pair with import_media + create_caption_track to lay the result onto a sequence.',
      inputSchema: z.object({
        srtPath: z
          .string()
          .describe('Absolute path to write the .srt to (overwritten if it exists).'),
        cues: z
          .array(
            z.object({
              start: z
                .union([z.number(), z.string()])
                .describe('Cue start: seconds (number) or an "HH:MM:SS,mmm" timecode string.'),
              end: z
                .union([z.number(), z.string()])
                .describe('Cue end: seconds (number) or an "HH:MM:SS,mmm" timecode string.'),
              text: z.string().describe('Cue text; may contain newlines for multi-line captions.'),
            }),
          )
          .describe('The full ordered list of cues to write. An empty list writes an empty file.'),
        allowInvalid: z
          .boolean()
          .optional()
          .describe(
            'When true, write even if validation finds structural errors (they are still reported). Default false = refuse and report the errors.',
          ),
      }),
    },
    {
      name: 'update_srt_cue',
      description:
        'Edits one cue in an existing .srt file, addressed by its 1-based index, changing any of start / end / text (omitted fields are left unchanged). Reads the file, applies the change, and writes it back with read-back verification. Returns the before/after of the edited cue. Host-independent; no Premiere request.',
      inputSchema: z.object({
        srtPath: z.string().describe('Absolute path to the .srt file to edit.'),
        index: z.number().int().describe('1-based cue number to edit (as shown by read_srt).'),
        start: z
          .union([z.number(), z.string()])
          .optional()
          .describe('New start: seconds or "HH:MM:SS,mmm". Omit to keep.'),
        end: z
          .union([z.number(), z.string()])
          .optional()
          .describe('New end: seconds or "HH:MM:SS,mmm". Omit to keep.'),
        text: z.string().optional().describe('New cue text. Omit to keep.'),
      }),
    },
    {
      name: 'insert_srt_cue',
      description:
        'Inserts a new cue into an existing .srt file. The cue is placed in chronological order by its start time (the file stays time-sorted) and all cues are renumbered. Reads, inserts, and writes back with read-back verification. Host-independent; no Premiere request.',
      inputSchema: z.object({
        srtPath: z.string().describe('Absolute path to the .srt file to edit.'),
        start: z.union([z.number(), z.string()]).describe('Cue start: seconds or "HH:MM:SS,mmm".'),
        end: z.union([z.number(), z.string()]).describe('Cue end: seconds or "HH:MM:SS,mmm".'),
        text: z.string().describe('Cue text; may contain newlines.'),
      }),
    },
    {
      name: 'remove_srt_cue',
      description:
        'Removes one cue from an existing .srt file, addressed by its 1-based index, and renumbers the rest. Reads, removes, and writes back with read-back verification. Returns the removed cue. Host-independent; no Premiere request.',
      inputSchema: z.object({
        srtPath: z.string().describe('Absolute path to the .srt file to edit.'),
        index: z.number().int().describe('1-based cue number to remove (as shown by read_srt).'),
      }),
    },
    {
      name: 'shift_srt_timing',
      description:
        'Shifts caption timing in an .srt file to fix sync drift. Adds a fixed offset in seconds (negative pulls captions earlier) to every cue, or to a contiguous 1-based range only (fromIndex..toIndex) when the head is in sync but a later section drifts. Optionally also scales all timing by a positive factor about t=0 first (the honest fix for a frame-rate mismatch, e.g. 25/23.976). Times are clamped at 0. Reads, retimes, and writes back with read-back verification. Host-independent; no Premiere request.',
      inputSchema: z.object({
        srtPath: z.string().describe('Absolute path to the .srt file to retime.'),
        offsetSeconds: z
          .number()
          .optional()
          .describe('Seconds to add to each cue (may be negative). Default 0.'),
        scaleFactor: z
          .number()
          .optional()
          .describe(
            'Positive multiplier applied to all timing about t=0 BEFORE the offset. Use for frame-rate mismatch (e.g. 25/23.976 ≈ 1.0427). Applies to the whole file regardless of the index range.',
          ),
        fromIndex: z
          .number()
          .int()
          .optional()
          .describe('1-based first cue the offset applies to. Default 1 (all).'),
        toIndex: z
          .number()
          .int()
          .optional()
          .describe('1-based last cue the offset applies to. Default last (all).'),
      }),
    },
    {
      name: 'probe_media',
      description:
        "Reads ground-truth technical metadata from a media file with ffprobe (run via child_process), NOT via Premiere -- so it works on any file on disk whether or not it is imported, online, or offline, and reports the container/stream facts Premiere's own get_metadata cannot: exact codec and profile, pixel format, color space/range, bit depth, frame rate, sample rate, channel layout, stream counts, duration, and bit rate. Requires ffprobe on PATH (ships with ffmpeg; overridable via PREMIERE_MCP_FFPROBE_CMD) and returns explicit install guidance if it is absent rather than failing silently. Returns a distilled `summary` plus the full parsed ffprobe JSON under `probe`.",
      inputSchema: z
        .object({
          mediaPath: z
            .string()
            .optional()
            .describe('Direct filesystem path to the media file to probe'),
          projectItemId: z
            .string()
            .optional()
            .describe(
              'Project item ID to resolve to a media path instead of passing mediaPath directly',
            ),
        })
        .refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId',
        }),
    },
    {
      name: 'generate_scope',
      description:
        'Renders a signal/QC scope image -- waveform, vectorscope, histogram, or RGB parade -- from a single frame of a media file using ffmpeg (run via child_process), NOT via Premiere, whose Lumetri scopes cannot be scripted or exported. Grabs the frame at timeSeconds, applies the chosen scope filter, and writes a PNG. Requires ffmpeg on PATH (overridable via PREMIERE_MCP_FFMPEG_CMD) and returns explicit install guidance if it is absent; verifies the PNG was actually written before reporting success. Use for exposure/color QC and before/after grade checks.',
      inputSchema: z
        .object({
          mediaPath: z
            .string()
            .optional()
            .describe('Direct filesystem path to the media file to analyze'),
          projectItemId: z
            .string()
            .optional()
            .describe(
              'Project item ID to resolve to a media path instead of passing mediaPath directly',
            ),
          scope: z
            .enum(['waveform', 'vectorscope', 'histogram', 'rgb_parade'])
            .optional()
            .describe(
              'Which scope to render (default "waveform"). "rgb_parade" is a per-channel RGB waveform.',
            ),
          timeSeconds: z
            .number()
            .optional()
            .describe(
              'Timestamp of the frame to analyze, in seconds from the file start (default 0).',
            ),
          outputPath: z
            .string()
            .optional()
            .describe(
              'Where to write the PNG. Defaults to <mediaDir>/<mediaBasename>_<scope>.png.',
            ),
        })
        .refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId',
        }),
    },
    {
      name: 'capture_program_output',
      description:
        'Captures the actual COMPOSITED Program Monitor output -- the real rendered pixels of the sequence at a given time, with all clips, effects, transitions, titles and grades baked in -- and writes it to an image, so an AI can SEE what the edit renders to rather than trusting that an API call returned. This is Premiere\'s true render output, not a DOM read-back. Premiere hands script no framebuffer of the program, so the frame is obtained off one of four "taps": render/export (zero-dependency, both OS, always available when Premiere is connected -- uses Premiere\'s own frame export), and the real-time GPU/network taps NDI, Syphon (macOS) and Spout (Windows) which need a Transmit plugin + native receiver. Tap selection is automatic ("auto") but forceable. Always reports which tap was actually used and verifies a real frame landed on disk before claiming success; if a requested tap is unavailable it returns per-OS install guidance instead of faking a frame. Pass probeOnly:true to just report which taps are available on this machine without capturing.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('Sequence to capture. Defaults to the active sequence.'),
        time: z
          .number()
          .optional()
          .describe(
            'Timestamp in seconds to capture. Defaults to the current playhead position of the sequence.',
          ),
        format: z
          .enum(['png', 'jpg', 'jpeg', 'tiff', 'tif', 'dpx', 'tga', 'targa'])
          .optional()
          .describe('Image format for the render/export tap (default "png").'),
        outputPath: z
          .string()
          .optional()
          .describe(
            'Where to write the captured frame. Defaults to a timestamped file in the system temp directory.',
          ),
        tap: z
          .enum(['auto', 'render', 'ndi', 'syphon', 'spout'])
          .optional()
          .describe(
            'Which capture tap to use. "auto" (default) picks the best available, falling back to render/export. The GPU/network taps (ndi/syphon/spout) require a Transmit plugin and a native receiver; if forced and unavailable the call fails with install guidance rather than silently using render/export.',
          ),
        probeOnly: z
          .boolean()
          .optional()
          .describe(
            'If true, do not capture -- just return which taps are available on this machine and their install guidance.',
          ),
      }),
    },
    {
      name: 'bake_speed_change',
      description:
        'Renders a NEW media file at a constant changed speed using ffmpeg (run via child_process), NOT via Premiere. This is the honest escape hatch for time-remapping: Premiere\'s scripting API has never exposed the time-remap/speed keyframe graph, so agents that "set a speed ramp" through the DOM get silently ignored keyframes at render. Instead this bakes a real, frame-accurate constant-speed clip to disk that you then import_media and place. Video is retimed with setpts; audio is retimed pitch-preserved with an atempo chain (or dropped with includeAudio:false). speed>1 is faster/shorter, speed<1 is slower/longer (e.g. 0.5 = half speed, 2 = double). Requires ffmpeg on PATH (overridable via PREMIERE_MCP_FFMPEG_CMD); returns install guidance if absent and verifies the output file was written and non-empty before reporting success. For a variable ramp, bake several constant-speed segments and butt them together. Note: this is a straight time-scale, not optical-flow frame interpolation.',
      inputSchema: z
        .object({
          mediaPath: z
            .string()
            .optional()
            .describe('Direct filesystem path to the source media file'),
          projectItemId: z
            .string()
            .optional()
            .describe(
              'Project item ID to resolve to a media path instead of passing mediaPath directly',
            ),
          speed: z
            .number()
            .optional()
            .describe(
              'Speed multiplier (required). >1 faster/shorter, <1 slower/longer. Must be > 0.',
            ),
          outputPath: z
            .string()
            .optional()
            .describe(
              'Where to write the retimed file. Defaults to <mediaDir>/<basename>_<speed>x.<ext>.',
            ),
          includeAudio: z
            .boolean()
            .optional()
            .describe(
              'Retime and keep audio, pitch-preserved (default true). false drops audio (-an).',
            ),
          preservePitch: z
            .boolean()
            .optional()
            .describe(
              'When keeping audio, preserve pitch via atempo (default true). false lets pitch shift with speed via asetrate resample.',
            ),
        })
        .refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId',
        }),
    },
    {
      name: 'normalize_loudness',
      description:
        "Renders a NEW audio-normalized media file to a broadcast loudness target using ffmpeg's two-pass loudnorm (EBU R128), run via child_process, NOT via Premiere. Premiere exposes no scriptable loudness measurement or normalization, so agents cannot hit a delivery spec (e.g. -14 LUFS for streaming, -23 LUFS for broadcast) from the DOM. This measures the source in a first pass, then applies linear loudnorm with the measured values in a second pass for an accurate result, and writes the normalized file to disk. Requires ffmpeg + ffprobe on PATH (overridable via PREMIERE_MCP_FFMPEG_CMD / PREMIERE_MCP_FFPROBE_CMD); returns install guidance if absent and verifies the output before reporting success. Returns the measured input loudness and the target so the change is auditable.",
      inputSchema: z
        .object({
          mediaPath: z
            .string()
            .optional()
            .describe('Direct filesystem path to the source media file'),
          projectItemId: z
            .string()
            .optional()
            .describe(
              'Project item ID to resolve to a media path instead of passing mediaPath directly',
            ),
          targetLufs: z
            .number()
            .optional()
            .describe(
              'Integrated loudness target in LUFS (default -14, common streaming target; -23 for EBU R128 broadcast).',
            ),
          truePeakDb: z.number().optional().describe('Maximum true peak in dBTP (default -1.0).'),
          loudnessRange: z
            .number()
            .optional()
            .describe('Target loudness range (LRA) in LU (default 11).'),
          outputPath: z
            .string()
            .optional()
            .describe(
              'Where to write the normalized file. Defaults to <mediaDir>/<basename>_norm<targetLufs>LUFS.<ext>.',
            ),
        })
        .refine((data) => Boolean(data.mediaPath) || Boolean(data.projectItemId), {
          message: 'Provide either mediaPath or projectItemId',
        }),
    },
    {
      name: 'lint_timeline',
      description:
        'Runs automated quality-control checks on a sequence and returns a list of findings -- the "layout lint" half of the render-truth loop. Walks every video and audio track and flags common editorial defects an agent (or human) cannot easily see from the DOM: GAPS between clips (black/silence), FLASH FRAMES (clips shorter than a frame threshold, usually accidental), OVERLAPS, a LEADING GAP before the first clip, and MIXED FRAME RATES (a clip whose source frame rate differs from the sequence, which stutters or drops frames). Read-only -- it changes nothing, it reports. Each finding carries a severity, the track and time, and a plain-English message. Defaults to the active sequence. Use it after assembling a timeline to catch mistakes before export.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('Sequence to lint. Defaults to the active sequence.'),
        flashFrameThresholdFrames: z
          .number()
          .optional()
          .describe('Clips shorter than this many frames are flagged as flash frames (default 2).'),
        gapThresholdFrames: z
          .number()
          .optional()
          .describe(
            'Gaps larger than this many frames are flagged (default 1). Set to 0 to flag any gap.',
          ),
        checks: z
          .array(z.enum(['gaps', 'flash_frames', 'overlaps', 'leading_gap', 'mixed_frame_rate']))
          .optional()
          .describe('Subset of checks to run. Defaults to all.'),
      }),
    },
    {
      name: 'diff_sequences',
      description:
        'Compares two sequences clip-by-clip and reports exactly what changed between them -- the version-diff for an edit. Walks both timelines and classifies every difference as ADDED (a clip only in B), REMOVED (only in A), MOVED (the same clip at a new start time) or RETIMED (the same clip with a new duration). Read-only -- it changes nothing. Ideal for reviewing an AI edit against the original, or a restored recovery checkpoint against the current cut, so you can SEE what an operation did instead of trusting that it worked. Clips are matched within a track by name (nearest start time wins when a name repeats) and compared with a half-frame tolerance. Returns a change count and per-category lists; identical timelines report changeCount 0.',
      inputSchema: z.object({
        sequenceIdA: z.string().describe('The "before" sequence (the baseline / original).'),
        sequenceIdB: z
          .string()
          .describe('The "after" sequence (the edited / current version) to compare against A.'),
      }),
    },
    {
      name: 'index_footage',
      description:
        "Builds or refreshes a local, persistent index of media files on disk so footage DISCOVERY stops requiring the media to be imported into Premiere first. Walks a folder (recursively by default), reads each file's technical metadata with ffprobe, and writes a JSON index. Incremental: files whose path + size + modified-time already match the index are skipped, so re-running after adding a few clips is cheap. Entirely local -- ffprobe + filesystem, no Premiere request. Query the result with search_footage. Needs ffprobe (ships with ffmpeg); returns install guidance if it is missing.",
      inputSchema: z.object({
        rootPath: z.string().describe('Absolute path of the folder to scan for media.'),
        recursive: z
          .boolean()
          .optional()
          .describe(
            'Descend into subfolders. Defaults to true. Hidden folders (dot-prefixed) are always skipped.',
          ),
        extensions: z
          .array(z.string())
          .optional()
          .describe(
            'File extensions to include (without the dot, e.g. ["mov","wav"]). Defaults to a broad video/audio/image set.',
          ),
        indexPath: z
          .string()
          .optional()
          .describe(
            'Where to store the index JSON. Defaults to PREMIERE_MCP_FOOTAGE_INDEX or ~/.premiere-mcp/footage-index.json.',
          ),
        pruneMissing: z
          .boolean()
          .optional()
          .describe(
            'When true, drop index entries whose files are no longer on disk. Defaults to false (missing files are kept and reported).',
          ),
      }),
    },
    {
      name: 'search_footage',
      description:
        'Searches the local footage index built by index_footage, entirely offline -- no Premiere request. Find the right clip before importing it by filtering on filename substring, file extension, codec, duration/resolution/frame-rate ranges, and whether the file has audio or video. Returns matches with their distilled technical summary. Build or refresh the index with index_footage first.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            'Case-insensitive substring matched against the full file path (filename or folder).',
          ),
        extension: z
          .string()
          .optional()
          .describe('Match a single file extension (with or without the dot).'),
        codec: z
          .string()
          .optional()
          .describe('Match a video OR audio codec name (e.g. "h264", "prores", "pcm_s24le").'),
        minDurationSeconds: z.number().optional().describe('Only files at least this long.'),
        maxDurationSeconds: z.number().optional().describe('Only files at most this long.'),
        minWidth: z.number().optional().describe('Minimum video width in pixels.'),
        minHeight: z.number().optional().describe('Minimum video height in pixels.'),
        minFps: z.number().optional().describe('Minimum video frame rate.'),
        maxFps: z.number().optional().describe('Maximum video frame rate.'),
        hasAudio: z
          .boolean()
          .optional()
          .describe('Require (true) or exclude (false) files with an audio stream.'),
        hasVideo: z
          .boolean()
          .optional()
          .describe('Require (true) or exclude (false) files with a video stream.'),
        indexPath: z
          .string()
          .optional()
          .describe(
            'Which index JSON to read. Defaults to PREMIERE_MCP_FOOTAGE_INDEX or ~/.premiere-mcp/footage-index.json.',
          ),
        limit: z.number().optional().describe('Maximum number of results to return (default 100).'),
      }),
    },
    {
      name: 'rename_project_item',
      description:
        'Renames a project item (sequence, bin, clip) by setting its name. Use this when duplicate_sequence does not propagate the new name to the project panel.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item to rename'),
        newName: z.string().describe('The new name for the project item'),
      }),
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
        hasHardBoundaries: z
          .boolean()
          .optional()
          .describe('Whether boundaries are hard (cannot be extended)'),
        takeAudio: z.boolean().optional().describe('Whether to include audio (default: true)'),
        takeVideo: z.boolean().optional().describe('Whether to include video (default: true)'),
      }),
    },

    // Media Management - Relink & Metadata
    {
      name: 'relink_media',
      description: 'Relinks an offline or moved media file to a new file path.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item to relink'),
        newFilePath: z.string().describe('The new absolute file path to relink to'),
      }),
    },
    {
      name: 'set_color_label',
      description: 'Sets the color label on a project item.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item'),
        colorIndex: z
          .number()
          .describe(
            'Color label index 0-15 (0=Violet, 1=Iris, 2=Caribbean, 3=Lavender, 4=Cerulean, 5=Forest, 6=Rose, 7=Mango, 8=Purple, 9=Blue, 10=Teal, 11=Magenta, 12=Tan, 13=Green, 14=Brown, 15=Yellow)',
          ),
      }),
    },
    {
      name: 'get_color_label',
      description: 'Gets the color label index of a project item.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item'),
      }),
    },
    {
      name: 'get_metadata',
      description: 'Gets project metadata and XMP metadata for a project item.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item'),
      }),
    },
    {
      name: 'set_metadata',
      description: 'Sets a project metadata value on a project item.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item'),
        key: z.string().describe('The metadata key/field name'),
        value: z.string().describe('The metadata value to set'),
      }),
    },
    {
      name: 'get_footage_interpretation',
      description:
        'Gets the footage interpretation settings (frame rate, pixel aspect ratio, field type, etc.) for a project item.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item'),
      }),
    },
    {
      name: 'set_footage_interpretation',
      description:
        'Sets footage interpretation settings (frame rate, pixel aspect ratio) for a project item.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item'),
        frameRate: z.number().optional().describe('Override frame rate'),
        pixelAspectRatio: z.number().optional().describe('Override pixel aspect ratio'),
      }),
    },
    {
      name: 'check_offline_media',
      description:
        'Checks all project items and returns a list of any that are offline (missing media).',
      inputSchema: z.object({}),
    },
    {
      name: 'export_as_fcp_xml',
      description: 'Exports a sequence as Final Cut Pro XML.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence to export. Defaults to the active sequence.'),
        outputPath: z.string().describe('The absolute file path for the exported XML file'),
      }),
    },
    {
      name: 'undo',
      description: 'Performs an undo operation in Premiere Pro.',
      inputSchema: z.object({}),
    },
    {
      name: 'set_sequence_in_out_points',
      description: 'Sets the in and/or out points on a sequence timeline.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        inPoint: z.number().optional().describe('The in point in seconds'),
        outPoint: z.number().optional().describe('The out point in seconds'),
      }),
    },
    {
      name: 'get_sequence_in_out_points',
      description: 'Gets the in and out points of a sequence timeline.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
      }),
    },
    {
      name: 'export_aaf',
      description:
        'Exports a sequence as an AAF file for interchange with other editing/audio applications.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence to export. Defaults to the active sequence.'),
        outputPath: z.string().describe('The absolute file path for the exported AAF file'),
        mixDownVideo: z
          .boolean()
          .optional()
          .describe(
            'Render a video mixdown into the AAF (default: false). True renders the whole sequence first, which holds Premiere for minutes on anything with graphics or effects and then raises the AAF Export Log; leave it off for audio post.',
          ),
        explodeToMono: z
          .boolean()
          .optional()
          .describe('Whether to explode audio to mono (default: false)'),
        sampleRate: z.number().optional().describe('Audio sample rate (default: 48000)'),
        bitsPerSample: z.number().optional().describe('Audio bits per sample (default: 16)'),
      }),
    },
    {
      name: 'consolidate_duplicates',
      description: 'Consolidates duplicate media items in the project.',
      inputSchema: z.object({}),
    },
    {
      name: 'refresh_media',
      description: 'Refreshes the media for a project item, reloading it from disk.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item to refresh'),
      }),
    },
    {
      name: 'import_sequences_from_project',
      description: 'Imports sequences from another Premiere Pro project file.',
      inputSchema: z.object({
        projectPath: z.string().describe('The absolute path to the source .prproj file'),
        sequenceIds: z
          .array(z.string())
          .describe('Array of sequence IDs to import from the source project'),
      }),
    },
    {
      name: 'create_subsequence',
      description: 'Creates a subsequence from the in/out points of a sequence.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the source sequence. Defaults to the active sequence.'),
        ignoreTrackTargeting: z
          .boolean()
          .optional()
          .describe('Whether to ignore track targeting (default: false)'),
      }),
    },
    {
      name: 'import_mogrt',
      description: 'Imports a Motion Graphics Template (.mogrt) file into a sequence.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        mogrtPath: z.string().describe('The absolute path to the .mogrt file'),
        time: z.number().describe('The time in seconds where the MOGRT should be placed'),
        videoTrackIndex: z.number().optional().describe('The video track index (default: 0)'),
        audioTrackIndex: z.number().optional().describe('The audio track index (default: 0)'),
      }),
    },
    {
      name: 'import_mogrt_from_library',
      description: 'Imports a Motion Graphics Template from a Creative Cloud Library.',
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('The ID of the sequence. Defaults to the active sequence.'),
        libraryName: z.string().describe('The name of the Creative Cloud Library'),
        mogrtName: z.string().describe('The name of the MOGRT in the library'),
        time: z.number().describe('The time in seconds where the MOGRT should be placed'),
        videoTrackIndex: z.number().optional().describe('The video track index (default: 0)'),
        audioTrackIndex: z.number().optional().describe('The audio track index (default: 0)'),
      }),
    },
    {
      name: 'manage_proxies',
      description:
        'Checks proxy status, attaches a proxy file, or gets the proxy path for a project item.',
      inputSchema: z.object({
        projectItemId: z.string().describe('The ID of the project item'),
        action: z
          .enum(['check', 'attach', 'get_path'])
          .describe('The proxy action: check status, attach a proxy, or get proxy path'),
        proxyPath: z
          .string()
          .optional()
          .describe('The absolute path to the proxy file (required for attach action)'),
      }),
    },

    // ── Batch Final: ~70 more tools to reach 600 ──────────────────────────

    // Audio effect control
    {
      name: 'set_parametric_eq',
      description:
        'Sets a Parametric Equalizer band on an audio clip using QE component params. Finds the EQ component and sets frequency/gain/Q for a specified band (1-5).',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based audio track index'),
        clipIndex: z.number().describe('0-based clip index'),
        band: z.number().min(1).max(5).describe('EQ band 1-5'),
        frequency: z.number().optional().describe('Center frequency in Hz'),
        gain: z.number().optional().describe('Gain in dB (-24 to +24)'),
        q: z.number().optional().describe('Q factor (bandwidth)'),
      }),
    },
    {
      name: 'set_compressor',
      description:
        'Sets Dynamics Processing compressor parameters on an audio clip. Finds the Dynamics Processing component and sets threshold, ratio, attack, release via QE.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number(),
        clipIndex: z.number(),
        threshold: z.number().optional().describe('Threshold in dBFS'),
        ratio: z.number().optional().describe('Compression ratio (e.g. 4 for 4:1)'),
        attack: z.number().optional().describe('Attack time in ms'),
        release: z.number().optional().describe('Release time in ms'),
      }),
    },
    {
      name: 'set_limiter',
      description:
        'Sets a limiter ceiling on an audio clip. Applies Dynamics Processing limiter params via QE.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number(),
        clipIndex: z.number(),
        ceiling: z.number().describe('Limiter ceiling in dBFS (e.g. -0.3)'),
      }),
    },
    {
      name: 'dereverb_clip',
      description:
        'Applies the DeReverb audio effect to a clip at the given audio track/clip index using QE addAudioEffect.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based audio track'),
        clipIndex: z.number(),
        amount: z.number().min(0).max(100).optional().describe('Amount 0-100. Default 50.'),
      }),
    },
    {
      name: 'normalize_track_peaks',
      description:
        'Normalizes all clips on an audio track to a target peak dBFS. Uses ffprobe to measure each clip peak, then sets clip gain accordingly.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based audio track index'),
        targetDbfs: z.number().optional().describe('Target peak dBFS. Default -3.'),
      }),
    },
    {
      name: 'fill_room_tone',
      description:
        'Fills an EMPTY span on one audio track with room tone: audio-only subclips of the source cut to the gap, looped when the gap is longer than the media. Refuses if anything already occupies the span on that track; never places video. Verified by reading back the track coverage.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based audio track'),
        gapStartSecs: z.number().describe('Gap start in seconds'),
        gapDurationSecs: z.number().describe('Gap duration in seconds'),
        roomToneItemId: z.string().describe('Project item nodeId of the room tone clip'),
      }),
    },
    {
      name: 'stem_export',
      description:
        'Exports individual audio tracks as separate files by muting all except the target track and exporting. Args: sequenceId, trackIndices (array), outputDir, format (wav|aac).',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndices: z.array(z.number()).describe('Audio track indices to export separately'),
        outputDir: z.string().describe('Output directory for stem files'),
        format: z.enum(['wav', 'aac']).optional().describe('Output format. Default wav.'),
      }),
    },
    {
      name: 'channel_remap_report',
      description:
        'Reports audio channel mapping for clips in the active sequence — track counts, channel layout, sample rate per clip.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },

    // Multicam
    {
      name: 'enable_multicam',
      description:
        'Enables or disables multicam mode on a timeline clip via QE setMulticam(bool). First checks canDoMulticam().',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based video track'),
        clipIndex: z.number().describe('0-based clip index'),
        enabled: z.boolean().describe('Enable or disable multicam mode'),
      }),
    },
    {
      name: 'get_multicam_angle_count',
      description:
        'Returns the number of angles/tracks in a multicam source sequence. Uses isMulticamClip() to verify and videoTracks.numTracks for count.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'flatten_multicam',
      description:
        'Flattens a multicam clip by disabling multicam mode (setMulticam(false)), converting it to a single-stream clip at the current active angle.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number(),
        clipIndex: z.number(),
      }),
    },
    {
      name: 'multicam_info',
      description:
        'Returns multicam status of a clip: isMulticamClip, canDoMulticam, multicamEnabled from the QE clip.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number(),
        clipIndex: z.number(),
      }),
    },
    {
      name: 'set_multicam_angle',
      description:
        'Switches the active multicam angle via QE setSwitchSources(sourceIndex). Args: trackIndex, clipIndex, angleIndex.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number(),
        clipIndex: z.number(),
        angleIndex: z.number().describe('0-based angle index'),
      }),
    },
    {
      name: 'create_multicam_source_sequence',
      description:
        'Creates a multicam source sequence by placing clips from a bin on separate video tracks aligned at their media start timecode. Args: binName, newSeqName, presetPath.',
      inputSchema: z.object({
        binName: z
          .string()
          .describe(
            'Bin containing the camera angles. Use a "/"-separated path ("Scenes/Scene 008/SC008_0710") for a nested bin, or a single name to deep-search the tree (ambiguous single names are rejected rather than guessed).',
          ),
        binId: z
          .string()
          .optional()
          .describe(
            'Bin nodeId -- the unambiguous way to target a nested bin, e.g. the binId returned by create_bin. Takes precedence over binName.',
          ),
        newSequenceName: z.string().describe('Name for the new multicam source sequence'),
        presetPath: z.string().optional().describe('Sequence preset path'),
      }),
    },
    {
      name: 'create_multicam_cut',
      description:
        "Builds a finished multicam cut: a new sequence whose V1 is a run of real multicam clips, each showing the angle you choose, so the cut stays re-switchable in Premiere. Angles are synced at their media start. Built through an FCP7 XML import because ExtendScript cannot create a multicam source or switch angles; verified by reading back each cut's angle.",
      inputSchema: z.object({
        angleItemIds: z
          .array(z.string())
          .describe('Project item nodeIds of the camera clips, in angle order (angle 1 first)'),
        cuts: z
          .array(
            z.object({
              startSecs: z.number(),
              endSecs: z.number(),
              angle: z.number().describe('1-based angle number'),
            }),
          )
          .describe('The edit: one entry per cut, in seconds from the start of the angles'),
        sequenceName: z.string().describe('Name for the new sequence'),
      }),
    },
    {
      name: 'create_multicam_from_clips',
      description:
        'Creates a multicam sequence from a list of project item IDs placed on separate tracks, synced at their timecodes.',
      inputSchema: z.object({
        projectItemIds: z
          .array(z.string())
          .describe('Array of project item nodeIds (one per angle)'),
        sequenceName: z.string(),
        presetPath: z.string().optional(),
      }),
    },

    // Render truth / verification
    {
      name: 'frame_diff',
      description:
        'Exports two frames from the active sequence at different times and computes their visual difference using ffmpeg PSNR. Returns PSNR score — lower means more different.',
      inputSchema: z.object({
        time1Secs: z.number().describe('First frame time in seconds'),
        time2Secs: z.number().describe('Second frame time in seconds'),
        outputDir: z.string().optional().describe('Directory for temp frames. Default /tmp.'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'verify_effect_rendered',
      description:
        'PIXEL VERIFICATION: confirms that an effect actually changed the rendered output of a clip — not just that the params were set. Captures a frame before and after applying the effect, runs ffmpeg PSNR, and reports whether a visible pixel difference was detected. Closes the QE silent-no-op honesty gap for effects like setFrameBlend and setTimeInterpolationType that have no DOM getter.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based video track index'),
        clipIndex: z.number().describe('0-based clip index'),
        effectName: z.string().describe('Effect to apply and verify (e.g. "Gaussian Blur")'),
        effectParam: z
          .string()
          .optional()
          .describe('A param name to set to confirm the effect is active (e.g. "Amount")'),
        effectParamValue: z.string().optional().describe('Value to set the param to'),
        outputDir: z
          .string()
          .optional()
          .describe(
            'Temp directory for frame captures. Default /tmp/premiere-mcp-bridge/generated-assets.',
          ),
      }),
    },
    {
      name: 'verify_color_grade',
      description:
        'PIXEL VERIFICATION: confirms that a Lumetri color grade actually changed the rendered output. Captures a frame before and after setting grade params, runs ffmpeg PSNR, and reports whether a visible change occurred. Use after lumetri_basic_set or paste_grade_to_clips to close the verify gap.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number().describe('0-based video track index'),
        clipIndex: z.number().describe('0-based clip index'),
        gradeParams: z
          .object({
            exposure: z.number().optional(),
            contrast: z.number().optional(),
            highlights: z.number().optional(),
            shadows: z.number().optional(),
            temperature: z.number().optional(),
            saturation: z.number().optional(),
          })
          .describe('The Lumetri params to apply — used to verify this specific grade landed'),
        outputDir: z.string().optional(),
      }),
    },
    {
      name: 'verify_clip_visible',
      description:
        'Checks whether a clip is actually contributing pixels: track not muted, clip enabled, opacity > 0, not fully obscured by a higher track. Returns a visibility assessment.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number(),
        clipIndex: z.number(),
      }),
    },

    // ── #5: Batch execution ─────────────────────────────────────────────
    {
      name: 'batch_execute',
      description:
        'Executes multiple ExtendScript operations in a single bridge round-trip, dramatically faster than individual tool calls for bulk operations. Each operation is an ExtendScript snippet that returns a JSON string. Results are returned as an array in the same order. Use for bulk property reads, batch label changes, mass metadata writes, or any operation where you would otherwise call 10+ tools sequentially.',
      inputSchema: z.object({
        operations: z
          .array(
            z.object({
              id: z
                .string()
                .describe('Unique identifier for this operation (returned with result)'),
              script: z
                .string()
                .describe(
                  'ExtendScript that returns JSON.stringify({...}). Has access to app, qe (after enableQE()), and all standard Premiere globals.',
                ),
            }),
          )
          .describe('Array of ExtendScript operations to run in sequence'),
        enableQE: z
          .boolean()
          .optional()
          .describe('Call app.enableQE() once before all operations. Default false.'),
      }),
    },

    // ── #7: Cross-app integration ────────────────────────────────────────
    {
      name: 'send_to_after_effects',
      description:
        'Exports the active sequence (or a clip) as a Premiere Pro project file that After Effects can open, enabling a round-trip workflow. AE can then render comps back as media for Premiere. Returns the output .prproj path.',
      inputSchema: z.object({
        outputPath: z.string().describe('Absolute path for the output .prproj file'),
        sequenceId: z
          .string()
          .optional()
          .describe('Sequence to export. Defaults to active sequence.'),
      }),
    },
    {
      name: 'frame_io_notes_to_markers',
      description:
        'Imports Frame.io review notes from a JSON export file and creates sequence markers at the corresponding timecodes. Frame.io exports a JSON with comments + timestamps when you use "Export Comments". Each comment becomes a marker with the reviewer name and comment text.',
      inputSchema: z.object({
        jsonPath: z.string().describe('Path to Frame.io comments JSON export file'),
        sequenceId: z.string().optional().describe('Target sequence. Defaults to active.'),
        markerColor: z
          .number()
          .min(0)
          .max(7)
          .optional()
          .describe('Color index for all imported markers. Default 1 (yellow).'),
      }),
    },
    {
      name: 'shotgrid_status_sync',
      description:
        'Reads a ShotGrid/ShotGrid (Autodesk) status CSV (shot name, status, assignee) and updates Premiere sequence labels + metadata to match. Maps ShotGrid statuses to label colors and writes shot code + status to project metadata. The CSV must have columns: shot_name, status, assignee.',
      inputSchema: z.object({
        csvPath: z.string().describe('Path to ShotGrid status CSV export'),
        statusToColor: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            'Map of ShotGrid status → label color index. Default: wtg=0, ip=3, fin=2, na=7.',
          ),
      }),
    },
    {
      name: 'black_frame_scan',
      description:
        'Scans a video file or exported sequence range for black frames using ffmpeg blackdetect filter. Returns list of black frame time ranges.',
      inputSchema: z.object({
        filePath: z.string().describe('Path to video file to scan'),
        threshold: z.number().optional().describe('Black threshold 0-1. Default 0.1.'),
        minDuration: z
          .number()
          .optional()
          .describe('Minimum black duration in seconds. Default 0.1.'),
      }),
    },
    {
      name: 'flash_frame_scan',
      description:
        'Scans a video file for flash frames (frames significantly brighter than neighbors) using ffmpeg. Returns timecodes of potential flashes.',
      inputSchema: z.object({
        filePath: z.string().describe('Path to video file'),
        threshold: z.number().optional().describe('Brightness threshold 0-1. Default 0.9.'),
      }),
    },
    {
      name: 'freeze_frame_scan',
      description:
        'Scans a video file for frozen frames (consecutive identical frames) using ffmpeg freezedetect. Returns list of freeze time ranges.',
      inputSchema: z.object({
        filePath: z.string().describe('Path to video file'),
        minDuration: z.number().optional().describe('Min freeze duration in seconds. Default 0.5.'),
      }),
    },
    {
      name: 'audio_silence_scan',
      description:
        'Scans an audio file for silence using ffmpeg silencedetect. Returns silence start/end times and durations.',
      inputSchema: z.object({
        filePath: z.string().describe('Path to audio/video file'),
        noiseDb: z.number().optional().describe('Noise threshold in dB. Default -50.'),
        minDuration: z
          .number()
          .optional()
          .describe('Min silence duration in seconds. Default 0.5.'),
      }),
    },
    {
      name: 'honesty_selftest',
      description:
        'Runs a self-test of core MCP tools against the live Premiere host (ping, get_version_info, get_premiere_state, list_sequences) and returns pass/fail for each. Confirms the bridge is healthy.',
      inputSchema: z.object({}),
    },

    // Productions API
    {
      name: 'convert_project_to_production',
      description:
        'Converts the current project into a Production via qe.ea.convertProjectIntoProduction(). Requires Creative Cloud login. Returns production ID on success.',
      inputSchema: z.object({
        productionPath: z.string().describe('Path where the Production folder will be created'),
        description: z.string().optional().describe('Production description'),
      }),
    },
    {
      name: 'share_production',
      description:
        'Shares the current Production with team via qe.ea.share(). Requires CC login and an active Production.',
      inputSchema: z.object({}),
    },
    {
      name: 'sync_production',
      description:
        'Syncs the current Production with the server via qe.ea.sync(). Pulls remote changes and pushes local changes.',
      inputSchema: z.object({}),
    },
    {
      name: 'get_conflicts',
      description:
        'Returns a list of sync conflicts in the current Production via qe.ea.getConflicts(). Each conflict includes a description and resolution options.',
      inputSchema: z.object({}),
    },
    {
      name: 'resolve_conflict',
      description:
        'Resolves a production sync conflict via qe.ea.resolveConflict(conflictId, resolution). Resolution options vary by conflict type.',
      inputSchema: z.object({
        conflictId: z.string().describe('Conflict ID from get_conflicts'),
        resolution: z.string().describe('Resolution action (e.g. "mine", "theirs", "manual")'),
      }),
    },
    {
      name: 'production_sync_status',
      description:
        'Returns the current Production sync status: session sync state, whether the project has unshared changes, and login status.',
      inputSchema: z.object({}),
    },

    // Source monitor
    {
      name: 'stop_source_monitor',
      description: 'Stops playback in the Source Monitor via qe.source.player.stop().',
      inputSchema: z.object({}),
    },
    {
      name: 'step_source_monitor',
      description:
        'Steps the Source Monitor playhead by one frame (or N frames) via qe.source.player.step(deltaTimecode).',
      inputSchema: z.object({
        frames: z
          .number()
          .optional()
          .describe('Frames to step. Positive=forward, negative=backward. Default 1.'),
      }),
    },
    {
      name: 'scrub_source_to',
      description:
        'Scrubs the Source Monitor to a specific timecode via qe.source.player.scrubTo(timecode). Confirmed method.',
      inputSchema: z.object({
        timecode: z.string().describe('Timecode string e.g. "00:00:01:00"'),
      }),
    },
    {
      name: 'get_source_position',
      description:
        'Returns the current Source Monitor playhead position via qe.source.player.getPosition().',
      inputSchema: z.object({}),
    },
    {
      name: 'open_file_in_source',
      description:
        'Opens a media file by path in the Source Monitor via qe.source.openFilePath(path). Confirmed working.',
      inputSchema: z.object({ filePath: z.string().describe('Absolute path to the media file') }),
    },
    {
      name: 'set_source_in_out_qe',
      description:
        'Sets source monitor in/out points via qe.source.clip.setInPoint(tc) and setOutPoint(tc). Both confirmed. Pass null to clear either point.',
      inputSchema: z.object({
        inPoint: z.string().nullable().optional().describe('In-point timecode or null to clear'),
        outPoint: z.string().nullable().optional().describe('Out-point timecode or null to clear'),
      }),
    },
    {
      name: 'get_source_clip_info_qe',
      description:
        'Returns info about the clip currently loaded in the Source Monitor via qe.source.clip: type, methods available, playhead position.',
      inputSchema: z.object({}),
    },

    // Export tools
    {
      name: 'export_with_burn_ins',
      description:
        'Exports the sequence with timecode burn-in: applies a Metadata & Timecode Burn-in effect on an adjustment layer, exports, then removes it. Returns output path.',
      inputSchema: z.object({
        outputPath: z.string().describe('Output file path'),
        presetPath: z.string().optional().describe('AME preset path. Default: H.264.'),
      }),
    },
    {
      name: 'archive_master',
      description:
        'Exports the active sequence and copies all source media to an archive folder, writing a manifest.json with file names and sizes. Args: outputDir.',
      inputSchema: z.object({
        outputDir: z.string().describe('Directory to write the archive into'),
        includeProxy: z.boolean().optional().describe('Include proxy files. Default false.'),
      }),
    },
    {
      name: 'start_encode_and_monitor',
      description:
        'Adds the active sequence to the AME queue and starts encoding. Returns job status immediately. Use get_export_progress to poll.',
      inputSchema: z.object({
        outputPath: z.string().describe('Output file path'),
        presetPath: z.string().optional().describe('AME .epr preset path'),
        workAreaType: z.number().optional().describe('0=entire, 1=work area. Default 0.'),
      }),
    },
    {
      name: 'export_per_marker_range',
      description:
        "Exports one media file per PAIR of sequence markers (marker 1 to marker 2, marker 3 to marker 4, ...), by setting the sequence in/out to each range and calling exportAsMediaDirect. Output filenames are built from the opening marker name and assume a .mp4 extension, so a preset that writes another container will be reported under missing[] rather than as a success. Every output is stat'ed on disk: success is true only when every range produced a file. The sequence in/out points are saved before the run and restored afterwards (inOutPointsRestored says whether that worked).",
      inputSchema: z.object({
        outputDir: z.string().describe('Output directory'),
        presetPath: z.string().optional().describe('AME preset path'),
        markerNamePattern: z
          .string()
          .optional()
          .describe('Filter markers by name prefix. Default: all marker pairs.'),
        sequenceId: z
          .string()
          .optional()
          .describe('Sequence to export from. Defaults to the active sequence.'),
      }),
    },
    {
      name: 'batch_export_sequences',
      description:
        'Exports multiple sequences with the same AME preset. Args: sequenceIds, outputDir, preset. Returns list of output paths.',
      inputSchema: z.object({
        sequenceIds: z.array(z.string()).describe('Sequence IDs to export'),
        outputDir: z.string().describe('Output directory'),
        presetPath: z.string().optional().describe('AME .epr preset path'),
      }),
    },
    {
      name: 'export_omf_with_settings',
      description:
        'Exports the active sequence as OMF via app.project.exportOMF(), then verifies it by checking that a new file arrived at outputPath (the API reports nothing about its own result). Only the path is honoured. 48 kHz / 16-bit.',
      inputSchema: z.object({ outputPath: z.string().describe('Output .omf file path') }),
    },
    {
      name: 'export_aaf_with_settings',
      description:
        'Exports the active sequence as AAF via app.project.exportAAF(), then verifies it by checking that a new file arrived at outputPath (the API reports nothing about its own result). Only the path is honoured. 48 kHz / 16-bit.',
      inputSchema: z.object({ outputPath: z.string().describe('Output .aaf file path') }),
    },
    {
      name: 'verify_export_file',
      description:
        'Uses ffprobe to verify an exported file: returns duration, fps, resolution, codec, file size, and whether they match expected sequence settings.',
      inputSchema: z.object({
        filePath: z.string().describe('Path to the exported file to verify'),
        expectedDurationSecs: z.number().optional(),
        expectedFps: z.number().optional(),
        expectedWidth: z.number().optional(),
        expectedHeight: z.number().optional(),
      }),
    },

    // Title & MOGRT tools
    {
      name: 'lower_third_preset',
      description:
        'Creates a lower-third text overlay at a specified time: two text layers (name + title) positioned at the bottom third of the frame. Uses add_text_overlay internally.',
      inputSchema: z.object({
        name: z.string().describe('Main name text'),
        title: z.string().optional().describe('Title/role below name'),
        startTimeSecs: z.number().describe('Start time in seconds'),
        durationSecs: z.number().optional().describe('Duration in seconds. Default 5.'),
        trackIndex: z.number().optional().describe('Video track. Default 1.'),
        mogrtPath: z
          .string()
          .optional()
          .describe(
            "MOGRT template path. Defaults to PREMIERE_MCP_DEFAULT_MOGRT. Must be an After Effects-authored template (e.g. Premiere's bundled [AE] packages): Premiere-native titles expose no scriptable text.",
          ),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'title_card',
      description:
        'Creates a full-screen centered text card clip at a specified time. Single text overlay, centered.',
      inputSchema: z.object({
        text: z.string().describe('Text to display'),
        startTimeSecs: z.number().describe('Start time in seconds'),
        durationSecs: z.number().optional().describe('Duration. Default 3.'),
        trackIndex: z.number().optional().describe('Video track. Default 1.'),
        mogrtPath: z
          .string()
          .optional()
          .describe(
            "MOGRT template path. Defaults to PREMIERE_MCP_DEFAULT_MOGRT. Must be an After Effects-authored template (e.g. Premiere's bundled [AE] packages): Premiere-native titles expose no scriptable text.",
          ),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'watermark_apply',
      description:
        'Imports a PNG/logo and places it as a clip on the topmost video track spanning the full sequence, with specified opacity. Confirms with clip count readback.',
      inputSchema: z.object({
        logoPath: z.string().describe('Absolute path to the PNG/logo file'),
        opacity: z.number().min(0).max(100).optional().describe('Opacity %. Default 50.'),
        corner: z
          .enum(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
          .optional()
          .describe('Corner placement. Default top-right.'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'set_mogrt_color',
      description:
        'Sets a color parameter on a MOGRT clip by display name. Finds the first isMGT() clip on the specified track and sets the named color param.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number(),
        clipIndex: z.number(),
        paramName: z.string().describe('Parameter display name'),
        r: z.number().min(0).max(255),
        g: z.number().min(0).max(255),
        b: z.number().min(0).max(255),
      }),
    },
    {
      name: 'get_mogrt_text_all',
      description:
        'Finds all MOGRT clips in the active sequence and returns their text parameters — name, track, clip index, and all text param values.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'remove_mogrt_clip',
      description:
        'Removes a specific MOGRT clip from the timeline by track+clip index. Verifies removal with clip count readback.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z.number(),
        clipIndex: z.number(),
      }),
    },
    {
      name: 'batch_mogrt_from_data',
      description:
        'Places lower-third MOGRTs at multiple timecodes from a data array. Each entry specifies time + text fields. Uses set_mogrt_text internally.',
      inputSchema: z.object({
        items: z
          .array(z.object({ timeSecs: z.number(), name: z.string(), title: z.string().optional() }))
          .describe('Array of lower-third data items'),
        durationSecs: z.number().optional().describe('Duration per MOGRT. Default 5.'),
        trackIndex: z.number().optional().describe('Video track. Default 1.'),
        mogrtPath: z.string().optional().describe('MOGRT template path'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'countdown_leader',
      description:
        'Creates a countdown text sequence (5, 4, 3, 2, 1) using text overlay clips. One clip per second. Placed at the specified start time.',
      inputSchema: z.object({
        startTimeSecs: z.number().describe('Start time in seconds for the countdown'),
        count: z.number().optional().describe('Count from this number down to 1. Default 5.'),
        trackIndex: z.number().optional().describe('Video track. Default 1.'),
        mogrtPath: z
          .string()
          .optional()
          .describe(
            "MOGRT template path. Defaults to PREMIERE_MCP_DEFAULT_MOGRT. Must be an After Effects-authored template (e.g. Premiere's bundled [AE] packages): Premiere-native titles expose no scriptable text.",
          ),
        sequenceId: z.string().optional(),
      }),
    },

    // Sequence ops
    {
      name: 'create_adjustment_layer_at',
      description:
        'Creates an adjustment layer clip at the specified time/track by importing a transparent solid and placing it. Returns clip info.',
      inputSchema: z.object({
        startTimeSecs: z.number().describe('Start time in seconds'),
        durationSecs: z.number().describe('Duration in seconds'),
        trackIndex: z.number().optional().describe('Video track index. Default top track.'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'nest_all_v1_clips',
      description:
        'Selects all clips on V1 and nests them into a new subsequence. Uses seq.setSelection + nest_clips. Returns the new nested sequence info.',
      inputSchema: z.object({
        newSequenceName: z.string().describe('Name for the nested sequence'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'create_sequence_from_bin',
      description:
        'Creates a new sequence and populates it with all clips from a named bin, placed sequentially on V1. Args: binName, sequenceName, presetPath.',
      inputSchema: z.object({
        binName: z
          .string()
          .describe(
            'Bin containing the source clips. Use a "/"-separated path ("Scenes/Scene 008/SC008_0710") for a nested bin, or a single name to deep-search the tree (ambiguous single names are rejected rather than guessed).',
          ),
        binId: z
          .string()
          .optional()
          .describe(
            'Bin nodeId -- the unambiguous way to target a nested bin, e.g. the binId returned by create_bin. Takes precedence over binName.',
          ),
        sequenceName: z.string().describe('Name for the new sequence'),
        presetPath: z.string().optional().describe('Sequence preset path'),
      }),
    },
    {
      name: 'get_all_clip_effects',
      description:
        'Returns a report of all effects on all clips across all video tracks in the active sequence — clip name, track, effect name, effect matchName.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'batch_replace_clips',
      description:
        'Replaces all timeline clips that reference oldItemId with newItemId across all sequences. Returns count of replaced clips.',
      inputSchema: z.object({
        oldProjectItemId: z.string().describe('NodeId of the project item to replace'),
        newProjectItemId: z.string().describe('NodeId of the replacement project item'),
        sequenceId: z
          .string()
          .optional()
          .describe('Limit to one sequence. Default: all sequences.'),
      }),
    },
    {
      name: 'clear_sequence_in_out',
      description:
        'Clears the sequence in/out points (work area markers) back to full sequence length.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },
    {
      name: 'get_sequence_gaps',
      description:
        'Returns all gaps (empty ranges) in the active sequence across all video tracks. More detailed than get_timeline_gaps.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        trackIndex: z
          .number()
          .optional()
          .describe('Limit to one track. Default: check all video tracks.'),
      }),
    },
    {
      name: 'set_sequence_start_timecode',
      description:
        'Sets the starting timecode of the sequence (zero point). Args: timecode string like "01:00:00:00".',
      inputSchema: z.object({
        timecode: z.string().describe('Starting timecode e.g. "01:00:00:00"'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'select_all_on_track',
      description: 'Selects all clips on a specified track. Optionally limit to a time range.',
      inputSchema: z.object({
        trackIndex: z.number().describe('0-based video track index'),
        startSecs: z.number().optional().describe('Optional start of time range'),
        endSecs: z.number().optional().describe('Optional end of time range'),
        sequenceId: z.string().optional(),
      }),
    },
    {
      name: 'get_sequence_duration',
      description:
        'Returns the duration of a sequence in seconds, ticks, and frames. Also returns frame size, fps, and total frame count.',
      inputSchema: z.object({ sequenceId: z.string().optional() }),
    },

    // Final 6 tools to reach 600
    {
      name: 'get_open_project_count',
      description:
        'Returns the number of currently open Premiere Pro projects. Quick check via app.projects.numProjects.',
      inputSchema: z.object({}),
    },
    {
      name: 'set_project_property',
      description:
        'Sets an application-level property via app.properties.setProperty(key, value). Confirmed working. Returns readback.',
      inputSchema: z.object({
        key: z.string().describe('Property key'),
        value: z.string().describe('Property value'),
      }),
    },
    {
      name: 'get_project_property',
      description:
        'Gets an application-level property via app.properties.getProperty(key). Returns the property value.',
      inputSchema: z.object({ key: z.string().describe('Property key') }),
    },
    {
      name: 'list_video_transitions',
      description:
        'Lists all available video transitions by name via qe.project.getVideoTransitionList(). Includes Morph Cut.',
      inputSchema: z.object({}),
    },
    {
      name: 'list_audio_transitions',
      description:
        'Lists all available audio transitions by name via qe.project.getAudioTransitionList(). Returns Constant Power, Constant Gain, Exponential Fade.',
      inputSchema: z.object({}),
    },
    {
      name: 'get_ea_status',
      description:
        'Returns full Creative Cloud / Productions login status: isLoggedIn, userEmail, username, productionList count, sessionSyncStatus. Uses qe.ea confirmed APIs.',
      inputSchema: z.object({}),
    },

    // Catalogue discovery. This server exposes hundreds of tools, which is a
    // liability for tool-selection accuracy unless the model can search rather
    // than scan. Host-independent: no Premiere request, works with Premiere closed.
    {
      name: 'look_at_cut',
      description:
        'Shows you the cut: renders one frame from the middle of each shot (or at the times you give) and returns them tiled into a single labelled contact sheet image, so you can see what is on screen in one call. Use it after an edit to check the result. Read-only.',
      inputSchema: z.object({
        sequenceId: z.string().optional(),
        times: z
          .array(z.number())
          .optional()
          .describe(
            'Sequence times in seconds to show; default one frame per shot on the top-most clips',
          ),
        maxFrames: z.number().optional().describe('At most this many frames (default 8, max 16)'),
        outputPath: z
          .string()
          .optional()
          .describe('Where to write the contact sheet (.jpg); default a temp file'),
      }),
    },
    {
      name: 'revert_last_call',
      description:
        "Undoes the whole of the last edit made through this server, however many Premiere steps it took (undo reverses one step; remove_silence or replace_clip take many). Undoes step by step until the sequence is exactly as it was before that call, and if it never gets there redoes everything, so a failed revert changes nothing. Refuses when the sequence changed after that call (those changes would be undone first) unless force is set. Calls made since this server started are tracked; call it again to go back one more. Markers added by script are not on Premiere's undo stack, so marker-only edits cannot be reverted this way.",
      inputSchema: z.object({
        sequenceId: z
          .string()
          .optional()
          .describe('Revert the last edit on this sequence (default: the last edit anywhere)'),
        force: z.boolean().optional().describe('Also undo changes made after that call'),
        maxSteps: z.number().optional().describe('Most undo steps to try (default 40, max 200)'),
      }),
    },
    {
      name: 'what_changed',
      description:
        'What changed in a sequence since the last edit made through this server, or since the last what_changed: clips added, removed, moved or trimmed, renamed, tracks, markers, and project sequence/item counts. Use it after the user has worked in Premiere by hand, before relying on clip ids from earlier replies. The first call in a session records a baseline.',
      inputSchema: z.object({
        sequenceId: z.string().optional().describe('Default: the active sequence'),
      }),
    },
    {
      name: 'get_project_notes',
      description:
        "Reads this project's notes: conventions recorded with add_project_note (shot naming, where renders land, bins, the export preset the client wants). Kept as a Markdown file next to the .prproj; get_project_info includes it too.",
      inputSchema: z.object({}),
    },
    {
      name: 'add_project_note',
      description:
        'Records a convention for this project so later sessions (and teammates) start knowing it, e.g. "shots are SPHE_<seq>_<shot>; comps land in /renders/<shot>/". Appended under a section in the Markdown notes file next to the .prproj.',
      inputSchema: z.object({
        note: z.string().describe('The convention, one line'),
        section: z.string().optional().describe('Section heading (default "Conventions")'),
      }),
    },
    {
      name: 'stringout_from_transcript',
      description:
        'Rough cut from a transcript: give the lines you want (quotes, in cut order) and a Whisper .json or .srt transcript of the source clip, and this builds a new sequence with just those moments, end to end. Quotes are found by their words (case and punctuation ignored, near-misses allowed and reported with a score); quotes that are not found are listed, not guessed. Explicit source ranges in seconds can be given instead of, or as well as, quotes. Handles add a little air on each side because .srt word timing is estimated within each caption. Use dryRun to see the matched ranges first.',
      inputSchema: z.object({
        projectItemId: z
          .string()
          .describe('The source clip (project item) the transcript belongs to'),
        transcriptPath: z
          .string()
          .optional()
          .describe('Whisper .json (word timestamps preferred) or .srt of that clip'),
        quotes: z
          .array(z.string())
          .optional()
          .describe('Lines to use, in the order they should play'),
        ranges: z
          .array(z.object({ start: z.number(), end: z.number(), label: z.string().optional() }))
          .optional()
          .describe('Source ranges in seconds, used when there are no quotes'),
        sequenceName: z
          .string()
          .optional()
          .describe('Name of the new sequence (default: "<clip> stringout")'),
        handleSeconds: z
          .number()
          .optional()
          .describe('Air kept before and after each line (default 0.15)'),
        gapSeconds: z.number().optional().describe('Black between lines (default 0)'),
        minScore: z
          .number()
          .optional()
          .describe('How close a quote must match, 0-1 (default 0.75)'),
        dryRun: z.boolean().optional().describe('Only report the matched ranges'),
      }),
    },
    {
      name: 'sync_by_audio',
      description:
        "Lines up clips recorded at the same time (several cameras, a camera and a separate sound recorder) by matching their audio waveforms. Returns each clip's offset from the reference in seconds and a match score (0-1; below about 0.3 the audio probably is not the same event). With sequenceName it also builds a new sequence with the reference on V1/A1 and each other clip on its own track at its synced position. Uses ffmpeg; makes no change unless sequenceName is given.",
      inputSchema: z.object({
        referenceItemId: z.string().describe('Project item to sync everything to'),
        itemIds: z.array(z.string()).describe('Project items to sync to the reference'),
        maxOffsetSeconds: z.number().optional().describe('Search range either way (default 30)'),
        analyzeSeconds: z
          .number()
          .optional()
          .describe('How much of each file to compare (default 90)'),
        sequenceName: z.string().optional().describe('Build a synced sequence with this name'),
      }),
    },
    {
      name: 'remove_silence',
      description:
        "Cuts the silent pauses out of a clip and closes each gap on EVERY track, so picture, music and other audio stay in sync (jump-cut style). Detects silence in the clip's own audio with ffmpeg, keeps a little padding either side, and snaps cuts to frames. Without confirm it only returns the plan (ranges and total seconds) and asks; with confirm:true it takes a recovery checkpoint first, then cuts last-to-first and verifies the total time removed.",
      inputSchema: z.object({
        clipId: z.string().describe('Timeline clip whose audio decides what is silent'),
        noiseThresholdDb: z
          .number()
          .optional()
          .describe('Quieter than this is silence (default -35 dBFS)'),
        minSilenceSeconds: z.number().optional().describe('Shortest pause to cut (default 0.5)'),
        paddingSeconds: z
          .number()
          .optional()
          .describe('Pause kept either side of each cut (default 0.1)'),
        confirm: z
          .boolean()
          .optional()
          .describe('Apply the cuts (default: return the plan and ask)'),
      }),
    },
    {
      name: 'version_up_shots',
      description:
        'Brings every versioned shot in the project up to its newest render on disk. Finds project items whose file is named like SH010_comp_v003.mp4, looks for newer versions (same name, higher _v number, same extension) in the folders those files are in plus any renderDirs you give, and relinks each item to its newest version with replace_clip_media -- so every timeline clip keeps its trims, effects and position, and items or clips still named after the old file are renamed. Reports what moved, what was already current, and what failed. Use dryRun to see the plan first.',
      inputSchema: z.object({
        renderDirs: z
          .array(z.string())
          .optional()
          .describe('Extra folders to search for new versions (absolute paths)'),
        recursive: z
          .boolean()
          .optional()
          .describe('Search subfolders of renderDirs too (default true)'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Only report the plan; change nothing (default false)'),
        shotFilter: z
          .string()
          .optional()
          .describe('Only shots whose name contains this text, e.g. "SH010" or "SQ05"'),
      }),
    },
    {
      name: 'where_used',
      description:
        'Where is this project item used? Lists every timeline use of a clip, or of anything inside a bin: sequence, track and start time. Ask it before deleting or relinking media. Read-only.',
      inputSchema: z.object({
        projectItemId: z.string().describe('Project item or bin nodeId'),
        limit: z
          .number()
          .optional()
          .describe('Max uses to list (default 50); the total is always reported'),
      }),
    },
    {
      name: 'get_recent_calls',
      description:
        'Answers "did my last call run?". Lists the most recent tool calls this server received, newest first, with status (running / ok / failed), start and finish times, and a summary of the result -- including calls whose response the client never saw because it timed out. Check it BEFORE retrying an edit that timed out, so the edit is not applied twice. Any tool also accepts an optional requestId: a retry with the same requestId returns the first result instead of running again. Read-only; makes no Premiere request.',
      inputSchema: z.object({
        limit: z.number().optional().describe('How many calls (default 10, max 100)'),
        mutatingOnly: z.boolean().optional().describe('Only calls that can change the project'),
        sinceSeconds: z.number().optional().describe('Only calls started within this many seconds'),
      }),
    },
    {
      name: 'start_job',
      description:
        "Runs any tool in the background and returns a jobId at once, so a slow call (export, render, transcription, stems, workflow) cannot outlive the client's timeout. Poll get_job with the jobId for status and, when done, the tool's own result. Jobs live in this server process.",
      inputSchema: z.object({
        tool: z.string().describe('Name of the tool to run'),
        args: z.record(z.string(), z.any()).optional().describe('Arguments for that tool'),
      }),
    },
    {
      name: 'get_job',
      description:
        "Status of a background job started with start_job: running / done / failed, elapsed seconds, and when finished the tool's result.",
      inputSchema: z.object({ jobId: z.string() }),
    },
    {
      name: 'list_jobs',
      description:
        'Lists background jobs started with start_job in this server process, newest first, without their full results.',
      inputSchema: z.object({}),
    },
    {
      name: 'find_tool',
      description:
        'Searches THIS server\'s own tool catalogue by keyword and returns the best-matching tool names with their descriptions, ranked. Use it FIRST whenever you are unsure which tool does a job, instead of guessing a name and getting "Tool not found" -- this catalogue has hundreds of tools and searching it is far more reliable than scanning it. Matches against tool names and descriptions (lexical, not semantic, so prefer a domain noun like "marker", "proxy", "lumetri", "caption", "keyframe" over a full sentence). Reports how many tools were searched, and honestly flags any match that exists in this build but is hidden by the active tool profile as exposed:false rather than omitting it, so a curated deployment cannot look like a missing capability. Read-only: makes no Premiere request and changes nothing.',
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'Keyword(s) describing the job, e.g. "marker", "audio fade", "export preset", "offline media"',
          ),
        limit: z.number().optional().describe('Max matches to return (default 15, max 100)'),
        readOnly: z
          .boolean()
          .optional()
          .describe(
            'Only return inspection tools (name begins with get/list/read/find/search/inspect/is/check/detect/probe/validate/verify/lint/diff). Naming heuristic, not a capability guarantee.',
          ),
        includeParameters: z
          .boolean()
          .optional()
          .describe(
            "Include each match's parameter names (default false, to keep the response small)",
          ),
        includeHidden: z
          .boolean()
          .optional()
          .describe(
            'Include matches hidden by the active tool profile, flagged exposed:false (default true)',
          ),
      }),
    },
    // Schema-on-demand: the whole catalogue, reachable through three tool definitions
    // instead of 639. find_tool (search) -> get_tool_typings (signature) -> call_tool
    // (invoke). Host-independent gate; the target tool does whatever it normally does.
    {
      name: 'call_tool',
      description:
        'Invokes ANY tool this build implements, including tools the active profile does not advertise, by name. Use this when find_tool showed you a tool marked exposed:false -- it is the call path for the rest of the catalogue, so a curated tool list costs you context, not capability. Call get_tool_typings({ only: ["<name>"] }) first to get the exact argument shape. Arguments are validated against that tool\'s real schema before anything runs, and the result is that tool\'s own result, unchanged. dryRun validates the arguments and returns the resolved schema WITHOUT running anything. It will refuse, naming the setting responsible, when the deployment sets an authority boundary rather than a context-cost profile (PREMIERE_MCP_PROFILE=read-only, an explicit PREMIERE_MCP_TOOLS allowlist, or a PREMIERE_MCP_EXCLUDE veto).',
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            'Exact tool name to invoke, e.g. "apply_lumetri_preset". Use find_tool to search for it.',
          ),
        args: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            'Arguments for the target tool, exactly as that tool documents them. Omit for a tool that takes none.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Validate the arguments against the target's schema and return the resolved JSON Schema without invoking it (default false)",
          ),
      }),
    },
    {
      name: 'activate_tools',
      description:
        'Promotes hidden tools into the advertised tool list for the rest of this session, so the client sees their real typed schemas instead of routing through call_tool. Pass explicit names, a query to activate the top matches of a catalogue search, or a bundle to load a whole task menu at once (task-orient, task-rough-cut, task-cut-dialogue, task-caption, task-grade, task-motion, task-conform-deliver, task-review-notes, or core; "grade" or "grading" also works). Warns once the list passes ~50 tools. Emits a tools/list_changed notification, so a client that follows the MCP spec re-lists automatically. Returns the measured context cost of the new list, because growing the menu is a real cost and should be visible rather than silent. Refuses any tool an authority boundary excludes (read-only profile, explicit allowlist, or exclusion veto) and says which. Activation is session state and is never persisted -- restarting the server returns exactly the configured profile.',
      inputSchema: z.object({
        names: z
          .array(z.string())
          .optional()
          .describe('Exact tool names to advertise, e.g. ["normalize_loudness","loudness_report"]'),
        query: z
          .string()
          .optional()
          .describe(
            'Instead of names: activate the best catalogue matches for this keyword (same ranking as find_tool)',
          ),
        limit: z
          .number()
          .optional()
          .describe('With query: how many matches to activate (default 8, max 50)'),
        bundle: z
          .string()
          .optional()
          .describe('A task menu to load whole, e.g. "task-grade" or "grade"'),
      }),
    },
    {
      name: 'deactivate_tools',
      description:
        'Removes tools previously added by activate_tools from the advertised list, shrinking the context cost back down. Pass names, a bundle to drop a task menu loaded with activate_tools, or all:true to return to exactly the configured profile. Emits tools/list_changed. Cannot remove a tool the configured profile itself advertises -- change PREMIERE_MCP_PROFILE for that.',
      inputSchema: z.object({
        names: z.array(z.string()).optional().describe('Activated tool names to stop advertising'),
        all: z
          .boolean()
          .optional()
          .describe('Deactivate everything activate_tools added this session (default false)'),
        bundle: z.string().optional().describe('Drop the tools a bundle activation added'),
      }),
    },
    {
      name: 'get_tool_typings',
      description:
        "Returns TypeScript declarations (.d.ts) for this server's tools: an argument interface per tool, a ToolName union, and one overloaded callTool signature per callable tool. Fetch this BEFORE authoring a script or a multi-step plan against these tools -- it turns a wrong argument shape into a compile-time error instead of a runtime tool failure you have to decode from an error string. Generated from the same schemas the server validates against, so it cannot drift. Tools hidden by the active profile are still declared and marked @profileHidden rather than omitted. Read-only: makes no Premiere request.",
      inputSchema: z.object({
        only: z
          .array(z.string())
          .optional()
          .describe(
            'Restrict output to these tool names. Omit for the whole catalogue (large - prefer find_tool first, then request typings for the handful you need).',
          ),
        includeHidden: z
          .boolean()
          .optional()
          .describe('Declare tools the active profile hides, marked @profileHidden (default true)'),
      }),
    },

    // Transactional editing. Snapshots the active sequence, runs a plan step by
    // step, verifies each one, and rolls back to the snapshot if any step fails
    // or cannot be proven. Refuses before running anything it cannot promise to
    // undo. Orchestrates existing verified handlers — emits no ExtendScript of
    // its own. See src/tools/transactions.ts.
    {
      name: TRANSACTION_TOOL_NAME,
      description:
        "Runs a multi-step sequence edit as an all-or-nothing transaction: it clones the active sequence into a recovery snapshot FIRST, runs your steps in order, verifies each one (read-back, fingerprint, or the tool's own verified flag), and if any step fails or cannot be proven it restores the snapshot and reports exactly where it stopped. Every step is classified BEFORE anything runs; if any step names a tool whose effect escapes one sequence (imports, bin/project-item changes, file writes, arbitrary scripts, project/sequence lifecycle), the whole transaction refuses without touching the project — a sequence clone cannot put those back. dryRun classifies the plan without reading or writing anything. Only wraps edits whose whole effect stays inside the active sequence; run anything else outside a transaction. Read the verifiedEndToEnd, rolledBack, and projectStateNow fields of the result — they say plainly what state the project is in.",
      inputSchema: transactSequenceEditsSchema,
    },
  ];
}
