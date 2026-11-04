import {
  EmailMessage,
  EmailProvider,
  MagicLinkEmailOptions,
  PasswordResetEmailOptions,
  SendEmailResult,
  TeamInvitationEmailOptions,
} from './email.types';
import { MockEmailProvider } from './mock.provider';
import { ResendEmailProvider } from './resend.provider';
import { UnconfiguredEmailProvider } from './unconfigured.provider';

export const mockEmailProvider = new MockEmailProvider();

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function resolveTrustedWebUrl(candidateUrl?: string | null): string | null {
  if (!candidateUrl || typeof candidateUrl !== 'string') return null;
  const trimmed = candidateUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid invitation web fallback URL: ${candidateUrl}`);
  }

  const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:'];
  if (dangerousProtocols.includes(parsed.protocol.toLowerCase())) {
    throw new Error(`Dangerous URL scheme rejected: ${parsed.protocol}`);
  }

  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (
    parsed.protocol !== 'https:' &&
    !(process.env.NODE_ENV !== 'production' && isLocalhost && parsed.protocol === 'http:')
  ) {
    throw new Error(`Insecure web fallback URL scheme: ${parsed.protocol}. Only HTTPS is permitted.`);
  }

  if (parsed.hostname === 'example.com' || parsed.hostname.endsWith('.example.com')) {
    return null;
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

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

  async sendTeamInvitationEmail(options: TeamInvitationEmailOptions): Promise<SendEmailResult> {
    const rawBaseUrl = process.env.APP_BASE_URL;
    const trustedBaseUrl = rawBaseUrl ? resolveTrustedWebUrl(rawBaseUrl) : null;
    const webInviteUrl = trustedBaseUrl
      ? `${trustedBaseUrl}/invite?token=${encodeURIComponent(options.token)}`
      : null;

    const appDeepLink = `rota://invite?token=${encodeURIComponent(options.token)}`;
    const expirationText = '7 days';

    const safeInviterName = options.inviterName ? options.inviterName.trim() : null;
    const inviterText = safeInviterName
      ? `${safeInviterName} has invited you`
      : "You've been invited";

    // Text version
    const textLines = [
      'Hello,',
      '',
      `${inviterText} to join "${options.teamName}" on Rota as a ${options.role}.`,
      '',
      '--- ROTA MOBILE APP (RECOMMENDED) ---',
      'If you have the Rota mobile app installed, open this link on your device:',
      appDeepLink,
      '',
      'Or open the Rota mobile app and enter this invitation code manually:',
      options.token,
    ];

    if (webInviteUrl) {
      textLines.push(
        '',
        '--- WEB BROWSER (ALTERNATIVE) ---',
        'Alternatively, you can accept your invitation in a web browser:',
        webInviteUrl
      );
    }

    textLines.push(
      '',
      `This invitation will expire in ${expirationText}.`,
      '',
      `If you do not yet have a Rota account, please register using this email address (${options.to}) before accepting the invitation.`,
      '',
      'The Rota Team'
    );

    const text = textLines.join('\n');

    // Safe HTML version - all dynamic untrusted fields escaped
    const escapedTeamName = escapeHtml(options.teamName);
    const escapedInviterName = safeInviterName ? escapeHtml(safeInviterName) : null;
    const escapedInviterText = escapedInviterName
      ? `${escapedInviterName} has invited you`
      : "You&#39;ve been invited";
    const escapedRole = escapeHtml(options.role);
    const escapedTo = escapeHtml(options.to);
    const escapedToken = escapeHtml(options.token);
    const escapedDeepLink = escapeHtml(appDeepLink);

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111827;">
        <h2 style="color: #111827; margin-bottom: 16px;">You're invited to join ${escapedTeamName} on Rota</h2>
        <p style="color: #374151; font-size: 16px; line-height: 1.5;">
          ${escapedInviterText} to join <strong>${escapedTeamName}</strong> as a <strong>${escapedRole}</strong>.
        </p>

        <div style="margin: 24px 0; padding: 16px; background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #4b5563; margin: 0 0 12px 0;">
            Rota Mobile App
          </h3>
          <div style="margin-bottom: 16px;">
            <a href="${escapedDeepLink}" style="background-color: #2563eb; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
              Open in Rota App
            </a>
          </div>
          <p style="color: #4b5563; font-size: 14px; margin: 0 0 8px 0;">
            Or enter this invitation code manually in the app:
          </p>
          <code style="display: inline-block; background-color: #ffffff; border: 1px solid #d1d5db; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 14px; word-break: break-all; color: #111827;">${escapedToken}</code>
          <p style="color: #6b7280; font-size: 13px; margin: 12px 0 0 0;">
            Direct link: <a href="${escapedDeepLink}" style="color: #2563eb; word-break: break-all;">${escapedDeepLink}</a>
          </p>
        </div>

        ${
          webInviteUrl
            ? `
        <div style="margin: 24px 0; padding: 16px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #4b5563; margin: 0 0 12px 0;">
            Web Browser (Alternative)
          </h3>
          <p style="color: #4b5563; font-size: 14px; margin: 0 0 8px 0;">
            If you do not have the mobile app, you can accept your invitation via browser:
          </p>
          <a href="${escapeHtml(webInviteUrl)}" style="color: #2563eb; font-size: 14px; word-break: break-all;">
            ${escapeHtml(webInviteUrl)}
          </a>
        </div>
        `
            : ''
        }

        <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
          Note: If you do not yet have a Rota account, please register with this email address (${escapedTo}) first, then accept the invitation.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">
          This invitation will expire in ${expirationText}. If you were not expecting this invitation, you can safely ignore this email.
        </p>
      </div>
    `.trim();

    const cleanSubject = `Invitation to join ${options.teamName.replace(/[\r\n]+/g, ' ').trim()} on Rota`;

    return this.provider.send({
      to: options.to,
      subject: cleanSubject,
      text,
      html,
    });
  }
}

export const emailService = new EmailService();

