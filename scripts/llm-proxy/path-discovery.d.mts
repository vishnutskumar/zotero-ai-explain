export declare const FALLBACK_PATH_ENTRIES: readonly string[];

export type PathQuery = { readonly command: string; readonly args: readonly string[] };

export declare function shellPathQuery(shellPath: string | undefined): PathQuery | null;

export declare function discoverLoginShellPath(deps?: {
  readonly shell?: string;
  readonly spawn?: typeof import("node:child_process").spawn;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<string | null>;

export declare function mergePathEntries(
  currentPath: string,
  additions: Iterable<string> | string
): string;

export type PathEnrichmentResult = {
  readonly source: "shell" | "fallback" | "noop";
  readonly added: readonly string[];
  readonly finalPath: string;
  readonly shellUsed?: string;
};

export declare function enrichEnvironmentPath(deps?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly discover?: typeof discoverLoginShellPath;
  readonly fallbackEntries?: readonly string[];
  readonly exists?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
}): Promise<PathEnrichmentResult>;

export declare function findBinary(
  command: string,
  deps?: {
    readonly override?: string | null | undefined;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly exists?: (path: string) => boolean;
    readonly isExecutable?: (path: string) => boolean;
    readonly platform?: NodeJS.Platform;
  }
): { readonly path: string | null; readonly searched: readonly string[] };
