import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from './config.js';

export interface EmailSender {
  sendVerificationCode(email: string, code: string): Promise<void>;
  sendPasswordResetCode(email: string, code: string): Promise<void>;
}

class ConsoleEmailSender implements EmailSender {
  async sendVerificationCode(email: string, code: string): Promise<void> {
    console.info(`Development email verification code for ${email}: ${code}`);
  }

  async sendPasswordResetCode(email: string, code: string): Promise<void> {
    console.info(`Development password reset code for ${email}: ${code}`);
  }
}

class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
  ) {}

  async sendVerificationCode(email: string, code: string): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: email,
      subject: 'Verify your Green Fork account',
      text: `Your Green Fork verification code is ${code}. It expires in 15 minutes.`,
    });
  }

  async sendPasswordResetCode(email: string, code: string): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: email,
      subject: 'Reset your Green Fork password',
      text: `Your Green Fork password reset code is ${code}. It expires in 15 minutes.`,
    });
  }
}

export function createEmailSender(config: AppConfig): EmailSender {
  const smtpConfigured = Boolean(config.smtpHost && config.smtpUser && config.smtpPassword);
  if (!smtpConfigured) {
    if (config.nodeEnv === 'production') {
      throw new Error('SMTP_HOST, SMTP_USER, and SMTP_PASSWORD are required in production.');
    }
    return new ConsoleEmailSender();
  }

  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: config.smtpUser, pass: config.smtpPassword },
  });
  return new SmtpEmailSender(transport, config.emailFrom);
}
