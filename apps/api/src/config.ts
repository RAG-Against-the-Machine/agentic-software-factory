import { resolve } from '@asf/shared';

/** All values via the settings catalogue. PORT (PaaS-injected) overrides API_PORT and implies 0.0.0.0. */
const PORT = process.env.PORT ? Number(process.env.PORT) : null;

export const config = {
  port: PORT ?? resolve('API_PORT'),
  host: process.env.API_HOST ? resolve('API_HOST') : PORT ? '0.0.0.0' : resolve('API_HOST'),
  registryUrl: resolve('REGISTRY_URL'),
  runEventSecret: resolve('RUN_EVENT_SECRET'),
  ticketProvider: resolve('TICKET_PROVIDER'),
  scmProvider: resolve('SCM_PROVIDER'),
  webDist: resolve('WEB_DIST'),
  authMode: resolve('AUTH_MODE'),
  authHeader: resolve('AUTH_HEADER'),
  orgMaxCostUsd: resolve('ORG_MAX_COST_USD'),
};
