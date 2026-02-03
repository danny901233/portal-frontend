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
import voiceRouter from './routes/voice.js';
import twilioRouter from './routes/twilio.js';
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
    credentials: false,
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', callsRouter);
app.use('/api', configRouter);
app.use('/api/auth', authRouter);
app.use('/api', adminRouter);
app.use('/api', twilioRouter);
app.use('/webhooks', agentWebhookRouter);
app.use('/webhooks', voiceRouter);

app.use(errorHandler);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${port}`);
  console.log('Effective WEBHOOK_SECRET:', JSON.stringify(process.env.WEBHOOK_SECRET ?? null));
  
  // Initialize scheduled report jobs
  initializeScheduledReports();
});
