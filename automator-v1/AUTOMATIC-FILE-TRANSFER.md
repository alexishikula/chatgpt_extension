# Automator V1 - Automatic File Transfer System

## Overview

The automator now supports **automatic file transfer between agents** via the sidecar storage system. When an agent completes a task with file deliverables (ZIPs, binaries, etc.), those files are automatically made available to the next agent dispatched on the same task.

## How It Works

### Flow: Developer → PM → QA

1. **Developer Agent** completes work:
   - Stores files using `sidecar.storeFile(taskId, file)`
   - Returns `TASK_RESULT` with status `COMPLETE`
   - Files persist in browser storage

2. **Automator** routes result to PM:
   - Retrieves files from sidecar for that task
   - Includes "ATTACHED DELIVERABLES" section in message to PM
   - PM sees list of files with sizes and types

3. **PM** reviews and dispatches to QA:
   - PM sends `DISPATCH_TASK` to QA agent
   - Automator automatically includes file metadata in assignment

4. **QA Agent** receives assignment:
   - Sees "ATTACHED DELIVERABLES FROM PREVIOUS AGENT" section
   - Can access files using `sidecar.getFiles(taskId)` or `sidecar.downloadFile(fileId)`
   - No manual transfer needed!

## Key Features

### Automatic Attachment
- Files are **automatically attached** to messages when dispatched between agents
- No need for agents to manually reference or transfer files
- PM doesn't need to do anything special - files flow automatically

### Visibility
When files are present, agents see:
```
---
ATTACHED DELIVERABLES FROM PREVIOUS AGENT:
- Northstar-Native-TV-Foundation.zip (application/zip, 2450.3KB)
- SHA256SUMS.txt (text/plain, 1.2KB)

Use sidecar.getFileData(fileId) to retrieve each file.
```

### Storage Limits
- **5MB per file** maximum
- **50MB total** storage across all tasks
- Files persist until task is cleared or extension storage is reset

## Usage Examples

### Storing Files (Developer Agent)
```javascript
// In browser console or content script
const fileInput = document.querySelector('input[type="file"]');
const file = fileInput.files[0];

await sidecar.storeFile('NATIVE-APP-001', file, {
  sha256: 'abc123...',
  description: 'Android TV foundation APK'
});

// Then return TASK_RESULT
<<AUTOMATOR>>
{
  "action": "TASK_RESULT",
  "task_id": "NATIVE-APP-001",
  "status": "COMPLETE",
  "summary": "Completed Android TV foundation. Deliverable stored in sidecar."
}
<<END_AUTOMATOR>>
```

### Retrieving Files (QA Agent)
```javascript
// Get list of files for this task
const files = await sidecar.getFiles('NATIVE-APP-001');
console.log('Available files:', files);

// Download a specific file
await sidecar.downloadFile('NATIVE-APP-001:Northstar-Native-TV-Foundation.zip');

// Or get raw data for processing
const fileData = await sidecar.getFileData('NATIVE-APP-001:Northstar-Native-TV-Foundation.zip');
console.log(fileData.dataUrl); // base64 data URL
```

### PM Viewing Files
PM receives automatic notification:
```
AUTOMATOR AGENT RETURN
SOURCE_AGENT_ID: developer
TASK_ID: NATIVE-APP-001
AGENT_STATUS: COMPLETE
DELIVERABLE_COUNT: 2

ATTACHED DELIVERABLES:
- Northstar-Native-TV-Foundation.zip (application/zip, 2450.3KB)
- SHA256SUMS.txt (text/plain, 1.2KB)

Use sidecar.getFileData(fileId) to retrieve each file.
```

## Implementation Details

### Modified Components

1. **background.js**
   - `executeAgentResult()`: Retrieves files and includes in PM message
   - `dispatchMessageToAgent()`: Appends file metadata to assignments
   - `buildPmResultEnvelope()`: Formats file list for PM display

2. **sidecar-helper.js**
   - Auto-instantiates `window.sidecar` for convenience
   - Added documentation about automatic transfer

3. **AGENT-V1-INSTRUCTIONS.txt**
   - Added "RECEIVING FILES FROM PREVIOUS AGENTS" section
   - Clarified automatic availability of files

4. **PM-V1-INSTRUCTIONS.txt**
   - Added "ACCESSING FILE DELIVERABLES FROM AGENTS" section
   - Documented automatic file flow

## Benefits

1. **No Manual Transfer**: Agents don't need to coordinate file handoffs
2. **Transparent**: Files automatically appear in next agent's context
3. **Persistent**: Files survive browser refreshes (stored in chrome.storage.local)
4. **Auditable**: All file operations logged in event log
5. **Size-Limited**: Prevents storage abuse with 5MB/50MB limits

## Troubleshooting

### Files Not Appearing
- Check if agent stored files BEFORE returning TASK_RESULT
- Verify taskId matches between storing and retrieving agents
- Check storage limits (5MB per file, 50MB total)

### Storage Full Error
- Clear old task files: `await sidecar.clearTaskFiles('OLD-TASK-ID')`
- Delete individual files: `await sidecar.deleteFile('taskId:fileName')`
- Check usage: `await sidecar.getStorageInfo()`

### File Too Large
- Compress files before storing
- Split large deliverables into multiple files
- Consider external hosting for very large files (>5MB)

## Event Log Entries

The automator logs these events for file operations:
- `FILE_STORED_IN_SIDECAR`: When agent stores a file
- `RESULT_RETURNED_TO_PM`: Includes file count
- `DISPATCH_MESSAGE_TO_AGENT`: Indicates if files were attached
- `FILE_DELETED_FROM_SIDECAR`: When files are removed
- `TASK_FILES_CLEARED`: When all task files are cleared

View events in the automator sidepanel or via:
```javascript
chrome.storage.local.get('automatorStateV1', (result) => {
  console.log(result.automatorStateV1.eventLog);
});
```
