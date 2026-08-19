/**
 * DOM Helper Utility - Resilient Element Querying
 * 
 * Provides fault-tolerant DOM querying with:
 * - Multiple selector strategies (class, aria-label, role, relative position)
 * - Wait logic for async rendering (React/Vue)
 * - Fallback mechanisms when primary selectors fail
 * - Clear warnings for debugging UI changes
 */

(function(global) {
  'use strict';

  const DEFAULT_TIMEOUT = 3000;
  const DEFAULT_RETRY_INTERVAL = 100;

  /**
   * Wait for an element to appear in the DOM
   * @param {string|string[]} selectors - Single selector or array of fallback selectors
   * @param {Object} options - Configuration options
   * @param {number} options.timeout - Max time to wait in ms (default: 3000)
   * @param {boolean} options.required - If true, throw error on timeout; if false, return null
   * @param {string} options.description - Human-readable description for logging
   * @returns {Promise<Element|null>}
   */
  async function waitForElement(selectors, options = {}) {
    const {
      timeout = DEFAULT_TIMEOUT,
      required = true,
      description = 'element'
    } = options;

    const selectorList = Array.isArray(selectors) ? selectors : [selectors];
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      for (const selector of selectorList) {
        try {
          const element = document.querySelector(selector);
          if (element) {
            return element;
          }
        } catch (e) {
          // Invalid selector, try next one
          console.warn(`[DOM Helper] Invalid selector "${selector}":`, e.message);
        }
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, DEFAULT_RETRY_INTERVAL));
    }

    // Timeout reached
    const msg = `[DOM Helper] Timeout waiting for ${description} after ${timeout}ms. Tried selectors: ${selectorList.join(', ')}`;
    
    if (required) {
      console.error(msg);
      throw new Error(msg);
    }
    
    console.warn(msg);
    return null;
  }

  /**
   * Query element with multiple fallback strategies
   * @param {Object} strategies - Selector strategies in priority order
   * @param {string[]} strategies.primary - Primary selectors (exact match)
   * @param {string[]} strategies.fallback - Fallback selectors (less specific)
   * @param {string[]} strategies.textMatch - Text content matching (for buttons/links)
   * @param {string[]} strategies.roleMatch - ARIA role matching
   * @param {Object} options - Configuration options
   * @param {number} options.timeout - Max time to wait (default: 1000 for immediate queries)
   * @param {boolean} options.waitForAppearance - If true, wait for element to appear
   * @returns {Element|null}
   */
  function queryResilient(strategies, options = {}) {
    const {
      timeout = 1000,
      waitForAppearance = false
    } = options;

    const {
      primary = [],
      fallback = [],
      textMatch = [],
      roleMatch = []
    } = strategies;

    // Build complete selector list
    const allSelectors = [...primary, ...fallback];
    
    // Add role-based selectors
    const roleSelectors = roleMatch.map(role => `[role="${role}"]`);
    allSelectors.push(...roleSelectors);

    // Try immediate query first
    for (const selector of allSelectors) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          return element;
        }
      } catch (e) {
        console.warn(`[DOM Helper] Invalid selector "${selector}":`, e.message);
      }
    }

    // Try text content matching for buttons/links
    for (const text of textMatch) {
      const elements = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
      for (const el of elements) {
        const elText = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
        if (elText.includes(text.toLowerCase())) {
          return el;
        }
      }
    }

    // If not found immediately and waitForAppearance is true, wait
    if (waitForAppearance && allSelectors.length > 0) {
      return waitForElement(allSelectors, {
        timeout,
        required: false,
        description: 'resilient query target'
      });
    }

    return null;
  }

  /**
   * Wait for element to be clickable (not disabled, visible, and interactive)
   * @param {Element} element - The element to check
   * @param {number} timeout - Max time to wait in ms
   * @returns {Promise<Element>}
   */
  async function waitForClickable(element, timeout = 2000) {
    if (!element) {
      throw new Error('[DOM Helper] Cannot wait for clickable: element is null');
    }

    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const isVisible = () => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && 
               style.visibility !== 'hidden' && 
               style.opacity !== '0' &&
               element.offsetParent !== null;
      };

      const isDisabled = () => {
        return element.disabled === true || 
               element.getAttribute('disabled') !== null ||
               element.getAttribute('aria-disabled') === 'true';
      };

      if (isVisible() && !isDisabled()) {
        return element;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`[DOM Helper] Element did not become clickable within ${timeout}ms`);
  }

  /**
   * Find element by relative position (e.g., button next to specific text)
   * @param {string} anchorSelector - Selector for anchor element
   * @param {string} targetTag - Tag name of target element (e.g., 'button', 'input')
   * @param {string} relationship - Relationship type ('next', 'parent', 'child', 'sibling')
   * @returns {Element|null}
   */
  function findByRelation(anchorSelector, targetTag, relationship = 'next') {
    const anchor = document.querySelector(anchorSelector);
    if (!anchor) return null;

    switch (relationship) {
      case 'next':
        return anchor.nextElementSibling?.tagName === targetTag.toUpperCase() 
          ? anchor.nextElementSibling 
          : anchor.parentElement?.querySelector(targetTag);
      
      case 'parent':
        return anchor.closest(targetTag);
      
      case 'child':
        return anchor.querySelector(targetTag);
      
      case 'sibling':
        const parent = anchor.parentElement;
        if (!parent) return null;
        return Array.from(parent.children)
          .find(child => child.tagName === targetTag.toUpperCase() && child !== anchor);
      
      default:
        return null;
    }
  }

  /**
   * Log a warning about potential UI changes
   * @param {string} context - Context where the issue occurred
   * @param {string[]} attemptedSelectors - Selectors that were tried
   * @param {string} suggestion - Suggested fix or alternative
   */
  function logUiChangeWarning(context, attemptedSelectors, suggestion = '') {
    const msg = `[DOM Helper] ⚠️ Potential UI change detected in ${context}. ` +
                `Selectors tried: [${attemptedSelectors.join(', ')}]. ` +
                (suggestion ? `Suggestion: ${suggestion}` : '');
    console.warn(msg);
  }

  // Export for different module systems
  if (typeof module !== 'undefined' && module.exports) {
    // Node.js / CommonJS
    module.exports = {
      waitForElement,
      queryResilient,
      waitForClickable,
      findByRelation,
      logUiChangeWarning
    };
  } else if (typeof define === 'function' && define.amd) {
    // AMD / RequireJS
    define([], function() {
      return {
        waitForElement,
        queryResilient,
        waitForClickable,
        findByRelation,
        logUiChangeWarning
      };
    });
  } else {
    // Browser global
    global.DomHelper = {
      waitForElement,
      queryResilient,
      waitForClickable,
      findByRelation,
      logUiChangeWarning
    };
  }

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
