import { EmailMessage, EmailProvider, SendEmailResult } from './email.types';

export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';
  private sent: EmailMessage[] = [];
  private shouldFail = false;
  private shouldFailSendOnly = false;
  private failureError: Error | null = null;
  private unconfigured = false;

  isConfigured(): boolean {
    return !this.unconfigured;
  }

  isFailing(): boolean {
    return this.shouldFail || this.shouldFailSendOnly;
  }

  setUnconfigured(unconfigured: boolean): void {
    this.unconfigured = unconfigured;
  }

  setSendFailureOnly(shouldFailSendOnly: boolean, error?: Error): void {
    this.shouldFailSendOnly = shouldFailSendOnly;
    this.failureError = error ?? null;
  }

  async verifyHealth(): Promise<void> {
    if (this.unconfigured) {
      throw new Error(
        'Email delivery is not configured on this server. Please contact an administrator.'
      );
    }
    if (this.shouldFail) {
      throw this.failureError ?? new Error('Mock email delivery failed');
    }
  }

  async send(message: EmailMessage): Promise<SendEmailResult> {
    if (this.unconfigured) {
      throw new Error(
        'Email delivery is not configured on this server. Please contact an administrator.'
      );
    }
    if (this.shouldFail || this.shouldFailSendOnly) {
      throw this.failureError ?? new Error('Mock email delivery failed');
    }

    this.sent.push({ ...message });
    return { messageId: `mock-${Date.now()}-${this.sent.length}` };
  }

  getSentEmails(): EmailMessage[] {
    return [...this.sent];
  }

  getLastEmail(): EmailMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  clear(): void {
    this.sent = [];
    this.shouldFail = false;
    this.shouldFailSendOnly = false;
    this.failureError = null;
    this.unconfigured = false;
  }

  setShouldFail(shouldFail: boolean, error?: Error): void {
    this.shouldFail = shouldFail;
    this.failureError = error ?? null;
  }
}
