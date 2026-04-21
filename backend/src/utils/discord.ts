/**
 * Discord webhook utility — sends formatted notifications to a Discord channel.
 * Reads DISCORD_WEBHOOK_URL from env. If not set, silently skips.
 */

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbedOptions {
  title: string;
  description?: string;
  color?: number;
  fields?: DiscordField[];
}

// Colours matching the existing agent convention
export const DISCORD_COLORS = {
  error:   0xFF0000,
  warning: 0xFFA500,
  success: 0x00FF00,
  info:    0x0099FF,
};

export async function sendDiscordNotification(options: DiscordEmbedOptions): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const body = {
    embeds: [
      {
        title: options.title,
        description: options.description ?? '',
        color: options.color ?? DISCORD_COLORS.info,
        fields: options.fields ?? [],
        timestamp: new Date().toISOString(),
        footer: { text: 'ReceptionMate Portal' },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText}`);
  }
}
