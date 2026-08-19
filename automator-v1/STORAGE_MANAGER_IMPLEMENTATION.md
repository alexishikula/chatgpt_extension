# Storage Manager Implementation

## Overview
The Storage Manager solves Chrome's storage limitations (5MB per item, 50MB total) for the Automator extension, which transfers large files (15-20MB each) between agents.

## Key Features

### 1. **Automatic Compression**
- Uses `pako` (gzip) library for compression
- Achieves 60-80% size reduction on text/JSON data
- Automatic detection of compressed vs uncompressed data
- Only compresses data > 1KB to avoid overhead on tiny items

### 2. **Time-To-Live (TTL)**
- Default 24-hour expiration for file sidecar data
- Configurable TTL per item (e.g., 7 days for critical state)
- Automatic cleanup of expired items on access
- Prevents stale data from accumulating

### 3. **Automatic Cleanup**
- Triggers when storage reaches 80% capacity
- Phase 1: Removes expired items (past TTL)
- Phase 2: Removes oldest items first (FIFO)
- Targets 70% usage after cleanup

### 4. **Size Limits Enforcement**
- Max item size: 4.5MB (safe margin under 5MB Chrome limit)
- Max total storage: 45MB (safe margin under 50MB Chrome limit)
- Throws clear error if item exceeds limits with suggestion to chunk

### 5. **Storage Statistics**
- Track usage percentage
- Monitor compression savings
- Identify largest/oldest/newest items
- Count compressed vs uncompressed items

## API Reference

### Core Functions

```javascript
// Store data with auto-compression and TTL
await setItem(key, data, { 
  ttlHours: 24,      // Default: 24 hours
  forceCompress: true // Force compression even for small data
});

// Retrieve and auto-decompress data
const data = await getItem(key, { raw: false });

// Remove specific item
await removeItem(key);

// Clear items by pattern (e.g., "file_*")
const count = await clearByPattern('file_*');

// Clear all storage
await clearAll();

// Get detailed statistics
const stats = await getStats();
/* Returns:
{
  usedBytes: 12345678,
  totalBytes: 45000000,
  percentUsed: 27,
  itemCount: 15,
  compressedCount: 12,
  avgItemSize: 823045,
  largestItem: 4500000,
  compressionSavings: "72.3%",
  oldestItem: "2024-01-15T10:30:00.000Z",
  newestItem: "2024-01-16T14:22:00.000Z"
}
*/

// Check current usage
const usage = await getStorageUsage();
/* Returns: { used: bytes, total: bytes, percent: 0.0-1.0 } */

// Manual cleanup trigger
await autoCleanup(targetPercent: 0.7);
```

### Constants

```javascript
MAX_ITEM_SIZE_BYTES = 4.5 * 1024 * 1024;   // 4.5MB
MAX_TOTAL_SIZE_BYTES = 45 * 1024 * 1024;   // 45MB
DEFAULT_TTL_HOURS = 24;                    // 24 hours
```

## Usage in background.js

```javascript
import { setItem, getItem, DEFAULT_TTL_HOURS } from './src/utils/storage-manager.js';

// Store application state (7 day TTL, forced compression)
await setItem('automatorStateV1', state, { 
  ttlHours: 168, 
  forceCompress: true 
});

// Store file sidecar (24 hour TTL, forced compression)
await setItem('automatorFileSidecarV1', sidecar, { 
  ttlHours: DEFAULT_TTL_HOURS, 
  forceCompress: true 
});

// Retrieve state
const state = await getItem('automatorStateV1');

// Retrieve sidecar
const sidecar = await getItem('automatorFileSidecarV1');
```

## Compression Performance

Typical compression ratios for agent file transfers:
- **JSON data**: 70-85% reduction
- **Text files**: 60-80% reduction
- **Base64 encoded files**: 5-15% reduction (already encoded)
- **Binary files**: Varies (use native binary when possible)

Example: A 20MB JSON file → ~4-6MB after compression (75% savings)

## Automatic Cleanup Strategy

When storage reaches 80% capacity:

1. **Expired Items First**: Any item past its TTL is immediately removed
2. **Oldest Items Next**: If still over threshold, removes oldest items first
3. **Target 70%**: Continues until usage drops to 70% or lower
4. **Logged Actions**: All cleanup actions are logged to console for monitoring

## Error Handling

- **Compression failures**: Falls back to uncompressed storage with warning
- **Decompression failures**: Returns clear error message with key name
- **Size exceeded**: Throws error suggesting to split into chunks
- **Storage full**: Triggers auto-cleanup before failing

## Monitoring Recommendations

Add periodic stats logging to detect issues early:

```javascript
// In background.js reconcile loop or alarm
setInterval(async () => {
  const stats = await getStats();
  if (stats.percentUsed > 70) {
    console.warn(`[StorageMonitor] High usage: ${stats.percentUsed}%`);
  }
}, 5 * 60 * 1000); // Every 5 minutes
```

## Dependencies

- **pako**: Installed via npm (`npm install pako --save`)
- Automatically loaded in service workers and content scripts
- Uses gzip compression (level 9 for maximum compression)

## Migration Notes

Existing `chrome.storage.local.get/set/remove` calls should be replaced with:
- `chrome.storage.local.set({key: value})` → `setItem(key, value, options)`
- `chrome.storage.local.get([key])` → `getItem(key, options)`
- `chrome.storage.local.remove([key])` → `removeItem(key)`

The Storage Manager wraps these operations with compression, TTL, and automatic cleanup.
