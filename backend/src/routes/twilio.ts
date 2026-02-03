import { Router } from 'express';
import twilio from 'twilio';
import { z } from 'zod';
import { authenticateApiKey, requireAdmin } from '../middleware/auth.js';

const router = Router();

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const searchNumbersSchema = z.object({
  areaCode: z.string().optional().transform(val => val ? parseInt(val, 10) : undefined),
  countryCode: z.string().default('GB'),
  contains: z.string().optional(),
  limit: z.number().min(1).max(50).optional().default(10),
});

const purchaseNumberSchema = z.object({
  phoneNumber: z.string(),
});

// Search for available Twilio numbers
router.post('/admin/twilio/available-numbers', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const parsed = searchNumbersSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { areaCode, countryCode, contains, limit } = parsed.data;

    const availableNumbers = await twilioClient.availablePhoneNumbers(countryCode)
      .local
      .list({
        areaCode,
        contains,
        limit,
      });

    res.json({
      numbers: availableNumbers.map((num: any) => ({
        phoneNumber: num.phoneNumber,
        friendlyName: num.friendlyName,
        locality: num.locality,
        region: num.region,
        capabilities: num.capabilities,
      })),
    });
  } catch (error: any) {
    console.error('Twilio search failed:', error);
    console.error('Error details:', {
      message: error?.message,
      code: error?.code,
      status: error?.status,
      moreInfo: error?.moreInfo,
    });
    res.status(500).json({
      error: 'Failed to search numbers',
      details: error instanceof Error ? error.message : 'Unknown error',
      code: error?.code,
    });
  }
});

// Purchase a Twilio number
router.post('/admin/twilio/purchase', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const parsed = purchaseNumberSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { phoneNumber } = parsed.data;

    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber,
    });

    res.status(201).json({
      success: true,
      phoneNumber: purchasedNumber.phoneNumber,
      sid: purchasedNumber.sid,
      friendlyName: purchasedNumber.friendlyName,
    });
  } catch (error: any) {
    console.error('Twilio purchase failed:', error);
    console.error('Error details:', {
      message: error?.message,
      code: error?.code,
      status: error?.status,
      moreInfo: error?.moreInfo,
    });
    res.status(500).json({
      error: 'Failed to purchase number',
      details: error instanceof Error ? error.message : 'Unknown error',
      code: error?.code,
    });
  }
});

export default router;
