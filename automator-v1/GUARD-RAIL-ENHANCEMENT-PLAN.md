# Automator V1 - Guard Rail Enhancement Plan

## Executive Summary

This document identifies critical missing guard rails in the Automator V1 extension and provides implementation specifications to ensure AI agents can be brought back on track when they deviate from expected behavior.

## Identified Gaps

### 1. Missing: Clickable Markdown Link Detection

**Problem**: When agents output Markdown links like `[filename.zip](sandbox:/path/to/file.zip)`, the extension does not:
- Detect these clickable links in assistant messages
- Parse and extract file paths from Markdown link syntax
- Validate that linked files are accessible or stored

**Risk**: Agents may provide file deliverables as Markdown links instead of using the sidecar API, causing file transfer failures.

**Solution Required**:
- Add Markdown link parser to `parseProtocol()` function
- Extract sandbox paths from Markdown link syntax
- Auto-convert Markdown links to sidecar storage requests
- Validate all extracted paths before task completion

### 2. Missing: Auto-Download from Sandbox URLs

**Problem**: When agents include `sandbox:` paths (either in deliverables array or Markdown links), the extension:
- Does not automatically trigger downloads for PM/owner review
- Relies on manual retrieval via sidecar API
- Has no mechanism to push files to user's download folder

**Risk**: Critical deliverables may remain inaccessible in sandbox storage, requiring manual intervention.

**Solution Required**:
- Add Chrome `downloads` API permission to manifest.json
- Implement auto-download trigger when `download_url` field is present in command
- Create optional auto-download setting for PM-governed tasks
- Support batch download for multiple deliverables

### 3. Missing: PM Link Requirement Enforcement

**Problem**: When an agent's TASK_RESULT includes a `download_url` field:
- No validation ensures the URL is properly formatted
- No check verifies the file exists at that location
- No requirement for PM acknowledgment before marking complete
- No enforcement that download_url matches stored sidecar files

**Risk**: Agents could provide broken/invalid download links and still mark tasks as COMPLETE.

**Solution Required**:
- Add `download_url` validation to `validateAgentResult()` function
- Require PM confirmation when download_url is present
- Cross-reference download_url with sidecar-stored files
- Log validation failures as REQUIRES_PM_REVIEW events

### 4. Missing: Agent Deviation Detection & Recovery

**Current State**: The extension has basic validation but lacks proactive guard rails:
- `RESPONSE_NO_VALID_RESULT` state exists but recovery is passive
- No timeout-based escalation for stuck tasks
- No pattern detection for agents going off-track
- No automatic intervention triggers

**Solution Required**:
- Implement task duration monitoring with configurable thresholds
- Add deviation pattern detection (e.g., multiple protocol errors)
- Create automatic PM notification for agent deviations
- Build recovery workflow templates for common failure modes

## Implementation Priority

### P0 - Critical (Must Have)
1. **download_url validation** in `validateAgentResult()`
2. **Markdown link extraction** in content.js message parser
3. **Auto-download capability** via chrome.downloads API

### P1 - High (Should Have)
1. **PM confirmation requirement** for tasks with download_url
2. **Task duration monitoring** with alarm-based checks
3. **Deviation pattern tracking** per agent

### P2 - Medium (Nice to Have)
1. **Recovery workflow templates**
2. **Automatic file cleanup** for expired tasks
3. **Enhanced event logging** for audit trails

## Technical Specifications

### 1. Manifest.json Updates

```json
{
  "permissions": [
    "storage",
    "tabs",
    "scripting",
    "alarms",
    "sidePanel",
    "downloads"  // ADD THIS
  ]
}
```

### 2. Background.js - Download URL Validation

Add to `validateAgentResult()` function:

```javascript
function validateAgentResult(state, sourceAgentId, command) {
  // ... existing validations ...
  
  // NEW: Validate download_url if present
  if (command.download_url) {
    const urlPattern = /^https?:\\/\\/.+/i;
    if (!urlPattern.test(command.download_url)) {
      return 'download_url must be a valid HTTP/HTTPS URL';
    }
    
    // Check if matching file exists in sidecar
    const taskId = String(command.task_id || '').trim();
    const files = await getFilesForTask(taskId);
    const hasMatchingFile = files.some(f => 
      command.download_url.includes(f.fileName)
    );
    
    if (!hasMatchingFile && files.length > 0) {
      return 'download_url references file not found in sidecar deliverables';
    }
    
    // Flag for PM review
    command.requiresPmReview = true;
  }
  
  return null;
}
```

### 3. Content.js - Markdown Link Parser

Add to message parsing:

```javascript
function extractMarkdownLinks(text) {
  const markdownLinkPattern = /\\[([^\\]]+)\\]\\((sandbox:[^)]+)\\)/gi;
  const links = [];
  let match;
  
  while ((match = markdownLinkPattern.exec(text)) !== null) {
    links.push({
      linkText: match[1],
      url: match[2],
      fullPath: match[2].replace('sandbox:', '')
    });
  }
  
  return links;
}
```

### 4. Auto-Download Implementation

```javascript
async function autoDownloadFiles(fileIds, options = {}) {
  const sidecar = await loadFileSidecar();
  
  for (const fileId of fileIds) {
    const entry = sidecar[fileId];
    if (!entry) continue;
    
    try {
      await chrome.downloads.download({
        url: entry.dataUrl,
        filename: entry.fileName,
        saveAs: options.saveAs || false
      });
      
      logEvent(state, 'FILE_AUTO_DOWNLOADED', {
        fileId,
        fileName: entry.fileName,
        taskId: entry.taskId
      });
    } catch (error) {
      logEvent(state, 'FILE_DOWNLOAD_FAILED', {
        fileId,
        error: error.message
      });
    }
  }
}
```

## Testing Requirements

### Unit Tests
1. Test download_url validation with valid/invalid URLs
2. Test Markdown link extraction from various formats
3. Test auto-download with different file types
4. Test PM review requirement enforcement

### Integration Tests
1. Full workflow: Agent → PM with download_url → PM approval → Complete
2. Agent deviation scenario → Detection → PM notification → Recovery
3. Markdown link in response → Auto-extraction → Sidecar storage

### Manual Tests
1. Verify Chrome downloads API works in extension context
2. Test with real ChatGPT agent outputs containing Markdown links
3. Validate PM receives proper notifications for review-required tasks

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Chrome downloads API blocked | High | Fallback to manual download links |
| False positive deviation detection | Medium | Configurable thresholds, PM override |
| Storage bloat from unclaimed downloads | Medium | Auto-cleanup after N days |
| PM notification fatigue | Low | Batch notifications, priority levels |

## Success Metrics

1. **Zero orphaned deliverables**: All sandbox paths resolved to stored files
2. **100% download_url validation**: No invalid URLs reach PM
3. **<5min deviation detection**: Agents corrected within 5 minutes of going off-track
4. **Zero manual file transfers**: All file handoffs automated via sidecar

## Next Steps

1. Review and approve this enhancement plan
2. Implement P0 features (estimated: 4-6 hours)
3. Test with sample agent workflows
4. Deploy and monitor for 1 week
5. Implement P1/P2 features based on operational feedback

---

**Document Version**: 1.0  
**Created**: $(date +%Y-%m-%d)  
**Reviewers**: [Pending]  
**Approval Status**: [Pending]
