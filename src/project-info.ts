export type ProjectInfo = {
  readonly displayName: string;
  readonly packageName: string;
  readonly zoteroMinimumVersion: string;
};

export const projectInfo: ProjectInfo = {
  displayName: "Zotero AI Explain",
  packageName: "zotero-ai-explain",
  zoteroMinimumVersion: "7.0"
};
