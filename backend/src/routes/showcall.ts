import type { Request, Response } from 'express';
import { Router } from 'express';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * The trade-show line: a number that answers and plays a recorded call.
 *
 * On the stand a retro Bluetooth handset is paired to a phone with two speed-dial
 * keys. One rings the live demo line (the ReceptionMate Demo garage, which needs
 * nothing from this file); the other rings a number pointed here, and a visitor
 * hears a real call the agent handled. Two numbers rather than a keypad menu
 * because a Bluetooth handset is only a hands-free device — dialling "9" on it
 * makes the phone place a cellular call to "9", which no network routes.
 *
 * The clip lives in S3 rather than in the repo so a take can be swapped by
 * uploading another object and changing ?clip= on the number, with no deploy
 * during a show.
 */

const router = Router();

/** The take played when the webhook carries no ?clip=. */
export const DEFAULT_CLIP = 'demo-call-short';

/**
 * Deliberately narrow. The clip name arrives on the query string, so a name of
 * '../../recordings/<id>' would otherwise presign a real customer call recording
 * out of the same bucket and play it down the line to a stranger.
 */
const CLIP_NAME = /^[a-z0-9-]{1,40}$/;

/** Twilio fetches the URL within a second or two; an hour is slack, not exposure. */
const URL_TTL_SECONDS = 3600;

const DEFAULT_INTRO =
  'Here is a real call our AI receptionist handled for a garage. '
  + 'Some customer details have been removed. Have a listen.';
const DEFAULT_OUTRO =
  'That was handled start to finish without a human. '
  + 'Press the other button to speak to it yourself.';

function xmlEscape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function showcallClipKey(clip?: string | null): string | null {
  const name = (clip || '').trim().toLowerCase() || DEFAULT_CLIP;
  if (!CLIP_NAME.test(name)) return null;
  return `showcall/${name}.mp3`;
}

export function buildShowcallTwiml(opts: { audioUrl: string; intro: string; outro: string }): string {
  const say = (text: string) =>
    text.trim() ? `  <Say voice="Polly.Amy-Neural">${xmlEscape(text.trim())}</Say>\n` : '';
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Response>\n'
    + say(opts.intro)
    + `  <Play>${xmlEscape(opts.audioUrl)}</Play>\n`
    + say(opts.outro)
    + '  <Hangup/>\n'
    + '</Response>';
}

/**
 * What a caller hears when the clip cannot be served.
 *
 * Twilio's own behaviour for a <Play> that 404s is to announce an application
 * error, and an empty <Response> is silence then a dead line. On a stand either
 * one reads as "their product is broken", so say something human instead.
 */
export function buildUnavailableTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Response>\n'
    + '  <Say voice="Polly.Amy-Neural">Sorry, the recording is not available just now. '
    + 'Please press the other button to speak to our AI receptionist live.</Say>\n'
    + '  <Hangup/>\n'
    + '</Response>';
}

/**
 * Read-only, so the default credential chain is enough here — unlike the write
 * paths, which need the explicit S3_* key (see ticketAttachments.ts). Built per
 * request rather than at import so the process starts even with no AWS config.
 */
function s3(): S3Client {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.S3_REGION || process.env.AWS_REGION || 'eu-west-2';
  return new S3Client({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

function bucket(): string {
  return process.env.S3_SHOWCALL_BUCKET
    || process.env.S3_ATTACHMENT_BUCKET
    || process.env.S3_MEDIA_BUCKET
    || process.env.S3_BUCKET
    || 'receptionmate-recordings';
}

// `all`, not `post`: Twilio sends POST by default, but a number configured by
// hand on the stand may well end up on GET, and a show is the wrong time to be
// debugging a 404 from the wrong verb.
router.all('/showcall', async (req: Request, res: Response) => {
  const clip = typeof req.query.clip === 'string' ? req.query.clip : undefined;
  const key = showcallClipKey(clip);
  res.type('text/xml');

  if (!key) {
    console.warn(`[SHOWCALL] Refusing clip name ${JSON.stringify(clip)}`);
    return res.send(buildUnavailableTwiml());
  }

  try {
    const client = s3();
    const Bucket = bucket();
    // HeadObject first so a missing or misnamed clip becomes a spoken line
    // rather than Twilio's "an application error has occurred".
    await client.send(new HeadObjectCommand({ Bucket, Key: key }));
    const audioUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), {
      expiresIn: URL_TTL_SECONDS,
    });
    console.log(`[SHOWCALL] Playing ${Bucket}/${key} to ${req.body?.From || req.query.From || 'caller'}`);
    return res.send(buildShowcallTwiml({
      audioUrl,
      intro: process.env.SHOWCALL_INTRO ?? DEFAULT_INTRO,
      outro: process.env.SHOWCALL_OUTRO ?? DEFAULT_OUTRO,
    }));
  } catch (error) {
    console.error(`[SHOWCALL] Could not serve ${key}:`, error);
    return res.send(buildUnavailableTwiml());
  }
});

export default router;
