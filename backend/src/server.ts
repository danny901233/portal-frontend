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
import onboardingPipelineRouter from './routes/onboarding-pipeline.js';
import garagehiveConnectRouter from './routes/garagehive-connect.js';
import customerBillingRouter from './routes/customer-billing.js';
import socialConnectionsRouter from './routes/social-connections.js';
import oauthRouter from './routes/oauth.js';
import connectSignupRouter from './routes/connect-signup.js';
import connectBillingRouter from './routes/connect-billing.js';
import smsRouter from './routes/sms.js';
import widgetRouter from './routes/widget.js';
import chatRouter from './routes/chat.js';
import conversationsRouter from './routes/conversations.js';
import outboundRouter from './routes/outbound.js';
import outboundCallsRouter from './routes/outbound-calls.js';
import templatesRouter from './routes/templates.js';
import metaWhatsappWebhook from './routes/webhooks/meta-whatsapp.js';
import metaFacebookWebhook from './routes/webhooks/meta-facebook.js';
import metaInstagramWebhook from './routes/webhooks/meta-instagram.js';
import gocardlessWebhook from './routes/webhooks/gocardless.js';
import stripeWebhook from './routes/webhooks/stripe.js';
import livekitDemoRouter from './routes/livekit-demo.js';
import featureAnnouncementRouter from './routes/featureAnnouncement.js';
import usersRouter from './routes/users.js';
import publicSignupRouter from './routes/public-signup.js';
import publicStatsRouter from './routes/public-stats.js';
import publicLeadRouter from './routes/public-lead.js';
import agreementsRouter from './routes/agreements.js';
import supportRouter from './routes/support.js';
import deviceTokensRouter from './routes/deviceTokens.js';
import { errorHandler } from './middleware/errorHandler.js';
import { initializeScheduledReports } from './utils/scheduler.js';
import { initConnectTrialCron } from './utils/connectTrialCron.js';
import { startArrearsSweep } from './utils/arrears.js';
import billingStatusRouter from './routes/billing-status.js';
import publicProspectRouter from './routes/public-prospect.js';

const app = express();

const port = Number(process.env.PORT) || 4000;
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());

// Anything under /api/public/* is intentionally public + cross-origin
// (marketing stats + lead capture). Mounted BEFORE the strict CORS below
// so any origin can call it; needs POST too for the lead endpoint.
// `/api/public-signup` is included explicitly because Express's path-prefix
// match treats the hyphen as a boundary and wouldn't otherwise pick it up.
const PUBLIC_CORS_PATHS = ['/api/public', '/api/public-signup', '/api/livekit'];
app.use(
  PUBLIC_CORS_PATHS,
  cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['Content-Type'], maxAge: 86400 }),
);

// Strict CORS for the authenticated portal API. We SKIP /api/public so
// the permissive CORS above isn't overridden when the browser hits the
// public endpoints from a non-portal origin.
const strictCors = cors({
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
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/public/') || req.path === '/api/public-signup') return next();
  if (req.path.startsWith('/api/livekit/')) return next();
  // Webhook callbacks come from third-party services (Stripe, GoCardless,
  // Meta, Twilio) — no browser origin, so CORS doesn't apply. Let them pass.
  if (req.path.startsWith('/api/webhooks/')) return next();
  return strictCors(req, res, next);
});

// Mount Stripe webhook BEFORE the JSON body parser — Stripe signs the raw
// request body, and `express.raw` inside the router needs to capture the
// untouched bytes. Mounting after express.json() would consume the stream
// before our handler gets to see it.
app.use('/api/webhooks', stripeWebhook);

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
app.use('/api', onboardingPipelineRouter);
app.use('/api', garagehiveConnectRouter);
app.use('/api/customer/billing', customerBillingRouter);
app.use('/api', billingStatusRouter);
app.use('/api', publicProspectRouter);
app.use('/api', socialConnectionsRouter);
app.use('/api', oauthRouter);
app.use('/api/public/connect-signup', connectSignupRouter);
app.use('/api', connectBillingRouter);
app.use('/api', smsRouter);
app.use('/api', widgetRouter);
app.use('/api', chatRouter);
app.use('/api', conversationsRouter);
app.use('/api', outboundRouter);
app.use('/api', outboundCallsRouter);
app.use('/api', featureAnnouncementRouter);
app.use('/api', usersRouter);
app.use('/api', publicSignupRouter);
app.use('/api', publicStatsRouter);
app.use('/api', publicLeadRouter);
app.use('/api', livekitDemoRouter);
app.use('/api', agreementsRouter);
app.use('/api', supportRouter);
app.use('/api', deviceTokensRouter);
app.use('/api', templatesRouter);
app.use('/api/webhooks', metaWhatsappWebhook);
app.use('/api/webhooks', metaFacebookWebhook);
app.use('/api/webhooks', metaInstagramWebhook);
app.use('/api/webhooks', gocardlessWebhook);
app.use('/webhooks', agentWebhookRouter);
app.use('/webhooks', voiceRouter);

app.use(errorHandler);

// Last-resort process guards. An async route handler that rejects without going
// through next(err) bypasses the Express errorHandler above and, under Node 20,
// terminates the process — which pm2 then restarts. A single bad request (e.g. a
// support-chat upsert with a stale userId) can therefore crash-loop the whole
// backend, taking down calls, chat and WhatsApp for every garage and wiping the
// in-memory chat-delay reply timers. Log loudly and keep serving instead.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

app.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${port}`);
  console.log('Effective WEBHOOK_SECRET:', JSON.stringify(process.env.WEBHOOK_SECRET ?? null));

  // Initialize scheduled report jobs
  initializeScheduledReports();
  initConnectTrialCron();

  // Backstop sweep: auto-lock garages whose Stripe payment has been failed past the grace window.
  startArrearsSweep();
});
