/**
 * Payload size cap and Content-Length enforcement regression tests (V3-005, V4-005, V4-010).
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

interface StreamRequestInit extends RequestInit {
  duplex?: 'half';
}

function createChunkedStream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });
}

describe('Payload size cap & Content-Length enforcement (V4-005 / V4-010)', () => {
  it('returns 411 Length Required when Content-Length is missing on POST (chunked stream)', async () => {
    const stream = createChunkedStream('{"test":"missing-cl"}');
    const init: StreamRequestInit = {
      method: 'POST',
      body: stream,
      duplex: 'half',
    };
    const res = await SELF.fetch('http://localhost/api/v1/health', init);
    expect(res.status).toBe(411);
    const json = await res.json<{ error: { code: string; message: string } }>();
    expect(json.error.code).toBe('LENGTH_REQUIRED');
  });

  it('returns 411 Length Required when Content-Length is missing on PUT, PATCH, DELETE', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const stream = createChunkedStream('{"test":"missing-cl"}');
      const init: StreamRequestInit = {
        method,
        body: stream,
        duplex: 'half',
      };
      const res = await SELF.fetch('http://localhost/api/v1/health', init);
      expect(res.status).toBe(411);
      const json = await res.json<{ error: { code: string } }>();
      expect(json.error.code).toBe('LENGTH_REQUIRED');
    }
  });

  it('allows GET requests without Content-Length', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
  });

  it('returns 413 Payload Too Large when Content-Length exceeds 128 KB', async () => {
    const hugeSize = 130 * 1024; // 130 KB
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(hugeSize),
      },
      body: JSON.stringify({ data: 'x'.repeat(100) }),
    });
    expect(res.status).toBe(413);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 413 Payload Too Large when Content-Length is malformed (NaN)', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': 'invalid-number',
      },
      body: '{"test":1}',
    });
    expect(res.status).toBe(413);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('allows POST requests with valid Content-Length <= 128 KB', async () => {
    const body = JSON.stringify({ amount: '10.00', currency: 'BDT' });
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
    });
    // Moves past the payload cap middleware without 411/413
    expect(res.status).not.toBe(411);
    expect(res.status).not.toBe(413);
  });
});
