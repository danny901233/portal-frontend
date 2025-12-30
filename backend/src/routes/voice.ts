import type { Request, Response } from 'express';
import { Router } from 'express';

const router = Router();

router.post('/voice', async (req: Request, res: Response) => {
  const { garageId } = req.query;

  if (!garageId || typeof garageId !== 'string') {
    return res.status(400).send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid request</Say></Response>');
  }

  // Get the LiveKit SIP domain from environment
  const livekitSipDomain = process.env.LIVEKIT_SIP_DOMAIN || 'n4s20ufg0v7.sip.livekit.cloud';

  // Return TwiML that dials the LiveKit SIP address
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip>sip:${garageId}@${livekitSipDomain}</Sip>
  </Dial>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

export default router;
