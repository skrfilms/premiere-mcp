# API Coverage Matrix

Mechanical diff of every live-reflected symbol in `VERIFIED-API-SURFACE.md` against
every symbol the tool catalogue actually calls. Regenerate with:

```
node scripts/api-coverage-audit.mjs
```

**This document exists because of a specific failure.** We shipped four proxy tools
(`get_proxy_status`, `has_proxy`, `manage_proxies`, `detach_proxy`) — all concerned with
proxy *attachment* — and never exposed `app.getEnableProxies()`/`setEnableProxies()`, the
global toggle that decides whether attached proxies are used at all. A user generated
proxies, playback stayed slow, and the server could not say why. The capability was
present in the API and simply unexposed. Reading documentation would not have caught
that; diffing the surface against the catalogue does.

## Detector notes

A symbol counts as covered if the source contains either `.symbol` (direct property
access) or `"symbol"` (quoted). The second form is required because `expanded.ts`
dispatches dynamically — `tryCall(item, ["detachProxy", "clearProxy"], [])` — so a
symbol can be genuinely covered while never appearing as a property access. An earlier
version of this audit lacked that check and reported 48 false gaps.

Sources scanned: `src/tools/index.ts`, `src/tools/expanded.ts`, `src/bridge/index.ts`.
The bridge is included because some DOM calls live there rather than in a tool body
(`app.openDocument` is reached via `bridge.openProject`).

## Triage buckets

| Bucket | Meaning |
|---|---|
| **COVERED** | At least one tool calls it. |
| **BUILT** | Was a gap; a tool was added in this pass. |
| **EXCLUDED** | Deliberately not exposed. Reason given per row. |
| **PENDING** | Cannot be confirmed without the live host. Not implemented speculatively. |
| **PLUMBING** | JS/CEP internals, not a Premiere capability. |

---
## Totals

- COVERED: **456**
- EXCLUDED (deliberate): **31**
- PENDING (needs live host): **22**
- PLUMBING: **28**
- symbols examined: **537**

---

### app — 34 methods

| Symbol | Status | Note |
|---|---|---|
| `addEventListener` | PLUMBING | Not a Premiere capability. |
| `bind` | PLUMBING | Not a Premiere capability. |
| `broadcastPrefsChanged` | PLUMBING | Not a Premiere capability. |
| `dispatchEvent` | PLUMBING | Not a Premiere capability. |
| `enableQE` | COVERED | |
| `getConstant` | **PENDING** | Returned -1 for every name tried; the constant namespace is unknown. |
| `getCurrentProjectViewSelection` | COVERED | |
| `getEnableProxies` | COVERED | |
| `getProjectFromViewID` | COVERED | |
| `getProjectViewIDs` | COVERED | |
| `getProjectViewSelection` | COVERED | |
| `getWorkspaces` | COVERED | |
| `isDocument` | COVERED | |
| `isDocumentOpen` | COVERED | |
| `isWindowVisible` | COVERED | |
| `newPrProduction` | **EXCLUDED** | Creates a Creative Cloud Production — mutates cloud state. |
| `openDocument` | COVERED | |
| `openFCPXML` | COVERED | |
| `openPrProduction` | **EXCLUDED** | Opens a cloud Production, swapping the whole session. |
| `quit` | **EXCLUDED** | Quits Premiere and kills the bridge with it. |
| `refresh` | COVERED | |
| `removeEventListener` | PLUMBING | Not a Premiere capability. |
| `setEnableProxies` | COVERED | |
| `setEnableTranscodeOnIngest` | COVERED | |
| `setExtensionPersistent` | **EXCLUDED** | CEP panel lifecycle plumbing, not an editing capability. |
| `setProjectViewSelection` | COVERED | |
| `setSDKEventMessage` | PLUMBING | Not a Premiere capability. |
| `setScratchDiskPath` | COVERED | |
| `setTimeout` | PLUMBING | Not a Premiere capability. |
| `setWorkspace` | COVERED | |
| `showCursor` | PLUMBING | Not a Premiere capability. |
| `trace` | PLUMBING | Not a Premiere capability. |
| `unbind` | PLUMBING | Not a Premiere capability. |
| `write` | PLUMBING | Not a Premiere capability. |

### app properties

| Symbol | Status | Note |
|---|---|---|
| `anywhere` | **PENDING** | Never reflected (Adobe Anywhere, likely vestigial). |
| `build` | COVERED | |
| `encoder` | COVERED | |
| `getAppPrefPath` | **PENDING** | Threw when called through CEP evalScript. |
| `getAppSystemPrefPath` | **PENDING** | Threw when called through CEP evalScript. |
| `getLookInfo` | **PENDING** | Never reflected. |
| `getPProPrefPath` | **PENDING** | Threw when called through CEP evalScript. |
| `getPProSystemPrefPath` | **PENDING** | Threw when called through CEP evalScript. |
| `isStagingEnvironment` | PLUMBING | Not a Premiere capability. |
| `learnPanelContentDirPath` | PLUMBING | Not a Premiere capability. |
| `learnPanelExampleProjectDirPath` | PLUMBING | Not a Premiere capability. |
| `path` | COVERED | |
| `production` | **PENDING** | Never reflected. |
| `project` | COVERED | |
| `projectManager` | **PENDING** | ProjectManagerOptions was never reflected, so process() argument shape is unknown. Project Manager (consolidate/transcode/trim) is a real editor feature worth exposing once the options object is inspected. |
| `projects` | COVERED | |
| `properties` | COVERED | |
| `sourceMonitor` | COVERED | |
| `userGuid` | PLUMBING | Not a Premiere capability. |
| `version` | COVERED | |

### app.project — 43 methods

| Symbol | Status | Note |
|---|---|---|
| `addPropertyToProjectMetadataSchema` | COVERED | |
| `applyLumetriPreset` | COVERED | |
| `applyProjectSnapshot` | **PENDING** | Depends on saveProjectSnapshot, which does not work on this build. |
| `closeDocument` | COVERED | |
| `consolidateDuplicates` | COVERED | |
| `createNewSequence` | COVERED | |
| `createNewSequenceFromClips` | COVERED | |
| `deleteSequence` | COVERED | |
| `disableCopyToLocationSetting` | COVERED | |
| `enableAdobeLocationCopy` | COVERED | |
| `enableSharedLocationCopy` | COVERED | |
| `exportAAF` | COVERED | |
| `exportFinalCutProXML` | COVERED | |
| `exportOMF` | COVERED | |
| `exportTimeline` | **PENDING** | Returned error code "7" and produced no file. |
| `getAllLumetriPresetsList` | COVERED | |
| `getGraphicsWhiteLuminance` | COVERED | |
| `getInsertionBin` | COVERED | |
| `getLUTInterpolationMethod` | COVERED | |
| `getLumetriPresetsForFolderList` | COVERED | |
| `getProjectPanelMetadata` | COVERED | |
| `getSharedLocation` | COVERED | |
| `getSupportedGraphicsWhiteLuminances` | COVERED | |
| `getSupportedLUTInterpolationMethods` | COVERED | |
| `importAEComps` | COVERED | |
| `importAllAEComps` | COVERED | |
| `importFiles` | COVERED | |
| `importSequences` | COVERED | |
| `isAdobeLocationCopyEnabled` | COVERED | |
| `isSharedLocationCopyEnabled` | COVERED | |
| `openSequence` | COVERED | |
| `pauseGrowing` | COVERED | |
| `placeAsset` | **PENDING** | Threw "Not Enough Parameters"; argument shape unknown. |
| `save` | COVERED | |
| `saveAs` | COVERED | |
| `saveProjectSnapshot` | **PENDING** | Returned false on 26.3.2; unreliable. |
| `setEnableTranscodeOnIngest` | COVERED | |
| `setGraphicsWhiteLuminance` | COVERED | |
| `setLUTInterpolationMethod` | COVERED | |
| `setLogColorManagement` | COVERED | |
| `setProjectPanelMetadata` | COVERED | |
| `setScratchDiskPath` | COVERED | |
| `writeSidecarFile` | COVERED | |

### Sequence (DOM) — render/export-relevant subset

| Symbol | Status | Note |
|---|---|---|
| `attachCustomProperty` | COVERED | |
| `autoReframeSequence` | COVERED | |
| `clone` | COVERED | |
| `createCaptionTrack` | COVERED | |
| `createSubsequence` | COVERED | |
| `exportAsFinalCutProXML` | COVERED | |
| `exportAsMediaDirect` | COVERED | |
| `exportAsProject` | COVERED | |
| `getExportFileExtension` | COVERED | |
| `getInPoint` | COVERED | |
| `getOutPoint` | COVERED | |
| `getPlayerPosition` | COVERED | |
| `getSelection` | COVERED | |
| `getWorkAreaInPoint` | COVERED | |
| `getWorkAreaOutPoint` | COVERED | |
| `isWorkAreaEnabled` | COVERED | |
| `linkSelection` | COVERED | |
| `performSceneEditDetectionOnSelection` | COVERED | |
| `renderVideoFrameAtTime` | **PENDING** | Returns null and writes no file regardless of argument form tried. |
| `renderVideoFrameAtTimeWithColorSpace` | **PENDING** | Same failure as renderVideoFrameAtTime. |
| `setInPoint` | COVERED | |
| `setOutPoint` | COVERED | |
| `setPlayerPosition` | COVERED | |
| `setSelection` | COVERED | |
| `setZeroPoint` | COVERED | |
| `unlinkSelection` | COVERED | |

### Sequence properties

| Symbol | Status | Note |
|---|---|---|
| `audioDisplayFormat` | COVERED | |
| `audioTracks` | COVERED | |
| `end` | COVERED | |
| `frameSizeHorizontal` | COVERED | |
| `frameSizeVertical` | COVERED | |
| `id` | COVERED | |
| `markers` | COVERED | |
| `name` | COVERED | |
| `projectItem` | COVERED | |
| `sequenceID` | COVERED | |
| `timebase` | COVERED | |
| `videoDisplayFormat` | COVERED | |
| `videoTracks` | COVERED | |
| `zeroPoint` | COVERED | |

### TrackItem — only 10 methods

| Symbol | Status | Note |
|---|---|---|
| `getLinkedItems` | COVERED | |
| `getMGTComponent` | COVERED | |
| `getSpeed` | COVERED | |
| `isAdjustmentLayer` | COVERED | |
| `isMGT` | COVERED | |
| `isSelected` | COVERED | |
| `isSpeedReversed` | COVERED | |
| `move` | COVERED | |
| `remove` | COVERED | |
| `setSelected` | COVERED | |

### TrackItem properties

| Symbol | Status | Note |
|---|---|---|
| `components` | COVERED | |
| `disabled` | COVERED | |
| `duration` | COVERED | |
| `end` | COVERED | |
| `inPoint` | COVERED | |
| `matchName` | COVERED | |
| `mediaType` | COVERED | |
| `name` | COVERED | |
| `nodeId` | COVERED | |
| `outPoint` | COVERED | |
| `parentTrackIndex` | COVERED | |
| `projectItem` | COVERED | |
| `start` | COVERED | |
| `type` | COVERED | |

### ProjectItem — 53 methods

| Symbol | Status | Note |
|---|---|---|
| `attachProxy` | COVERED | |
| `canChangeMediaPath` | COVERED | |
| `canProxy` | COVERED | |
| `changeMediaPath` | COVERED | |
| `clearInPoint` | COVERED | |
| `clearOutPoint` | COVERED | |
| `createBin` | COVERED | |
| `createSmartBin` | COVERED | |
| `createSubClip` | COVERED | |
| `deleteBin` | COVERED | |
| `detachProxy` | COVERED | |
| `findItemsMatchingMediaPath` | COVERED | |
| `getColorLabel` | COVERED | |
| `getColorSpace` | COVERED | |
| `getEmbeddedLUTID` | COVERED | |
| `getInPoint` | COVERED | |
| `getInputLUTID` | COVERED | |
| `getMarkers` | COVERED | |
| `getMediaPath` | COVERED | |
| `getOriginalColorSpace` | COVERED | |
| `getOutPoint` | COVERED | |
| `getOverrideColorSpace` | COVERED | |
| `getProjectColumnsMetadata` | COVERED | |
| `getProjectMetadata` | COVERED | |
| `getProxyPath` | COVERED | |
| `getXMPMetadata` | COVERED | |
| `hasProxy` | COVERED | |
| `isAdjustmentLayer` | COVERED | |
| `isColorManagedMedia` | COVERED | |
| `isMergedClip` | COVERED | |
| `isMulticamClip` | COVERED | |
| `isOffline` | COVERED | |
| `isReference` | COVERED | |
| `isSequence` | COVERED | |
| `isValidOverrideColorSpace` | COVERED | |
| `moveBin` | COVERED | |
| `refreshMedia` | COVERED | |
| `renameBin` | **PENDING** | Capability covered by assigning ProjectItem.name (rename_bin does this). The method itself is an unverified alternative. |
| `saveProjectSnapshot` | **PENDING** | Returned false on 26.3.2; unreliable. |
| `select` | COVERED | |
| `setColorLabel` | COVERED | |
| `setInPoint` | COVERED | |
| `setOffline` | COVERED | |
| `setOutPoint` | COVERED | |
| `setOverrideColorSpace` | COVERED | |
| `setOverrideFrameRate` | COVERED | |
| `setOverridePixelAspectRatio` | COVERED | |
| `setProjectMetadata` | COVERED | |
| `setScaleToFrameSize` | COVERED | |
| `setStartTime` | COVERED | |
| `setXMPMetadata` | COVERED | |
| `startTime` | COVERED | |
| `videoComponents` | COVERED | |

### ProjectItem properties

| Symbol | Status | Note |
|---|---|---|
| `children` | COVERED | |
| `getOverrideColorSpaceList` | COVERED | |
| `interpretedTimebase` | COVERED | |
| `name` | COVERED | |
| `nodeId` | COVERED | |
| `sourceTimebase` | COVERED | |
| `timeDisplayFormat` | COVERED | |
| `treePath` | COVERED | |
| `type` | COVERED | |

### Track (DOM)

| Symbol | Status | Note |
|---|---|---|
| `insertClip` | COVERED | |
| `isLocked` | COVERED | |
| `isMuted` | COVERED | |
| `isTargeted` | COVERED | |
| `overwriteClip` | COVERED | |
| `setLocked` | COVERED | |
| `setMute` | COVERED | |
| `setTargeted` | COVERED | |

### MarkerCollection

| Symbol | Status | Note |
|---|---|---|
| `createMarker` | COVERED | |
| `deleteMarker` | COVERED | |
| `getFirstMarker` | COVERED | |
| `getLastMarker` | COVERED | |
| `getNextMarker` | COVERED | |
| `getPrevMarker` | COVERED | |

### ComponentParam

| Symbol | Status | Note |
|---|---|---|
| `addKey` | COVERED | |
| `areKeyframesSupported` | COVERED | |
| `findNearestKey` | COVERED | |
| `findNextKey` | COVERED | |
| `findPreviousKey` | COVERED | |
| `getColorValue` | COVERED | |
| `getKeys` | COVERED | |
| `getValue` | COVERED | |
| `getValueAtKey` | COVERED | |
| `getValueAtTime` | COVERED | |
| `isEmpty` | COVERED | |
| `isTimeVarying` | COVERED | |
| `keyExistsAtTime` | COVERED | |
| `removeKey` | COVERED | |
| `removeKeyRange` | COVERED | |
| `setColorValue` | COVERED | |
| `setInterpolationTypeAtKey` | COVERED | |
| `setTimeVarying` | COVERED | |
| `setValue` | COVERED | |
| `setValueAtKey` | COVERED | |

### VideoComponent properties

| Symbol | Status | Note |
|---|---|---|
| `displayName` | COVERED | |
| `instanceName` | COVERED | |
| `matchName` | COVERED | |
| `properties` | COVERED | |

### app.encoder

| Symbol | Status | Note |
|---|---|---|
| `addEventListener` | PLUMBING | Not a Premiere capability. |
| `dispatchEvent` | PLUMBING | Not a Premiere capability. |
| `encodeFile` | COVERED | |
| `encodeProjectItem` | COVERED | |
| `encodeSequence` | COVERED | |
| `exportWithPresetObject` | COVERED | |
| `getExporters` | COVERED | |
| `getPresetObject` | **PENDING** | Returned an EncoderPreset when handed a directory, but the expected argument is undocumented. |
| `lastExportMediaFolder` | COVERED | |
| `launchEncoder` | COVERED | |
| `removeEventListener` | PLUMBING | Not a Premiere capability. |
| `selectFolder` | **EXCLUDED** | Opens a native folder-picker dialog, which blocks the bridge. |
| `setEmbeddedXMPEnabled` | COVERED | |
| `setSidecarXMPEnabled` | COVERED | |
| `startBatch` | COVERED | |

### app.sourceMonitor

| Symbol | Status | Note |
|---|---|---|
| `closeAllClips` | COVERED | |
| `closeClip` | COVERED | |
| `getPosition` | COVERED | |
| `getProjectItem` | COVERED | |
| `openFilePath` | COVERED | |
| `openProjectItem` | COVERED | |
| `play` | COVERED | |

### qe.project — 42 methods

| Symbol | Status | Note |
|---|---|---|
| `close` | COVERED | |
| `deletePreviewFiles` | COVERED | |
| `findItemByID` | COVERED | |
| `flushCache` | COVERED | |
| `getActiveSequence` | COVERED | |
| `getAudioEffectByName` | COVERED | |
| `getAudioEffectList` | COVERED | |
| `getAudioTransitionByName` | COVERED | |
| `getAudioTransitionList` | COVERED | |
| `getBinAt` | COVERED | |
| `getItemAt` | COVERED | |
| `getRemainingMetadataCacheIndexCount` | COVERED | |
| `getRendererNames` | COVERED | |
| `getSequenceAt` | COVERED | |
| `getSequenceItemAt` | COVERED | |
| `getVideoEffectByName` | COVERED | |
| `getVideoEffectList` | COVERED | |
| `getVideoTransitionByName` | COVERED | |
| `getVideoTransitionList` | COVERED | |
| `import` | COVERED | |
| `importAEComps` | COVERED | |
| `importAllAEComps` | COVERED | |
| `importFiles` | COVERED | |
| `importPSD` | **EXCLUDED** | PSD import raises a layer-options modal. |
| `importProject` | COVERED | |
| `init` | PLUMBING | Not a Premiere capability. |
| `newBarsAndTone` | **EXCLUDED** | Opens a BLOCKING modal. |
| `newBin` | COVERED | |
| `newBlackVideo` | **EXCLUDED** | Opens a BLOCKING modal (same family as newColorMatte). |
| `newColorMatte` | **EXCLUDED** | Opens a BLOCKING colour picker + name prompt. Confirmed live; wedged the bridge. |
| `newSequence` | COVERED | |
| `newSmartBin` | COVERED | |
| `newTransparentVideo` | **EXCLUDED** | Opens a BLOCKING modal. |
| `newUniversalCountingLeader` | **EXCLUDED** | Opens a BLOCKING modal. |
| `redo` | COVERED | |
| `resetNumFilesCounter` | **PENDING** | Purpose unclear; no observable effect to verify against. |
| `save` | COVERED | |
| `saveAs` | COVERED | |
| `setRenderer` | COVERED | |
| `sizeOnDisk` | COVERED | |
| `undo` | COVERED | |
| `undoStackIndex` | COVERED | |

### qe sequence — 50+ methods

| Symbol | Status | Note |
|---|---|---|
| `addTracks` | COVERED | |
| `close` | COVERED | |
| `deletePreviewFiles` | COVERED | |
| `exportDirect` | COVERED | |
| `exportFrameDPX` | COVERED | |
| `exportFrameJPEG` | COVERED | |
| `exportFramePNG` | COVERED | |
| `exportFrameTIFF` | COVERED | |
| `exportFrameTarga` | COVERED | |
| `exportToAME` | COVERED | |
| `extract` | COVERED | |
| `flushCache` | COVERED | |
| `getAudioTrackAt` | COVERED | |
| `getEmptyBarTimes` | COVERED | |
| `getExportComplete` | COVERED | |
| `getExportFileExtension` | COVERED | |
| `getGreenBarTimes` | COVERED | |
| `getRedBarTimes` | COVERED | |
| `getVideoTrackAt` | COVERED | |
| `getYellowBarTimes` | COVERED | |
| `isIncompleteBackgroundVideoEffects` | COVERED | |
| `isOpen` | COVERED | |
| `left` | COVERED | |
| `lockTracks` | COVERED | |
| `makeCurrent` | COVERED | |
| `muteTracks` | COVERED | |
| `razor` | COVERED | |
| `removeAudioTrack` | COVERED | |
| `removeEmptyAudioTracks` | COVERED | |
| `removeEmptyVideoTracks` | COVERED | |
| `removeTracks` | **EXCLUDED** | Destructive bulk track removal; remove_track/delete_empty_tracks cover the safe cases. |
| `removeVideoTrack` | COVERED | |
| `renderAll` | COVERED | |
| `renderAudio` | COVERED | |
| `renderPreview` | COVERED | |
| `setAudioDisplayFormat` | **PENDING** | Enum values unverified; passing a wrong one may silently no-op. |
| `setAudioFrameRate` | **PENDING** | Accepted rates unverified. |
| `setCTI` | COVERED | |
| `setInOutPoints` | COVERED | |
| `setInPoint` | COVERED | |
| `setOutPoint` | COVERED | |
| `setPreviewFrameSize` | COVERED | |
| `setPreviewPresetPath` | COVERED | |
| `setUseMaxBitDepth` | COVERED | |
| `setUseMaxRenderQuality` | COVERED | |
| `setVideoDisplayFormat` | COVERED | |
| `setVideoFrameSize` | COVERED | |
| `setWorkInOutPoints` | COVERED | |
| `setWorkInPoint` | COVERED | |
| `setWorkOutPoint` | COVERED | |
| `syncLockTracks` | COVERED | |

### properties

| Symbol | Status | Note |
|---|---|---|
| `CTI` | COVERED | |
| `alignment` | COVERED | |
| `antiAliasQuality` | COVERED | |
| `audioDisplayFormat` | COVERED | |
| `audioFrameRate` | COVERED | |
| `borderColor` | COVERED | |
| `borderWidth` | COVERED | |
| `duration` | COVERED | |
| `editingMode` | COVERED | |
| `end` | COVERED | |
| `endPercent` | COVERED | |
| `fieldType` | COVERED | |
| `frameBlend` | COVERED | |
| `guid` | COVERED | |
| `inPoint` | COVERED | |
| `mediaType` | COVERED | |
| `multicam` | COVERED | |
| `multicamEnabled` | COVERED | |
| `name` | COVERED | |
| `numAudioTracks` | COVERED | |
| `numComponents` | COVERED | |
| `numVideoTracks` | COVERED | |
| `outPoint` | COVERED | |
| `par` | COVERED | |
| `player` | COVERED | |
| `presetList` | COVERED | |
| `previewPresetCodec` | COVERED | |
| `previewPresetPath` | COVERED | |
| `reverse` | COVERED | |
| `reversed` | COVERED | |
| `scaleToFrameSize` | COVERED | |
| `speed` | COVERED | |
| `start` | COVERED | |
| `startPercent` | COVERED | |
| `staticClipGain` | COVERED | |
| `switchSources` | COVERED | |
| `timeInterpolationType` | COVERED | |
| `type` | COVERED | |
| `useMaxBitDepth` | COVERED | |
| `useMaxRenderQuality` | COVERED | |
| `videoDisplayFormat` | COVERED | |
| `videoFrameRate` | COVERED | |
| `workInPoint` | COVERED | |
| `workOutPoint` | COVERED | |

### qe clip — 30 methods

| Symbol | Status | Note |
|---|---|---|
| `addAudioEffect` | COVERED | |
| `addTransition` | COVERED | |
| `addVideoEffect` | COVERED | |
| `canDoMulticam` | COVERED | |
| `getClipPanComponent` | COVERED | |
| `getComponentAt` | COVERED | |
| `getProjectItem` | COVERED | |
| `move` | COVERED | |
| `moveToTrack` | COVERED | |
| `remove` | COVERED | |
| `removeEffects` | COVERED | |
| `rippleDelete` | COVERED | |
| `roll` | COVERED | |
| `setAntiAliasQuality` | COVERED | |
| `setBorderColor` | COVERED | |
| `setBorderWidth` | COVERED | |
| `setEndPercent` | COVERED | |
| `setEndPosition` | COVERED | |
| `setFrameBlend` | COVERED | |
| `setMulticam` | COVERED | |
| `setName` | COVERED | |
| `setReverse` | COVERED | |
| `setScaleToFrameSize` | COVERED | |
| `setSpeed` | COVERED | |
| `setStartPercent` | COVERED | |
| `setStartPosition` | COVERED | |
| `setSwitchSources` | COVERED | |
| `setTimeInterpolationType` | COVERED | |
| `slide` | COVERED | |
| `slip` | COVERED | |

### QEComponent (via qeClip.getComponentAt(i))

| Symbol | Status | Note |
|---|---|---|
| `getParamControlValue` | COVERED | |
| `getParamKeyframes` | COVERED | |
| `getParamList` | COVERED | |
| `getParamValue` | COVERED | |
| `remove` | COVERED | |
| `setParamValue` | COVERED | |

### qe track

| Symbol | Status | Note |
|---|---|---|
| `addAudioEffect` | COVERED | |
| `getComponentAt` | COVERED | |
| `getItemAt` | COVERED | |
| `getTransitionAt` | COVERED | |
| `insert` | COVERED | |
| `isLocked` | COVERED | |
| `isMuted` | COVERED | |
| `isSyncLocked` | COVERED | |
| `overwrite` | COVERED | |
| `razor` | COVERED | |
| `setLock` | COVERED | |
| `setMute` | COVERED | |
| `setName` | COVERED | |
| `setSyncLock` | COVERED | |

### QEProjectItem (via qeClip.getProjectItem())

| Symbol | Status | Note |
|---|---|---|
| `automateToSequence` | **PENDING** | Five numeric arguments of unknown meaning; needs live probing. |
| `containsSpeechTrack` | COVERED | |
| `createProxy` | COVERED | |
| `getMetadataSize` | COVERED | |
| `isAudioConforming` | COVERED | |
| `isAudioPeakGenerating` | COVERED | |
| `isIndexing` | COVERED | |
| `isOffline` | COVERED | |
| `isPending` | COVERED | |
| `linkMedia` | COVERED | |
| `openInSource` | COVERED | |
| `rename` | COVERED | |
| `setOffline` | COVERED | |

### qe.ea — QEEA (Productions / Team Projects)

| Symbol | Status | Note |
|---|---|---|
| `addEventListener` | PLUMBING | Not a Premiere capability. |
| `benchmarkReflectEverything` | PLUMBING | Not a Premiere capability. |
| `canShare` | COVERED | |
| `closeProduction` | **EXCLUDED** | Closes a cloud Production for the session. |
| `convertProductionIntoProject` | **EXCLUDED** | Irreversibly converts shared cloud state. |
| `convertProjectIntoProduction` | COVERED | |
| `createProduction` | **EXCLUDED** | Creates a cloud Production. |
| `dispatchEvent` | PLUMBING | Not a Premiere capability. |
| `doesEditingSessionHaveLocalMedia` | COVERED | |
| `doesProjectHaveUnsharedChanges` | COVERED | |
| `fetchIMSAccessToken` | **EXCLUDED** | Returns a credential. |
| `getAdminInterface` | **EXCLUDED** | Returns an admin surface for a team Production; out of scope. |
| `getArchivedProductionList` | COVERED | |
| `getConflicts` | COVERED | |
| `getCreativeCloudIdentity` | COVERED | |
| `getDiscoveryURL` | **EXCLUDED** | Cloud endpoint introspection; paired with the excluded setter. |
| `getInviteList` | COVERED | |
| `getProcessID` | PLUMBING | Not a Premiere capability. |
| `getProductionByID` | **EXCLUDED** | Requires a Production ID and reaches the cloud; get_production_info covers read-only status. |
| `getProductionList` | COVERED | |
| `getRemoteServerBuildVersion` | COVERED | |
| `getSessionSyncStatus` | COVERED | |
| `getUserEmail` | COVERED | |
| `getUsername` | COVERED | |
| `isCollaborationOnly` | COVERED | |
| `isConvertProductionIntoProjectRunning` | COVERED | |
| `isConvertProjectIntoProductionRunning` | COVERED | |
| `isHostedCollaborationOnly` | COVERED | |
| `isLoggedIn` | COVERED | |
| `isShareCommandEnabled` | COVERED | |
| `isSyncCommandEnabled` | COVERED | |
| `openCleanSandbox` | **EXCLUDED** | Replaces the editing session. |
| `openProduction` | **EXCLUDED** | Opens a cloud Production, swapping the session. |
| `removeEventListener` | PLUMBING | Not a Premiere capability. |
| `renameProduction` | **EXCLUDED** | Renames shared cloud state visible to the whole team. |
| `resolveConflict` | COVERED | |
| `saveProductionAs` | **EXCLUDED** | Writes new shared cloud state. |
| `setAuthToken` | **EXCLUDED** | Sets a credential. |
| `setLocalHubConnectionStatus` | **EXCLUDED** | Mutates collaboration transport state. |
| `setMediaCachePath` | **EXCLUDED** | Repoints the media cache for a collaboration session. |
| `share` | COVERED | |
| `sync` | COVERED | |
| `waitForCurrentReflectionToComplete` | PLUMBING | Not a Premiere capability. |

### qe.tqm — QECloudDispatcher

| Symbol | Status | Note |
|---|---|---|
| `addEventListener` | PLUMBING | Not a Premiere capability. |
| `createQueue` | **EXCLUDED** | Creates a cloud render queue — mutates external service state. |
| `dispatchEvent` | PLUMBING | Not a Premiere capability. |
| `getActiveRegion` | COVERED | |
| `getAuthToken` | **EXCLUDED** | Returns a credential; deliberately not surfaced through a tool. |
| `getQueueListObject` | COVERED | |
| `getSupportedRegionList` | COVERED | |
| `logIntoTaskQueueManager` | **EXCLUDED** | Performs a cloud login. |
| `loginByRegion` | **EXCLUDED** | Performs a cloud login. |
| `removeEventListener` | PLUMBING | Not a Premiere capability. |
| `setDiscoveryURL` | **EXCLUDED** | Repoints a cloud service endpoint. |
