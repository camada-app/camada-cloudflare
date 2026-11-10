import { expect, it } from 'vitest';
import pkg from '../package.json';
import { VERSION } from '../src/version';

it('VERSION matches package.json', () => {
  expect(VERSION).toBe(pkg.version);
});
