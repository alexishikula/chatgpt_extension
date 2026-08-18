# Automator File Transfer System - Current State Review

## Overview
The extension has been updated with automatic file transfer capabilities between agents using browser storage (sidecar). This document reviews the current implementation and identifies gaps.

## Current Architecture

### 1. File Storage (Sidecar)
- **Location**: `chrome.storage.local` (IndexedDB backend)
- **Limits**: 5MB per file, 50MB total
- **API**: `AutomatorSidecarHelper` class in `sidecar-helper.js`
- **Key Methods**:
  - `storeFile(taskId, file, metadata)` - Store a file blob
  - `getFiles(taskId)` - List files for a task
  - `getFileData(fileId)` - Get full file data including base64
  - `downloadFile(fileId)` - Trigger browser download

### 2. Automatic File Extraction (background.js lines 991-1047)
When an agent returns `TASK_RESULT` with `deliverables` containing `sandbox:` paths:
1. Extension detects sandbox paths in deliverables array
2. Sends `AUTOMATOR_READ_FILE` message to agent's tab
3. Content script attempts to retrieve file from sidecar storage
4. If found, stores in sidecar; if not, logs error

**CRITICAL GAP**: The content script CANNOT read files from the Docker container's filesystem. It can only access files already stored in the browser's sidecar.

### 3. Automatic File Injection (background.js lines 695-723, 725-754)
When dispatching a task to an agent:
1. Extension checks sidecar for files matching the taskId
2. If files exist, appends "ATTACHED DELIVERABLES" section to the assignment message
3. Next agent sees file list and can use `sidecar.getFileData()` to retrieve them

### 4. Status/Action Correction (background.js lines 379-437)
Auto-corrects common typos:
- `"COMPLETED"` → `"COMPLETE"`
- `"TASK_RESULTS"` → `"TASK_RESULT"`
- `"FAIL"` → `"FAILED"`
- etc.

## The Problem with Your Example Response

Your example response includes:
```json
"deliverables": [
  {
    "name": "Northstar-Native-TV-Foundation-NATIVE-APP-001.zip",
    "path": "sandbox:/workspace/scratch/318b35efd3bc/deliverables/Northstar-Native-TV-Foundation-NATIVE-APP-001.zip",
    "sha256": "..."
  }
]
```

**This will NOT work automatically** because:

1. **Extension cannot access Docker filesystem**: The `sandbox:` path points to a file inside the Docker container where the agent runs. The browser extension has no direct access to this filesystem.

2. **Agent must explicitly store files**: Before returning `TASK_RESULT`, the agent MUST call `sidecar.storeFile()` or `chrome.runtime.sendMessage({type: 'AUTOMATOR_STORE_FILE', ...})` to push the file content into browser storage.

3. **Current flow expects pre-stored files**: The `AUTOMATOR_READ_FILE` handler in content.js only checks if the file is already in sidecar storage. It cannot fetch from sandbox paths.

## Required Agent Workflow

For file transfer to work, agents must follow this sequence:

### Step 1: Read and Encode File (in Docker/Node.js context)
```javascript
const fs = require('fs');
const fileBuffer = fs.readFileSync('/workspace/scratch/.../file.zip');
const base64 = fileBuffer.toString('base64');
const dataUrl = `data:application/zip;base64,${base64}`;
```

### Step 2: Store in Sidecar (via browser extension)
```javascript
chrome.runtime.sendMessage({
  type: 'AUTOMATOR_STORE_FILE',
  taskId: 'NATIVE-APP-001',
  fileName: 'file.zip',
  fileType: 'application/zip',
  dataUrl: dataUrl,
  metadata: { sha256: '...', description: '...' }
});
```

### Step 3: Return TASK_RESULT
```json
<<AUTOMATOR>>
{
  "action": "TASK_RESULT",
  "task_id": "NATIVE-APP-001",
  "status": "COMPLETE",
  "summary": "Completed. File stored in sidecar: file.zip"
}
<<END_AUTOMATOR>>
```

## What Happens Automatically

✅ **Status correction**: "COMPLETED" → "COMPLETE"
✅ **Action correction**: "TASK_RESULTS" → "TASK_RESULT"
✅ **File listing injection**: When PM sends task to QA, files are listed
✅ **File retrieval by next agent**: QA can call `sidecar.getFileData()`

## What Does NOT Happen Automatically

❌ **File reading from sandbox paths**: Extension cannot access Docker filesystem
❌ **Automatic base64 encoding**: Agent must encode files before sending
❌ **Automatic storage**: Agent must explicitly call store API

## Recommended Solutions

### Option A: Update Agent Instructions (Implemented)
Updated `AGENT-V1-INSTRUCTIONS.txt` with clear examples showing:
- How to read files in Node.js context
- How to encode as base64
- How to call the storage API
- Explicit warning that sandbox: paths alone are insufficient

### Option B: Add Pre-Completion Hook (Future Enhancement)
Create a mechanism where:
1. Agent signals "about to complete with files"
2. Extension provides a helper script to run in Docker context
3. Script automatically reads, encodes, and stores files
4. Agent then completes normally

### Option C: Hybrid Mount Point (For Large Files)
For files >5MB:
1. Mount host directory to Docker: `-v ~/Downloads:/host_downloads`
2. Agent saves large files to mounted directory
3. Extension monitors mount point and imports files
4. Files transferred via host filesystem instead of browser storage

## Testing Checklist

To verify the system works:

1. ✅ Agent stores file via `sidecar.storeFile()` BEFORE completing
2. ✅ Agent returns `TASK_RESULT` with status "COMPLETE" (not "COMPLETED")
3. ✅ Extension extracts files and logs `FILE_AUTO_EXTRACTED_FROM_SANDBOX`
4. ✅ PM receives result with file count in envelope
5. ✅ PM dispatches to next agent with "ATTACHED DELIVERABLES" section
6. ✅ Next agent calls `sidecar.getFiles()` and sees the files
7. ✅ Next agent calls `sidecar.getFileData()` and gets base64 data
8. ✅ Next agent can download or process the file

## Current Status Summary

| Component | Status | Notes |
|-----------|--------|-------|
| Status correction | ✅ Working | Auto-fixes "COMPLETED" → "COMPLETE" |
| Action correction | ✅ Working | Auto-fixes "TASK_RESULTS" → "TASK_RESULT" |
| File storage API | ✅ Working | `sidecar.storeFile()` functional |
| File retrieval API | ✅ Working | `sidecar.getFileData()` functional |
| Auto-injection to next agent | ✅ Working | Files listed in assignment messages |
| Auto-extraction from sandbox: | ⚠️ Partial | Only works if file already in sidecar |
| Direct filesystem access | ❌ Not possible | Browser cannot access Docker FS |
| Agent instructions | ✅ Updated | Clear examples added |

## Conclusion

The system is **architecturally sound** but requires **agent cooperation**. Files will transfer automatically IF agents follow the correct workflow:

1. Read file in Docker
2. Encode as base64
3. Store via sidecar API
4. Return TASK_RESULT

The extension handles everything else automatically: validation, correction, storage, injection, and retrieval.

**Your original example would fail** because it only lists sandbox paths without storing the files first. The agent needs to add the storage step before completing.
