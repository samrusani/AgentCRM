import { describe, expect, it } from 'vitest';
import { cleanText, validEmail } from '../src/extract/common';

describe('validEmail', () => {
  it.each(['jane@example.com', 'jane.doe+crm@sub.example.co.uk', ' jane@example.com ', 'mailto:jane@example.com'])('keeps %s', (value) => {
    expect(validEmail(value)).toBe(value.trim().replace(/^mailto:/, ''));
  });
  it.each(['', 'jane', 'jane@', '@example.com', 'jane@example', 'jane doe@example.com', 'a@b@c.com', 'jane@example..com', undefined, 42, null])(
    'drops %s',
    (value) => expect(validEmail(value)).toBeUndefined(),
  );
  it('drops an address longer than 254 characters', () => {
    expect(validEmail(`${'a'.repeat(250)}@example.com`)).toBeUndefined();
  });
});

describe('cleanText', () => {
  it('collapses whitespace, trims, and caps length', () => {
    expect(cleanText('  a \n b  ')).toBe('a b');
    expect(cleanText('abcdef', 3)).toBe('abc');
    expect(cleanText('   ')).toBeUndefined();
    expect(cleanText(5)).toBeUndefined();
  });
});
