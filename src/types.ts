export interface DraftMetadata {
  uuid: string;
  title: string;
  tags: string[];
  createdAt: string;
  modifiedAt: string;
  isFlagged: boolean;
  isArchived: boolean;
  isTrashed: boolean;
}
