import { startDiscordBot } from "./discord-bot";
import { logger } from "./lib/logger";

startDiscordBot().catch((err: unknown) => {
  logger.error({ err }, "Discord ticket bot failed to start");
  process.exitCode = 1;
});
