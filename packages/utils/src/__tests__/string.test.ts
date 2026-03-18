/**
 * @arcaai/utils - String Utilities Tests
 *
 * Comprehensive tests for string utility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  capitalize,
  toTitleCase,
  toKebabCase,
  toCamelCase,
  toPascalCase,
  randomString,
  generateUUID,
  removeWhitespace,
  escapeHtml,
} from '../string.js';

describe('string utilities', () => {
  describe('capitalize', () => {
    it('should capitalize the first letter', () => {
      expect(capitalize('hello')).toBe('Hello');
      expect(capitalize('world')).toBe('World');
      expect(capitalize('test')).toBe('Test');
    });

    it('should lowercase the rest of the string', () => {
      expect(capitalize('HELLO')).toBe('Hello');
      expect(capitalize('hELLO')).toBe('Hello');
      expect(capitalize('HeLLo WoRLD')).toBe('Hello world');
    });

    it('should handle empty strings', () => {
      expect(capitalize('')).toBe('');
    });

    it('should handle single characters', () => {
      expect(capitalize('a')).toBe('A');
      expect(capitalize('A')).toBe('A');
    });

    it('should handle strings starting with numbers', () => {
      expect(capitalize('123abc')).toBe('123abc');
    });
  });

  describe('toTitleCase', () => {
    it('should capitalize first letter of each word', () => {
      expect(toTitleCase('hello world')).toBe('Hello World');
      expect(toTitleCase('the quick brown fox')).toBe('The Quick Brown Fox');
    });

    it('should handle single words', () => {
      expect(toTitleCase('hello')).toBe('Hello');
    });

    it('should handle uppercase input', () => {
      expect(toTitleCase('HELLO WORLD')).toBe('Hello World');
    });

    it('should handle mixed case input', () => {
      expect(toTitleCase('hELLO wORLD')).toBe('Hello World');
    });

    it('should handle empty strings', () => {
      expect(toTitleCase('')).toBe('');
    });

    it('should handle multiple spaces', () => {
      expect(toTitleCase('hello  world')).toBe('Hello  World');
    });
  });

  describe('toKebabCase', () => {
    it('should convert camelCase to kebab-case', () => {
      expect(toKebabCase('helloWorld')).toBe('hello-world');
      expect(toKebabCase('thisIsTest')).toBe('this-is-test');
    });

    it('should convert PascalCase to kebab-case', () => {
      expect(toKebabCase('HelloWorld')).toBe('hello-world');
      expect(toKebabCase('ThisIsTest')).toBe('this-is-test');
    });

    it('should convert spaces to hyphens', () => {
      expect(toKebabCase('hello world')).toBe('hello-world');
      expect(toKebabCase('hello  world')).toBe('hello-world');
    });

    it('should convert underscores to hyphens', () => {
      expect(toKebabCase('hello_world')).toBe('hello-world');
      expect(toKebabCase('hello__world')).toBe('hello-world');
    });

    it('should handle already kebab-case strings', () => {
      expect(toKebabCase('hello-world')).toBe('hello-world');
    });

    it('should handle empty strings', () => {
      expect(toKebabCase('')).toBe('');
    });
  });

  describe('toCamelCase', () => {
    it('should convert kebab-case to camelCase', () => {
      expect(toCamelCase('hello-world')).toBe('helloWorld');
      expect(toCamelCase('this-is-a-test')).toBe('thisIsATest');
    });

    it('should convert snake_case to camelCase', () => {
      expect(toCamelCase('hello_world')).toBe('helloWorld');
      expect(toCamelCase('this_is_a_test')).toBe('thisIsATest');
    });

    it('should convert spaces to camelCase', () => {
      expect(toCamelCase('hello world')).toBe('helloWorld');
      expect(toCamelCase('hello  world')).toBe('helloWorld');
    });

    it('should handle already camelCase strings', () => {
      expect(toCamelCase('helloWorld')).toBe('helloWorld');
    });

    it('should lowercase the first character', () => {
      expect(toCamelCase('HelloWorld')).toBe('helloWorld');
    });

    it('should handle empty strings', () => {
      expect(toCamelCase('')).toBe('');
    });
  });

  describe('toPascalCase', () => {
    it('should convert kebab-case to PascalCase', () => {
      expect(toPascalCase('hello-world')).toBe('HelloWorld');
      expect(toPascalCase('this-is-a-test')).toBe('ThisIsATest');
    });

    it('should convert snake_case to PascalCase', () => {
      expect(toPascalCase('hello_world')).toBe('HelloWorld');
      expect(toPascalCase('this_is_a_test')).toBe('ThisIsATest');
    });

    it('should convert spaces to PascalCase', () => {
      expect(toPascalCase('hello world')).toBe('HelloWorld');
    });

    it('should convert camelCase to PascalCase', () => {
      expect(toPascalCase('helloWorld')).toBe('HelloWorld');
    });

    it('should handle already PascalCase strings', () => {
      expect(toPascalCase('HelloWorld')).toBe('HelloWorld');
    });

    it('should handle empty strings', () => {
      expect(toPascalCase('')).toBe('');
    });
  });

  describe('randomString', () => {
    it('should generate string of specified length', () => {
      expect(randomString(10)).toHaveLength(10);
      expect(randomString(5)).toHaveLength(5);
      expect(randomString(100)).toHaveLength(100);
    });

    it('should generate empty string for length 0', () => {
      expect(randomString(0)).toBe('');
    });

    it('should only contain alphanumeric characters', () => {
      const result = randomString(100);
      expect(result).toMatch(/^[A-Za-z0-9]+$/);
    });

    it('should generate different strings on each call', () => {
      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        results.add(randomString(20));
      }
      // Should have high uniqueness (allowing for tiny collision probability)
      expect(results.size).toBeGreaterThan(95);
    });
  });

  describe('generateUUID', () => {
    it('should generate valid UUID v4 format', () => {
      const uuid = generateUUID();
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuid).toMatch(uuidRegex);
    });

    it('should generate unique UUIDs', () => {
      const uuids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        uuids.add(generateUUID());
      }
      expect(uuids.size).toBe(1000);
    });

    it('should have version 4 indicator', () => {
      const uuid = generateUUID();
      expect(uuid.charAt(14)).toBe('4');
    });

    it('should have correct variant bits', () => {
      const uuid = generateUUID();
      const variantChar = uuid.charAt(19);
      expect(['8', '9', 'a', 'b']).toContain(variantChar.toLowerCase());
    });
  });

  describe('removeWhitespace', () => {
    it('should remove all spaces', () => {
      expect(removeWhitespace('hello world')).toBe('helloworld');
      expect(removeWhitespace('hello  world')).toBe('helloworld');
    });

    it('should remove tabs and newlines', () => {
      expect(removeWhitespace('hello\tworld')).toBe('helloworld');
      expect(removeWhitespace('hello\nworld')).toBe('helloworld');
      expect(removeWhitespace('hello\r\nworld')).toBe('helloworld');
    });

    it('should remove mixed whitespace', () => {
      expect(removeWhitespace('  hello \t world \n ')).toBe('helloworld');
    });

    it('should handle strings without whitespace', () => {
      expect(removeWhitespace('helloworld')).toBe('helloworld');
    });

    it('should handle empty strings', () => {
      expect(removeWhitespace('')).toBe('');
    });

    it('should handle whitespace-only strings', () => {
      expect(removeWhitespace('   ')).toBe('');
      expect(removeWhitespace('\t\n\r')).toBe('');
    });
  });

  describe('escapeHtml', () => {
    it('should escape ampersands', () => {
      expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
      expect(escapeHtml('A & B & C')).toBe('A &amp; B &amp; C');
    });

    it('should escape less than signs', () => {
      expect(escapeHtml('a < b')).toBe('a &lt; b');
      expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    });

    it('should escape greater than signs', () => {
      expect(escapeHtml('a > b')).toBe('a &gt; b');
    });

    it('should escape double quotes', () => {
      expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
    });

    it('should escape single quotes', () => {
      expect(escapeHtml("it's fine")).toBe('it&#39;s fine');
    });

    it('should escape multiple characters', () => {
      expect(escapeHtml('<script>alert("XSS")</script>')).toBe(
        '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;'
      );
    });

    it('should handle strings without special characters', () => {
      expect(escapeHtml('hello world')).toBe('hello world');
    });

    it('should handle empty strings', () => {
      expect(escapeHtml('')).toBe('');
    });
  });
});
