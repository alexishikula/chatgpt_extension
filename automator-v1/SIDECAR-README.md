# Automator File Sidecar

## Overview

The File Sidecar is a browser-based storage system that allows agents to temporarily store file deliverables (ZIP files, binaries, large artifacts) and pass them to the Project Manager when tasks are completed. This solves the problem of transferring binary files between agents in a text-only chat interface.

## Architecture

```
┌─────────────────┐     Store File      ┌──────────────────────┐
│   Agent Browser │ ──────────────────► │  Chrome Storage Local│
│   (Content Script)                    │  (File Sidecar)      │
│                                       │                      │
│   chrome.runtime.sendMessage()        │  - taskId:fileName   │
│   AUTOMATOR_STORE_FILE                │  - dataUrl (base64)  │
│                                       │  - metadata          │
└─────────────────┘                     └──────────────────────┘
                                               ▲
                                               │ Retrieve
                                               │
                                    ┌──────────────────────┐
                                    │   PM Browser         │
                                    │   chrome.runtime.    │
                                    │   sendMessage()      │
                                    │   AUTOMATOR_GET_FILES│
                                    └──────────────────────┘
```

## Storage Limits

- **Maximum file size**: 5MB per file
- **Maximum total storage**: 50MB across all tasks
- Files persist until explicitly deleted or task is cleared

## API Reference

### Background Script Messages

#### Store a File
```javascript
chrome.runtime.sendMessage({
  type: 'AUTOMATOR_STORE_FILE',
  taskId: 'NATIVE-APP-001',
  fileName: 'Northstar-Native-TV-Foundation.zip',
  fileType: 'application/zip',
  dataUrl: 'data:application/zip;base64,UEsDBBQ...',
  metadata: {
    uploadedByAgentId: 'senior_developer_chatgpt_work',
    sha256: '47ba0a2524f17bada984ba280d9bbf58081d924021bbed82625ed16afc5578e8',
    description: 'Android TV foundation APK project'
  }
}, (response) => {
  if (response.ok) {
    console.log('Stored as:', response.fileId);
  } else {
    console.error('Error:', response.error);
  }
});
```

#### Get Files for Task
```javascript
chrome.runtime.sendMessage({
  type: 'AUTOMATOR_GET_FILES',
  taskId: 'NATIVE-APP-001'
}, (response) => {
  if (response.ok) {
    console.log('Files:', response.files);
    // [{ fileId, fileName, fileType, sizeBytes, uploadedAt, sha256, description }]
  }
});
```

#### Get File Data
```javascript
chrome.runtime.sendMessage({
  type: 'AUTOMATOR_GET_FILE_DATA',
  fileId: 'NATIVE-APP-001:Northstar-Native-TV-Foundation.zip'
}, (response) => {
  if (response.ok && response.file) {
    // response.file.dataUrl contains the base64 data
  }
});
```

#### Delete a File
```javascript
chrome.runtime.sendMessage({
  type: 'AUTOMATOR_DELETE_FILE',
  fileId: 'NATIVE-APP-001:Northstar-Native-TV-Foundation.zip'
});
```

#### Clear All Files for Task
```javascript
chrome.runtime.sendMessage({
  type: 'AUTOMATOR_CLEAR_TASK_FILES',
  taskId: 'NATIVE-APP-001'
});
```

#### Get Storage Info
```javascript
chrome.runtime.sendMessage({
  type: 'AUTOMATOR_GET_STORAGE_INFO'
}, (response) => {
  console.log(`Used: ${response.usedMB}MB / ${response.maxMB}MB (${response.percentUsed}%)`);
});
```

## Helper Library

A convenience library `sidecar-helper.js` is provided for easier integration:

```javascript
// Load the helper (in content script or console)
const sidecar = new AutomatorSidecarHelper();

// Store a file from file input
const fileInput = document.querySelector('input[type="file"]');
const file = fileInput.files[0];
await sidecar.storeFile('NATIVE-APP-001', file, {
  sha256: 'abc123...',
  description: 'My deliverable'
});

// List files for a task
const files = await sidecar.getFiles('NATIVE-APP-001');
console.log(files);

// Download a file
await sidecar.downloadFile('NATIVE-APP-001:myfile.zip');

// Check storage usage
const info = await sidecar.getStorageInfo();
console.log(`${info.percentUsed}% used`);
```

## Agent Workflow Example

1. **Agent creates deliverable** (e.g., ZIP file)
2. **Agent stores file in sidecar**:
   ```javascript
   const sidecar = new AutomatorSidecarHelper();
   const result = await sidecar.storeFile(taskId, zipFile, {
     sha256: sha256Hash,
     description: 'Project deliverable'
   });
   ```
3. **Agent returns TASK_RESULT** referencing the stored file:
   ```json
   <<AUTOMATOR>>
   {
     "action": "TASK_RESULT",
     "task_id": "NATIVE-APP-001",
     "status": "COMPLETE",
     "summary": "Completed Android TV foundation. Deliverable stored: Northstar-Native-TV-Foundation.zip"
   }
   <<END_AUTOMATOR>>
   ```
4. **PM retrieves files** after receiving result:
   ```javascript
   const files = await sidecar.getFiles('NATIVE-APP-001');
   for (const file of files) {
     await sidecar.downloadFile(file.fileId);
   }
   ```

## Event Logging

All sidecar operations are logged in the automator event log:
- `FILE_STORED_IN_SIDECAR`
- `FILE_DELETED_FROM_SIDECAR`
- `TASK_FILES_CLEARED`

View events in the automator sidepanel or via:
```javascript
const state = await chrome.runtime.sendMessage({ type: 'AUTOMATOR_GET_STATE' });
console.log(state.eventLog.filter(e => e.type.includes('FILE')));
```

## Best Practices

1. **Store files BEFORE returning TASK_RESULT** - ensures PM can access them immediately
2. **Include SHA256 in metadata** - for integrity verification
3. **Use descriptive filenames** - helps PM identify deliverables
4. **Clear old task files** - prevents storage bloat
5. **Reference files in summary** - makes it clear what was delivered

## Troubleshooting

### "Storage limit exceeded"
- Check usage with `getStorageInfo()`
- Clear old task files with `clearTaskFiles(taskId)`
- Delete individual files with `deleteFile(fileId)`

### "File too large"
- Compress the file further
- Split into multiple smaller files
- Consider external hosting for very large files (>5MB)

### File not found
- Verify taskId matches exactly
- Check if files were cleared
- Ensure agent stored the file before completing task
