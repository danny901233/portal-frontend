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

/**
 * Twilio files UK numbers under three separate regulatory bundles, and provisioning fails with
 * error 21649 if the bundle does not match the number's regulation type. The catch is that the
 * `local` search endpoint returns 03xx numbers alongside geographic ones, so an operator picking
 * from one result list can land on a number our Local bundle is not allowed to buy. Pick the
 * bundle from the number itself rather than assuming every result is geographic.
 */
function bundleForNumber(phoneNumber: string): { bundleSid?: string; addressSid?: string; kind: string } {
  const digits = phoneNumber.replace(/[^0-9]/g, '');
  const gb = digits.startsWith('44') ? digits.slice(2) : digits;

  // 07xxx — UK mobile.
  if (gb.startsWith('7')) {
    return {
      bundleSid: process.env.TWILIO_BUNDLE_SID_MOBILE,
      addressSid: process.env.TWILIO_ADDRESS_SID_MOBILE,
      kind: 'mobile',
    };
  }
  // 03xx / 08xx — non-geographic, needs the National bundle.
  if (gb.startsWith('3') || gb.startsWith('8')) {
    return {
      bundleSid: process.env.TWILIO_BUNDLE_SID_NATIONAL,
      addressSid: process.env.TWILIO_ADDRESS_SID_NATIONAL,
      kind: 'national',
    };
  }
  // 01xx / 02xx — geographic.
  return {
    bundleSid: process.env.TWILIO_BUNDLE_SID,
    addressSid: process.env.TWILIO_ADDRESS_SID,
    kind: 'local',
  };
}

// Search for available Twilio numbers
router.post('/admin/twilio/available-numbers', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const parsed = searchNumbersSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { areaCode, countryCode, contains, limit } = parsed.data;

    // `areaCode` is a North-American concept. Twilio silently returns an empty list for GB,
    // so the admin area-code box looked broken. For GB, express it as a dialling-code prefix
    // pattern instead — '1484' becomes '441484*', which is what Twilio actually matches on.
    const gbAreaPattern =
      countryCode === 'GB' && areaCode ? `44${String(areaCode).replace(/^0+/, '')}*` : undefined;

    const availableNumbers = await twilioClient.availablePhoneNumbers(countryCode)
      .local
      .list({
        ...(gbAreaPattern ? {} : { areaCode }),
        contains: contains || gbAreaPattern,
        limit,
      });

    res.json({
      numbers: availableNumbers.map((num: any) => ({
        phoneNumber: num.phoneNumber,
        friendlyName: num.friendlyName,
        locality: num.locality,
        region: num.region,
        capabilities: num.capabilities,
        // Twilio mixes non-geographic 03xx numbers into the `local` results; say which is which
        // so the UI can show it and nobody wonders why one number behaves differently.
        numberType: bundleForNumber(num.phoneNumber).kind,
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

    // Match the bundle to the number's regulation type. Using the Local bundle for an 03xx
    // number is what made 'failed to purchase number' look random: it depended entirely on
    // whether Twilio's result page happened to include a non-geographic number.
    const { bundleSid, addressSid, kind } = bundleForNumber(phoneNumber);
    if (!bundleSid || !addressSid) {
      return res.status(500).json({
        error: `No regulatory bundle configured for ${kind} UK numbers`,
        details: `Set TWILIO_BUNDLE_SID${kind === 'local' ? '' : '_' + kind.toUpperCase()} and the matching address SID.`,
      });
    }

    console.log(`Using ${kind} bundle: ${bundleSid} with address: ${addressSid}`);
    console.log('Attempting to purchase:', phoneNumber);

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
