/**
 * LLM Robust Parser
 * A fuzzy parser system for handling imperfect JSON responses from LLMs.
 * Implements a 4-layer approach: Syntax Repair, Semantic Normalization,
 * Intent Extraction, and Graceful Degradation.
 */

/**
 * Layer 1: Syntax Repair (The "Cleaner")
 * Repairs common JSON syntax issues before parsing.
 * @param {string} rawText - The raw text input that may contain JSON
 * @returns {string} - Cleaned JSON string ready for parsing
 */
function repairJsonString(rawText) {
  if (typeof rawText !== 'string') {
    return rawText;
  }

  let cleaned = rawText.trim();

  // Strip Markdown code blocks (```json ... ``` or ``` ... ```)
  cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();

  // Remove trailing commas before closing braces/brackets
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  // Fix unquoted keys (e.g., {key: "value"} -> {"key": "value"})
  cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

  // Convert single quotes to double quotes (handling escaped quotes properly)
  // Simple approach: replace standalone single quotes used as string delimiters
  cleaned = cleaned.replace(/'([^']*)'/g, '"$1"');

  // Handle truncated JSON by adding missing closing brackets/braces
  // Track the stack of open brackets/braces to close them in correct order
  const stack = [];
  for (const char of cleaned) {
    if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      if (stack.length > 0) {
        const lastOpen = stack[stack.length - 1];
        if ((lastOpen === '{' && char === '}') || (lastOpen === '[' && char === ']')) {
          stack.pop();
        }
      }
    }
  }
  
  // Close any remaining open brackets/braces in reverse order
  while (stack.length > 0) {
    const lastOpen = stack.pop();
    if (lastOpen === '{') {
      cleaned += '}';
    } else if (lastOpen === '[') {
      cleaned += ']';
    }
  }

  return cleaned;
}

/**
 * Layer 2: Semantic Normalization (The "Translator")
 * Normalizes parsed object values to standard formats.
 * @param {object} parsedObject - The parsed JSON object
 * @returns {object} - Normalized object with standardized values
 */
function normalizeValues(parsedObject) {
  if (!parsedObject || typeof parsedObject !== 'object') {
    return parsedObject;
  }

  // Deep clone to avoid mutating the original
  const normalized = JSON.parse(JSON.stringify(parsedObject));

  // Status mapping (case-insensitive)
  const statusMap = {
    complete: 'COMPLETE',
    done: 'COMPLETE',
    finished: 'COMPLETE',
    completed: 'COMPLETE',
    in_progress: 'IN_PROGRESS',
    inprogress: 'IN_PROGRESS',
    'in progress': 'IN_PROGRESS',
    pending: 'PENDING',
    waiting: 'PENDING',
    todo: 'TODO',
    'to_do': 'TODO',
    blocked: 'BLOCKED',
    cancelled: 'CANCELLED',
    canceled: 'CANCELLED'
  };

  // Action mapping
  const actionMap = {
    return: 'RETURN_TO_PM',
    send_back: 'RETURN_TO_PM',
    sendback: 'RETURN_TO_PM',
    'send back': 'RETURN_TO_PM',
    approve: 'APPROVE',
    approved: 'APPROVE',
    reject: 'REJECT',
    rejected: 'REJECT',
    forward: 'FORWARD',
    escalate: 'ESCALATE'
  };

  // Recursive normalization function
  function normalizeValue(key, value) {
    if (typeof value === 'string') {
      const lowerValue = value.toLowerCase().trim();

      // Check for status values
      if (['status', 'state', 'taskStatus'].includes(key.toLowerCase())) {
        return statusMap[lowerValue] || value.toUpperCase();
      }

      // Check for action values
      if (['action', 'nextAction', 'decision'].includes(key.toLowerCase())) {
        return actionMap[lowerValue] || value.toUpperCase();
      }

      // General case-insensitive normalization for known fields
      return value;
    }

    if (typeof value === 'object' && value !== null) {
      return normalizeObject(value);
    }

    return value;
  }

  function normalizeObject(obj) {
    if (Array.isArray(obj)) {
      return obj.map((item, index) =>
        typeof item === 'object' ? normalizeObject(item) : normalizeValue('', item)
      );
    }

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = normalizeValue(key, value);
    }
    return result;
  }

  return normalizeObject(normalized);
}

/**
 * Layer 3: Intent Extraction (The "Detective")
 * Extracts structured intent from plain text when JSON parsing fails.
 * @param {string} rawText - The raw text input
 * @returns {object|null} - Extracted intent object or null if nothing found
 */
function extractIntentFromText(rawText) {
  if (typeof rawText !== 'string') {
    return null;
  }

  const text = rawText.toLowerCase();
  const intent = {
    status: null,
    action: null,
    fileLinks: [],
    confidence: 'low',
    source: 'intent_extraction'
  };

  // Regex patterns for status detection (including partial matches)
  const statusPatterns = [
    /\b(complete|completed|done|finished)\b/i,
    /\b(in\s*progress|inprogress|processing)\b/i,
    /\b(pending|waiting|todo|to-do)\b/i,
    /\b(blocked|stuck|issue)\b/i,
    /\b(cancelled|canceled|aborted)\b/i,
    // Partial matches for truncated text
    /(complete|complet|comple|compl|comp)/i,
    /(done|don|do)/i,
    /(finished|finish|finis|fini|fin)/i
  ];

  // Regex patterns for action detection (including partial matches)
  const actionPatterns = [
    /\b(return|send\s*back)\b/i,
    /\b(approve|approved|accept)\b/i,
    /\b(reject|rejected|decline)\b/i,
    /\b(forward|escalate)\b/i,
    // Partial matches for truncated text
    /(return|retur|retu|ret|re)/i,
    /(send\s*back|send\s*bac|send\s*ba|send\s*b)/i,
    /(approve|approv|appro|appr|app)/i
  ];

  // File link detection (URLs, file paths)
  const linkPatterns = [
    /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi,
    /[a-zA-Z]:\\[^\s<>"{}|\\^`\[\]]+/g,
    /\/[a-zA-Z0-9._/-]+/g
  ];

  // Extract status
  for (const pattern of statusPatterns) {
    const match = rawText.match(pattern);
    if (match) {
      const matchedText = match[0].toLowerCase().trim();
      if (/complete|done|finished/.test(matchedText)) {
        intent.status = 'COMPLETE';
      } else if (/progress|processing/.test(matchedText)) {
        intent.status = 'IN_PROGRESS';
      } else if (/pending|waiting|todo/.test(matchedText)) {
        intent.status = 'PENDING';
      } else if (/blocked|stuck|issue/.test(matchedText)) {
        intent.status = 'BLOCKED';
      } else if (/cancelled|canceled|aborted/.test(matchedText)) {
        intent.status = 'CANCELLED';
      }
      break;
    }
  }

  // Extract action
  for (const pattern of actionPatterns) {
    const match = rawText.match(pattern);
    if (match) {
      const matchedText = match[0].toLowerCase().trim();
      if (/return|retur|retu|ret|re|send\s*back/.test(matchedText)) {
        intent.action = 'RETURN_TO_PM';
      } else if (/approve|approv|appro|appr|app|accept/.test(matchedText)) {
        intent.action = 'APPROVE';
      } else if (/reject|rejected|decline/.test(matchedText)) {
        intent.action = 'REJECT';
      } else if (/forward|escalate/.test(matchedText)) {
        intent.action = 'ESCALATE';
      }
      break;
    }
  }

  // Extract file links
  for (const pattern of linkPatterns) {
    const matches = rawText.match(pattern);
    if (matches) {
      intent.fileLinks = [...new Set(matches)]; // Remove duplicates
    }
  }

  // Return null if no meaningful intent was extracted
  if (!intent.status && !intent.action && intent.fileLinks.length === 0) {
    return null;
  }

  return intent;
}

/**
 * Layer 4: Graceful Degradation (The "Safety Net")
 * Handles parse failures with standardized error objects.
 * @param {Error} error - The caught error
 * @param {string} rawText - The original raw text that caused the failure
 * @param {string} stage - The stage where the failure occurred
 * @returns {object} - Standardized error payload
 */
function handleParseFailure(error, rawText, stage) {
  const errorPayload = {
    success: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      stage: stage || 'unknown',
      timestamp: new Date().toISOString()
    },
    rawText: rawText,
    intent: null
  };

  // Attempt intent extraction as final fallback
  try {
    const intent = extractIntentFromText(rawText);
    if (intent && Object.keys(intent).length > 0) {
      errorPayload.intent = intent;
    }
  } catch (extractionError) {
    // Silently fail - we're already in error handling
    console.warn('Intent extraction also failed:', extractionError);
  }

  // Log the error for debugging
  console.error('[LlmRobustParser] Parse failure:', errorPayload);

  return errorPayload;
}

/**
 * Main parser class combining all layers
 */
class LlmRobustParser {
  /**
   * Layer 1: Syntax Repair (The "Cleaner")
   * Repairs common JSON syntax issues before parsing.
   * @param {string} rawText - The raw text input that may contain JSON
   * @returns {string} - Cleaned JSON string ready for parsing
   */
  static repairJsonString(rawText) {
    return repairJsonString(rawText);
  }

  /**
   * Layer 2: Semantic Normalization (The "Translator")
   * Normalizes parsed object values to standard formats.
   * @param {object} parsedObject - The parsed JSON object
   * @returns {object} - Normalized object with standardized values
   */
  static normalizeValues(parsedObject) {
    return normalizeValues(parsedObject);
  }

  /**
   * Layer 3: Intent Extraction (The "Detective")
   * Extracts structured intent from plain text when JSON parsing fails.
   * @param {string} rawText - The raw text input
   * @returns {object|null} - Extracted intent object or null if nothing found
   */
  static extractIntentFromText(rawText) {
    return extractIntentFromText(rawText) || {};
  }

  /**
   * Layer 4: Graceful Degradation (The "Safety Net")
   * Handles parse failures with standardized error objects.
   * @param {Error} error - The caught error
   * @param {string} rawText - The original raw text that caused the failure
   * @param {string} stage - The stage where the failure occurred
   * @returns {object} - Standardized error payload
   */
  static handleParseFailure(error, rawText, stage) {
    return handleParseFailure(error, rawText, stage);
  }

  /**
   * Parse raw text into a structured object with robust error handling.
   * @param {string} rawText - The raw text input from LLM
   * @returns {object} - Parse result with success flag and data/error
   */
  static parse(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return handleParseFailure(
        new Error('Invalid input: expected a non-empty string'),
        rawText,
        'validation'
      );
    }

    try {
      // Layer 1: Syntax Repair
      const repairedJson = repairJsonString(rawText);

      // Attempt JSON parsing
      let parsed;
      try {
        parsed = JSON.parse(repairedJson);
      } catch (parseError) {
        // If still failing after repair, try intent extraction
        const intent = extractIntentFromText(rawText);
        if (intent) {
          return {
            success: true,
            data: intent,
            warning: 'Parsed via intent extraction due to JSON parse failure',
            originalError: parseError.message
          };
        }
        throw parseError;
      }

      // Layer 2: Semantic Normalization
      const normalized = normalizeValues(parsed);

      return {
        success: true,
        data: normalized
      };
    } catch (error) {
      // Layer 4: Graceful Degradation
      return handleParseFailure(error, rawText, 'parsing');
    }
  }

  /**
   * Parse with strict mode - throws on any failure
   * @param {string} rawText - The raw text input
   * @returns {object} - Parsed and normalized object
   * @throws {Error} - If parsing fails even after repairs
   */
  static parseStrict(rawText) {
    const result = this.parse(rawText);
    if (!result.success) {
      throw new Error(`Parse failed: ${result.error.message}`);
    }
    return result.data;
  }

  /**
   * Validate if text contains valid JSON structure (without repairs)
   * @param {string} rawText - The raw text to validate
   * @returns {boolean} - True if valid JSON without any repairs needed
   */
  static isValidJson(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return false;
    }
    try {
      // Test the raw text directly without any repairs
      JSON.parse(rawText);
      return true;
    } catch {
      return false;
    }
  }
}

// Export for use in other modules (ES6 and CommonJS)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LlmRobustParser,
    repairJsonString,
    normalizeValues,
    extractIntentFromText,
    handleParseFailure
  };
}

// ES6 module export
export { LlmRobustParser, repairJsonString, normalizeValues, extractIntentFromText, handleParseFailure };

// Also expose globally for browser environments
if (typeof window !== 'undefined') {
  window.LlmRobustParser = LlmRobustParser;
}
