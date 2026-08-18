/**
 * Automator File Sidecar Helper Library
 * 
 * Provides utilities for agents to store and retrieve file deliverables
 * using the browser's chrome.storage.local API via the automator extension.
 * 
 * Usage in browser console or content script:
 *   const sidecar = new AutomatorSidecarHelper();
 *   await sidecar.storeFile(taskId, fileObject);
 */

class AutomatorSidecarHelper {
  constructor() {
    this.MAX_FILE_SIZE_MB = 5;
    this.MAX_TOTAL_SIZE_MB = 50;
  }

  /**
   * Store a file in the sidecar for a specific task
   * @param {string} taskId - The task ID this file belongs to
   * @param {File|Blob} file - The File or Blob object to store
   * @param {object} metadata - Optional metadata (sha256, description, etc.)
   * @returns {Promise<{fileId: string, sizeBytes: number}>}
   */
  async storeFile(taskId, file, metadata = {}) {
    return new Promise((resolve, reject) => {
      if (!taskId || typeof taskId !== 'string') {
        reject(new Error('taskId is required and must be a string'));
        return;
      }
      if (!file || !(file instanceof File || file instanceof Blob)) {
        reject(new Error('file must be a File or Blob object'));
        return;
      }

      // Check file size before attempting upload
      const fileSizeMB = file.size / (1024 * 1024);
      if (fileSizeMB > this.MAX_FILE_SIZE_MB) {
        reject(new Error(`File size ${fileSizeMB.toFixed(2)}MB exceeds ${this.MAX_FILE_SIZE_MB}MB limit`));
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        
        chrome.runtime.sendMessage(
          {
            type: 'AUTOMATOR_STORE_FILE',
            taskId,
            fileName: file.name || 'unnamed',
            fileType: file.type || 'application/octet-stream',
            dataUrl,
            metadata: {
              uploadedByAgentId: metadata.uploadedByAgentId || null,
              sha256: metadata.sha256 || null,
              description: metadata.description || '',
              originalSize: file.size
            }
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.ok) {
              resolve({ fileId: response.fileId, sizeBytes: response.sizeBytes });
            } else {
              reject(new Error(response?.error || 'Unknown error storing file'));
            }
          }
        );
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Get list of files for a task
   * @param {string} taskId - The task ID to query
   * @returns {Promise<Array>} Array of file metadata objects
   */
  async getFiles(taskId) {
    return new Promise((resolve, reject) => {
      if (!taskId) {
        reject(new Error('taskId is required'));
        return;
      }

      chrome.runtime.sendMessage(
        { type: 'AUTOMATOR_GET_FILES', taskId },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.ok) {
            resolve(response.files || []);
          } else {
            reject(new Error(response?.error || 'Unknown error getting files'));
          }
        }
      );
    });
  }

  /**
   * Get full file data including the Data URL
   * @param {string} fileId - The file ID (format: taskId:fileName)
   * @returns {Promise<object>} File data with dataUrl
   */
  async getFileData(fileId) {
    return new Promise((resolve, reject) => {
      if (!fileId) {
        reject(new Error('fileId is required'));
        return;
      }

      chrome.runtime.sendMessage(
        { type: 'AUTOMATOR_GET_FILE_DATA', fileId },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.ok) {
            resolve(response.file);
          } else {
            reject(new Error(response?.error || 'Unknown error getting file data'));
          }
        }
      );
    });
  }

  /**
   * Download a file from the sidecar to the user's local system
   * @param {string} fileId - The file ID to download
   * @param {string} [fileName] - Optional override filename
   */
  async downloadFile(fileId, fileName = null) {
    const fileData = await this.getFileData(fileId);
    if (!fileData) {
      throw new Error('File not found');
    }

    const actualFileName = fileName || fileData.fileName;
    
    // Create download link
    const link = document.createElement('a');
    link.href = fileData.dataUrl;
    link.download = actualFileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * Delete a file from the sidecar
   * @param {string} fileId - The file ID to delete
   */
  async deleteFile(fileId) {
    return new Promise((resolve, reject) => {
      if (!fileId) {
        reject(new Error('fileId is required'));
        return;
      }

      chrome.runtime.sendMessage(
        { type: 'AUTOMATOR_DELETE_FILE', fileId },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.ok) {
            resolve();
          } else {
            reject(new Error(response?.error || 'Unknown error deleting file'));
          }
        }
      );
    });
  }

  /**
   * Clear all files for a task
   * @param {string} taskId - The task ID to clear
   */
  async clearTaskFiles(taskId) {
    return new Promise((resolve, reject) => {
      if (!taskId) {
        reject(new Error('taskId is required'));
        return;
      }

      chrome.runtime.sendMessage(
        { type: 'AUTOMATOR_CLEAR_TASK_FILES', taskId },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.ok) {
            resolve();
          } else {
            reject(new Error(response?.error || 'Unknown error clearing task files'));
          }
        }
      );
    });
  }

  /**
   * Get storage usage information
   * @returns {Promise<{usedBytes: number, usedMB: string, maxBytes: number, maxMB: string, percentUsed: string}>}
   */
  async getStorageInfo() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'AUTOMATOR_GET_STORAGE_INFO' },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.ok) {
            resolve({
              usedBytes: response.usedBytes,
              usedMB: response.usedMB,
              maxBytes: response.maxBytes,
              maxMB: response.maxMB,
              percentUsed: response.percentUsed
            });
          } else {
            reject(new Error(response?.error || 'Unknown error getting storage info'));
          }
        }
      );
    });
  }

  /**
   * Convert a Data URL back to a Blob
   * @param {string} dataUrl - The Data URL to convert
   * @returns {Blob}
   */
  dataUrlToBlob(dataUrl) {
    const arr = dataUrl.split(',');
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  }

  /**
   * Convert a Data URL to a File object
   * @param {string} dataUrl - The Data URL to convert
   * @param {string} fileName - The filename
   * @returns {File}
   */
  dataUrlToFile(dataUrl, fileName) {
    const blob = this.dataUrlToBlob(dataUrl);
    return new File([blob], fileName, { type: blob.type });
  }
}

// Export for use as module or global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutomatorSidecarHelper;
} else {
  window.AutomatorSidecarHelper = AutomatorSidecarHelper;
}
