import { CommandContext } from "../command_handler.ts";
import { resolvePath } from "../common.ts";
import { ExecuteResult, resultFromCode } from "../result.ts";
import { stat } from "../utils.ts";
import { bailUnsupported, parse_arg_kinds } from "./args.ts";

export async function mkdirCommand(
  context: CommandContext,
): Promise<ExecuteResult> {
  try {
    await executeMkdir(context.cwd, context.args);
    return resultFromCode(0);
  } catch (err) {
    context.stderr.writeLine(`mkdir: ${err?.message ?? err}`);
    return resultFromCode(1);
  }
}

interface mkdirFlags {
  parents: boolean;
  paths: string[];
}

async function executeMkdir(cwd: string, args: string[]) {
  const flags = parseArgs(args);
  for (const specifiedPath of flags.paths) {
    const path = resolvePath(cwd, specifiedPath);
    if (
      await stat(path, (info) => info.isFile) ||
      (!flags.parents &&
        await stat(path, (info) => info.isDirectory))
    ) {
      throw Error(`cannot create directory '${specifiedPath}': File exists`);
    }
    if (flags.parents) {
      await Deno.mkdir(path, { recursive: true });
    } else {
      await Deno.mkdir(path);
    }
  }
}

export function parseArgs(args: string[]) {
  const result: mkdirFlags = {
    parents: false,
    paths: [],
  };

  for (const arg of parse_arg_kinds(args)) {
    if (
      (arg.arg === "parents" && arg.kind === "LongFlag") ||
      (arg.arg === "p" && arg.kind == "ShortFlag")
    ) {
      result.parents = true;
    } else {
      if (arg.kind !== "Arg") bailUnsupported(arg);
      result.paths.push(arg.arg.trim()); // NOTE: rust version doesn't trim
    }
  }
  if (result.paths.length === 0) {
    throw Error("missing operand");
  }
  return result;
}