import request from 'supertest';
import { app } from '../src/app';
import fs from 'fs';
import path from 'path';

describe('Frontend Static Asset Cache-Control Header Policy', () => {
  const clientDistAssets = path.resolve(__dirname, '../client/dist/assets');
  let jsFileName = '';
  let cssFileName = '';

  beforeAll(() => {
    if (fs.existsSync(clientDistAssets)) {
      const files = fs.readdirSync(clientDistAssets);
      jsFileName = files.find((f) => f.endsWith('.js')) || '';
      cssFileName = files.find((f) => f.endsWith('.css')) || '';
    }
  });

  test('Content-hashed JS asset is served with long-lived immutable Cache-Control headers', async () => {
    if (!jsFileName) return;

    const res = await request(app).get(`/assets/${jsFileName}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  test('Content-hashed CSS asset is served with long-lived immutable Cache-Control headers', async () => {
    if (!cssFileName) return;

    const res = await request(app).get(`/assets/${cssFileName}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  test('index.html entrypoint is served with no-cache revalidation headers', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  test('SPA route fallback is served with no-cache revalidation headers', async () => {
    const res = await request(app).get('/dashboard/view-123');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });
});
