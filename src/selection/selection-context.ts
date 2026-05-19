export type SourceMetadata = {
  readonly itemKey: string | null;
  readonly itemTitle: string | null;
  readonly attachmentKey: string | null;
  readonly pageLabel: string | null;
  readonly location: string | null;
};

export type SelectionAnchor = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
};

export type SelectionContext = {
  readonly quote: string;
  readonly source: SourceMetadata;
  readonly anchor: SelectionAnchor | null;
};
