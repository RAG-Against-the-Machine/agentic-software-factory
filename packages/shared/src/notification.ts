export interface Notification {
  runId: string;
  taskId?: string;
  kind: 'needs_human' | 'gate' | 'finished' | 'failed' | 'credential';
  title: string;
  body: string;
  actions?: { label: string; url: string }[];
}

export interface NotificationSink {
  readonly kind: 'web' | 'slack' | 'telegram' | 'email';
  send(n: Notification): Promise<void>;
}
