import { loadConfig } from '@dnd/shared';
import { SERVER_NAME } from './index.js';
import { createServer } from './server.js';

const config = loadConfig();

createServer().listen(config.MCP_PORT, () => {
  console.log(`${SERVER_NAME} listening on port ${config.MCP_PORT}`);
});
