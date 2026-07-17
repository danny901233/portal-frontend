import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type OpenAI from 'openai';

// Chat media (customer photos) lives in a PRIVATE S3 bucket, so a vision model can't fetch the raw
// URL. Presign a short-lived GET URL it can read. Mirrors the /media/signed-url route in messages.ts.
export async function presignChatImage(url: string): Promise<string | null> {
  try {
    const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) return null;
    const bucket = process.env.S3_MEDIA_BUCKET || process.env.S3_BUCKET || 'receptionmate-recordings';
    const region = process.env.AWS_REGION || 'eu-west-2';
    const key = new URL(url).pathname.replace(/^\//, '');
    const s3 = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 600 });
  } catch (e: any) {
    console.error('[CHAT_MEDIA] presignChatImage failed:', e?.message);
    return null;
  }
}

// If the message is a customer image attachment, returns the vision content parts (text + image_url)
// for a gpt-4o user message; otherwise null. Pass the result as the message `content`.
export async function imageMessageContent(
  msg: { content: string; mediaType?: string | null; mediaUrl?: string | null },
): Promise<OpenAI.Chat.ChatCompletionContentPart[] | null> {
  if (!msg.mediaType?.startsWith('image/') || !msg.mediaUrl) return null;
  const signed = await presignChatImage(msg.mediaUrl);
  if (!signed) return null;
  const caption = msg.content && !['[Image]', '[Customer sent an image]'].includes(msg.content)
    ? msg.content
    : 'The customer sent this image. Use it to help — e.g. read a registration plate, logbook/V5C, or dashboard warning light.';
  return [
    { type: 'text', text: caption },
    { type: 'image_url', image_url: { url: signed } },
  ];
}
