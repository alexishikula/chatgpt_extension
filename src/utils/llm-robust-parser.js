/**
 * LLM Robust Parser
 * 
 * A multi-layered parsing system designed to handle imperfect, malformed, 
 * or unexpected output from LLMs. This system compensates for common AI 
 * formatting errors, syntax mistakes, and semantic variations.
 * 
 * Architecture:
 * Layer 1: Syntax Repair - Fixes JSON structure issues
 * Layer 2: Semantic Normalization - Maps variations to standard values
 * Layer 3: Intent Extraction - Recovers data from broken formats
 * Layer 4: Graceful Degradation - Safe fallbacks when all else fails
 */

const LlmRobustParser = {
  // Standard value mappings for normalization
  STATUS_MAP: {
    'COMPLETE': 'COMPLETE',
    'COMPLETED': 'COMPLETE',
    'DONE': 'COMPLETE',
    'FINISHED': 'COMPLETE',
    'SUCCESS': 'COMPLETE',
    'FAILED': 'FAILED',
    'FAIL': 'FAILED',
    'FAILURE': 'FAILED',
    'ERROR': 'FAILED',
    'IN_PROGRESS': 'IN_PROGRESS',
    'INPROGRESS': 'IN_PROGRESS',
    'WORKING': 'IN_PROGRESS',
    'PENDING': 'PENDING',
    'WAITING': 'PENDING',
    'ESCALATION_REQUIRED': 'ESCALATION_REQUIRED',
    'ESCALATE': 'ESCALATION_REQUIRED',
    'OWNER_ACTION_REQUIRED': 'OWNER_ACTION_REQUIRED',
    'OWNER_ACTION': 'OWNER_ACTION_REQUIRED',
    'HUMAN_INPUT': 'OWNER_ACTION_REQUIRED'
  },

  ACTION_MAP: {
    'RETURN_TO_PM': 'RETURN_TO_PM',
    'RETURN': 'RETURN_TO_PM',
    'SEND_BACK': 'RETURN_TO_PM',
    'BACK_TO_PM': 'RETURN_TO_PM',
    'PM_REVIEW': 'RETURN_TO_PM',
    'REVIEW': 'RETURN_TO_PM',
    'SUBMIT': 'RETURN_TO_PM',
    'ASSIGN': 'ASSIGN_TO_AGENT',
    'ASSIGN_TO': 'ASSIGN_TO_AGENT',
    'SEND_TO': 'ASSIGN_TO_AGENT',
    'FORWARD_TO': 'ASSIGN_TO_AGENT',
    'DELEGATE': 'ASSIGN_TO_AGENT'
  },

  /**
   * Main entry point - attempts to parse LLM output through all layers
   * @param {string} rawText - Raw text output from LLM
   * @returns {Object} - Parsed result with success flag and data/errors
   */
  parse(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return this.handleParseFailure('INVALID_INPUT', { rawText });
    }

    const trimmedText = rawText.trim();
    
    // Layer 1: Syntax Repair
    const repairedJson = this.repairJsonString(trimmedText);
    if (repairedJson) {
      try {
        let parsed = JSON.parse(repairedJson);
        
        // Layer 2: Semantic Normalization
        parsed = this.normalizeValues(parsed);
        
        // Validate required fields
        const validation = this.validateStructure(parsed);
        if (validation.valid) {
          return {
            success: true,
            data: parsed,
            layer: 'LAYER_2_NORMALIZATION',
            warnings: validation.warnings || []
          };
        }
        
        // If validation fails but structure is mostly there, try Layer 3
        return this.attemptIntentExtraction(trimmedText, parsed);
        
      } catch (parseError) {
        // JSON parsed but failed normalization/validation, try Layer 3
        return this.attemptIntentExtraction(trimmedText);
      }
    }
    
    // Layer 1 failed, go straight to Layer 3
    return this.attemptIntentExtraction(trimmedText);
  },

  /**
   * Layer 1: Syntax Repair
   * Fixes common JSON structural issues
   * @param {string} text - Raw text
   * @returns {string|null} - Repaired JSON string or null if unfixable
   */
  repairJsonString(text) {
    let cleaned = text;
    
    // Remove markdown code blocks
    cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    
    // Remove common wrapper text
    cleaned = cleaned.replace(/^(here is the result|result|output|response):?\s*/i, '');
    
    // Trim whitespace
    cleaned = cleaned.trim();
    
    // Fix trailing commas before closing braces/brackets
    cleaned = cleaned.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    
    // Fix unquoted keys (simple cases)
    cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    
    // Convert single quotes to double quotes (carefully)
    // Only replace quotes that are likely string delimiters
    cleaned = cleaned.replace(/'/g, '"');
    
    // Fix missing colons (rare but happens)
    cleaned = cleaned.replace(/"\s*"([^"]+)"/g, '":"$1"');
    
    // Handle truncated JSON - try to close open structures
    const openBraces = (cleaned.match(/{/g) || []).length;
    const closeBraces = (cleaned.match(/}/g) || []).length;
    const openBrackets = (cleaned.match(/\[/g) || []).length;
    const closeBrackets = (cleaned.match(/]/g) || []).length;
    
    if (openBraces > closeBraces) {
      cleaned += '}'.repeat(openBraces - closeBraces);
    }
    if (openBrackets > closeBrackets) {
      cleaned += ']'.repeat(openBrackets - closeBrackets);
    }
    
    // Basic validation - must start with { or [
    if (!/^\s*[\[{]/.test(cleaned)) {
      return null;
    }
    
    return cleaned;
  },

  /**
   * Layer 2: Semantic Normalization
   * Maps variations to standard values
   * @param {Object} obj - Parsed JSON object
   * @returns {Object} - Normalized object
   */
  normalizeValues(obj) {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }
    
    const normalized = { ...obj };
    
    // Normalize status field
    if (normalized.status) {
      const upperStatus = String(normalized.status).toUpperCase().trim();
      normalized.status = this.STATUS_MAP[upperStatus] || normalized.status;
    }
    
    // Normalize action field
    if (normalized.action) {
      const upperAction = String(normalized.action).toUpperCase().trim();
      normalized.action = this.ACTION_MAP[upperAction] || normalized.action;
    }
    
    // Normalize agent_id variations
    if (normalized.agentId && !normalized.agent_id) {
      normalized.agent_id = normalized.agentId;
      delete normalized.agentId;
    }
    
    if (normalized.agentID && !normalized.agent_id) {
      normalized.agent_id = normalized.agentID;
      delete normalized.agentID;
    }
    
    // Normalize task_id variations
    if (normalized.taskId && !normalized.task_id) {
      normalized.task_id = normalized.taskId;
      delete normalized.taskId;
    }
    
    if (normalized.taskID && !normalized.task_id) {
      normalized.task_id = normalized.taskID;
      delete normalized.taskID;
    }
    
    // Normalize message/reason fields
    if (normalized.message && !normalized.reason) {
      normalized.reason = normalized.message;
    }
    if (normalized.reason && !normalized.message) {
      normalized.message = normalized.reason;
    }
    
    return normalized;
  },

  /**
   * Validate basic structure requirements
   * @param {Object} obj - Parsed object
   * @returns {Object} - Validation result
   */
  validateStructure(obj) {
    const warnings = [];
    
    if (!obj.status && !obj.action) {
      return {
        valid: false,
        error: 'Missing required field: status or action',
        warnings
      };
    }
    
    // Check for action-specific requirements
    if (obj.action === 'ASSIGN_TO_AGENT' && !obj.agent_id) {
      warnings.push('Action ASSIGN_TO_AGENT missing agent_id');
    }
    
    return {
      valid: true,
      warnings
    };
  },

  /**
   * Layer 3: Intent Extraction
   * Attempts to extract meaning from malformed or non-JSON text
   * @param {string} text - Raw or partially parsed text
   * @param {Object} partialData - Any data already extracted
   * @returns {Object} - Extraction result
   */
  attemptIntentExtraction(text, partialData = {}) {
    const extracted = { ...partialData };
    let foundIntent = false;
    
    // Pattern 1: Status keywords anywhere in text
    const statusPatterns = [
      { regex: /\b(COMPLET(E|ED|ION)|DONE|FINISHED|SUCCESS)\b/i, value: 'COMPLETE' },
      { regex: /\b(FAIL(ED|URE)?|ERROR)\b/i, value: 'FAILED' },
      { regex: /\b(IN\s*PROGRESS|WORKING|PENDING)\b/i, value: 'IN_PROGRESS' },
      { regex: /\b(ESCALAT(ION|E))\b/i, value: 'ESCALATION_REQUIRED' },
      { regex: /\b(OWNER\s*(ACTION|INPUT)|HUMAN\s*INPUT)\b/i, value: 'OWNER_ACTION_REQUIRED' }
    ];
    
    for (const pattern of statusPatterns) {
      if (pattern.regex.test(text) && !extracted.status) {
        extracted.status = pattern.value;
        foundIntent = true;
        break;
      }
    }
    
    // Pattern 2: Action keywords
    const actionPatterns = [
      { regex: /\b(RETURN\s*(TO\s*PM)?|SEND\s*BACK|BACK\s*TO\s*PM)\b/i, value: 'RETURN_TO_PM' },
      { regex: /\b(ASSIGN\s*(TO)?|SEND\s*TO|FORWARD\s*TO|DELEGATE)\b/i, value: 'ASSIGN_TO_AGENT' }
    ];
    
    for (const pattern of actionPatterns) {
      if (pattern.regex.test(text) && !extracted.action) {
        extracted.action = pattern.value;
        foundIntent = true;
        break;
      }
    }
    
    // Pattern 3: Extract agent references
    const agentMatch = text.match(/agent[_\s-]*(?:id)?[:\s]*([A-Za-z0-9_-]+)/i);
    if (agentMatch && !extracted.agent_id) {
      extracted.agent_id = agentMatch[1];
    }
    
    // Pattern 4: Extract file links (sandbox paths)
    const fileMatches = text.match(/\/mnt\/data\/[^\s"'<>]+/g);
    if (fileMatches && fileMatches.length > 0) {
      extracted.files = extracted.files || [];
      for (const file of fileMatches) {
        if (!extracted.files.includes(file)) {
          extracted.files.push(file);
        }
      }
    }
    
    // Pattern 5: Extract quoted text as reason/message
    const quotedMatch = text.match(/"([^"]{10,})"/);
    if (quotedMatch && !extracted.reason) {
      extracted.reason = quotedMatch[1];
    }
    
    if (foundIntent || extracted.status || extracted.action) {
      // Try to normalize what we found
      const normalized = this.normalizeValues(extracted);
      
      return {
        success: true,
        data: normalized,
        layer: 'LAYER_3_INTENT_EXTRACTION',
        warnings: ['Parsed from unstructured text - verify accuracy']
      };
    }
    
    // Layer 3 failed, go to Layer 4
    return this.handleParseFailure('INTENT_EXTRACTION_FAILED', { 
      rawText: text, 
      partialData: extracted 
    });
  },

  /**
   * Layer 4: Graceful Degradation
   * Handles complete parse failures safely
   * @param {string} errorCode - Error type
   * @param {Object} context - Error context
   * @returns {Object} - Safe error response
   */
  handleParseFailure(errorCode, context) {
    console.warn('[LLM Robust Parser] Parse failure:', errorCode, context);
    
    return {
      success: false,
      error: {
        code: errorCode,
        message: this.getErrorMessage(errorCode),
        rawText: context?.rawText?.substring(0, 500) || '', // Limit size
        timestamp: new Date().toISOString()
      },
      layer: 'LAYER_4_DEGRADATION',
      suggestions: this.getSuggestions(errorCode)
    };
  },

  /**
   * Get human-readable error messages
   */
  getErrorMessage(code) {
    const messages = {
      'INVALID_INPUT': 'Input was null, undefined, or not a string',
      'INTENT_EXTRACTION_FAILED': 'Could not determine intent from the text',
      'MISSING_REQUIRED_FIELDS': 'Required fields (status or action) not found',
      'UNKNOWN_ACTION': 'Unrecognized action type',
      'MALFORMED_STRUCTURE': 'Text structure too damaged to repair'
    };
    return messages[code] || 'Unknown parsing error';
  },

  /**
   * Get suggestions for fixing the issue
   */
  getSuggestions(code) {
    const suggestions = {
      'INVALID_INPUT': ['Ensure the LLM output is captured correctly', 'Check for empty responses'],
      'INTENT_EXTRACTION_FAILED': [
        'Review the LLM prompt for clearer instructions',
        'Add more examples to the prompt',
        'Request structured JSON output explicitly'
      ],
      'MISSING_REQUIRED_FIELDS': [
        'Prompt should require "status" or "action" field',
        'Add validation examples to the prompt'
      ]
    };
    return suggestions[code] || ['Review LLM output format'];
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LlmRobustParser;
}
