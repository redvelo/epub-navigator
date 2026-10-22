export interface NavigatorHighlightAnnotationRecord {
  readonly type: "highlight";
  readonly id: string;
  readonly targetJson: string;
  readonly occurrence: number;
  readonly excerpt: string | null;
  readonly sectionLabel: string | null;
}

export interface NavigatorNoteAnnotationRecord {
  readonly type: "note";
  readonly id: string;
  readonly targetJson: string;
  readonly occurrence: number;
  readonly excerpt: string | null;
  readonly sectionLabel: string | null;
  readonly text: string;
}

export interface NavigatorBookmarkAnnotationRecord {
  readonly type: "bookmark";
  readonly id: string;
  readonly targetJson: string;
  readonly occurrence: number;
  readonly sectionLabel: string | null;
  readonly label: string | null;
}

export type NavigatorAnnotationRecord =
  | NavigatorHighlightAnnotationRecord
  | NavigatorNoteAnnotationRecord
  | NavigatorBookmarkAnnotationRecord;

export interface NavigatorAnnotationProjection {
  readonly revision: number;
  readonly records: readonly NavigatorAnnotationRecord[];
}

export type NavigatorAnnotationMutationRequest =
  | {
      readonly type: "create-bookmark";
      readonly requestId: string;
      readonly basedOnRevision: number;
      readonly locationRevision: number;
      readonly occurrence: number;
      readonly targetJson: string;
      readonly sectionLabel: string | null;
      readonly label: string | null;
    }
  | {
      readonly type: "create-highlight";
      readonly requestId: string;
      readonly basedOnRevision: number;
      readonly selectionRevision: number;
      readonly occurrence: number;
      readonly targetJson: string;
      readonly excerpt: string | null;
      readonly sectionLabel: string | null;
    }
  | {
      readonly type: "create-note";
      readonly requestId: string;
      readonly basedOnRevision: number;
      readonly selectionRevision: number;
      readonly occurrence: number;
      readonly targetJson: string;
      readonly excerpt: string | null;
      readonly sectionLabel: string | null;
      readonly text: string;
    }
  | {
      readonly type: "update-note";
      readonly requestId: string;
      readonly basedOnRevision: number;
      readonly recordId: string;
      readonly text: string;
    }
  | {
      readonly type: "convert-highlight-to-note";
      readonly requestId: string;
      readonly basedOnRevision: number;
      readonly recordId: string;
      readonly text: string;
    }
  | {
      readonly type: "delete-annotation";
      readonly requestId: string;
      readonly basedOnRevision: number;
      readonly recordId: string;
    }
  | {
      readonly type: "retarget-annotation";
      readonly requestId: string;
      readonly basedOnRevision: number;
      readonly recordId: string;
      readonly targetJson: string;
      readonly excerpt: string;
    };

export type NavigatorAnnotationAcknowledgment =
  | {
      readonly status: "accepted";
      readonly requestId: string;
      readonly recordId: string;
      readonly projectionRevision: number;
    }
  | {
      readonly status: "rejected";
      readonly requestId: string;
      readonly reason: string;
    };
