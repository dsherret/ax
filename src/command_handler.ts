import { ExecuteResult } from "./result.ts";

/** Used to read from stdin. */
export type CommandPipeReader = "inherit" | "null" | Deno.Reader;

/** Used to write to stdout or stderr. */
export interface CommandPipeWriter extends Deno.WriterSync {
  writeSync(p: Uint8Array): number;
  writeText(text: string): void;
  writeLine(text: string): void;
}

/** Context of the currently executing command. */
export interface CommandContext {
  get args(): string[];
  get cwd(): string;
  get stdin(): CommandPipeReader;
  get stdout(): CommandPipeWriter;
  get stderr(): CommandPipeWriter;
}

/** Handler for executing a command. */
export type CommandHandler = (context: CommandContext) => Promise<ExecuteResult> | ExecuteResult;
