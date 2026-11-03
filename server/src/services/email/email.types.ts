export interface EmailMessage {
  to: string;
  from?: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailResult {
  messageId?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SendEmailResult>;
  isConfigured?(): boolean;
  verifyHealth?(): Promise<void>;
}

export interface PasswordResetEmailOptions {
  to: string;
  resetToken: string;
  clientBaseUrl?: string;
}
