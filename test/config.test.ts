import { describe, expect, it } from 'vitest';
import { missingConfig } from '../src/index';

describe('missingConfig', () => {
  it('names every required value that is absent or blank', () => {
    expect(missingConfig({ CAMADA_KEY: ' ', ZONE: 'example.com' })).toEqual(['CAMADA_KEY', 'CLOUDFLARE_API_TOKEN']);
  });

  it('is empty when the key, token and zone are set', () => {
    expect(missingConfig({ CAMADA_KEY: 'a.b', CLOUDFLARE_API_TOKEN: 't', ZONE: 'example.com' })).toEqual([]);
  });
});
