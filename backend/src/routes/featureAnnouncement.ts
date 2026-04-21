import { Router, Request, Response } from 'express';
import { sendEmail } from '../utils/email.js';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

interface FeatureAnnouncementRequest {
  testEmail?: string;
  sendToAll?: boolean;
}

const createFeatureAnnouncementHTML = () => {
  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Features - ReceptionMate</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #09203c;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #09203c;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #1a3a52; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
          <!-- Header with Logo -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%);">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 32px 32px 8px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                      <tr>
                        <td>
                          <img src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png" alt="ReceptionMate Logo" width="200" height="auto" style="display: block; border: 0; outline: none; text-decoration: none; max-width: 200px; height: auto;" />
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="text-align: center; padding: 16px 32px 32px;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 600; color: #ffffff;">
                      Exciting New Features Are Here
                    </h2>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding-bottom: 24px;">
                    <p style="margin: 0; font-size: 16px; line-height: 1.7; color: rgba(255,255,255,0.9);">
                      We're excited to announce two new features that make ReceptionMate even more powerful for your garage. These updates have been designed based on your feedback to make customer interactions smoother and more efficient.
                    </p>
                  </td>
                </tr>
                
                <!-- Feature 1 -->
                <tr>
                  <td style="padding: 24px 0;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #243e56; border-radius: 8px; padding: 24px;">
                      <tr>
                        <td>
                          <h3 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 600; color: #ffffff;">
                            🎤 Enhanced VRM Recognition
                          </h3>
                          <p style="margin: 0 0 12px 0; font-size: 15px; line-height: 1.7; color: rgba(255,255,255,0.9);">
                            Our AI voice agent now handles slower speakers with exceptional patience and accuracy. When customers spell their registration numbers letter-by-letter with natural pauses between characters, the agent stays perfectly silent and collects the information accurately – no more awkward interruptions or repeated requests.
                          </p>
                          <p style="margin: 0; font-size: 15px; line-height: 1.7; color: rgba(255,255,255,0.75);">
                            <strong style="color: #ffffff;">Perfect for:</strong> Elderly customers, those on hands-free, or anyone spelling carefully. The agent now waits patiently for complete input before responding.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                
                <!-- Feature 2 -->
                <tr>
                  <td style="padding: 0 0 24px 0;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #243e56; border-radius: 8px; padding: 24px;">
                      <tr>
                        <td>
                          <h3 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 600; color: #ffffff;">
                            🔄 Flexible Drop-Off Booking
                          </h3>
                          <p style="margin: 0 0 12px 0; font-size: 15px; line-height: 1.7; color: rgba(255,255,255,0.9);">
                            New configurable toggle switch that lets you choose between specific timeslots or flexible date-only bookings. Perfect for garages with adaptable workflows.
                          </p>
                          <p style="margin: 0 0 12px 0; font-size: 15px; line-height: 1.7; color: rgba(255,255,255,0.75);">
                            <strong style="color: #ffffff;">How it works:</strong> Instead of offering "9:00am, 10:00am, 11:00am", the AI can now say "We have availability on Thursday the 12th – you can drop your vehicle off between 8-10:30am" with your custom message.
                          </p>
                          <p style="margin: 0; font-size: 15px; line-height: 1.7; color: rgba(255,255,255,0.75);">
                            <strong style="color: #ffffff;">Smart exceptions:</strong> You can still enforce specific timeslots for services that need them (like MOTs), while keeping flexibility for general repairs and servicing.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                
                <!-- CTA Button -->
                <tr>
                  <td style="text-align: center; padding: 8px 0 24px 0;">
                    <a href="https://app.receptionmate.co.uk/dashboard" style="display: inline-block; background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                      Configure These Features Now
                    </a>
                  </td>
                </tr>
                
                <tr>
                  <td style="padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.1);">
                    <p style="margin: 0; font-size: 15px; line-height: 1.7; color: rgba(255,255,255,0.75);">
                      Both features are live in your account right now. Need help setting them up or have questions? Our support team is standing by.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #0d2137; text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 13px; color: rgba(255,255,255,0.6);">
                This is an automated notification from <strong style="color: #3126cf;">ReceptionMate</strong>
              </p>
              <p style="margin: 0; font-size: 13px; color: rgba(255,255,255,0.6);">
                <a href="https://app.receptionmate.co.uk/dashboard" style="color: #3126cf; text-decoration: none;">Dashboard</a> · 
                <a href="https://receptionmate.co.uk" style="color: #3126cf; text-decoration: none;">Website</a> · 
                <a href="mailto:support@receptionmate.co.uk" style="color: #3126cf; text-decoration: none;">Support</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
};

const createFeatureAnnouncementText = () => {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

                    RECEPTIONMATE
        
          EXCITING NEW FEATURES ARE HERE

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

We're excited to announce two new features that make ReceptionMate even more powerful for your garage. These updates have been designed based on your feedback to make customer interactions smoother and more efficient.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎤 ENHANCED VRM RECOGNITION

Our AI voice agent now handles slower speakers with exceptional patience and accuracy. When customers spell their registration numbers letter-by-letter with natural pauses between characters, the agent stays perfectly silent and collects the information accurately – no more awkward interruptions or repeated requests.

PERFECT FOR: Elderly customers, those on hands-free, or anyone spelling carefully. The agent now waits patiently for complete input before responding.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔄 FLEXIBLE DROP-OFF BOOKING

New configurable toggle switch that lets you choose between specific timeslots or flexible date-only bookings. Perfect for garages with adaptable workflows.

HOW IT WORKS: Instead of offering "9:00am, 10:00am, 11:00am", the AI can now say "We have availability on Thursday the 12th – you can drop your vehicle off between 8-10:30am" with your custom message.

SMART EXCEPTIONS: You can still enforce specific timeslots for services that need them (like MOTs), while keeping flexibility for general repairs and servicing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Both features are live in your account right now. Need help setting them up or have questions? Our support team is standing by.

Configure these features: https://app.receptionmate.co.uk/dashboard

Best regards,
The ReceptionMate Team

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RECEPTIONMATE
Your AI-powered reception assistant working 24/7

Dashboard: https://app.receptionmate.co.uk/dashboard
Website: https://receptionmate.co.uk
Support: support@receptionmate.co.uk
`;
};

router.post('/send-feature-announcement', async (req: Request, res: Response) => {
  try {
    const { testEmail, sendToAll }: FeatureAnnouncementRequest = req.body;

    if (!testEmail && !sendToAll) {
      return res.status(400).json({ 
        error: 'Either testEmail or sendToAll must be provided' 
      });
    }

    let recipients: string[] = [];
    
    if (testEmail) {
      recipients = [testEmail];
    } else if (sendToAll) {
      // Fetch all customer users from database (excluding RECEPTIONMATE_STAFF)
      const users = await prisma.user.findMany({
        where: { 
          role: {
            in: ['USER', 'MANAGER']
          }
        },
        select: { email: true }
      });
      recipients = users.map(u => u.email);
      console.log(`Sending feature announcement to ${recipients.length} users`);
    }

    const html = createFeatureAnnouncementHTML();
    const text = createFeatureAnnouncementText();

    const success = await sendEmail({
      to: recipients,
      subject: 'New Features Now Live',
      html,
      text,
    });

    if (success) {
      return res.json({ 
        success: true, 
        message: `Feature announcement sent to ${recipients.length} recipient(s)`,
        recipients 
      });
    } else {
      return res.status(500).json({ 
        error: 'Failed to send email. Check email configuration.' 
      });
    }
  } catch (error) {
    console.error('Error sending feature announcement:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Export function for scheduled sending
export const sendFeatureAnnouncementToAll = async (): Promise<{ success: boolean; count: number }> => {
  try {
    // Fetch all customer users from database (excluding RECEPTIONMATE_STAFF)
    const users = await prisma.user.findMany({
      where: { 
        role: {
          in: ['USER', 'MANAGER']
        }
      },
      select: { email: true }
    });
    const recipients = users.map(u => u.email);
    console.log(`Sending scheduled feature announcement to ${recipients.length} users`);

    const html = createFeatureAnnouncementHTML();
    const text = createFeatureAnnouncementText();

    const success = await sendEmail({
      to: recipients,
      subject: 'New Features Now Live',
      html,
      text,
    });

    return { success, count: recipients.length };
  } catch (error) {
    console.error('Error sending scheduled feature announcement:', error);
    return { success: false, count: 0 };
  }
};

export default router;
