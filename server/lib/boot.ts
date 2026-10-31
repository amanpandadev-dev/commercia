// Imported first by every program that starts the server or opens the database from the command line:
// reads the .env file, then makes sure nothing secret can reach a log.
import { loadDotEnv, config, ConfigError } from './config';
import { installConsoleRedaction } from './redact';

loadDotEnv();
installConsoleRedaction();
try {
  config();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`\n${e.message}\n`);
    process.exit(1);
  }
  throw e;
}
