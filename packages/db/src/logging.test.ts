import { describe, it, expect } from 'vitest';
import { redact } from './logging';

describe('redact — key-level', () => {
  it('replaces values under sensitive-name keys', () => {
    const out = redact({
      public: 'ok',
      api_key: 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx',
      nested: { auth_token: 'abc', name: 'keep' },
    });
    expect(out).toEqual({
      public: 'ok',
      api_key: '[REDACTED]',
      nested: { auth_token: '[REDACTED]', name: 'keep' },
    });
  });
});

describe('redact — value-level', () => {
  it('redacts Bearer tokens in free text', () => {
    expect(redact('Authorization: Bearer abcdefghij1234567890XYZ')).toContain('Bearer [REDACTED]');
  });

  it('redacts JWT-shaped strings', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.s1gn4ture1234';
    const redacted = redact(`401: ${jwt}`) as string;
    expect(redacted).toContain('[REDACTED_JWT]');
    expect(redacted).not.toContain(jwt);
  });

  it('redacts known vendor key prefixes inside a larger message', () => {
    const msg = 'HTTP 401 from anthropic key=sk-ant-apiKeyValue1234567890 failed';
    const out = redact(msg) as string;
    expect(out).toContain('[REDACTED_API_KEY]');
    expect(out).not.toContain('apiKeyValue');
  });

  it('redacts long bare hex strings', () => {
    const h = 'abcdef0123456789'.repeat(3); // 48 chars
    expect(redact(`sha: ${h}`)).toBe(`sha: [REDACTED_HEX]`);
  });

  it('leaves ordinary strings alone', () => {
    expect(redact('all good here, no secrets at all')).toBe('all good here, no secrets at all');
  });

  it('applies value scrubbing to strings inside objects', () => {
    const out = redact({ message: 'Error: Bearer abcdefghij1234567890zzzzz' }) as {
      message: string;
    };
    expect(out.message).toContain('Bearer [REDACTED]');
  });
});
