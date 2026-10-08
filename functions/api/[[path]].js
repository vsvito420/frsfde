// Cloudflare Pages Function: leitet alle /api/*-Anfragen an die Buchungs-Logik weiter.
import app from '../../worker/index.js';

export const onRequest = context => app.fetch(context.request, context.env);
