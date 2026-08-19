/**
 * Storage Manager - Handles compression, quotas, and automatic cleanup
 * Solves the 5MB per item / 50MB total Chrome storage limit for large file transfers
 */

const COMPRESSION_THRESHOLD = 1024; // Only compress if > 1KB
const MAX_ITEM_SIZE_BYTES = 4.5 * 1024 * 1024; // 4.5MB safe limit (under 5MB chrome limit)
const MAX_TOTAL_SIZE_BYTES = 45 * 1024 * 1024; // 45MB safe limit (under 50MB chrome limit)
const STORAGE_WARNING_THRESHOLD = 0.8; // Warn at 80% capacity
const DEFAULT_TTL_HOURS = 24; // Default time-to-live for files

// Dynamic import for pako (works in both service workers and content scripts)
let pako = null;

async function getPako() {
  if (!pako) {
    if (typeof require !== 'undefined') {
      pako = require('pako');
    } else if (typeof importScripts !== 'undefined') {
      // Service worker
      importScripts('../../node_modules/pako/dist/pako.min.js');
      pako = self.pako;
    } else {
      // Browser global
      pako = window.pako;
    }
  }
  return pako;
}

/**
 * Compress data using gzip
 * @param {string|Object} data - Data to compress
 * @returns {Promise<string>} Base64 encoded compressed data
 */
async function compressData(data) {
  const strData = typeof data === 'string' ? data : JSON.stringify(data);
  
  if (strData.length < COMPRESSION_THRESHOLD) {
    return strData; // Don't compress tiny data
  }
  
  const pakolib = await getPako();
  const compressed = pakolib.gzip(strData, { level: 9 }); // Max compression
  return arrayBufferToBase64(compressed);
}

/**
 * Decompress data
 * @param {string} base64Data - Base64 encoded compressed data
 * @returns {Promise<string>} Decompressed string
 */
async function decompressData(base64Data) {
  // Check if data is compressed (gzip magic number: 1f 8b)
  const binaryString = atob(base64Data);
  const headerBytes = binaryString.charCodeAt(0).toString(16) + 
                      binaryString.charCodeAt(1).toString(16);
  
  if (headerBytes !== '1f8b') {
    return base64Data; // Not compressed, return as-is
  }
  
  const pakolib = await getPako();
  const compressed = base64ToArrayBuffer(base64Data);
  const decompressed = pakolib.gunzip(compressed, { to: 'string' });
  return decompressed;
}

/**
 * Convert ArrayBuffer to Base64
 */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert Base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Get current storage usage
 * @returns {Promise<{used: number, total: number, percent: number}>}
 */
async function getStorageUsage() {
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse((totalUsed) => {
      resolve({
        used: totalUsed || 0,
        total: MAX_TOTAL_SIZE_BYTES,
        percent: (totalUsed || 0) / MAX_TOTAL_SIZE_BYTES
      });
    });
  });
}

/**
 * Check if storage is near capacity
 * @returns {Promise<boolean>}
 */
async function isStorageNearCapacity() {
  const usage = await getStorageUsage();
  return usage.percent >= STORAGE_WARNING_THRESHOLD;
}

/**
 * Get all stored items with metadata
 * @returns {Promise<Array>}
 */
async function getAllStoredItems() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const itemList = Object.entries(items).map(([key, value]) => ({
        key,
        size: JSON.stringify(value).length,
        timestamp: value?.metadata?.timestamp || 0,
        ttl: value?.metadata?.ttl || null,
        isCompressed: value?.metadata?.compressed || false
      }));
      resolve(itemList.sort((a, b) => a.timestamp - b.timestamp));
    });
  });
}

/**
 * Automatic cleanup strategy:
 * 1. Remove expired items (past TTL)
 * 2. Remove oldest items if still over threshold
 * 3. Keep most recent items up to safe limit
 */
async function autoCleanup(targetPercent = 0.7) {
  console.log('[StorageManager] Starting auto cleanup...');
  const items = await getAllStoredItems();
  const usage = await getStorageUsage();
  
  if (usage.percent <= targetPercent) {
    console.log('[StorageManager] Storage already under target, skipping cleanup');
    return { cleaned: 0, freedBytes: 0 };
  }
  
  let cleaned = 0;
  let freedBytes = 0;
  const now = Date.now();
  
  // Phase 1: Remove expired items (TTL)
  for (const item of items) {
    if (item.ttl && now > item.ttl) {
      await removeItem(item.key);
      freedBytes += item.size;
      cleaned++;
      console.log(`[StorageManager] Removed expired item: ${item.key}`);
    }
  }
  
  // Re-check usage
  const usageAfterExpired = await getStorageUsage();
  if (usageAfterExpired.percent <= targetPercent) {
    return { cleaned, freedBytes };
  }
  
  // Phase 2: Remove oldest items first
  const remainingItems = await getAllStoredItems();
  for (const item of remainingItems) {
    if (usage.percent <= targetPercent) break;
    
    await removeItem(item.key);
    freedBytes += item.size;
    cleaned++;
    console.log(`[StorageManager] Removed oldest item: ${item.key}`);
  }
  
  console.log(`[StorageManager] Cleanup complete: removed ${cleaned} items, freed ${freedBytes} bytes`);
  return { cleaned, freedBytes };
}

/**
 * Store data with automatic compression and TTL
 * @param {string} key - Storage key
 * @param {any} data - Data to store
 * @param {Object} options - Options
 * @param {number} options.ttlHours - Time to live in hours
 * @param {boolean} options.forceCompress - Force compression regardless of size
 * @returns {Promise<void>}
 */
async function setItem(key, data, options = {}) {
  const { ttlHours = DEFAULT_TTL_HOURS, forceCompress = false } = options;
  
  // Check storage capacity before storing
  if (await isStorageNearCapacity()) {
    console.warn('[StorageManager] Storage near capacity, triggering auto cleanup');
    await autoCleanup(0.7);
  }
  
  // Prepare data
  let storedData = data;
  let compressed = false;
  
  // Compress if needed
  const dataSize = JSON.stringify(data).length;
  if (forceCompress || dataSize > COMPRESSION_THRESHOLD) {
    try {
      storedData = await compressData(data);
      compressed = true;
      console.log(`[StorageManager] Compressed ${key}: ${dataSize} → ${storedData.length} bytes (${Math.round(storedData.length/dataSize*100)}%)`);
    } catch (err) {
      console.warn(`[StorageManager] Compression failed for ${key}, storing uncompressed`, err);
    }
  }
  
  // Add metadata
  const itemWithMetadata = {
    data: storedData,
    metadata: {
      timestamp: Date.now(),
      ttl: ttlHours ? Date.now() + (ttlHours * 60 * 60 * 1000) : null,
      compressed,
      originalSize: dataSize,
      storedSize: JSON.stringify(storedData).length
    }
  };
  
  // Verify size limit
  const itemSize = JSON.stringify(itemWithMetadata).length;
  if (itemSize > MAX_ITEM_SIZE_BYTES) {
    throw new Error(`Item too large: ${itemSize} bytes exceeds limit of ${MAX_ITEM_SIZE_BYTES} bytes. Consider splitting into chunks.`);
  }
  
  // Store
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: itemWithMetadata }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Storage failed: ${chrome.runtime.lastError.message}`));
      } else {
        console.log(`[StorageManager] Stored ${key} (${itemSize} bytes)`);
        resolve();
      }
    });
  });
}

/**
 * Retrieve and decompress data
 * @param {string} key - Storage key
 * @param {Object} options - Options
 * @param {boolean} options.raw - Return raw data without parsing
 * @returns {Promise<any>}
 */
async function getItem(key, options = {}) {
  const { raw = false } = options;
  
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], async (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      
      const item = result[key];
      if (!item) {
        resolve(null);
        return;
      }
      
      // Check if expired
      if (item.metadata?.ttl && Date.now() > item.metadata.ttl) {
        console.log(`[StorageManager] Item ${key} expired, removing`);
        await removeItem(key);
        resolve(null);
        return;
      }
      
      let data = item.data;
      
      // Decompress if needed
      if (item.metadata?.compressed) {
        try {
          data = await decompressData(data);
        } catch (err) {
          reject(new Error(`Decompression failed for ${key}: ${err.message}`));
          return;
        }
      }
      
      // Parse if JSON
      if (!raw && typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          // Keep as string if not valid JSON
        }
      }
      
      resolve(data);
    });
  });
}

/**
 * Remove item from storage
 * @param {string} key - Storage key
 * @returns {Promise<void>}
 */
async function removeItem(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove([key], () => {
      console.log(`[StorageManager] Removed ${key}`);
      resolve();
    });
  });
}

/**
 * Clear all items matching a pattern
 * @param {string} pattern - Key pattern (e.g., "file_*")
 * @returns {Promise<number>} Number of items removed
 */
async function clearByPattern(pattern) {
  const items = await getAllStoredItems();
  const regex = new RegExp(pattern.replace('*', '.*'));
  let removed = 0;
  
  for (const item of items) {
    if (regex.test(item.key)) {
      await removeItem(item.key);
      removed++;
    }
  }
  
  console.log(`[StorageManager] Cleared ${removed} items matching ${pattern}`);
  return removed;
}

/**
 * Clear all storage
 * @returns {Promise<void>}
 */
async function clearAll() {
  return new Promise((resolve) => {
    chrome.storage.local.clear(() => {
      console.log('[StorageManager] All storage cleared');
      resolve();
    });
  });
}

/**
 * Get storage statistics
 * @returns {Promise<Object>}
 */
async function getStats() {
  const usage = await getStorageUsage();
  const items = await getAllStoredItems();
  
  const compressedCount = items.filter(i => i.isCompressed).length;
  const totalOriginalSize = items.reduce((sum, i) => sum + (i.originalSize || i.size), 0);
  const totalStoredSize = items.reduce((sum, i) => sum + i.size, 0);
  const compressionRatio = totalOriginalSize > 0 ? (1 - totalStoredSize / totalOriginalSize) * 100 : 0;
  
  return {
    usedBytes: usage.used,
    totalBytes: usage.total,
    percentUsed: Math.round(usage.percent * 100),
    itemCount: items.length,
    compressedCount,
    avgItemSize: Math.round(totalStoredSize / (items.length || 1)),
    largestItem: items.length > 0 ? Math.max(...items.map(i => i.size)) : 0,
    compressionSavings: `${compressionRatio.toFixed(1)}%`,
    oldestItem: items.length > 0 ? new Date(items[0].timestamp).toISOString() : null,
    newestItem: items.length > 0 ? new Date(items[items.length - 1].timestamp).toISOString() : null
  };
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    setItem,
    getItem,
    removeItem,
    clearByPattern,
    clearAll,
    getStats,
    getStorageUsage,
    autoCleanup,
    compressData,
    decompressData,
    MAX_ITEM_SIZE_BYTES,
    MAX_TOTAL_SIZE_BYTES,
    DEFAULT_TTL_HOURS
  };
}
