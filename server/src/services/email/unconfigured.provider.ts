import { EmailMessage, EmailProvider, SendEmailResult } from './email.types';

export class UnconfiguredEmailProvider implements EmailProvider {
  readonly name = 'unconfigured';

  isConfigured(): boolean {
    return false;
  }

  async verifyHealth(): Promise<void> {
    console.warn(
      '[EmailService] Outgoing email delivery is unconfigured. Configure RESEND_API_KEY to enable production delivery.'
    );
    throw new Error(
      'Email delivery is not configured on this server. Please contact an administrator.'
    );
  }

  async send(message: EmailMessage): Promise<SendEmailResult> {
    console.warn(
      `[EmailService] Outgoing email delivery is unconfigured. Email to "${message.to}" was suppressed. ` +
        `Configure RESEND_API_KEY to enable production delivery.`
    );
    throw new Error(
      'Email delivery is not configured on this server. Please contact an administrator.'
    );
  }
}
