#!/usr/bin/env node
/**
 * riftw — entry point and dispatch.
 *
 * Every command ends the same way: flush the JSON document (if --json), close the relay socket,
 * exit with a code a script can read. Errors come out as one line plus a hint, never a stack
 * trace, unless RIFTW_DEBUG is set.
 */

import { parseArgs } from "./args";
import { cmdBatch } from "./commands/batch";
import { cmdDeploy } from "./commands/deploy";
import { cmdCall, cmdRead, cmdSend } from "./commands/interact";
import { cmdSelftest } from "./commands/selftest";
import { cmdConnect, cmdDisconnect, cmdStatus } from "./commands/session";
import { printHelp } from "./help";
import { emit, exit, flushJson, log, red, RiftwError, setJsonMode, setQuiet, yellow } from "./util";

const VERSION = "1.0.0";

type Handler = (args: ReturnType<typeof parseArgs>) => Promise<void>;

const COMMANDS: Record<string, Handler> = {
  connect: cmdConnect,
  status: cmdStatus,
  disconnect: cmdDisconnect,
  read: cmdRead,
  call: cmdCall,
  send: cmdSend,
  deploy: cmdDeploy,
  batch: cmdBatch,
  selftest: cmdSelftest,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.bool("json")) setJsonMode(true);
  if (args.bool("quiet")) setQuiet(true);

  if (args.bool("version") || args.command === "version") {
    log(`riftw ${VERSION}`);
    emit({ version: VERSION });
    return;
  }
  if (!args.command || args.command === "help") {
    printHelp(args.positional[0]);
    return;
  }
  if (args.bool("help")) {
    printHelp(args.command);
    return;
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    log(red(`  unknown command "${args.command}"`));
    log(`  known: ${Object.keys(COMMANDS).join(", ")}  ${yellow("(riftw --help)")}`);
    emit({ ok: false, error: { code: "UNKNOWN_COMMAND", message: args.command } });
    await exit(2);
  }

  await handler(args);
}

main()
  .then(async () => {
    flushJson();
    await exit(process.exitCode ? Number(process.exitCode) : 0);
  })
  .catch(async (e: any) => {
    if (e instanceof RiftwError) {
      log("");
      log(`  ${red("error")} ${e.message}`);
      if (e.hint) log(`  ${yellow("hint")}  ${e.hint}`);
      log("");
      emit({ ok: false, error: { code: e.code, message: e.message, hint: e.hint } });
    } else {
      log("");
      log(`  ${red("error")} ${e?.shortMessage || e?.message || String(e)}`);
      if (process.env.RIFTW_DEBUG) log(String(e?.stack || ""));
      else log(`  ${yellow("hint")}  set RIFTW_DEBUG=1 for the stack trace`);
      log("");
      emit({ ok: false, error: { code: e?.code || "UNEXPECTED", message: e?.message || String(e) } });
    }
    flushJson();
    await exit(1);
  });
