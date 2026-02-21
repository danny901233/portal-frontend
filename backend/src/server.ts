import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import authRouter from './routes/auth.js';
import callsRouter from './routes/calls.js';
import configRouter from './routes/config.js';
import agentWebhookRouter from './routes/agentWebhook.js';
import adminRouter from './routes/admin.js';
import adminFbConnectionRouter from './routes/admin-fb-connection.js';
import voiceRouter from './routes/voice.js';
import voicePreviewRouter from './routes/voicePreview.js';
import twilioRouter from './routes/twilio.js';
import onboardingRouter from './routes/onboarding.js';
import paymentRouter from './routes/payment.js';
import messagesRouter from './routes/messages.js';
import billingRouter from './routes/billing.js';
import billingActivationRouter from './routes/billing-activation.js';
import customerBillingRouter from './routes/customer-billing.js';
import socialConnectionsRouter from './routes/social-connections.js';
import oauthRouter from './routes/oauth.js';
import smsRouter from './routes/sms.js';
import metaWhatsappWebhook from './routes/webhooks/meta-whatsapp.js';
import metaFacebookWebhook from './routes/webhooks/meta-facebook.js';
import metaInstagramWebhook from './routes/webhooks/meta-instagram.js';
import gocardlessWebhook from './routes/webhooks/gocardless.js';
import { errorHandler } from './middleware/errorHandler.js';
import { initializeScheduledReports } from './utils/scheduler.js';

const app = express();

const port = Number(process.env.PORT) || 4000;
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 86400, // 24 hours
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' })); // Parse form-urlencoded bodies (Twilio webhooks)
app.use(morgan('dev'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', callsRouter);
app.use('/api', configRouter);
app.use('/api', voicePreviewRouter);
app.use('/api/auth', authRouter);
app.use('/api', adminRouter);
app.use('/api', adminFbConnectionRouter);
app.use('/api', twilioRouter);
app.use('/api', onboardingRouter);
app.use('/api', paymentRouter);
app.use('/api', messagesRouter);
app.use('/api', billingRouter);
app.use('/api', billingActivationRouter);
app.use('/api/customer/billing', customerBillingRouter);
app.use('/api', socialConnectionsRouter);
app.use('/api', oauthRouter);
app.use('/api', smsRouter);
app.use('/api/webhooks', metaWhatsappWebhook);
app.use('/api/webhooks', metaFacebookWebhook);
app.use('/api/webhooks', metaInstagramWebhook);
app.use('/api/webhooks', gocardlessWebhook);
app.use('/webhooks', agentWebhookRouter);
app.use('/webhooks', voiceRouter);

app.use(errorHandler);

app.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${port}`);
  console.log('Effective WEBHOOK_SECRET:', JSON.stringify(process.env.WEBHOOK_SECRET ?? null));

  // Initialize scheduled report jobs
  initializeScheduledReports();
});
