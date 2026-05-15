export type SecretReference =
  | { readonly kind: "credential-store"; readonly id: string }
  | { readonly kind: "environment"; readonly name: string }
  | { readonly kind: "local-file"; readonly path: string; readonly key: string }
  | { readonly kind: "none" };
