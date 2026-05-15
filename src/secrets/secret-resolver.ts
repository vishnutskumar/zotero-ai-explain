import type { SecretReference } from "./secret-types.js";

export type SecretResolverDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly credentialStore: ReadonlyMap<string, string>;
  readonly localFiles: ReadonlyMap<string, Readonly<Record<string, string | undefined>>>;
};

export type SecretResolver = {
  resolve(reference: SecretReference): Promise<string | null>;
};

export function createSecretResolver(deps: SecretResolverDeps): SecretResolver {
  return {
    resolve(reference) {
      return Promise.resolve(resolveSecretReference(deps, reference));
    }
  };
}

function resolveSecretReference(
  deps: SecretResolverDeps,
  reference: SecretReference
): string | null {
  switch (reference.kind) {
    case "none":
      return null;
    case "environment":
      return deps.env[reference.name] ?? null;
    case "credential-store":
      return deps.credentialStore.get(reference.id) ?? null;
    case "local-file":
      return deps.localFiles.get(reference.path)?.[reference.key] ?? null;
  }
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), message);
}
