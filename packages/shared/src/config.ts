import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const APP_ENVS = ['mac', 'firefly'] as const;

const port = z.coerce.number().int().min(1).max(65535);

export const configSchema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  OLLAMA_BASE_URL: z.url(),
  CHAT_MODEL: z.string().default('ornith-1.5:35b'),
  EMBED_MODEL: z.string().default('nomic-embed-text'),
  NUM_CTX: z.coerce.number().int().positive().default(32768),
  STT_URL: z.url(),
  WEB_PORT: port,
  MCP_PORT: port,
  MCP_URL: z.url(),
  OPEN5E_BASE_URL: z.url().default('https://api.open5e.com/v2'),
  RULES_DB_PATH: z.string(),
  GAME_DB_PATH: z.string(),
  DM_PIN: z.string().optional(),
  PLAYER_PIN: z.string().optional()
});

export type Config = z.infer<typeof configSchema>;

type Vars = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Validates raw variables. Empty strings count as unset. */
export function parseConfig(vars: Vars): Config {
  const set = Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== ''));
  const result = configSchema.safeParse(set);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid config:\n${lines.join('\n')}`);
  }
  return result.data;
}

export interface LoadConfigOptions {
  /** Directory holding `env/` and `.env`. Defaults to the workspace root above the cwd. */
  root?: string;
  /** The real environment, which wins over both files. */
  env?: Vars;
  /** Set false to skip `.env`. */
  dotenv?: boolean;
}

/** Loads `env/${APP_ENV}.env`, then `.env`, then the real environment (later wins). */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const root = options.root ?? findWorkspaceRoot(process.cwd());
  const env = options.env ?? process.env;

  const dotenvPath = join(root, '.env');
  const dotenv = options.dotenv !== false && existsSync(dotenvPath) ? readEnvFile(dotenvPath) : {};

  const appEnv = env.APP_ENV ?? dotenv.APP_ENV;
  if (!APP_ENVS.includes(appEnv as (typeof APP_ENVS)[number])) {
    throw new ConfigError(
      `Invalid config:\n  APP_ENV: expected one of ${APP_ENVS.join(' | ')}, got ${JSON.stringify(appEnv)}`
    );
  }

  const profilePath = join(root, 'env', `${appEnv}.env`);
  if (!existsSync(profilePath)) {
    throw new ConfigError(`Missing profile env/${appEnv}.env in ${root}`);
  }

  return parseConfig({ ...readEnvFile(profilePath), ...dotenv, ...env });
}

function readEnvFile(path: string): Vars {
  return parseEnv(readFileSync(path, 'utf8'));
}

/** The nearest directory at or above `start` holding `pnpm-workspace.yaml`, else `start`. */
export function findWorkspaceRoot(start: string): string {
  let dir = resolve(start);
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
  return dir;
}
