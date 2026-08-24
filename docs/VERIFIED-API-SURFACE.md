# Verified Premiere Scripting API Surface (26.3.2)

Everything here was obtained by **live reflection** against Premiere Pro 26.3.2 in this
project (`obj.reflect.methods` / `obj.reflect.properties`), not from documentation. It is
the ground truth for auditing tool coverage: any symbol listed here that no tool calls is
a coverage gap.

Reflection caveat: ExtendScript native ScriptObjects do **not** enumerate via `for..in`.
Use `obj.reflect.methods` and `obj.reflect.properties`. Also beware shadowing — declaring
`var qe = ...` hoists and shadows the global `qe`, which silently reports it as absent.

---

## `app` — 34 methods

```
broadcastPrefsChanged, getConstant, getCurrentProjectViewSelection, getEnableProxies,
getProjectFromViewID, getProjectViewIDs, getProjectViewSelection, getWorkspaces,
isDocument, isDocumentOpen, isWindowVisible, newPrProduction, openDocument, openFCPXML,
openPrProduction, quit, refresh, setEnableProxies, setEnableTranscodeOnIngest,
setExtensionPersistent, setProjectViewSelection, setSDKEventMessage, setScratchDiskPath,
setWorkspace, showCursor, trace, write, addEventListener, removeEventListener,
dispatchEvent, bind, unbind, setTimeout, enableQE
```

### `app` properties

```
anywhere, build, encoder, getAppPrefPath, getAppSystemPrefPath, getPProPrefPath,
getPProSystemPrefPath, isStagingEnvironment, learnPanelContentDirPath,
learnPanelExampleProjectDirPath, path, production, project, projectManager, projects,
properties, sourceMonitor, userGuid, version, getLookInfo
```

Confirmed signatures / behaviour:
- `openDocument(path:string, bool, bool, bool, bool)`
- `openFCPXML(path:string, sequenceName:string)`
- `isWindowVisible(windowClass:string)` — live: Timeline=true, Source Monitor=true,
  Program Monitor=true, Effects=false, Project=false
- `getConstant(name:string)` — returned `-1` for every name tried; constant names unknown
- `newPrProduction(path)` / `openPrProduction(path)`
- `getProjectViewIDs()` → Array of GUID strings; `getProjectFromViewID(id)` → Project
- `getEnableProxies()` / `setEnableProxies(bool)` — **the global Toggle Proxies state**
- `refresh()`, `setSDKEventMessage(type, message)`
- `getAppPrefPath()` / `getPProPrefPath()` — threw via CEP evalScript when called

## `app.project` — 43 methods

```
addPropertyToProjectMetadataSchema, applyLumetriPreset, applyProjectSnapshot,
closeDocument, consolidateDuplicates, createNewSequence, createNewSequenceFromClips,
deleteSequence, disableCopyToLocationSetting, enableAdobeLocationCopy,
enableSharedLocationCopy, exportAAF, exportFinalCutProXML, exportOMF, exportTimeline,
getAllLumetriPresetsList, getGraphicsWhiteLuminance, getInsertionBin,
getLUTInterpolationMethod, getLumetriPresetsForFolderList, getProjectPanelMetadata,
getSharedLocation, getSupportedGraphicsWhiteLuminances,
getSupportedLUTInterpolationMethods, importAEComps, importAllAEComps, importFiles,
importSequences, isAdobeLocationCopyEnabled, isSharedLocationCopyEnabled, openSequence,
pauseGrowing, placeAsset, save, saveAs, saveProjectSnapshot, setEnableTranscodeOnIngest,
setGraphicsWhiteLuminance, setLUTInterpolationMethod, setLogColorManagement,
setProjectPanelMetadata, setScratchDiskPath, writeSidecarFile
```

Confirmed:
- `closeDocument(saveFirst:bool, closeIfLast:bool)`
- `writeSidecarFile(fileName:string, fileExtension:string, contents:string)`
- `exportTimeline(string)` — returned `"7"` (error code), no file produced. **Uncracked.**
- `exportFinalCutProXML(path:string, bool)` — verified, wrote valid XMEML
- `getAllLumetriPresetsList()` → **325** preset names, CSV string
- `getLumetriPresetsForFolderList(folder:string)`
- `setLUTInterpolationMethod(0|1)` — 0=linear, 1=tetrahedral; verified changeable
- `getSupportedLUTInterpolationMethods()` → "0,1"
- `saveProjectSnapshot(path)` — returned false on 26.3.2; **unreliable**
- `applyProjectSnapshot(string, bool, bool)`
- `pauseGrowing(bool)`, `setLogColorManagement(bool)`
- `addPropertyToProjectMetadataSchema(id, name, type:int)` — verified (0=string)
- `placeAsset()` — threw "Not Enough Parameters"; arg shape unknown

## `Sequence` (DOM) — render/export-relevant subset

```
exportAsFinalCutProXML, exportAsMediaDirect, exportAsProject, getExportFileExtension,
renderVideoFrameAtTime, renderVideoFrameAtTimeWithColorSpace, createSubsequence,
autoReframeSequence, getSelection, setSelection, linkSelection, unlinkSelection,
performSceneEditDetectionOnSelection, createCaptionTrack, getInPoint, getOutPoint,
setInPoint, setOutPoint, getPlayerPosition, setPlayerPosition, getWorkAreaInPoint,
getWorkAreaOutPoint, isWorkAreaEnabled, setZeroPoint, attachCustomProperty, clone
```

### `Sequence` properties
```
audioDisplayFormat, audioTracks, end, frameSizeHorizontal, frameSizeVertical, id,
markers, name, projectItem, sequenceID, timebase, videoDisplayFormat, videoTracks,
zeroPoint
```

Confirmed:
- `exportAsMediaDirect(outputPath:string, presetPath:string, workAreaType:number)`
- `exportAsProject(path:string)` — verified, file written
- `createSubsequence(bool)` — verified, created `<name>_Sub_01`
- `autoReframeSequence(w:number, h:number, preset:string, name:string, bool)` — verified;
  presets 'slower' | 'default' | 'faster'; returns a Sequence
- `getSelection()` → Array of TrackItem; `setSelection(Array)` — verified
- `performSceneEditDetectionOnSelection(clipOperation:string)`
- `createCaptionTrack()` — threw "Not Enough Parameters". **Arg shape uncracked.**
- `renderVideoFrameAtTime(?, Time, ?)` — returns null, never wrote a file. **Uncracked.**
- **NO playback-resolution method** (Program Monitor Full/½/¼ appears to be UI-only)

## `TrackItem` — only 10 methods

```
getLinkedItems, getMGTComponent, getSpeed, isAdjustmentLayer, isMGT, isSelected,
isSpeedReversed, move, remove, setSelected
```

### `TrackItem` properties
```
components, disabled, duration, end, inPoint, matchName, mediaType, name, nodeId,
outPoint, parentTrackIndex, projectItem, start, type
```

**Critical:** there is **no `setInPoint`/`setOutPoint` on TrackItem** — those belong to
ProjectItem. `inPoint`/`outPoint`/`start`/`end` are properties; assign to them. Six tools
originally called the nonexistent method and failed with opaque evalScript errors.

- `getSpeed()` is the only speed getter; there is no DOM speed setter (use QE `setSpeed`).
- `isMGT()` / `getMGTComponent()` — Motion Graphics Template detection.

## `ProjectItem` — 53 methods

```
attachProxy, canChangeMediaPath, canProxy, changeMediaPath, clearInPoint, clearOutPoint,
createBin, createSmartBin, createSubClip, deleteBin, detachProxy,
findItemsMatchingMediaPath, getColorLabel, getColorSpace, getEmbeddedLUTID, getInPoint,
getInputLUTID, getMarkers, getMediaPath, getOriginalColorSpace, getOutPoint,
getOverrideColorSpace, getProjectColumnsMetadata, getProjectMetadata, getProxyPath,
getXMPMetadata, hasProxy, isAdjustmentLayer, isColorManagedMedia, isMergedClip,
isMulticamClip, isOffline, isReference, isSequence, isValidOverrideColorSpace, moveBin,
refreshMedia, renameBin, saveProjectSnapshot, select, setColorLabel, setInPoint,
setOffline, setOutPoint, setOverrideColorSpace, setOverrideFrameRate,
setOverridePixelAspectRatio, setProjectMetadata, setScaleToFrameSize, setStartTime,
setXMPMetadata, startTime, videoComponents
```

### `ProjectItem` properties
```
children, getOverrideColorSpaceList, interpretedTimebase, name, nodeId, sourceTimebase,
timeDisplayFormat, treePath, type
```

Confirmed:
- `setProjectMetadata(key:string, value:any)` — verified; **this is how Essential Sound
  category is written** (`ESP.Tag`, `ESP.AdjustmentsModeID`, `ESP.ClipMixTypeID`,
  `MZ.AudioCategorization.AudioCategorizationAdjustmentMode` — all accepted)
- `getProjectColumnsMetadata()` → JSON array of all project-panel columns (24 on test item)
- `treePath` → full bin path, e.g. `\project.prproj\Clip.mp4`
- `isMergedClip()` / `isMulticamClip()` — detection only, no creation counterpart

## `Track` (DOM)

```
insertClip, overwriteClip, isLocked, isMuted, isTargeted, setLocked, setMute, setTargeted
```
**Note:** `overwriteClip` can raise Premiere's *Clip Mismatch Warning* modal when the
inserted media does not match sequence settings. A modal blocks the CEP bridge.

## `MarkerCollection`

```
createMarker, deleteMarker, getFirstMarker, getLastMarker, getNextMarker, getPrevMarker
```
`createMarker(seconds:float)` → Marker with `name`, `comments`, `type`, `start`, `end`,
`colorByIndex` — all read AND write. Verified types: Comment, Chapter, Segmentation,
WebLink, FLVCuePoint, Named.

## `ComponentParam`

```
addKey, areKeyframesSupported, findNearestKey, findNextKey, findPreviousKey,
getColorValue, getKeys, getValue, getValueAtKey, getValueAtTime, isEmpty, isTimeVarying,
keyExistsAtTime, removeKey, removeKeyRange, setColorValue, setInterpolationTypeAtKey,
setTimeVarying, setValue, setValueAtKey
```
Interpolation accepts only 0=Linear, 4=Hold, 5=Bezier.

## `VideoComponent` properties
```
displayName, instanceName, matchName, properties
```
matchNames confirmed: Opacity=`AE.ADBE Opacity`, Motion=`AE.ADBE Motion`,
Lumetri=`AE.ADBE Lumetri`, Gaussian Blur=`AE.Impact_Blur_FX`.

## `app.encoder`

```
encodeFile, encodeProjectItem, encodeSequence, exportWithPresetObject, getExporters,
getPresetObject, lastExportMediaFolder, launchEncoder, selectFolder,
setEmbeddedXMPEnabled, setSidecarXMPEnabled, startBatch,
addEventListener, removeEventListener, dispatchEvent
```
- `getExporters()` → 24 `Exporter` objects, each with `name`, `classID`, `fileExtension`,
  `fileType`, `getPresets()`
- Formats: AAC Audio, AIFF, Animated GIF, Apple ProRes MXF OP1a, AS-10, DNxHR/DNxHD MXF
  OP1a (152 presets), DPX, H.264 (43), H.264 Blu-ray, HEVC (H.265), JPEG, JPEG 2000 MXF
  OP1a, MP3, MPEG2, MPEG2 Blu-ray, MPEG2-DVD, MPEG4, MXF OP1a (117), OpenEXR, PNG,
  QuickTime (35), Targa, TIFF, Waveform Audio
- `EncoderPreset` → `setExportParamValue(paramString, value)`, `writeToFile(path)`;
  props `id`, `matchName`, `name`
- Confirmed writable params: TargetBitrate, MaxBitrate, MinBitrate, VideoBitrate,
  AudioBitrate, FrameRate, Width, Height, TVStandard, FieldOrder, AspectRatio,
  KeyframeDistance, CodecPreset, PerformanceLevel, Profile, Level, AudioCodec,
  AudioSampleRate, VBREncoding
- `exportWithPresetObject(outputFilePath, EncoderPreset, Sequence, ?)` — returned true
- Fires `onEncoderJobComplete`, `onEncoderJobProgress`, `onEncoderJobError`

## `app.sourceMonitor`

```
closeAllClips, closeClip, getPosition, getProjectItem, openFilePath, openProjectItem, play
```
`openProjectItem(ProjectItem)` — verified; pass the DOM item, no path needed.
`play(number)`. `getPosition()` → Time.

## `app.projects` / `app.projectManager` / `app.properties`

- `app.projects` → `ProjectCollection`, `numProjects`, indexable → Project
- `app.projectManager` → `ProjectManager` with `process()`, props `errors`, `options`
  (`ProjectManagerOptions`)
- `app.properties` → `clearProperty, doesPropertyExist, getProperty, isPropertyReadOnly,
  setProperty`

---

# QE DOM (`app.enableQE()`)

`qe` properties: `audioChannelMapping, codeProfiler, config, ea, language, location,
name, platform, project, source, tqm, version`

## `qe.project` — 42 methods
```
close, deletePreviewFiles, findItemByID, flushCache, getActiveSequence,
getAudioEffectByName, getAudioEffectList, getAudioTransitionByName,
getAudioTransitionList, getBinAt, getItemAt, getRemainingMetadataCacheIndexCount,
getRendererNames, getSequenceAt, getSequenceItemAt, getVideoEffectByName,
getVideoEffectList, getVideoTransitionByName, getVideoTransitionList, import,
importAEComps, importAllAEComps, importFiles, importPSD, importProject, init,
newBarsAndTone, newBin, newBlackVideo, newColorMatte, newSequence, newSmartBin,
newTransparentVideo, newUniversalCountingLeader, redo, resetNumFilesCounter, save,
saveAs, setRenderer, sizeOnDisk, undo, undoStackIndex
```
- **136 video effects, 76 audio effects, 110 video transitions, 3 audio transitions**
- `newColorMatte/newBlackVideo/newBarsAndTone/newTransparentVideo/newUniversalCountingLeader`
  all open **BLOCKING NATIVE DIALOGS** — unusable unattended. Confirmed the hard way.
- `newBin(name)`, `import(path, isNumberedStills)`, `newSequence(name, editingModeGUID)`
- `getVideoTransitionByName('Morph Cut')` → live QEVideoTransition object

## `qe` sequence — 50+ methods
```
addTracks, close, deletePreviewFiles, exportDirect, exportFrameDPX, exportFrameJPEG,
exportFramePNG, exportFrameTIFF, exportFrameTarga, exportToAME, extract, flushCache,
getAudioTrackAt, getEmptyBarTimes, getExportComplete, getExportFileExtension,
getGreenBarTimes, getRedBarTimes, getVideoTrackAt, getYellowBarTimes,
isIncompleteBackgroundVideoEffects, isOpen, left, lockTracks, makeCurrent, muteTracks,
razor, removeAudioTrack, removeEmptyAudioTracks, removeEmptyVideoTracks, removeTracks,
removeVideoTrack, renderAll, renderAudio, renderPreview, setAudioDisplayFormat,
setAudioFrameRate, setCTI, setInOutPoints, setInPoint, setOutPoint, setPreviewFrameSize,
setPreviewPresetPath, setUseMaxBitDepth, setUseMaxRenderQuality, setVideoDisplayFormat,
setVideoFrameSize, setWorkInOutPoints, setWorkInPoint, setWorkOutPoint, syncLockTracks
```
### properties
```
CTI, audioDisplayFormat, audioFrameRate, editingMode, fieldType, guid, inPoint, multicam,
name, numAudioTracks, numVideoTracks, outPoint, par, player, presetList,
previewPresetCodec, previewPresetPath, useMaxBitDepth, useMaxRenderQuality,
videoDisplayFormat, videoFrameRate, workInPoint, workOutPoint
```
- Render bars: `getGreen/Red/Yellow/EmptyBarTimes()` → Array of `QETime`
  (`.ticks`, `.secs`, `.frames` all readable)
- `renderAll()`, `renderPreview()`, `renderAudio()` — all zero-arg, verified
- `razor(timecode:string, bool, bool)` — verified + undoable
- `exportFramePNG/JPEG/TIFF/DPX/Targa(path, timecode, ?)` — all returned **false**,
  no file written. **Uncracked.**
- `extract(?, ?)` / `left(?, ?)` — "Illegal Parameter type" on everything tried

## `qe` clip — 30 methods
```
addAudioEffect, addTransition, addVideoEffect, canDoMulticam, getClipPanComponent,
getComponentAt, getProjectItem, move, moveToTrack, remove, removeEffects, rippleDelete,
roll, setAntiAliasQuality, setBorderColor, setBorderWidth, setEndPercent, setEndPosition,
setFrameBlend, setMulticam, setName, setReverse, setScaleToFrameSize, setSpeed,
setStartPercent, setStartPosition, setSwitchSources, setTimeInterpolationType, slide, slip
```
### properties
```
alignment, antiAliasQuality, borderColor, borderWidth, duration, end, endPercent,
frameBlend, mediaType, multicamEnabled, name, numComponents, reverse, reversed,
scaleToFrameSize, speed, start, startPercent, staticClipGain, switchSources,
timeInterpolationType, type
```
- `setSpeed(rate, durationTimecode, reverse, maintainAudioPitch, rippleEdit)` — **5 args**;
  fewer throws "Not Enough Parameters"; rate is a RATIO (0.5 = 50%). Verified via DOM
  `getSpeed()` 1.0 → 0.5. On-timeline duration did NOT ripple with args tried.
- `slide(timecode:string, bool)` / `slip` — "Illegal Parameter type" with numbers

## `QEComponent` (via `qeClip.getComponentAt(i)`)
```
getParamControlValue, getParamKeyframes, getParamList, getParamValue, remove, setParamValue
```
- `remove()` — **verified removes exactly that one effect** (6 → 5 components).
  This is what makes effect-stack reorder possible.
- `getParamList()` → CSV of param names; `getParamValue(name)` / `setParamValue(name, value)`
  take STRING names, not indices (indices throw "Illegal Parameter type")
- `getParamKeyframes(name)` → Array

## `qe.source` (Source Monitor)
```
openFilePath(path)
```
- `qe.source.clip` → `QEMasterClip`: `setInPoint, setOutPoint, clearInPoint, clearOutPoint,
  setVideoInPoint, setVideoOutPoint, setAudioInPoint, setAudioOutPoint, setDuration,
  clearChildClips, hasChildClipsInUse, numOfChildClips, numOfChildClipsInUse`
- `qe.source.player` → `QEPlayer`: `play(speed:number), stop, step(deltaTimecode:string),
  scrubTo(tc:string), getPosition, startScrubbing, endScrubbing, setLoopPlayback,
  enableStatistics, disableStatistics, captureAudioDeviceLoad, clearAudioDropoutStatus`
- `QEPlayer` props: `avgFPS, avgRenderRate, avgPrefetchTime, droppedFrames, isPlaying,
  loopPlayback, preroll, totalFrames, audioDropouts, audioIODropouts, audioIOOverloads,
  audioClockJitters, audioDeviceLoadAvg/Max/Min/StdDev, audioMediaNotFound,
  audioPrefetchBehinds`

## `qe` track
```
addAudioEffect, getComponentAt, getItemAt, getTransitionAt, insert, isLocked, isMuted,
isSyncLocked, overwrite, razor, setLock, setMute, setName, setSyncLock
```
props: `id, index, name, numComponents, numItems, numTransitions, type`

## `QEProjectItem` (via `qeClip.getProjectItem()`)
```
automateToSequence, containsSpeechTrack, createProxy, getMetadataSize, isAudioConforming,
isAudioPeakGenerating, isIndexing, isOffline, isPending, linkMedia, openInSource, rename,
setOffline
```
`automateToSequence(Object, number, number, number, number)`

## `qe.ea` — `QEEA` (Productions / Team Projects)
```
addEventListener, benchmarkReflectEverything, canShare, closeProduction,
convertProductionIntoProject, convertProjectIntoProduction, createProduction,
dispatchEvent, doesEditingSessionHaveLocalMedia, doesProjectHaveUnsharedChanges,
fetchIMSAccessToken, getAdminInterface, getArchivedProductionList,
getCreativeCloudIdentity, getConflicts, getDiscoveryURL, getInviteList, getProcessID,
getProductionByID, getProductionList, getRemoteServerBuildVersion, getSessionSyncStatus,
getUserEmail, getUsername, isCollaborationOnly,
isConvertProductionIntoProjectRunning, isConvertProjectIntoProductionRunning,
isHostedCollaborationOnly, isLoggedIn, isShareCommandEnabled, isSyncCommandEnabled,
openCleanSandbox, openProduction, removeEventListener, renameProduction, resolveConflict,
saveProductionAs, setAuthToken, setLocalHubConnectionStatus, setMediaCachePath, share, sync,
waitForCurrentReflectionToComplete
```
props: `isAdministrator`
- `createProduction(p0:string, p1:string, p2:boolean, p3:string, p4:string, p5:boolean)`
- `convertProjectIntoProduction(string, string, boolean, string, boolean)`
- `openProduction(string, boolean)`
- Verified logged in during probing.

## `qe.tqm` — `QECloudDispatcher`
```
addEventListener, createQueue, dispatchEvent, getActiveRegion, getAuthToken,
getQueueListObject, getSupportedRegionList, logIntoTaskQueueManager, loginByRegion,
removeEventListener, setDiscoveryURL
```
**Never explored.** Cloud task queue — likely relates to Team Projects / remote render.

---

# Confirmed NOT available

- `app.findMenuCommandId` / `app.executeCommand` — **absent in the CEP ExtendScript
  context on 26.3.2** (`hasApi:false` live). No scripted menu bus on this build.
- No `Set`, `Map`, `Array.prototype.forEach` guarantees — engine is **ES3**.
- No native `JSON` (build 80.1060872) — the bridge injects its own.
- No expressions on keyframes (static/keyframed values only).
- No free-draw mask geometry on effects (PP2026 Object Mask stores shape data as a
  `SubComponent` in the .prproj XML, not reachable via DOM or QE).
- No playback-resolution (Program Monitor Full/½/¼) API found.
- No clipboard API for clips.
- No merged-clip creation (detection only).

# Known-dialog-opening calls (block the CEP bridge)

- `qe.project.newColorMatte / newBlackVideo / newBarsAndTone / newTransparentVideo /
  newUniversalCountingLeader`
- Adding an **obsolete** audio effect (e.g. `Adaptive Noise Reduction` on 26.3.2) raises
  "Audio Effects Replacement"
- `Track.overwriteClip` with mismatched media raises "Clip Mismatch Warning"
- EDL import prompts for sequence/source media
