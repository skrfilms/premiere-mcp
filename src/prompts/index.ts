/**
 * MCP Prompts for Adobe Premiere Pro — workflow templates that drive THIS server's tools.
 *
 * History, because it explains the shape. This file was inherited byte-identical from
 * the upstream fork and every prompt was a canned essay: a `user` turn asking "how do
 * I do X", followed by a pre-written `assistant` turn containing a six-bullet list of
 * generic editing advice ("Add basic transitions", "Beat detection (if available)").
 * Not one of them named a single tool this server exposes. A prompt that pre-writes
 * the assistant's answer teaches the model that the correct response is prose, which
 * is the opposite of what an MCP prompt is for — and it made our prompt surface
 * decorative while the 600+ tool surface went undirected.
 *
 * These are rebuilt as *tool-chain* templates. Each workflow declares:
 *   - the ordered tool chain an agent should actually walk,
 *   - the read-before-write orientation step,
 *   - the verification step that closes the loop,
 *   - and the honesty discipline (report verified:false rather than claiming success).
 *
 * Every tool named here is asserted to exist in the live catalogue by
 * `src/__tests__/prompts/tool-chains.test.ts`, so a renamed or removed tool breaks the
 * build instead of quietly sending an agent after a tool that is not there.
 *
 * Prompt names and argument names are preserved from the inherited version so existing
 * clients keep working.
 */

import { Logger } from '../utils/logger.js';

export interface MCPPrompt {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text';
    text: string;
  };
}

export interface GeneratedPrompt {
  description: string;
  messages: PromptMessage[];
}

/** One workflow: what it is for, and the tools that actually do it. */
interface WorkflowSpec {
  name: string;
  /** Shown in prompts/list. */
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
  /** Role the agent should adopt, one sentence. */
  role: string;
  /**
   * The ordered chain. Each step is a plain-English goal plus the exact tools to use.
   * Tool names are validated against the live catalogue in tests.
   */
  steps: Array<{ goal: string; tools: string[] }>;
  /** Workflow-specific cautions — real limits of this server, not generic advice. */
  cautions?: string[];
  /** Builds the concrete task line from the caller's arguments. */
  task: (args: Record<string, any>) => string;
}

/** Orientation every workflow starts with. Read before writing, always. */
const ORIENT: string[] = [
  'verify_premiere_connection',
  'get_project_info',
  'list_sequences',
  'get_active_sequence',
];

const WORKFLOWS: WorkflowSpec[] = [
  {
    name: 'create_video_project',
    description:
      'Tool-chain workflow to stand up a new project, import and organize media, and build a first assembly — with a lint and a render-truth check before export',
    arguments: [
      { name: 'project_type', description: 'Type of video project (e.g., "social media", "documentary", "commercial")', required: true },
      { name: 'duration', description: 'Expected duration of the final video', required: false },
    ],
    role: 'You are an assistant editor building a project from scratch through the Premiere MCP tools.',
    steps: [
      { goal: 'Confirm the bridge is live and see what already exists before creating anything', tools: ORIENT },
      { goal: 'Survey the media on disk BEFORE importing, so you import deliberately rather than everything', tools: ['index_footage', 'search_footage', 'probe_media'] },
      { goal: 'Create the project and a sequence whose settings match the footage you just probed', tools: ['create_project', 'create_sequence', 'get_sequence_settings'] },
      { goal: 'Import and organize into bins rather than a flat project panel', tools: ['import_media', 'import_folder', 'create_bin', 'move_items_to_bin', 'rename_project_item'] },
      { goal: 'Lay the assembly down in one batch instead of one call per clip', tools: ['add_to_timeline_batch', 'add_to_timeline'] },
      { goal: 'Quality-control the assembly — gaps, flash frames, overlaps, mixed frame rates', tools: ['lint_timeline', 'get_timeline_gaps'] },
      { goal: 'Look at the actual composited pixels before declaring the edit good', tools: ['capture_program_output'] },
      { goal: 'Export and verify the delivered file really matches the sequence', tools: ['export_sequence', 'verify_export', 'delivery_qc'] },
    ],
    cautions: [
      'Sequence settings are far easier to get right at creation than to change afterwards — probe the footage first.',
    ],
    task: (args) => {
      const type = args.project_type || 'general';
      const duration = args.duration;
      return `Build a new ${type} video project${duration ? ` with a target duration of ${duration}` : ''}.`;
    },
  },
  {
    name: 'edit_music_video',
    description:
      'Tool-chain workflow for a beat-driven cut: mark the beats, build the sequence from those markers, then verify the cut lands where the markers are',
    arguments: [
      { name: 'music_file', description: 'Path to the music file', required: true },
      { name: 'video_clips', description: 'List of video clip paths', required: true },
    ],
    role: 'You are a music-video editor cutting to a track through the Premiere MCP tools.',
    steps: [
      { goal: 'Orient in the project', tools: ORIENT },
      { goal: 'Import the track and the picture, and read the track\'s real duration and sample rate', tools: ['import_media', 'probe_media'] },
      { goal: 'Find cut candidates from the audio rather than guessing tempo', tools: ['detect_silence', 'probe_media'] },
      { goal: 'Place a marker at every cut point you intend to hit, then read them back', tools: ['add_marker', 'list_markers'] },
      { goal: 'Build the cut FROM the markers so the edit and the beat map cannot drift apart', tools: ['sequence_from_markers', 'create_subclips_from_markers', 'add_to_timeline_batch'] },
      { goal: 'Refine timing on individual clips', tools: ['trim_clip', 'split_clip', 'move_clip', 'ripple_delete'] },
      { goal: 'Add transitions in one batch pass rather than per cut', tools: ['batch_add_transitions', 'add_transition'] },
      { goal: 'Confirm the cut points still coincide with the markers, and that nothing flashed', tools: ['lint_timeline', 'list_markers', 'capture_program_output'] },
    ],
    cautions: [
      'There is no tempo/beat-grid or transient-detection API in Premiere, and this build has no beat detector. Establish the beat map yourself and record it as markers — markers are the durable, readable-back record, so write them before you cut.',
    ],
    task: (args) => {
      const music = args.music_file || 'the supplied music track';
      const clips = Array.isArray(args.video_clips) ? args.video_clips.join(', ') : args.video_clips || 'the supplied video clips';
      return `Cut a music video using ${music} as the track and these clips: ${clips}.`;
    },
  },
  {
    name: 'color_grade_footage',
    description:
      'Tool-chain workflow for a numeric Lumetri grade, read back and propagated — with scopes and a real composited frame as the check, not eyeballing a claim',
    arguments: [
      { name: 'footage_type', description: 'Type of footage (e.g., "log", "standard", "raw")', required: true },
      { name: 'target_mood', description: 'Desired mood or look (e.g., "cinematic", "vibrant", "moody")', required: false },
    ],
    role: 'You are a colorist grading through the Premiere MCP tools.',
    steps: [
      { goal: 'Orient, and identify exactly which clips you are grading', tools: [...ORIENT, 'get_selected_clips', 'get_clip_properties'] },
      { goal: 'Read the source ground truth — codec, bit depth, color space — before choosing a treatment', tools: ['probe_media', 'get_color_space', 'get_footage_interpretation'] },
      { goal: 'Attach Lumetri (log footage: put the transform on first)', tools: ['apply_lumetri_preset', 'apply_lut'] },
      { goal: 'Set the grade numerically rather than by preset name, so the values are knowable', tools: ['lumetri_basic_set', 'lumetri_creative_set', 'lumetri_vignette_set', 'lumetri_hsl_secondary_set'] },
      { goal: 'Read the grade back and confirm the values actually landed', tools: ['lumetri_report'] },
      { goal: 'Measure the signal instead of trusting the look', tools: ['generate_scope', 'capture_program_output'] },
      { goal: 'Propagate the approved grade to the rest of the shots', tools: ['copy_grade', 'paste_grade_to_clips'] },
    ],
    cautions: [
      'Free-draw bezier/ellipse masks on effects have no scripting API. Use apply_video_effect with "Track Matte Key", or lumetri_hsl_secondary_set for color-keyed isolation.',
      'setValue clamps silently, so lumetri_report is not optional — it is how you learn a value was rejected.',
    ],
    task: (args) => {
      const footage = args.footage_type || 'standard';
      const mood = args.target_mood;
      return `Grade ${footage} footage${mood ? ` toward a ${mood} look` : ''}.`;
    },
  },
  {
    name: 'multicam_editing',
    description:
      'Tool-chain workflow to sync multiple angles into a multicam sequence and cut between them, verifying sync rather than assuming it',
    arguments: [
      { name: 'camera_count', description: 'Number of camera angles', required: true },
      { name: 'sync_method', description: 'Method for syncing cameras (timecode, audio, markers)', required: true },
    ],
    role: 'You are an editor assembling a multicam edit through the Premiere MCP tools.',
    steps: [
      { goal: 'Orient in the project', tools: ORIENT },
      { goal: 'Import every angle and read each one\'s real timecode, frame rate and duration', tools: ['import_media', 'import_folder', 'probe_media', 'get_project_item_info'] },
      { goal: 'Confirm the angles share a frame rate before syncing — a mismatch is the usual cause of drift', tools: ['get_footage_interpretation', 'set_footage_interpretation'] },
      { goal: 'Build the multicam source sequence', tools: ['create_multicam_from_clips', 'create_sequence_from_clips'] },
      { goal: 'Verify sync by inspecting the assembled structure and looking at the frame', tools: ['get_full_sequence_info', 'lint_timeline', 'capture_program_output'] },
      { goal: 'Cut between angles', tools: ['razor_all_tracks', 'split_clip', 'enable_disable_clip', 'move_clip_to_track'] },
      { goal: 'Final QC on the cut', tools: ['lint_timeline', 'get_timeline_gaps'] },
    ],
    cautions: [
      'Merged-clip creation is detection-only in Premiere\'s scripting API. Use link_audio_video to associate audio with picture.',
      'A mixed frame rate across angles will stutter and lint_timeline flags it — fix interpretation before syncing, not after.',
    ],
    task: (args) => {
      const count = args.camera_count || 'several';
      const method = args.sync_method || 'audio';
      return `Assemble a multicam edit from ${count} camera angles, synced by ${method}.`;
    },
  },
  {
    name: 'podcast_editing',
    description:
      'Tool-chain workflow for a dialogue edit: silence removal, loudness to spec, ducking, and captions — every step measured',
    arguments: [
      { name: 'participant_count', description: 'Number of participants in the podcast', required: true },
      { name: 'episode_length', description: 'Target length of the episode', required: false },
    ],
    role: 'You are a dialogue editor cutting a podcast through the Premiere MCP tools.',
    steps: [
      { goal: 'Orient, and take a recovery point before any bulk removal', tools: [...ORIENT, 'create_recovery_checkpoint'] },
      { goal: 'Find the dead air by measurement rather than by ear', tools: ['detect_silence', 'probe_media'] },
      { goal: 'Remove it and close the holes so nothing is left out of sync', tools: ['ripple_delete', 'split_clip', 'remove_from_timeline', 'get_timeline_gaps'] },
      { goal: 'Clean each voice track', tools: ['denoise_clip', 'set_parametric_eq', 'set_compressor', 'set_essential_sound_category'] },
      { goal: 'Duck the music under speech with a real keyframe curve', tools: ['setup_ducking', 'add_audio_keyframes', 'fade_in_audio', 'fade_out_audio'] },
      { goal: 'Hit a loudness spec, and MEASURE the result', tools: ['loudness_report', 'normalize_loudness'] },
      { goal: 'Transcribe, edit the caption text on disk, then ingest it', tools: ['transcribe_to_srt', 'read_srt', 'validate_srt', 'update_srt_cue', 'write_srt', 'create_caption_track'] },
      { goal: 'Final QC and delivery', tools: ['lint_timeline', 'export_sequence', 'verify_export'] },
    ],
    cautions: [
      'Premiere\'s DOM can INGEST an .srt but exposes no caption read/update/delete API. All caption editing happens on the .srt file on disk, before (re-)ingest — that is what the read_srt/write_srt family is for.',
      'Essential Sound auto-analysis is panel logic and is not exposed. Apply the effects directly.',
      'Silence removal is bulk and destructive: take create_recovery_checkpoint first, or set PREMIERE_MCP_AUTO_CHECKPOINT=1.',
    ],
    task: (args) => {
      const count = args.participant_count || 'multiple';
      const length = args.episode_length;
      return `Edit a podcast episode with ${count} participants${length ? `, targeting ${length}` : ''}.`;
    },
  },
  {
    name: 'social_media_content',
    description:
      'Tool-chain workflow to cut down and reframe for a vertical/square platform, with a platform export preset and a real frame check',
    arguments: [
      { name: 'platform', description: 'Target platform (Instagram, TikTok, YouTube, etc.)', required: true },
      { name: 'content_type', description: 'Type of content (story, post, reel, etc.)', required: true },
    ],
    role: 'You are an editor producing a platform-native cutdown through the Premiere MCP tools.',
    steps: [
      { goal: 'Orient, and duplicate the master so the cutdown never edits it', tools: [...ORIENT, 'duplicate_sequence'] },
      { goal: 'Set the delivery frame size for the platform', tools: ['set_sequence_resolution', 'get_sequence_settings'] },
      { goal: 'Reframe the picture for the new aspect ratio', tools: ['auto_reframe_sequence', 'set_clip_position', 'set_clip_scale', 'set_scale_to_frame_size'] },
      { goal: 'Cut it to length', tools: ['set_sequence_in_out_points', 'split_clip', 'ripple_delete', 'trim_clip'] },
      { goal: 'Burn in captions (essential for sound-off viewing)', tools: ['transcribe_to_srt', 'read_srt', 'write_srt', 'create_caption_track'] },
      { goal: 'Confirm the reframe did not crop the subject out — look at the pixels', tools: ['capture_program_output', 'generate_scope', 'lint_timeline'] },
      { goal: 'Export with the platform preset and verify the file', tools: ['export_social_preset', 'export_sequence', 'verify_export'] },
    ],
    cautions: [
      'auto_reframe_sequence is an analysis pass, not a guarantee. capture_program_output is the only way to know the subject survived the crop.',
    ],
    task: (args) => {
      const platform = args.platform || 'the target platform';
      const type = args.content_type || 'video';
      return `Produce a ${type} for ${platform}.`;
    },
  },
  {
    name: 'documentary_editing',
    description:
      'Tool-chain workflow for a transcript-driven documentary assembly: index and log the material, string out selects, then structure',
    arguments: [
      { name: 'interview_count', description: 'Number of interview subjects', required: true },
      { name: 'narrative_structure', description: 'Narrative structure (chronological, thematic, etc.)', required: false },
    ],
    role: 'You are a documentary editor working from transcripts through the Premiere MCP tools.',
    steps: [
      { goal: 'Orient in the project', tools: ORIENT },
      { goal: 'Index the material on disk first — footage discovery is the real bottleneck on a doc', tools: ['index_footage', 'search_footage', 'probe_media'] },
      { goal: 'Import and organize by subject and theme', tools: ['import_folder', 'create_bin', 'move_items_to_bin', 'batch_rename_project_items', 'set_color_label'] },
      { goal: 'Transcribe every interview and search the text for your selects', tools: ['transcribe_to_srt', 'read_srt', 'validate_srt'] },
      { goal: 'Log the selects as markers and subclips so they are addressable', tools: ['add_marker', 'list_markers', 'create_subclips_from_markers', 'batch_log_from_csv', 'markers_from_csv'] },
      { goal: 'String out the selects, then restructure', tools: ['create_sequence_from_bin', 'sequence_from_markers', 'add_to_timeline_batch', 'move_clip', 'nest_clips'] },
      { goal: 'Track versions as the cut evolves', tools: ['duplicate_sequence', 'diff_sequences', 'assemble_review_reel'] },
      { goal: 'QC the assembly', tools: ['lint_timeline', 'get_timeline_gaps', 'get_offline_media'] },
    ],
    cautions: [
      'diff_sequences is how you answer "what changed between v3 and v4" without re-watching both.',
    ],
    task: (args) => {
      const count = args.interview_count || 'several';
      const structure = args.narrative_structure;
      return `Assemble a documentary from ${count} interview subjects${structure ? `, structured ${structure}` : ''}.`;
    },
  },
  {
    name: 'commercial_editing',
    description:
      'Tool-chain workflow for a spot: exact-duration cut, graphics, grade, and a broadcast-spec delivery check',
    arguments: [
      { name: 'commercial_length', description: 'Length of the commercial (15s, 30s, 60s, etc.)', required: true },
      { name: 'product_type', description: 'Type of product being advertised', required: false },
    ],
    role: 'You are an editor cutting a commercial to an exact duration through the Premiere MCP tools.',
    steps: [
      { goal: 'Orient in the project', tools: ORIENT },
      { goal: 'Assemble the spot — a composite tool does the placement, motion and transitions in one round trip', tools: ['assemble_product_spot', 'build_brand_spot_from_mogrt_and_assets', 'add_to_timeline_batch'] },
      { goal: 'Hit the exact duration — a spot that is 30.04s is a rejected spot', tools: ['get_sequence_duration', 'set_sequence_in_out_points', 'trim_clip', 'ripple_delete'] },
      { goal: 'Add and populate graphics', tools: ['import_mogrt', 'add_text_overlay', 'get_mogrt_component'] },
      { goal: 'Animate with real eased keyframes rather than linear ramps', tools: ['bake_keyframe_ease', 'add_keyframe', 'set_keyframe_interpolation'] },
      { goal: 'Grade and confirm the numbers landed', tools: ['apply_lumetri_preset', 'lumetri_basic_set', 'lumetri_report', 'generate_scope'] },
      { goal: 'Mix to the broadcast loudness spec', tools: ['loudness_report', 'normalize_loudness'] },
      { goal: 'Full delivery QC before you hand it over', tools: ['lint_timeline', 'validate_project_for_export', 'export_sequence', 'verify_export', 'delivery_qc'] },
    ],
    cautions: [
      'MOGRT text writes can silently no-op on an opaque token. add_text_overlay reads the Source Text back and reports partial/failed rather than claiming success — believe that field.',
      'get_sequence_duration returns ticks and frames as well as seconds. Use frames for an exact-duration deliverable; seconds round.',
    ],
    task: (args) => {
      const length = args.commercial_length || '30s';
      const product = args.product_type;
      return `Cut a ${length} commercial${product ? ` for a ${product}` : ''}.`;
    },
  },
  {
    name: 'optimize_workflow',
    description:
      'Tool-chain workflow to diagnose and speed up a heavy project: find what is broken or wasteful, then fix it with proxies, cache and consolidation',
    arguments: [
      { name: 'project_size', description: 'Size of the project (small, medium, large)', required: true },
      { name: 'hardware_specs', description: 'Hardware specifications', required: false },
    ],
    role: 'You are a post-production engineer tuning a Premiere project through the MCP tools.',
    steps: [
      { goal: 'Establish what this build can actually do on THIS machine before recommending anything', tools: ['get_capabilities', 'verify_premiere_connection', 'get_version_info'] },
      { goal: 'Find the real problems in the project', tools: ['get_full_project_overview', 'get_offline_media', 'check_offline_media', 'get_unused_media', 'get_duplicate_media'] },
      { goal: 'Reclaim space and remove duplication', tools: ['consolidate_duplicates', 'delete_preview_files', 'get_used_media_report'] },
      { goal: 'Speed up playback with proxies', tools: ['manage_proxies', 'has_proxy', 'set_transcode_on_ingest', 'get_proxies_enabled'] },
      { goal: 'Point the caches at fast storage', tools: ['get_project_scratch_disks', 'set_project_scratch_disk', 'set_scratch_disk_path'] },
      { goal: 'Understand render state instead of re-rendering blindly', tools: ['get_sequence_render_status', 'get_timeline_render_status', 'render_sequence_previews'] },
      { goal: 'Fix editorial defects that cost render time', tools: ['lint_timeline', 'get_timeline_gaps'] },
    ],
    cautions: [
      'Proxy creation queues an encode in Adobe Media Encoder and returns immediately. Attach the proxy in a second call once AME has finished — there is no single-call create-and-attach.',
      'Report get_capabilities findings honestly: if ffmpeg or the Whisper CLI is absent, the tools that depend on them will fail, and saying so up front beats a failure mid-workflow.',
    ],
    task: (args) => {
      const size = args.project_size || 'medium';
      const hardware = args.hardware_specs;
      return `Diagnose and optimize a ${size} Premiere project${hardware ? ` running on ${hardware}` : ''}.`;
    },
  },
  {
    name: 'audio_cleanup',
    description:
      'Tool-chain workflow to repair and deliver audio: measure the problem, apply the matching repair, then re-measure to prove it improved',
    arguments: [
      { name: 'audio_issues', description: 'Specific audio issues to address', required: true },
      { name: 'audio_source', description: 'Source of the audio (microphone, phone, etc.)', required: false },
    ],
    role: 'You are an audio post engineer repairing a mix through the Premiere MCP tools.',
    steps: [
      { goal: 'Orient, and identify the clips in question', tools: [...ORIENT, 'get_selected_clips', 'list_sequence_tracks'] },
      { goal: 'MEASURE before you treat — codec, channels, sample rate, loudness, dead air', tools: ['probe_media', 'loudness_report', 'detect_silence', 'channel_remap_report'] },
      { goal: 'Apply the repair that matches the measurement', tools: ['denoise_clip', 'set_parametric_eq', 'set_compressor', 'apply_audio_effect', 'list_available_audio_effects'] },
      { goal: 'Fix levels and level automation', tools: ['adjust_audio_levels', 'set_clip_volume', 'add_audio_keyframes', 'fade_in_audio', 'fade_out_audio', 'audio_crossfade_at_cut'] },
      { goal: 'Balance music against speech', tools: ['setup_ducking', 'set_clip_pan'] },
      { goal: 'RE-MEASURE to prove the repair worked, and hit the delivery spec', tools: ['loudness_report', 'normalize_loudness'] },
      { goal: 'Confirm the mixed output, not just the DOM', tools: ['capture_program_output'] },
    ],
    cautions: [
      'Some audio effects are obsolete on current builds and adding them opens a modal dialog that blocks the bridge until a human clicks it. Use list_available_audio_effects to see what this build actually offers.',
      'set_clip_volume clamps silently. Read the level back rather than assuming the value took.',
    ],
    task: (args) => {
      const issues = args.audio_issues || 'the reported problems';
      const source = args.audio_source;
      return `Repair audio problems: ${issues}${source ? ` (source: ${source})` : ''}.`;
    },
  },
];

/** Every tool named by any workflow. Used by the test that keeps this file honest. */
export function referencedToolNames(): string[] {
  const seen: Record<string, true> = {};
  for (const workflow of WORKFLOWS) {
    for (const step of workflow.steps) {
      for (const tool of step.tools) seen[tool] = true;
    }
  }
  return Object.keys(seen).sort();
}

/** The workflow specs, exported for tests. */
export function workflowSpecs(): ReadonlyArray<{ name: string; steps: Array<{ tools: string[] }> }> {
  return WORKFLOWS;
}

export class PremiereProPrompts {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('PremiereProPrompts');
  }

  getAvailablePrompts(): MCPPrompt[] {
    return WORKFLOWS.map((workflow) => ({
      name: workflow.name,
      description: workflow.description,
      arguments: workflow.arguments.map((argument) => ({ ...argument })),
    }));
  }

  async getPrompt(name: string, args: Record<string, any>): Promise<GeneratedPrompt> {
    this.logger.info(`Generating prompt: ${name}`);

    const workflow = WORKFLOWS.find((candidate) => candidate.name === name);
    if (!workflow) {
      throw new Error(`Prompt '${name}' not found`);
    }
    return {
      description: workflow.description,
      messages: [
        { role: 'user', content: { type: 'text', text: renderSystemText(workflow) } },
        { role: 'user', content: { type: 'text', text: renderTaskText(workflow, args) } },
      ],
    };
  }
}

/**
 * The operating contract. Identical in shape for every workflow so an agent learns it
 * once: orient, plan, walk the chain, verify, and report honestly.
 */
function renderSystemText(workflow: WorkflowSpec): string {
  const lines: string[] = [];
  lines.push(workflow.role);
  lines.push('');
  lines.push(
    'Attach the premiere://config/get_instructions resource before editing — it carries this ' +
      "build's verified effect names, the honest list of what Premiere's scripting API cannot do, " +
      'and the bridge setup steps.',
  );
  lines.push('');
  lines.push('Work this tool chain in order. Each step names the tools that actually do the job:');
  lines.push('');
  workflow.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.goal}`);
    lines.push(`   Tools: ${step.tools.join(', ')}`);
  });
  if (workflow.cautions && workflow.cautions.length) {
    lines.push('');
    lines.push('Known limits for this workflow — read these before you start, not after a failure:');
    for (const caution of workflow.cautions) lines.push(`- ${caution}`);
  }
  lines.push('');
  lines.push('Rules that apply to every step:');
  lines.push('- Read before you write. Never mutate a sequence you have not inspected.');
  lines.push(
    '- Every mutating tool returns a `verified` field. If it is false, the edit is NOT confirmed: ' +
      'say so plainly and do not report success. This server would rather refuse than lie.',
  );
  lines.push(
    '- Prefer IDs over names. Sequence IDs and clip nodeIds are stable; names are not unique and ' +
      'effect display names vary by locale.',
  );
  lines.push(
    '- Prefer the batch/composite tool over N single calls — one bridge round trip is far faster ' +
      'and is applied as one unit.',
  );
  lines.push(
    '- Before a bulk or destructive change, take create_recovery_checkpoint (or set ' +
      'PREMIERE_MCP_AUTO_CHECKPOINT=1) so the pre-edit state is recoverable.',
  );
  lines.push(
    "- If you cannot find the right tool, call find_tool with a keyword rather than guessing a name.",
  );
  lines.push(
    '- Finish by reporting what completed, what was skipped, and what failed. Do not summarize an ' +
      'unverified edit as done.',
  );
  return lines.join('\n');
}

function renderTaskText(workflow: WorkflowSpec, args: Record<string, any>): string {
  const task = workflow.task(args || {});
  return `${task}\n\nStart by orienting in the project, then tell me your plan before you mutate anything.`;
}
