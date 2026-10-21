import nodemailer from 'nodemailer';

import {env, isProduction, isTest} from '../config/env.js';
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

export async function sendMail(mail: SentMail) {
  if (isTest) {
    outbox.push(mail);
    return;
  }
  try {
    const info = await transport.sendMail({from: env.MAIL_FROM, ...mail});
    logger.info(
      {to: mail.to, subject: mail.subject, messageId: info.messageId},
      usesAuth
        ? `Email sent via ${env.SMTP_HOST}`
        : 'Email sent (open Mailpit at http://localhost:8025)',
    );
  } catch (error) {
    if (isProduction) {
      // Never log the email body (it contains codes) in production.
      logger.error({err: (error as Error).message, to: mail.to}, 'Failed to send email');
      throw error;
    }
    // Development: print the email so the flow can still be tested without a working SMTP server.
    logger.warn(
      {err: (error as Error).message},
      'SMTP unavailable, email printed to the console instead',
    );
    logger.info({to: mail.to, subject: mail.subject, text: mail.text}, 'EMAIL');
  }
}
