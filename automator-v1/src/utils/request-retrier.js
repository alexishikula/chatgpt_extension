/**
 * Smart Request Retrier with Exponential Backoff
 * 
 * Handles transient network errors, rate limits (429), and server errors (503)
 * by automatically retrying requests with increasing delays.
 */

class RequestRetrier {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000; // 1 second
    this.maxDelay = options.maxDelay || 30000; // 30 seconds
    this.jitter = options.jitter !== false; // Default: true
    this.retryableStatusCodes = options.retryableStatusCodes || [429, 503, 502, 504];
    this.onRetry = options.onRetry || this.defaultOnRetry;
  }

  /**
   * Execute a request with automatic retry logic
   * @param {Function} requestFn - Async function that performs the request
   * @param {Object} context - Optional context for logging (e.g., { url, method })
   * @returns {Promise<any>} - The result of the successful request
   * @throws {Error} - After all retries are exhausted
   */
  async execute(requestFn, context = {}) {
    let lastError;
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      try {
        attempt++;
        const result = await requestFn();
        
        if (attempt > 1) {
          console.log(`[RequestRetrier] Success after ${attempt} attempts`, context);
        }
        
        return result;
      } catch (error) {
        lastError = error;
        
        // Check if error is retryable
        if (!this.isRetryableError(error)) {
          console.error(`[RequestRetrier] Non-retryable error: ${error.message}`, context);
          throw error;
        }

        // If we've exhausted retries, throw the error
        if (attempt > this.maxRetries) {
          console.error(`[RequestRetrier] Max retries (${this.maxRetries}) exhausted`, context);
          break;
        }

        // Calculate delay with exponential backoff and jitter
        const delay = this.calculateDelay(attempt);
        
        // Call onRetry callback
        await this.onRetry({ attempt, maxRetries: this.maxRetries, delay, error, context });

        // Wait before next retry
        await this.sleep(delay);
      }
    }

    // Throw the last error after all retries exhausted
    throw new Error(`Request failed after ${this.maxRetries + 1} attempts: ${lastError.message}`, {
      cause: lastError
    });
  }

  /**
   * Determine if an error is retryable
   * @param {Error} error - The error to check
   * @returns {boolean}
   */
  isRetryableError(error) {
    // Network errors (no status code)
    if (!error.status && !error.response?.status) {
      return error.message.includes('network') || 
             error.message.includes('timeout') || 
             error.message.includes('fetch') ||
             error.name === 'TypeError'; // Often indicates network issues in fetch
    }

    const statusCode = error.status || error.response?.status;
    return this.retryableStatusCodes.includes(statusCode);
  }

  /**
   * Calculate delay with exponential backoff and optional jitter
   * @param {number} attempt - Current attempt number (1-based)
   * @returns {number} - Delay in milliseconds
   */
  calculateDelay(attempt) {
    // Exponential backoff: baseDelay * 2^(attempt-1)
    const exponentialDelay = this.baseDelay * Math.pow(2, attempt - 1);
    
    // Cap at maxDelay
    const cappedDelay = Math.min(exponentialDelay, this.maxDelay);
    
    // Add jitter (random variation ±25%)
    if (this.jitter) {
      const jitterRange = cappedDelay * 0.25;
      const jitter = (Math.random() * jitterRange * 2) - jitterRange;
      return Math.max(0, cappedDelay + jitter);
    }
    
    return cappedDelay;
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Default retry callback - logs retry information
   * @param {Object} params - Retry parameters
   */
  defaultOnRetry({ attempt, maxRetries, delay, error, context }) {
    const delaySeconds = (delay / 1000).toFixed(1);
    console.warn(
      `[RequestRetrier] Attempt ${attempt}/${maxRetries + 1} failed. ` +
      `Retrying in ${delaySeconds}s... (${error.message})`,
      context
    );
  }
}

// Singleton instance with default configuration
const globalRetrier = new RequestRetrier();

/**
 * Convenience function for quick retries with default settings
 * @param {Function} requestFn - Async function that performs the request
 * @param {Object} options - Optional configuration overrides
 * @param {Object} context - Optional context for logging
 * @returns {Promise<any>}
 */
async function retryRequest(requestFn, options = {}, context = {}) {
  const retrier = new RequestRetrier(options);
  return retrier.execute(requestFn, context);
}

// Export for both module systems and browser globals
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RequestRetrier, retryRequest };
} else if (typeof window !== 'undefined') {
  window.RequestRetrier = RequestRetrier;
  window.retryRequest = retryRequest;
}
