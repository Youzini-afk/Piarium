import { describe, expect, test } from 'vitest';
import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.js';

describe('sanitizeRuntimeRequestHeaders', () => {
  test('preserves safe custom headers', () => {
    expect(sanitizeRuntimeRequestHeaders({
      ' CF-Access-Client-Id ': ' client-id ',
      'X-Custom-Header': 'value',
    })).toEqual({
      'CF-Access-Client-Id': 'client-id',
      'X-Custom-Header': 'value',
    });
  });

  test('drops invalid and reserved headers', () => {
    expect(sanitizeRuntimeRequestHeaders({
      Authorization: 'Bearer proxy-token',
      'authorization': 'Bearer lower-token',
      'Bad:Name': 'value',
      'Bad\nName': 'value',
      'Bad-Value': 'line\nbreak',
      Empty: '',
      Good: 'ok',
    })).toEqual({ Good: 'ok' });
  });
});
