import { EmailMessage, EmailProvider, SendEmailResult } from './email.types';

export interface ResendProviderOptions {
  apiKey?: string;
  defaultFrom?: string;
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly apiKey: string | undefined;
  private readonly defaultFrom: string;

  constructor(options: ResendProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.RESEND_API_KEY;
    this.defaultFrom =
      options.defaultFrom ??
      process.env.EMAIL_FROM ??
      'Rota Scheduler <noreply@rotascheduler.com>';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async verifyHealth(): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error(
        'Resend API key is not configured. Set RESEND_API_KEY environment variable.'
      );
    }
  }

  async send(message: EmailMessage): Promise<SendEmailResult> {
    if (!this.apiKey) {
      throw new Error(
        'Resend API key is not configured. Set RESEND_API_KEY environment variable.'
      );
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: message.from ?? this.defaultFrom,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Resend API error (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as { id?: string };
    return { messageId: data.id };
  }
}
