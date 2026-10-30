// Vercel entry point.
// Vercel deploys every file in api/ as a serverless function, so this file
// exposes the shared relay handler at /api/relay.
import handler from '../lib/relay.js';

export default handler;
