import { runFlagsCli } from './flags-cli.ts';

const code = await runFlagsCli(process.argv.slice(2), process.env);
process.exit(code);
