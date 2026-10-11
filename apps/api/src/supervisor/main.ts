/**
 * Supervisor sidecar entrypoint (#135). Ships inside the api image; compose runs it
 * as `node apps/api/dist/supervisor/main.js` with the Docker socket mounted. It
 * reads no settings and holds no credentials — see supervisor.ts.
 */
import { createSupervisorServer } from './supervisor.js';

const PORT = 8791;
const SOCKET = '/var/run/docker.sock';

const server = createSupervisorServer({ socketPath: SOCKET, log: (m) => console.log(`[supervisor] ${m}`) });
server.listen(PORT, '0.0.0.0', () => console.log(`[supervisor] listening on :${PORT} (docker ${SOCKET})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
