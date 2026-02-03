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

    // Log the phone number being purchased
    console.log(`Attempting to purchase phone number: ${phoneNumber}`);

    // Fetch regulatory bundles for UK compliance
    const allBundles = await twilioClient.numbers.regulatoryCompliance.bundles.list({
      limit: 20,
    });

    // Log all bundles for debugging
    console.log('All bundles:', allBundles.map((b: any) => ({
      sid: b.sid,
      status: b.status,
      regulationType: b.regulationType,
      friendlyName: b.friendlyName,
    })));

    // Filter for approved bundles
    const approvedBundles = allBundles.filter((b: any) =>
      b.status === 'twilio-approved' || b.status === 'approved'
    );

    console.log('Approved bundles:', approvedBundles.length);

    if (!approvedBundles.length) {
      return res.status(400).json({
        error: 'No approved regulatory bundle found',
        details: 'UK phone numbers require an approved regulatory compliance bundle. Please create and submit one in your Twilio console under Regulatory Compliance > Bundles.',
      });
    }

    // Use the specific National bundle and associated address
    const bundleSid = 'BU30e5e37d9313ac7e38c42777d9dcbfc0';
    const addressSid = 'AD3c5a548136ce529b4e43e934762cbfec';

    console.log(`Using National bundle: ${bundleSid} with associated address: ${addressSid}`);
    console.log('Purchase request parameters:', {
      phoneNumber,
      bundleSid,
      addressSid,
    });

    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber,
      bundleSid,
      addressSid,
    });

    console.log('Purchase successful!', purchasedNumber.sid);

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

    let errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Provide helpful context for common errors
    if (error?.code === 21649) {
      errorMessage = 'This phone number type is not compatible with your National bundle. Try: 1) Use manual entry to add an existing Twilio number, or 2) Purchase via Twilio Console where compatibility is checked automatically.';
    } else if (error?.code === 21651) {
      errorMessage = 'Address not linked to bundle. Please verify the address is associated with the bundle in Twilio Console.';
    }

    res.status(500).json({
      error: 'Failed to purchase number',
      details: errorMessage,
      code: error?.code,
      twilioMessage: error?.message,
    });
  }
});

export default router;
