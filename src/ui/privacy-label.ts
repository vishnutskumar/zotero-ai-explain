export type ProviderDisclosureInput = {
  readonly displayName: string;
  readonly model: string;
  readonly sendMode: "local" | "remote";
};

export function providerDisclosure(input: ProviderDisclosureInput): string {
  if (input.sendMode === "local") {
    return `Selected text will be processed locally by ${input.displayName} using ${input.model}.`;
  }

  return `Selected text will be sent to ${input.displayName} using ${input.model}.`;
}
