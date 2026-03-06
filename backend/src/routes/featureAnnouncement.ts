import { Router, Request, Response } from 'express';
import { sendEmail } from '../utils/email.js';

const router = Router();

interface FeatureAnnouncementRequest {
  testEmail?: string;
  sendToAll?: boolean;
}

const createFeatureAnnouncementHTML = () => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Features - ReceptionMate</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background-color: #f4f7fa;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 40px 20px;
            text-align: center;
        }
        .header h1 {
            color: #ffffff;
            margin: 0;
            font-size: 28px;
            font-weight: 600;
        }
        .header p {
            color: #e0e7ff;
            margin: 10px 0 0 0;
            font-size: 16px;
        }
        .content {
            padding: 40px 30px;
        }
        .intro {
            font-size: 16px;
            line-height: 1.6;
            color: #374151;
            margin-bottom: 30px;
        }
        .feature {
            margin-bottom: 35px;
            padding-bottom: 30px;
            border-bottom: 1px solid #e5e7eb;
        }
        .feature:last-child {
            border-bottom: none;
        }
        .feature-title {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
        }
        .feature-icon {
            width: 40px;
            height: 40px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-right: 12px;
            font-size: 20px;
        }
        .feature h2 {
            color: #111827;
            font-size: 20px;
            margin: 0;
            font-weight: 600;
        }
        .feature p {
            color: #6b7280;
            font-size: 15px;
            line-height: 1.6;
            margin: 8px 0 0 0;
        }
        .feature ul {
            margin: 12px 0 0 0;
            padding-left: 20px;
        }
        .feature li {
            color: #6b7280;
            font-size: 15px;
            line-height: 1.6;
            margin-bottom: 8px;
        }
        .feature li strong {
            color: #374151;
        }
        .cta {
            text-align: center;
            margin: 40px 0;
        }
        .cta-button {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #ffffff;
            text-decoration: none;
            padding: 14px 32px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 16px;
        }
        .footer {
            background-color: #f9fafb;
            padding: 30px;
            text-align: center;
            border-top: 1px solid #e5e7eb;
        }
        .footer p {
            color: #6b7280;
            font-size: 14px;
            margin: 5px 0;
        }
        .footer a {
            color: #667eea;
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎉 Exciting New Features</h1>
            <p>ReceptionMate just got even better</p>
        </div>
        
        <div class="content">
            <p class="intro">
                We're thrilled to announce several powerful new features that make ReceptionMate even more effective at handling your customer interactions. Here's what's new:
            </p>
            
            <div class="feature">
                <div class="feature-title">
                    <div class="feature-icon">🎤</div>
                    <h2>Enhanced VRM Recognition</h2>
                </div>
                <p>
                    Our AI agent now handles slower speakers with improved patience and accuracy. When customers spell their registration numbers letter-by-letter with natural pauses, the agent stays perfectly silent and collects the information accurately – no more interruptions or repeated requests.
                </p>
            </div>
            
            <div class="feature">
                <div class="feature-title">
                    <div class="feature-icon">💬</div>
                    <h2>Webchat Live Chat Widget</h2>
                </div>
                <p>
                    Give your customers the freedom to choose how they connect with you. Our new webchat widget lets customers select their preferred communication method:
                </p>
                <ul>
                    <li><strong>WhatsApp:</strong> Instant messaging on their favourite platform</li>
                    <li><strong>SMS:</strong> Simple text-based communication</li>
                    <li><strong>Live Chat:</strong> Real-time conversation on your website</li>
                    <li><strong>Voice Call:</strong> Traditional phone support when needed</li>
                </ul>
                <p>
                    All channels integrated seamlessly in one place, ensuring no customer inquiry is missed.
                </p>
            </div>
            
            <div class="feature">
                <div class="feature-title">
                    <div class="feature-icon">📅</div>
                    <h2>24/7 Diary Integration</h2>
                </div>
                <p>
                    Unlike traditional message-taking bots, our AI doesn't just answer questions – it takes action. The system can physically book customers into all your branches around the clock, with zero manual intervention required. Your diary stays full even when you're closed.
                </p>
            </div>
            
            <div class="feature">
                <div class="feature-title">
                    <div class="feature-icon">🔔</div>
                    <h2>Smart MOT/Service Reminders</h2>
                </div>
                <p>
                    Transform automated reminders into actual bookings. Instead of sending a basic reminder message, the AI sends a human-like message and can take the booking immediately – no need for customers to call back or fill out online forms. Higher conversion, less hassle.
                </p>
            </div>
            
            <div class="feature">
                <div class="feature-title">
                    <div class="feature-icon">🔄</div>
                    <h2>Flexible Drop-Off Booking</h2>
                </div>
                <p>
                    New toggle switch for garages that prefer date-only bookings. Rather than offering specific timeslots, the AI can now offer availability for entire days with customizable drop-off instructions (e.g., "drop your vehicle off between 8-10:30am"). Perfect for garages with flexible workflow – and you can still use specific timeslots for MOTs or other services that need them.
                </p>
            </div>
            
            <div class="feature">
                <div class="feature-title">
                    <div class="feature-icon">👤</div>
                    <h2>Smart Human Handover</h2>
                </div>
                <p>
                    When customers request to speak with a human or the AI encounters a query it can't handle, the conversation is automatically flagged with all relevant information gathered. Your team can pick up seamlessly exactly where the AI left off, ensuring a smooth customer experience.
                </p>
            </div>
            
            <div class="cta">
                <a href="https://app.receptionmate.co.uk/dashboard" class="cta-button">
                    Explore These Features
                </a>
            </div>
            
            <p class="intro" style="margin-top: 40px; font-size: 15px;">
                All these features are now live in your account. If you have any questions or need help configuring them, our support team is ready to assist.
            </p>
        </div>
        
        <div class="footer">
            <p><strong>ReceptionMate</strong></p>
            <p>Your AI-powered reception assistant</p>
            <p style="margin-top: 15px;">
                <a href="https://receptionmate.co.uk">Visit our website</a> | 
                <a href="mailto:support@receptionmate.co.uk">Contact support</a>
            </p>
        </div>
    </div>
</body>
</html>
`;
};

const createFeatureAnnouncementText = () => {
  return `
🎉 EXCITING NEW FEATURES - RECEPTIONMATE

We're thrilled to announce several powerful new features that make ReceptionMate even more effective at handling your customer interactions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎤 ENHANCED VRM RECOGNITION

Our AI agent now handles slower speakers with improved patience and accuracy. When customers spell their registration numbers letter-by-letter with natural pauses, the agent stays perfectly silent and collects the information accurately – no more interruptions or repeated requests.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💬 WEBCHAT LIVE CHAT WIDGET

Give your customers the freedom to choose how they connect with you. Our new webchat widget lets customers select their preferred communication method:

• WhatsApp: Instant messaging on their favourite platform
• SMS: Simple text-based communication
• Live Chat: Real-time conversation on your website
• Voice Call: Traditional phone support when needed

All channels integrated seamlessly in one place, ensuring no customer inquiry is missed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📅 24/7 DIARY INTEGRATION

Unlike traditional message-taking bots, our AI doesn't just answer questions – it takes action. The system can physically book customers into all your branches around the clock, with zero manual intervention required. Your diary stays full even when you're closed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔔 SMART MOT/SERVICE REMINDERS

Transform automated reminders into actual bookings. Instead of sending a basic reminder message, the AI sends a human-like message and can take the booking immediately – no need for customers to call back or fill out online forms. Higher conversion, less hassle.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔄 FLEXIBLE DROP-OFF BOOKING

New toggle switch for garages that prefer date-only bookings. Rather than offering specific timeslots, the AI can now offer availability for entire days with customizable drop-off instructions (e.g., "drop your vehicle off between 8-10:30am"). Perfect for garages with flexible workflow – and you can still use specific timeslots for MOTs or other services that need them.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

👤 SMART HUMAN HANDOVER

When customers request to speak with a human or the AI encounters a query it can't handle, the conversation is automatically flagged with all relevant information gathered. Your team can pick up seamlessly exactly where the AI left off, ensuring a smooth customer experience.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All these features are now live in your account. If you have any questions or need help configuring them, our support team is ready to assist.

Explore these features: https://app.receptionmate.co.uk/dashboard

Best regards,
The ReceptionMate Team

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ReceptionMate - Your AI-powered reception assistant
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

    const recipients = testEmail ? [testEmail] : [];
    
    // TODO: If sendToAll is true, fetch all customer emails from database
    // const customers = await prisma.user.findMany({
    //   where: { role: 'customer', emailNotifications: true },
    //   select: { email: true }
    // });
    // recipients = customers.map(c => c.email);

    const html = createFeatureAnnouncementHTML();
    const text = createFeatureAnnouncementText();

    const success = await sendEmail({
      to: recipients,
      subject: '🎉 New Features: Enhanced VRM Recognition, Webchat Widget & More',
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

export default router;
