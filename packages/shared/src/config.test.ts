import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from './config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const REQUIRED = {
  APP_ENV: 'mac',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  STT_URL: 'http://localhost:9000',
  WEB_PORT: '3000',
  MCP_PORT: '8787',
  MCP_URL: 'http://localhost:8787',
  RULES_DB_PATH: './data/rules.db',
  GAME_DB_PATH: './data/game.db'
};

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dnd-config-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function toEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

describe('parseConfig', () => {
  it('applies model and context defaults', () => {
    const config = parseConfig(REQUIRED);
    expect(config.CHAT_MODEL).toBe('ornith-1.5:35b');
    expect(config.EMBED_MODEL).toBe('nomic-embed-text');
    expect(config.OPEN5E_BASE_URL).toBe('https://api.open5e.com/v2');
    expect(config.NUM_CTX).toBe(32768);
  });

  it('coerces numbers', () => {
    const config = parseConfig({ ...REQUIRED, NUM_CTX: '8192' });
    expect(config.NUM_CTX).toBe(8192);
    expect(config.WEB_PORT).toBe(3000);
    expect(config.MCP_PORT).toBe(8787);
  });

  it('treats empty strings as unset', () => {
    const config = parseConfig({ ...REQUIRED, DM_PIN: '', NUM_CTX: '' });
    expect(config.DM_PIN).toBeUndefined();
    expect(config.NUM_CTX).toBe(32768);
  });

  it('reports every invalid or missing variable at once', () => {
    const run = () =>
      parseConfig({
        ...REQUIRED,
        STT_URL: undefined,
        OLLAMA_BASE_URL: 'not a url',
        NUM_CTX: 'lots'
      });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/OLLAMA_BASE_URL/);
    expect(run).toThrow(/NUM_CTX/);
    expect(run).toThrow(/STT_URL/);
  });

  it('rejects an unknown APP_ENV', () => {
    expect(() => parseConfig({ ...REQUIRED, APP_ENV: 'windows' })).toThrow(/APP_ENV/);
  });
});

describe('loadConfig', () => {
  it('layers profile, then .env, then the real environment', () => {
    const root = makeRoot({
      'env/mac.env': toEnvFile({ ...REQUIRED, CHAT_MODEL: 'profile', EMBED_MODEL: 'profile' }),
      '.env': toEnvFile({ CHAT_MODEL: 'dotenv', EMBED_MODEL: 'dotenv' })
    });
    const config = loadConfig({ root, env: { APP_ENV: 'mac', CHAT_MODEL: 'process' } });
    expect(config.CHAT_MODEL).toBe('process');
    expect(config.EMBED_MODEL).toBe('dotenv');
    expect(config.STT_URL).toBe('http://localhost:9000');
  });

  it('reads APP_ENV from .env when the environment does not set it', () => {
    const root = makeRoot({
      'env/firefly.env': toEnvFile({ ...REQUIRED, APP_ENV: 'firefly' }),
      '.env': 'APP_ENV=firefly'
    });
    expect(loadConfig({ root, env: {} }).APP_ENV).toBe('firefly');
  });

  it('works without a .env file', () => {
    const root = makeRoot({ 'env/mac.env': toEnvFile(REQUIRED) });
    expect(loadConfig({ root, env: { APP_ENV: 'mac' } }).APP_ENV).toBe('mac');
  });

  it('fails when APP_ENV is missing', () => {
    const root = makeRoot({ 'env/mac.env': toEnvFile(REQUIRED) });
    expect(() => loadConfig({ root, env: {} })).toThrow(/APP_ENV/);
  });

  it('fails when APP_ENV is not a known profile', () => {
    const root = makeRoot({});
    expect(() => loadConfig({ root, env: { APP_ENV: '../secrets' } })).toThrow(/APP_ENV/);
  });

  it('fails when the profile file is missing', () => {
    const root = makeRoot({});
    expect(() => loadConfig({ root, env: { APP_ENV: 'mac' } })).toThrow(/env\/mac\.env/);
  });
});

describe('committed profiles', () => {
  it.each(['mac', 'firefly'])('%s.env is valid on its own', (profile) => {
    const config = loadConfig({ root: REPO_ROOT, env: { APP_ENV: profile }, dotenv: false });
    expect(config.APP_ENV).toBe(profile);
  });
});
