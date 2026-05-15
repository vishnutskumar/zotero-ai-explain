export type ProjectInfo = {
  readonly displayName: string;
  readonly packageName: string;
  readonly zoteroMinimumVersion: string;
  readonly supportedZoteroMajor: number;
};

export const projectInfo: ProjectInfo = {
  displayName: "Zotero AI Explain",
  packageName: "zotero-ai-explain",
  zoteroMinimumVersion: "8.0",
  supportedZoteroMajor: 8
};
