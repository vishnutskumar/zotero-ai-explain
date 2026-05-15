export type SourceMetadata = {
  readonly itemKey: string | null;
  readonly itemTitle: string | null;
  readonly attachmentKey: string | null;
  readonly pageLabel: string | null;
  readonly location: string | null;
};

export type SelectionContext = {
  readonly quote: string;
  readonly source: SourceMetadata;
  readonly anchor: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } | null;
};
