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

export interface Draft extends DraftMetadata {
  content: string;
}

export interface CallbackResponse {
  success: boolean;
  data?: Record<string, string>;
  error?: string;
}

export interface PendingRequest {
  resolve: (value: CallbackResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}
