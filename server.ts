import express from 'express';
import { config } from './config.js';
import { webhookRouter } from './routes/webhooks.js';

const app = express();
app.set('trust proxy', 1);                 // behind a TLS-terminating proxy / load balancer
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use('/webhooks', webhookRouter);       // raw-body parser lives inside this router

// Other routes (OAuth, rules CRUD, logs) use JSON parsing and auth; mount them after this line.
// app.use(express.json());

app.listen(config.port, () => console.log(`webhook server listening on :${config.port}`));
