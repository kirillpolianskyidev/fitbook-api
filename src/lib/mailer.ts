import nodemailer from 'nodemailer';

import {env, isTest} from '../config/env.js';
import {logger} from './logger.js';

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: false,
  ignoreTLS: true,
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
    await transport.sendMail({from: env.MAIL_FROM, ...mail});
    logger.info(
      {to: mail.to, subject: mail.subject},
      'Email sent (open Mailpit at http://localhost:8025)',
    );
  } catch (error) {
    // Local development without Mailpit: print the email so the flow can still be tested.
    logger.warn(
      {err: (error as Error).message},
      'SMTP unavailable, email printed to the console instead',
    );
    logger.info({to: mail.to, subject: mail.subject, text: mail.text}, 'EMAIL');
  }
}
