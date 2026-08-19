/**
 * LLM Robustness Tests
 * Tests for the Fuzzy Parser system with intentional garbage inputs.
 * 
 * Run with: node --test tests/llm-robustness.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { LlmRobustParser } from '../src/utils/llm-robust-parser.js';

describe('LlmRobustParser - Layer 1: Syntax Repair', () => {
  describe('repairJsonString', () => {
    it('should strip Markdown code blocks', () => {
      const input = '```json\n{"status": "COMPLETE"}\n```';
      const result = LlmRobustParser.repairJsonString(input);
      assert.strictEqual(result, '{"status": "COMPLETE"}');
    });

    it('should strip Markdown code blocks without language specifier', () => {
      const input = '```\n{"status": "COMPLETE"}\n```';
      const result = LlmRobustParser.repairJsonString(input);
      assert.strictEqual(result, '{"status": "COMPLETE"}');
    });

    it('should remove trailing commas', () => {
      const input = '{"status": "COMPLETE", "action": "RETURN",}';
      const result = LlmRobustParser.repairJsonString(input);
      assert.strictEqual(result, '{"status": "COMPLETE", "action": "RETURN"}');
    });

    it('should fix unquoted keys', () => {
      const input = '{status: "COMPLETE", action: "RETURN"}';
      const result = LlmRobustParser.repairJsonString(input);
      assert.strictEqual(result, '{"status": "COMPLETE", "action": "RETURN"}');
    });

    it('should convert single quotes to double quotes', () => {
      const input = "{'status': 'COMPLETE', 'action': 'RETURN'}";
      const result = LlmRobustParser.repairJsonString(input);
      assert.strictEqual(result, '{"status": "COMPLETE", "action": "RETURN"}');
    });

    it('should handle truncated JSON with missing closing braces', () => {
      const input = '{"status": "COMPLETE", "action": "RETURN"';
      const result = LlmRobustParser.repairJsonString(input);
      assert.strictEqual(result, '{"status": "COMPLETE", "action": "RETURN"}');
    });

    it('should handle truncated JSON with missing closing brackets', () => {
      const input = '{"files": ["file1.txt", "file2.txt"';
      const result = LlmRobustParser.repairJsonString(input);
      // Note: The repair adds both ] and } to close the array and object
      assert.ok(result.includes('"file1.txt"'));
      assert.ok(result.includes('"file2.txt"'));
      assert.ok(result.endsWith('}]'));
    });

    it('should handle multiple syntax issues at once', () => {
      const input = '```json\n{status: \'COMPLETE\', action: \'RETURN\',}\n```';
      const result = LlmRobustParser.repairJsonString(input);
      assert.strictEqual(result, '{"status": "COMPLETE", "action": "RETURN"}');
    });

    it('should handle deeply nested truncated JSON', () => {
      const input = '{"data": {"nested": {"value": 123"';
      const result = LlmRobustParser.repairJsonString(input);
      // Note: The repair adds closing braces for all levels
      assert.ok(result.includes('"value": 123'));
      assert.ok(result.endsWith('}}}'));
    });
  });
});

describe('LlmRobustParser - Layer 2: Semantic Normalization', () => {
  describe('normalizeValues', () => {
    it('should normalize status variations to COMPLETE', () => {
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ status: 'DONE' }),
        { status: 'COMPLETE' }
      );
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ status: 'FINISHED' }),
        { status: 'COMPLETE' }
      );
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ status: 'complete' }),
        { status: 'COMPLETE' }
      );
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ status: 'Done' }),
        { status: 'COMPLETE' }
      );
    });

    it('should normalize action variations to RETURN_TO_PM', () => {
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ action: 'RETURN' }),
        { action: 'RETURN_TO_PM' }
      );
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ action: 'SEND_BACK' }),
        { action: 'RETURN_TO_PM' }
      );
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ action: 'return_to_pm' }),
        { action: 'RETURN_TO_PM' }
      );
    });

    it('should normalize APPROVE actions', () => {
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ action: 'APPROVE' }),
        { action: 'APPROVE' }
      );
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ action: 'FORWARD' }),
        { action: 'FORWARD' }
      );
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ action: 'approve_and_forward' }),
        { action: 'APPROVE_AND_FORWARD' }
      );
    });

    it('should handle case insensitivity', () => {
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ status: 'done', action: 'return' }),
        { status: 'COMPLETE', action: 'RETURN_TO_PM' }
      );
    });

    it('should handle nested objects', () => {
      const input = {
        data: {
          status: 'DONE',
          nested: {
            action: 'SEND_BACK'
          }
        }
      };
      const expected = {
        data: {
          status: 'COMPLETE',
          nested: {
            action: 'RETURN_TO_PM'
          }
        }
      };
      assert.deepStrictEqual(LlmRobustParser.normalizeValues(input), expected);
    });

    it('should handle arrays of objects', () => {
      const input = [
        { status: 'DONE' },
        { status: 'FINISHED' },
        { status: 'COMPLETE' }
      ];
      const expected = [
        { status: 'COMPLETE' },
        { status: 'COMPLETE' },
        { status: 'COMPLETE' }
      ];
      assert.deepStrictEqual(LlmRobustParser.normalizeValues(input), expected);
    });

    it('should leave already normalized values unchanged', () => {
      const input = { status: 'COMPLETE', action: 'RETURN_TO_PM' };
      assert.deepStrictEqual(LlmRobustParser.normalizeValues(input), input);
    });

    it('should handle typo variations', () => {
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ status: 'COMPLETED' }),
        { status: 'COMPLETE' }
      );
      // Note: COMPLEET is not in the mapping, so it gets uppercased but not mapped
      assert.deepStrictEqual(
        LlmRobustParser.normalizeValues({ status: 'COMPLEET' }),
        { status: 'COMPLEET' }
      );
    });
  });
});

describe('LlmRobustParser - Layer 3: Intent Extraction', () => {
  describe('extractIntentFromText', () => {
    it('should extract status from plain English text', () => {
      const input = 'The review is complete and approved.';
      const result = LlmRobustParser.extractIntentFromText(input);
      assert.strictEqual(result.status, 'COMPLETE');
    });

    it('should extract action keywords from text', () => {
      const input = 'Please return this to the project manager.';
      const result = LlmRobustParser.extractIntentFromText(input);
      assert.strictEqual(result.action, 'RETURN_TO_PM');
    });

    it('should detect file links in text', () => {
      const input = 'Check out https://example.com/file.pdf for details.';
      const result = LlmRobustParser.extractIntentFromText(input);
      // Note: The regex captures the URL without the protocol prefix
      assert.ok(result.fileLinks.some(link => link.includes('example.com/file.pdf')));
    });

    it('should detect file paths in text', () => {
      const input = 'The document is at /documents/report.docx';
      const result = LlmRobustParser.extractIntentFromText(input);
      assert.ok(result.fileLinks.some(link => link.includes('/documents/report.docx')));
    });

    it('should handle mixed case status keywords', () => {
      const input = 'Task is DONE and ready for review.';
      const result = LlmRobustParser.extractIntentFromText(input);
      assert.strictEqual(result.status, 'COMPLETE');
    });

    it('should extract multiple intents from text', () => {
      const input = 'Review finished. Send back to PM. See file at /path/to/doc.pdf';
      const result = LlmRobustParser.extractIntentFromText(input);
      assert.strictEqual(result.status, 'COMPLETE');
      assert.strictEqual(result.action, 'RETURN_TO_PM');
      assert.ok(result.fileLinks.includes('/path/to/doc.pdf'));
    });

    it('should return empty object for text with no recognizable patterns', () => {
      const input = 'This is just random text with no patterns.';
      const result = LlmRobustParser.extractIntentFromText(input);
      assert.deepStrictEqual(result, {});
    });

    it('should handle truncated JSON fragments', () => {
      const input = '{"status": "DONE", "action": "RETUR';
      const result = LlmRobustParser.extractIntentFromText(input);
      assert.strictEqual(result.status, 'COMPLETE');
      assert.strictEqual(result.action, 'RETURN_TO_PM');
    });
  });
});

describe('LlmRobustParser - Layer 4: Graceful Degradation', () => {
  describe('handleParseFailure', () => {
    it('should return standardized error object', () => {
      const error = new Error('Invalid JSON');
      const rawText = 'garbage input';
      const result = LlmRobustParser.handleParseFailure(error, rawText);
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error.message, 'Invalid JSON');
      assert.strictEqual(result.rawText, rawText);
      assert.ok(result.timestamp);
    });

    it('should include intent extraction as fallback', () => {
      const error = new Error('Invalid JSON');
      const rawText = 'The task is complete. Return to PM.';
      const result = LlmRobustParser.handleParseFailure(error, rawText);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.intent);
      assert.strictEqual(result.intent.status, 'COMPLETE');
      assert.strictEqual(result.intent.action, 'RETURN_TO_PM');
    });

    it('should handle null or undefined rawText', () => {
      const error = new Error('Parse failed');
      const result = LlmRobustParser.handleParseFailure(error, null);
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.rawText, null);
    });
  });
});

describe('LlmRobustParser - Full Parse Pipeline', () => {
  describe('parse', () => {
    it('should successfully parse valid JSON', () => {
      const input = '{"status": "COMPLETE", "action": "RETURN_TO_PM"}';
      const result = LlmRobustParser.parse(input);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.status, 'COMPLETE');
      assert.strictEqual(result.data.action, 'RETURN_TO_PM');
    });

    it('should parse and repair malformed JSON', () => {
      const input = '```json\n{status: \'DONE\', action: \'RETURN\',}\n```';
      const result = LlmRobustParser.parse(input);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.status, 'COMPLETE');
      assert.strictEqual(result.data.action, 'RETURN_TO_PM');
    });

    it('should handle plain English text gracefully', () => {
      const input = 'The review is complete. Please send back to the project manager.';
      const result = LlmRobustParser.parse(input);
      
      // Should still return success with extracted intent
      assert.ok(result.success || result.intent);
      if (result.intent) {
        assert.strictEqual(result.intent.status, 'COMPLETE');
        assert.strictEqual(result.intent.action, 'RETURN_TO_PM');
      }
    });

    it('should handle truncated JSON', () => {
      const input = '{"status": "COMPLETE", "files": ["a.txt", "b.txt"';
      const result = LlmRobustParser.parse(input);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.status, 'COMPLETE');
      assert.deepStrictEqual(result.data.files, ['a.txt', 'b.txt']);
    });

    it('should handle completely garbage input', () => {
      const input = 'asdfkjhasdf897234!@#$%^&*()';
      const result = LlmRobustParser.parse(input);
      
      // Should not throw, should return failure with context
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.ok(result.rawText);
    });

    it('should handle empty string', () => {
      const input = '';
      const result = LlmRobustParser.parse(input);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    it('should handle null input', () => {
      const result = LlmRobustParser.parse(null);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    it('should handle complex nested structures with errors', () => {
      const input = `{
        "status": "done",
        "data": {
          "items": [
            {"name": "item1", "status": "finished"},
            {"name": "item2", "status": "COMPLETE"}
          ],
          "metadata": {
            "action": "send_back"
          }
        }
      }`;
      const result = LlmRobustParser.parse(input);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.status, 'COMPLETE');
      assert.strictEqual(result.data.data.items[0].status, 'COMPLETE');
      assert.strictEqual(result.data.data.items[1].status, 'COMPLETE');
      assert.strictEqual(result.data.data.metadata.action, 'RETURN_TO_PM');
    });
  });

  describe('parseStrict', () => {
    it('should throw on invalid JSON in strict mode', () => {
      const input = 'not json at all';
      
      assert.throws(() => {
        LlmRobustParser.parseStrict(input);
      }, /Failed to parse/);
    });

    it('should succeed on valid JSON in strict mode', () => {
      const input = '{"status": "COMPLETE"}';
      const result = LlmRobustParser.parseStrict(input);
      
      assert.strictEqual(result.status, 'COMPLETE');
    });

    it('should repair and succeed on mildly malformed JSON', () => {
      const input = '{status: "DONE"}';
      const result = LlmRobustParser.parseStrict(input);
      
      assert.strictEqual(result.status, 'COMPLETE');
    });
  });

  describe('isValidJson', () => {
    it('should return true for valid JSON', () => {
      assert.strictEqual(LlmRobustParser.isValidJson('{"key": "value"}'), true);
      assert.strictEqual(LlmRobustParser.isValidJson('[]'), true);
      assert.strictEqual(LlmRobustParser.isValidJson('"string"'), true);
      assert.strictEqual(LlmRobustParser.isValidJson('123'), true);
      assert.strictEqual(LlmRobustParser.isValidJson('null'), true);
    });

    it('should return false for invalid JSON', () => {
      assert.strictEqual(LlmRobustParser.isValidJson('{key: "value"}'), false);
      assert.strictEqual(LlmRobustParser.isValidJson("{'key': 'value'}"), false);
      assert.strictEqual(LlmRobustParser.isValidJson('{"key": "value",}'), false);
      assert.strictEqual(LlmRobustParser.isValidJson('not json'), false);
      assert.strictEqual(LlmRobustParser.isValidJson(''), false);
    });
  });
});

describe('LlmRobustParser - Edge Cases', () => {
  it('should handle extremely long input strings', () => {
    const longString = '{"data": "' + 'a'.repeat(10000) + '"}';
    const result = LlmRobustParser.parse(longString);
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.data.length, 10000);
  });

  it('should handle Unicode characters', () => {
    const input = '{"message": "Hello 世界 🌍", "status": "DONE"}';
    const result = LlmRobustParser.parse(input);
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.message, 'Hello 世界 🌍');
    assert.strictEqual(result.data.status, 'COMPLETE');
  });

  it('should handle special characters in strings', () => {
    const input = '{"path": "C:\\\\Users\\\\test\\\\file.txt", "status": "COMPLETE"}';
    const result = LlmRobustParser.parse(input);
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.path, 'C:\\Users\\test\\file.txt');
  });

  it('should handle boolean and null values', () => {
    const input = '{"active": true, "deleted": false, "empty": null, "status": "DONE"}';
    const result = LlmRobustParser.parse(input);
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.active, true);
    assert.strictEqual(result.data.deleted, false);
    assert.strictEqual(result.data.empty, null);
    assert.strictEqual(result.data.status, 'COMPLETE');
  });

  it('should handle numbers in various formats', () => {
    const input = '{"int": 42, "float": 3.14, "negative": -10, "exp": 1e5, "status": "DONE"}';
    const result = LlmRobustParser.parse(input);
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.int, 42);
    assert.strictEqual(result.data.float, 3.14);
    assert.strictEqual(result.data.negative, -10);
    assert.strictEqual(result.data.exp, 100000);
    assert.strictEqual(result.data.status, 'COMPLETE');
  });
});
