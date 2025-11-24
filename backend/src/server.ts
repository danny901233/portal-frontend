import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import authRouter from './routes/auth.js';
import callsRouter from './routes/calls.js';
import configRouter from './routes/config.js';
import agentWebhookRouter from './routes/agentWebhook.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

const port = Number(process.env.PORT) || 4000;
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';


app.use(helmet());
app.use(
  cors({
    origin: corsOrigin,
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
app.use('/webhooks', agentWebhookRouter);

app.use(errorHandler);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${port}`);
  console.log('Effective WEBHOOK_SECRET:', JSON.stringify(process.env.WEBHOOK_SECRET ?? null));
});
