# Error Recovery & Model Deviation Compensation Systems

## Overview
This document describes the comprehensive error handling and recovery mechanisms implemented in the automator extension to handle cases where the AI model goes off-script or produces unexpected output.

## Problems Identified & Fixed

### 1. **Task State Deadlock** ✅ FIXED
**Problem:** Tasks would get stuck in intermediate states (`RESULT_RECEIVED`, `PM_REVIEW`, `RESULT_RETURN_FAILED`) that were not included in `ACTIVE_TASK_STATES`, preventing PM from re-dispatching them.

**Solution:**
- Added intermediate states to `ACTIVE_TASK_STATES` set
- Implemented automatic timeout detection in `reconcile()` function
- Tasks stuck in `PM_REVIEW` for >5 minutes automatically reset to `RESPONSE_NO_VALID_RESULT`
- Tasks stuck in `RESULT_RETURN_FAILED` automatically retry by resetting to `RUNNING`
- Tasks stuck in `RESULT_RECEIVED` for >2 minutes reset to `RUNNING`

**Code Location:** `background.js` lines 5-6, 1210-1247

---

### 2. **Status Value Typos** ✅ FIXED
**Problem:** Models commonly return invalid status values like "COMPLETED" (should be "COMPLETE"), "FAIL" (should be "FAILED"), etc.

**Solution:**
- Enhanced `normalizeStatusInCommand()` with comprehensive status mapping
- Added auto-correction in `validateAgentResult()` that normalizes common typos before rejection
- System logs `STATUS_AUTO_CORRECTED` events when corrections are made
- Updated validation hints to explicitly list all invalid variants

**Status Mappings:**
- `COMPLETED` → `COMPLETE`
- `COMPLETE_TASK` → `COMPLETE`
- `FAIL` → `FAILED`
- `FAILURE` → `FAILED`
- `ESCALATE` → `ESCALATION_REQUIRED`
- `ESCALATION` → `ESCALATION_REQUIRED`
- `OWNER_ACTION` → `OWNER_ACTION_REQUIRED`
- `OWNER_APPROVAL` → `OWNER_ACTION_REQUIRED`

**Code Location:** `background.js` lines 379-404, 645-664

---

### 3. **Action Value Typos** ✅ FIXED
**Problem:** Models use incorrect action names like "TASK_RESULTS", "RESULT", "DISPATCH", etc.

**Solution:**
- Enhanced `normalizeActionInCommand()` with comprehensive action mapping
- Auto-correction applied during protocol parsing
- Updated validation hints with explicit examples

**Action Mappings:**
- `TASK_RESULTS`, `RESULT` → `TASK_RESULT`
- `DISPATCH`, `DISPATCH_ASSIGNMENT` → `DISPATCH_TASK`
- `REQUEST_APPROVAL` → `REQUEST_OWNER_APPROVAL`
- `REQUEST_ACTION` → `REQUEST_OWNER_ACTION`
- `CANCEL` → `CANCEL_TASK`
- `COMPLETE` → `COMPLETE_TASK`
- `PAUSE` → `PAUSE_PROJECT`
- `FINISH_PROJECT` → `COMPLETE_PROJECT`

**Code Location:** `background.js` lines 410-437

---

### 4. **Malformed JSON** ✅ FIXED
**Problem:** Models produce JSON with syntax errors (missing quotes, trailing commas, unquoted values).

**Solution:**
- Implemented `fixMalformedJsonAndExtract()` function that:
  - Adds missing quotes around keys
  - Removes trailing commas
  - Quotes unquoted string values
  - Extracts JSON objects even without proper wrappers
- Attempts multiple extraction patterns
- Logs "Fixed JSON syntax errors" when successful

**Code Location:** `background.js` lines 442-477

---

### 5. **Missing Protocol Wrappers** ✅ FIXED
**Problem:** Models forget to wrap JSON in `<<AUTOMATOR>>...<<END_AUTOMATOR>>` tags.

**Solution:**
- Enhanced `extractIntentionFromText()` performs fuzzy pattern matching on unstructured text
- Extracts task_id, status, action, summary from plain text
- Reconstructs valid command object from extracted fields
- Marks as "Extracted from unstructured text" for audit trail

**Extraction Patterns:**
- Task ID: `/task_id["\s:=]+([A-Z0-9_-]+)/i`
- Status: Fuzzy matching for COMPLETE/FAILED/ESCALATION_REQUIRED/OWNER_ACTION_REQUIRED
- Action: Fuzzy matching for TASK_RESULT/DISPATCH_TASK/REQUEST_OWNER_*
- Summary/Description: Extracts quoted strings
- Deliverables: Parses JSON arrays/objects

**Code Location:** `background.js` lines 487-587

---

### 6. **Validation Feedback Loop** ✅ ENHANCED
**Problem:** When validation fails, models need clear guidance to correct their output.

**Solution:**
- Enhanced `buildValidationCorrection()` with specific hints for each error type:
  - **Status errors**: Lists all valid values + common invalid variants
  - **Task ID errors**: Reminds to use exact task_id from assignment
  - **Action errors**: Explicitly states required action format
  - **JSON errors**: Provides complete syntax checklist + working example
  - **Assignment errors**: Guides verification of task ownership
  - **Extraction errors**: Reminds to use protocol wrappers

- Added complete working example in validation messages:
```
<<AUTOMATOR>>
{
  "action": "TASK_RESULT",
  "task_id": "TASK-001",
  "status": "COMPLETE",
  "summary": "Task completed successfully"
}
<<END_AUTOMATOR>>
```

**Code Location:** `background.js` lines 858-927

---

### 7. **PM Review Timeout** ✅ FIXED
**Problem:** If PM tab is unresponsive or PM doesn't act on results, tasks remain stuck indefinitely.

**Solution:**
- Added `PM_REVIEW_TIMEOUT_MS` constant (5 minutes)
- `reconcile()` function checks age of `PM_REVIEW` tasks
- Stuck tasks automatically transition to `RESPONSE_NO_VALID_RESULT` state
- Error message includes timeout duration for audit trail
- Event logged as `TASK_PM_REVIEW_TIMEOUT`

**Code Location:** `background.js` lines 4, 1218-1229

---

### 8. **Failed Result Return Recovery** ✅ FIXED
**Problem:** If sending result back to PM fails, task gets stuck in `RESULT_RETURN_FAILED` state permanently.

**Solution:**
- `reconcile()` automatically resets `RESULT_RETURN_FAILED` tasks to `RUNNING`
- Clears error field to allow clean retry
- Logs `TASK_RESULT_RETURN_RETRY` event for tracking
- Agent receives task again and can attempt result return

**Code Location:** `background.js` lines 1230-1236

---

## Predicted Error Scenarios & Compensation

| Error Type | Detection | Compensation | Recovery Path |
|------------|-----------|--------------|---------------|
| **Status typo** (COMPLETED vs COMPLETE) | Validation fails | Auto-correct in `validateAgentResult()` | Task proceeds normally, event logged |
| **Action typo** (TASK_RESULTS vs TASK_RESULT) | Validation fails | Auto-correct in `normalizeActionInCommand()` | Command executes, event logged |
| **Missing quotes in JSON** | JSON parse fails | `fixMalformedJsonAndExtract()` repairs | Parsed successfully, error noted |
| **No protocol wrapper** | Pattern match fails | `extractIntentionFromText()` extracts fields | Command reconstructed, marked as extracted |
| **Wrong task_id** | Validation fails | `buildValidationCorrection()` sends hint | Agent retries with correct task_id |
| **PM unresponsive** | Timeout check in reconcile() | Task reset to `RESPONSE_NO_VALID_RESULT` | PM can re-dispatch |
| **File attachment failure** | dispatchMessageToAgent catches error | Logged but continues with text-only | Files can be retrieved via sidecar |
| **Tab disconnected** | resolveTabForAgent fails | Agent status set to MISSING | Reconnect on next reconcile cycle |
| **Stuck in intermediate state** | reconcile() timeout check | Automatic state reset | Task resumes normal flow |

---

## Monitoring & Audit Trail

All recovery actions are logged with specific event types:
- `STATUS_AUTO_CORRECTED` - Status value was normalized
- `TASK_PM_REVIEW_TIMEOUT` - PM review exceeded timeout
- `TASK_RESULT_RETURN_RETRY` - Failed result return retry initiated
- `TASK_RESULT_RECEIVED_TIMEOUT` - Task stuck in RESULT_RECEIVED
- `VALIDATION_CORRECTION_SENT` - Correction message sent to agent
- `AGENT_RESPONSE_NO_PROTOCOL` - Agent response lacked protocol wrapper

These events enable debugging and monitoring of system health.

---

## Testing Recommendations

1. **Test status typos**: Have agent return `"status": "COMPLETED"` and verify auto-correction
2. **Test malformed JSON**: Remove quotes from keys and verify repair
3. **Test missing wrapper**: Send plain JSON without `<<AUTOMATOR>>` tags
4. **Test PM timeout**: Leave task in PM_REVIEW state for 5+ minutes
5. **Test failed dispatch**: Simulate tab disconnection during result return
6. **Test all action variants**: Try TASK_RESULTS, RESULT, DISPATCH, etc.

---

## Conclusion

The extension now has comprehensive error recovery systems that:
- ✅ Auto-correct common typos in status and action values
- ✅ Repair malformed JSON syntax
- ✅ Extract intentions from unstructured text
- ✅ Provide detailed validation feedback
- ✅ Recover from stuck task states via timeouts
- ✅ Maintain full audit trail of all corrections
- ✅ Allow system to self-heal without manual intervention

These mechanisms ensure the automator remains robust even when AI models deviate from expected output formats.
