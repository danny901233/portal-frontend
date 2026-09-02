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
import widgetRouter from './routes/widget.js';
import chatRouter from './routes/chat.js';
import conversationsRouter from './routes/conversations.js';
import outboundRouter from './routes/outbound.js';
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
import supportVoiceRouter from './routes/support-voice.js';
import opsTasksRouter from './routes/opsTasks.js';
import deviceTokensRouter from './routes/deviceTokens.js';
import { errorHandler, installProcessErrorHandlers } from './middleware/errorHandler.js';
import { trackActingUser } from './utils/actingUser.js';
import { initializeScheduledReports } from './utils/scheduler.js';
import { initReminderCron } from './services/reminderScheduler.js';
import { startArrearsSweep } from './utils/arrears.js';
import billingStatusRouter from './routes/billing-status.js';
import outboundCallsRouter from './routes/outbound-calls.js';
import publicProspectRouter from './routes/public-prospect.js';
import connectSignupRouter from './routes/connect-signup.js';
import connectBillingRouter from './routes/connect-billing.js';
import { initTrialCron } from './utils/trialCron.js';
import { resumePendingReplies } from './services/chatDelay.js';

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

// Kill slow requests after 30s instead of letting them hang until the socket resets.
// Webhooks and streaming endpoints are excluded — they have their own lifecycle.
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks') || req.path.includes('/recording/')) return next();
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error(`[TIMEOUT] ${req.method} ${req.originalUrl} exceeded 30s`);
      res.status(408).json({ error: 'Request timeout' });
    }
  }, 30_000);
  res.on('finish', () => clearTimeout(timeout));
  res.on('close', () => clearTimeout(timeout));
  next();
});

// Carry the signed-in user through the request so the garage audit hook in db.ts can record who
// made a change. Reads req.user when it is there and is harmless when it is not.
app.use(trackActingUser);

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
app.use('/api', billingStatusRouter);
app.use('/api', outboundCallsRouter);
app.use('/api', publicProspectRouter);
app.use('/api', socialConnectionsRouter);
app.use('/api', oauthRouter);
app.use('/api', smsRouter);
app.use('/api', widgetRouter);
app.use('/api', chatRouter);
app.use('/api', conversationsRouter);
app.use('/api', outboundRouter);
app.use('/api', featureAnnouncementRouter);
app.use('/api', usersRouter);
app.use('/api', publicSignupRouter);
app.use('/api', publicStatsRouter);
app.use('/api', publicLeadRouter);
app.use('/api/public/connect-signup', connectSignupRouter);
app.use('/api', connectBillingRouter);
app.use('/api', livekitDemoRouter);
app.use('/api', agreementsRouter);
app.use('/api', supportRouter);
app.use('/api', supportVoiceRouter);
app.use('/api', opsTasksRouter);
app.use('/api', deviceTokensRouter);
app.use('/api', templatesRouter);
app.use('/api/webhooks', metaWhatsappWebhook);
app.use('/api/webhooks', metaFacebookWebhook);
app.use('/api/webhooks', metaInstagramWebhook);
app.use('/api/webhooks', gocardlessWebhook);
app.use('/webhooks', agentWebhookRouter);
app.use('/webhooks', voiceRouter);

// Faults with no request behind them used to vanish silently. Install before anything starts
// listening so a throw during startup is reported too.
installProcessErrorHandlers();

app.use(errorHandler);

app.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${port}`);
  console.log('Effective WEBHOOK_SECRET:', JSON.stringify(process.env.WEBHOOK_SECRET ?? null));

  // Anything we owed a customer when the last process stopped. Deploys land mid-conversation
  // and the reply must outlive them.
  void resumePendingReplies();

  // Initialize scheduled report jobs
  initializeScheduledReports();
  // Staged MOT/service reminders. Dry-run unless REMINDER_SCHEDULER=on.
  initReminderCron();
  // Connect trial -> paid: ends expired/over-cap trials and puts them behind the card paywall.
  initTrialCron();

  // Backstop sweep: auto-lock garages whose Stripe payment has been failed past the grace window.
  startArrearsSweep();
});
