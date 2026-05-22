export type SourceMetadata = {
  readonly itemKey: string | null;
  readonly itemTitle: string | null;
  readonly attachmentKey: string | null;
  readonly pageLabel: string | null;
  /**
   * 0-indexed PDF page of the selection. Optional — `undefined` when the
   * reader event carries no page position. Deliberately NOT `number | null`:
   * `pageIndex: 0` is a valid first page, so absence must be `undefined`
   * (checked via `typeof pageIndex === "number"`), never conflated with a
   * falsy `0`.
   */
  readonly pageIndex?: number;
  /**
   * Request-scoped RAG scope. When set, in-PDF RAG retrieval filters to
   * chunks of this itemKey. `undefined`-absent — non-PDF readers and
   * library-wide chat leave it unset for unscoped retrieval.
   */
  readonly scopedItemKey?: string;
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
