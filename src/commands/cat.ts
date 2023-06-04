import { CommandContext } from "../command_handler.ts";
import { ExecuteResult, resultFromCode } from "../result.ts";
import { bailUnsupported, parseArgKinds } from "./args.ts";
import { path as pathUtils } from "../deps.ts";

interface CatFlags {
  paths: string[];
}

export async function catCommand(
  context: CommandContext,
): Promise<ExecuteResult> {
  try {
    const exit_code = await executeCat(context);
    return resultFromCode(exit_code);
  } catch (err) {
    context.stderr.writeLine(`cat: ${err?.message ?? err}`);
    return resultFromCode(1);
  }
}

async function executeCat(context: CommandContext) {
  const flags = parseCatArgs(context.args);
  let exit_code = 0;
  const buf = new Uint8Array(1024);

  for (const path of flags.paths) {
    if (path === "-") { // read from stdin
      if (typeof context.stdin === "object") { // stdin is a Deno.Reader
        while (true) {
          const size = await context.stdin.read(buf);
          if (!size || size === 0) break;
          else context.stdout.writeSync(buf.slice(0, size));
        }
      } else {
        const _assertValue: "null" | "inherit" = context.stdin;
        throw new Error(`not supported. stdin was '${context.stdin}'`);
      }
    } else {
      let file;
      try {
        file = Deno.openSync(pathUtils.join(context.cwd, path), { read: true });
        while (true) {
          // NOTE: rust supports cancellation here
          const size = file.readSync(buf);
          if (!size || size === 0) break;
          else context.stdout.writeSync(buf.slice(0, size));
        }
      } catch (err) {
        context.stderr.writeLine(`cat ${path}: ${err}`);
        exit_code = 1;
      } finally {
        if (file) file.close();
      }
    }
  }
  return exit_code;
}

export function parseCatArgs(args: string[]): CatFlags {
  const paths = [];
  for (const arg of parseArgKinds(args)) {
    if (arg.kind === "Arg") paths.push(arg.arg);
    else bailUnsupported(arg); // for now, we don't support any arguments
  }

  if (paths.length === 0) paths.push("-");
  return { paths };
}
