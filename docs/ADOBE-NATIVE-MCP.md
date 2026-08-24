# Adobe ships a native MCP server in Premiere Pro 2026

**Status: VERIFIED FIRST-HAND on the build installed on this machine (26.3.2), 2026-08-24.**
Adobe has published nothing about this. Everything below was read out of the application
bundle, not from documentation, and the method is recorded so it can be re-checked on any
future build.

This is the single most consequential fact about Premiere MCP's position, so it is written up
separately rather than buried in the roadmap.

---

## 1. The user-facing feature (highest-confidence evidence)

`Contents/Settings/EveScripts/AgentsPrefsPanel.adam.eve` is a plain-text UI layout defining a
**Preferences ▸ Agents** tab. Quoting its own strings:

> **Model Context Protocol Server**
> "Premiere provides an MCP endpoint for agentic clients to connect and drive automation. Use
> the settings below to configure your MCP client."

Controls in that panel:

| control | detail |
|---|---|
| `agentsEnableMcpCB` | "Enable MCP server" — "Turns MCP connectivity on or off for Premiere Pro." |
| `agentsEndpointValue` | Endpoint URL: **`http://localhost:3000/premiere/mcp`** |
| `agentsPortEdit` | Port, 1–65535, "default: 3000" |
| `agentsEnableAuthCB` | "Require Authentication" — "Require an access token for MCP connections." |
| `agentsPasswordEdit` | Password field (masked), with **Generate** and **Copy** buttons |
| `copyMcpConfigButton` | "Copy MCP Configuration" — "Paste this configuration block into your MCP client configuration." |
| `agentsLearnMoreButton` | "Learn more about the Model Context Protocol." |

There is also an `S_AgenticConnectivity_18_N_D` icon in `Contents/Resources/svg/`.

**It is off by default.** Nothing listens on port 3000 on this machine, and no MCP key exists
in `~/Documents/Adobe/Premiere Pro/26.0/Profile-testuser/Adobe Premiere Pro Prefs` (Adobe only
persists prefs that have been changed).

## 2. The implementation

In the main binary (`Contents/MacOS/Adobe Premiere Pro 2026`, 724 MB) around offset
~413,000,000. Note on method: `strings` and `grep -a` both time out on this file because it has
essentially no newlines — an `mmap` + regex scan in Python returns in seconds. My first two
attempts found nothing and I nearly recorded a false negative on tooling grounds alone.

Confirmed symbols:

- **`dvamcp::MCPServer`** / `IMCPServer`, and the literal string **"Rust MCP server"** — so the
  server is a Rust component, consistent with `rust::Tuple` appearing in its callback signatures.
- Handler interfaces: **`IMCPToolHandler`, `IMCPPromptHandler`, `IMCPResourceHandler`,
  `IMCPHandler`**, `MCPToolBase`, and `HSL::MCP::MCPServerManager` with `TryStartServer`,
  `InitializeListeners`, `SetClientConnectedCallback`, `SetClientDisconnectedCallback`,
  `MessageNameForMCPServerStatusChangedMessage`.
- Registration: `RegisterToolHandler`, `RegisterPromptHandler`, `RegisterResourceHandler`
  (twice — once for `Resource`, once for **`ResourceTemplate`**).
- **The full MCP content model**: `TextContent`, `ImageContent`, `AudioContent`,
  `EmbeddedResource`, `ResourceLink`, `TextResourceContents`, `BlobResourceContents`.
- **Both-direction schema validation**: `"schema root must be of type \"object\" for tool: "`,
  `Input validation`, `Output validation failed`.
- `HSL::MCP::ExperimentalToolHandler` — an experimental tool surface exists too.
- `MCPPreferences::Preferences`.

### Two extensibility hooks that matter more than the tools

- **`HSL::MCP::UXPMCPHandler`**, with `DispatchUXPMessage`, `RequestToolsFromUXPWithRetry`, and
  `ApplyTimeoutWithCleanup`. A third-party **UXP plugin can register its own tools into Adobe's
  server**, with Adobe handling transport, auth, schema validation and timeouts.
- **`HSL::MCP::Scripting::MCPScriptingExtensibilityAPIObject`**, registered through
  `dvascripting`, exposing **`CallMCPTool`** and **`ListMCPTools`**; plus
  `HSL::MCP::Scripting::MCPEventObject` with an `MCPEvent.MCPMethodCalled` event.

## 3. Their tool surface (~30, read from the binary)

Mutating (`MCP.<Name>Tool` classes): `AddTracksToSequence`, `CopyTrackItemAttributes`,
`CreateBins`, `CreateSequences`, `CreateSubClips`, `DeleteProjectItems`, `DeleteTrackItems`,
`DeleteTracks`, `ImportFiles`, `InsertClipsToSequence`, `InterpretFootage`, `ManageMarkers`,
`MoveOrCopyProjectItems`, `MoveOrCopyTrackItems`, `RenameProjectItems`, `SetEffectParameters`,
`SetLabelColors`, `SetTrackItemProperties`.

Reading: `getOpenProjects`, `getProjectItems`, `getClipInfo`, `getSequenceStructure`,
`getTrackItemProperties`, `getAppliedEffects`, `getEffectParams`, `getMarkers`, `getTranscript`,
`createTranscript`, `universalSearch`.

Two that are structurally interesting:

- **`executeMCPScript`** — an escape hatch. Its own description: *"Runs user JavaScript in
  Premiere's scripting engine with `callMCPTool(name, params)` pre-injected."* The wrapper it
  generates is visible in the binary, including `MCP.notifyScriptCompletion` and a documented
  `await` requirement.
- **`getToolTypings`** — *"Returns a TypeScript .d.ts blob covering every registered MCP tool"*,
  so an agent authoring a script gets compile-time param/return checking instead of runtime tool
  errors. Their own guidance says to fetch typings **before** calling a tool.

## 4. What I tested and what came back

- **Can our existing CEP/ExtendScript bridge reach `CallMCPTool`? No — not as shipped.**
  Probed live: `typeof MCP` is `undefined`, `app.mcp` and `app.MCP` are `undefined`, `MCP` /
  `MCPEvent` / `mcp` / `PremiereMCP` are all absent from `$.global`, and `app.reflect.properties`
  is unchanged from the surface recorded in `VERIFIED-API-SURFACE.md`. Consistent with the
  binary's own wording that `callMCPTool` is *"pre-injected"* per execution: that global belongs
  to the engine `executeMCPScript` runs in, not the legacy ExtendScript engine CEP talks to.
- **Untested, and the highest-value open question:** whether *enabling* the server registers the
  scripting object into the ExtendScript context. If it does, our bridge could call Adobe's
  native tools directly — no port, no auth, no new transport.

**I deliberately did not enable it.** Turning it on opens a persistent network listener and
changes the owner's application configuration; that is their decision, not a judgement call to
make unattended. It is also not needed for anything else tonight.

To try it (owner, ~2 minutes): Preferences ▸ Agents ▸ Enable MCP server, tick Require
Authentication, Generate a token, then:

```bash
node scripts/engine-sentinel.mjs --json        # confirm our bridge still healthy
lsof -nP -iTCP:3000                            # confirm Adobe is listening
# then re-run the probe that matters:
#   typeof MCP  /  MCP.ListMCPTools()  from the CEP ExtendScript context
```

## 5. What this means for Premiere MCP — read this part

**The bridge is on a clock we do not control.** A first-party server with Adobe's own transport,
auth, schema validation and UXP registration will beat a third-party CEP file-IPC bridge on
reliability eventually. Betting the project on the transport is betting against the vendor.

**But their surface is narrow, and narrow in a specific way: they shipped the primitives.**
~30 tools covering project/bin/sequence/track/clip CRUD, effect parameters, markers, labels,
transcript and search. Nothing they have touches:

export and encode control · render-truth and frame capture · Lumetri and colour · audio
(loudness, ducking, normalisation) · captions and SRT · proxies · MOGRT · keyframe
interpolation, and specifically `bake_keyframe_ease` · the QE-only capabilities (Morph Cut,
effect-stack reorder, speed) · scene edit detection · Project Manager / consolidate · EDL, AAF,
OMF, FCP XML · multicam · stabilisation · timeline linting · recovery checkpoints · and the
whole verification layer.

So the honest position is:

1. **Do not compete on primitives.** They will win those, and they should.
2. **Compete on everything above the primitives**, which is most of what an editor actually asks
   for and all of what we have spent this campaign building.
3. **Verification is now worth more, not less.** Adobe validates schemas in and out — that is
   argument validation, not proof that the edit landed. Nothing in their symbol table suggests a
   readback/fingerprint/pixel check, and QE remains the only route to several capabilities where
   silent no-ops are the norm.
4. **`RegisterUXPMCPHandler` may be the distribution answer.** Registering our tools *into*
   Adobe's server would inherit their transport, auth and validation, and drop the single most
   fragile thing we own — the file-IPC bridge and its modal/engine-death failure modes. That is
   a strategic option to evaluate seriously, not a threat to route around.
5. **Steal two ideas immediately, both cheap:** `getToolTypings` (self-describing typed surface —
   a strictly better answer to the 637-tool discovery problem than prose descriptions), and
   their instruction to fetch typings *before* calling.

Related: [[project-premiere-mcp-vision]], `docs/FEATURE-COMPARISON.md`,
`docs/VERIFIED-API-SURFACE.md`, `docs/INTERNAL-PLAN.md`.
