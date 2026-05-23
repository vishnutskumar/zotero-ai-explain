import type { ChildProcess } from "node:child_process";

export const PLUGIN_ID: string;
export const STARTUP_LINE: string;
export const DEFAULT_BINARY: string;
export const DEFAULT_MARIONETTE_PORT: number;
export const REPO_ROOT: string;

export type ZoteroExitInfo = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type ZoteroHandle = {
  readonly child: ChildProcess;
  readonly logPath: string;
  readonly profileDir: string;
  readonly marionettePort: number;
  readonly exitPromise: Promise<ZoteroExitInfo>;
  waitForLogLine(pattern: RegExp | string, options?: { timeoutMs?: number }): Promise<boolean>;
  onLogChunk(consumer: (chunk: string) => void): () => void;
  shutdown(options?: { graceMs?: number }): Promise<ZoteroExitInfo>;
  getLog(): string;
};

export type PrefValue = string | number | boolean;

export function createProfile(options?: {
  marionettePort?: number;
  profileDir?: string | null;
  extraPrefs?: Record<string, PrefValue>;
}): string;

export function installPlugin(
  profileDir: string,
  xpiPath: string,
  options?: { unpack?: boolean }
): string;

export function spawnZotero(options: {
  binaryPath?: string;
  profileDir: string;
  logPath: string;
  marionettePort?: number;
  quiet?: boolean;
}): ZoteroHandle;

export function readLogFile(logPath: string): Promise<string>;

export function startZoteroWithPlugin(options?: {
  binaryPath?: string;
  xpiPath?: string;
  marionettePort?: number;
  startupTimeoutMs?: number;
  quiet?: boolean;
  extraPrefs?: Record<string, PrefValue>;
}): Promise<ZoteroHandle>;

export function cleanupProfile(profileDir: string): void;

export function findFreePort(): Promise<number>;
