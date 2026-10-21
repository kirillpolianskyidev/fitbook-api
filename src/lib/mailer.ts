import nodemailer from 'nodemailer';

import {env, isTest} from '../config/env.js';
import {AppError} from './errors.js';
import {logger} from './logger.js';

/** Real SMTP service (Brevo etc.) when SMTP_USER is set, otherwise local Mailpit without auth or TLS. */
const usesAuth = Boolean(env.SMTP_USER);

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  ...(usesAuth
    ? {auth: {user: env.SMTP_USER, pass: env.SMTP_PASS}, requireTLS: !env.SMTP_SECURE}
    : {ignoreTLS: true}),
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

export type SentMail = {to: string; subject: string; text: string};

/** In tests mails are collected here instead of being sent. */
export const outbox: SentMail[] = [];

/** Indirection so tests can simulate delivery failures. */
export const mailTransport = {
  deliver: async (mail: SentMail): Promise<{messageId?: string}> => {
    if (isTest) {
      outbox.push(mail);
      return {};
    }
    return transport.sendMail({from: env.MAIL_FROM, ...mail});
  },
};

/**
 * A failed delivery is an error the user must see when a real email service is configured (and always in
 * production). Only local development without SMTP credentials (Mailpit not running) falls back to the log.
 */
const deliveryMustSucceed = () => env.NODE_ENV === 'production' || Boolean(env.SMTP_USER);

/** Sends an email. Throws EMAIL_DELIVERY_FAILED (503) when it could not be delivered to the email service. */
export async function sendMail(mail: SentMail) {
  try {
    const info = await mailTransport.deliver(mail);
    if (!isTest) {
      logger.info(
        {to: mail.to, subject: mail.subject, messageId: info.messageId},
        usesAuth
          ? `Email sent via ${env.SMTP_HOST}`
          : 'Email sent (open Mailpit at http://localhost:8025)',
      );
    }
  } catch (error) {
    if (deliveryMustSucceed()) {
      // Never log the email body here: it contains the code.
      logger.error(
        {err: (error as Error).message, to: mail.to, host: env.SMTP_HOST, port: env.SMTP_PORT},
        'Failed to send email',
      );
      throw new AppError('EMAIL_DELIVERY_FAILED');
    }
    // Local development without SMTP credentials: print the email so the flow can still be tested.
    logger.warn(
      {err: (error as Error).message},
      'SMTP unavailable, email printed to the console instead',
    );
    logger.info({to: mail.to, subject: mail.subject, text: mail.text}, 'EMAIL');
  }
}
