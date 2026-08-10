import type { Request, Response } from 'express';
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { resolveAllowedGarages } from '../utils/auth.js';
import { prisma } from '../db.js';

const router = Router();

// Map of voice names to ElevenLabs voice IDs
const VOICE_IDS: Record<string, string> = {
  tom: 'Fahco4VZzobUeiPqni1S',
  leah: 'rfkTsdZrVWEVhDycUYn9',
  sophie: 'fq1SdXsX6OokE10pJ4Xw',
  gemma: 'IosqM5LMIzqPfT0efhhy',
  isobel: 'h8eW5xfRUGVJrZhAFxqK',
  fraser: 'v2zbX16tJNtRIx8rSHDM',
  amelia: '21m00Tcm4TlvDq8ikWAM',
};

router.post(
  '/garages/:garageId/voice-preview',
  authenticate,
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const { voiceId, lang } = req.body;
    const isFrench = lang === 'fr';

    const allowedGarages = resolveAllowedGarages(req.user);
    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!voiceId || !VOICE_IDS[voiceId]) {
      return res.status(400).json({ error: 'Invalid voice ID' });
    }

    try {
      // Get the garage's greeting line
      const config = await prisma.agentConfiguration.findUnique({
        where: { garageId },
        select: { greetingLine: true },
      });

      const fallback = isFrench
        ? 'Bonjour, comment puis-je vous aider aujourd’hui ?'
        : 'Hello, how can I help you today?';
      const text = config?.greetingLine?.trim() || fallback;
      const elevenLabsVoiceId = VOICE_IDS[voiceId];
      const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;

      if (!elevenLabsApiKey) {
        return res.status(500).json({ error: 'ElevenLabs API key not configured' });
      }

      // Call ElevenLabs API to generate audio
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}`,
        {
          method: 'POST',
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': elevenLabsApiKey,
          },
          body: JSON.stringify({
            text,
            // Multilingual model for French so the accent/pronunciation is
            // correct; keep the English-only model for English previews.
            model_id: isFrench ? 'eleven_multilingual_v2' : 'eleven_monolingual_v1',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.5,
            },
          }),
        }
      );

      if (!response.ok) {
        console.error('ElevenLabs API error:', await response.text());
        return res.status(502).json({ error: 'Failed to generate voice preview' });
      }

      // Stream the audio back to the client
      res.setHeader('Content-Type', 'audio/mpeg');
      const audioBuffer = await response.arrayBuffer();
      res.send(Buffer.from(audioBuffer));
    } catch (error) {
      console.error('Voice preview error:', error);
      return res.status(500).json({ error: 'Failed to generate voice preview' });
    }
  }
);

export default router;
