import {
  EmailMessage,
  EmailProvider,
  MagicLinkEmailOptions,
  PasswordResetEmailOptions,
  SendEmailResult,
} from './email.types';
import { MockEmailProvider } from './mock.provider';
import { ResendEmailProvider } from './resend.provider';
import { UnconfiguredEmailProvider } from './unconfigured.provider';

export const mockEmailProvider = new MockEmailProvider();

export class EmailService {
  private provider: EmailProvider;

  constructor(provider?: EmailProvider) {
    if (provider) {
      this.provider = provider;
    } else if (process.env.NODE_ENV === 'test') {
      this.provider = mockEmailProvider;
    } else if (process.env.RESEND_API_KEY) {
      this.provider = new ResendEmailProvider();
    } else {
      this.provider = new UnconfiguredEmailProvider();
    }
  }

  setProvider(provider: EmailProvider): void {
    this.provider = provider;
  }

  getProvider(): EmailProvider {
    return this.provider;
  }

  isConfigured(): boolean {
    return this.provider.isConfigured
      ? this.provider.isConfigured()
      : this.provider.name !== 'unconfigured';
  }

  async verifyDeliveryAvailable(): Promise<void> {
    if (this.provider.verifyHealth) {
      await this.provider.verifyHealth();
    } else if (!this.isConfigured()) {
      throw new Error(
        'Email delivery is not configured on this server. Please contact an administrator.'
      );
    }
  }

  async send(message: EmailMessage): Promise<SendEmailResult> {
    return this.provider.send(message);
  }

  async sendPasswordResetEmail(options: PasswordResetEmailOptions): Promise<SendEmailResult> {
    const baseUrl =
      options.clientBaseUrl ??
      process.env.APP_BASE_URL ??
      'https://app.rota.example.com';
    const resetUrl = `${baseUrl.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(
      options.resetToken
    )}`;

    const text = [
      'Hello,',
      '',
      'We received a request to reset your password for your Rota account.',
      '',
      'To reset your password, visit the link below within 30 minutes:',
      resetUrl,
      '',
      'Or use this reset token directly in the mobile application:',
      options.resetToken,
      '',
      'If you did not request this password reset, please ignore this email. Your current password remains secure.',
      '',
      'The Rota Team',
    ].join('\n');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111827; margin-bottom: 16px;">Reset your Rota password</h2>
        <p style="color: #374151; font-size: 16px; line-height: 1.5;">
          We received a request to reset your password for your Rota account. This link will expire in 30 minutes.
        </p>
        <div style="margin: 32px 0;">
          <a href="${resetUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
            Reset Password
          </a>
        </div>
        <p style="color: #4b5563; font-size: 14px;">
          Or copy and paste this link into your browser:
        </p>
        <p style="color: #2563eb; font-size: 14px; word-break: break-all;">
          ${resetUrl}
        </p>
        <p style="color: #4b5563; font-size: 14px; margin-top: 24px;">
          Or enter this reset token in the mobile app:
        </p>
        <code style="display: inline-block; background-color: #f3f4f6; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 14px; word-break: break-all;">
          ${options.resetToken}
        </code>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
        <p style="color: #9ca3af; font-size: 12px;">
          If you did not request a password reset, you can safely ignore this email. Your password will not change.
        </p>
      </div>
    `.trim();

    return this.provider.send({
      to: options.to,
      subject: 'Reset your Rota password',
      text,
      html,
    });
  }

  async sendMagicLinkEmail(options: MagicLinkEmailOptions): Promise<SendEmailResult> {
    const baseUrl =
      options.clientBaseUrl ??
      process.env.APP_BASE_URL ??
      'https://app.rota.example.com';
    const magicLinkUrl = `${baseUrl.replace(/\/+$/, '')}/magic-link/confirm?token=${encodeURIComponent(
      options.token
    )}`;

    const text = [
      'Hello,',
      '',
      'We received a request to sign in to your Rota account using magic link passwordless authentication.',
      '',
      'Use this one-time sign-in code directly in the Rota mobile app:',
      options.token,
      '',
      'This sign-in code will expire in 15 minutes and can only be used once.',
      '',
      'Alternatively, if you are using a browser, you can open this link:',
      magicLinkUrl,
      '',
      'If you did not request this sign-in link, please ignore this email. Your account remains secure.',
      '',
      'The Rota Team',
    ].join('\n');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111827; margin-bottom: 16px;">Sign in to Rota</h2>
        <p style="color: #374151; font-size: 16px; line-height: 1.5;">
          We received a request to sign in to your Rota account. This sign-in code and link will expire in 15 minutes.
        </p>
        <p style="color: #4b5563; font-size: 14px; margin-top: 24px;">
          Enter this one-time sign-in code in the mobile app:
        </p>
        <code style="display: inline-block; background-color: #f3f4f6; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 14px; word-break: break-all;">
          ${options.token}
        </code>
        <div style="margin: 32px 0;">
          <a href="${magicLinkUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
            Sign In to Rota
          </a>
        </div>
        <p style="color: #4b5563; font-size: 14px;">
          Or copy and paste this link into your browser:
        </p>
        <p style="color: #2563eb; font-size: 14px; word-break: break-all;">
          ${magicLinkUrl}
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
        <p style="color: #9ca3af; font-size: 12px;">
          If you did not request this sign-in link, you can safely ignore this email. No changes were made to your account.
        </p>
      </div>
    `.trim();

    return this.provider.send({
      to: options.to,
      subject: 'Sign in to Rota',
      text,
      html,
    });
  }
}

export const emailService = new EmailService();

