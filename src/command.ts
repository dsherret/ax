import { CommandHandler } from "./command_handler.ts";
import { cdCommand } from "./commands/cd.ts";
import { printEnvCommand } from "./commands/printenv.ts";
import { cpCommand, mvCommand } from "./commands/cp_mv.ts";
import { echoCommand } from "./commands/echo.ts";
import { catCommand } from "./commands/cat.ts";
import { exitCommand } from "./commands/exit.ts";
import { exportCommand } from "./commands/export.ts";
import { mkdirCommand } from "./commands/mkdir.ts";
import { rmCommand } from "./commands/rm.ts";
import { pwdCommand } from "./commands/pwd.ts";
import { sleepCommand } from "./commands/sleep.ts";
import { testCommand } from "./commands/test.ts";
import { touchCommand } from "./commands/touch.ts";
import { unsetCommand } from "./commands/unset.ts";
import { Box, delayToMs, LoggerTreeBox } from "./common.ts";
import { Delay } from "./common.ts";
import { Buffer, colors, path, readerFromStreamReader } from "./deps.ts";
import {
  CapturingBufferWriter,
  InheritStaticTextBypassWriter,
  NullPipeWriter,
  PipedBuffer,
  Reader,
  ShellPipeReaderKind,
  ShellPipeWriter,
  ShellPipeWriterKind,
  WriterSync,
} from "./pipes.ts";
import { parseCommand, spawn } from "./shell.ts";
import { isShowingProgressBars } from "./console/progress/interval.ts";
import { PathRef } from "./path.ts";
import { RequestBuilder } from "./request.ts";

type BufferStdio = "inherit" | "null" | "streamed" | Buffer;

class Deferred<T> {
  #create: () => T | Promise<T>;
  constructor(create: () => T | Promise<T>) {
    this.#create = create;
  }

  create() {
    return this.#create();
  }
}

interface ShellPipeWriterKindWithOptions {
  kind: ShellPipeWriterKind;
  options?: PipeOptions;
}

interface CommandBuilderState {
  command: string | undefined;
  stdin:
    | "inherit"
    | "null"
    | Box<Reader | ReadableStream<Uint8Array> | "consumed">
    | Deferred<ReadableStream<Uint8Array> | Reader>;
  combinedStdoutStderr: boolean;
  stdout: ShellPipeWriterKindWithOptions;
  stderr: ShellPipeWriterKindWithOptions;
  noThrow: boolean | number[];
  env: Record<string, string | undefined>;
  commands: Record<string, CommandHandler>;
  cwd: string | undefined;
  exportEnv: boolean;
  printCommand: boolean;
  printCommandLogger: LoggerTreeBox;
  timeout: number | undefined;
  signal: KillSignal | undefined;
}

const textDecoder = new TextDecoder();

const builtInCommands = {
  cd: cdCommand,
  printenv: printEnvCommand,
  echo: echoCommand,
  cat: catCommand,
  exit: exitCommand,
  export: exportCommand,
  sleep: sleepCommand,
  test: testCommand,
  rm: rmCommand,
  mkdir: mkdirCommand,
  cp: cpCommand,
  mv: mvCommand,
  pwd: pwdCommand,
  touch: touchCommand,
  unset: unsetCommand,
};

/** @internal */
export const getRegisteredCommandNamesSymbol: unique symbol = Symbol();

/**
 * Underlying builder API for executing commands.
 *
 * This is what `$` uses to execute commands. Using this provides
 * a way to provide a raw text command or an array of arguments.
 *
 * Command builders are immutable where each method call creates
 * a new command builder.
 *
 * ```ts
 * const builder = new CommandBuilder()
 *  .cwd("./src")
 *  .command("echo $MY_VAR");
 *
 * // outputs 5
 * console.log(await builder.env("MY_VAR", "5").text());
 * // outputs 6
 * console.log(await builder.env("MY_VAR", "6").text());
 * ```
 */
export class CommandBuilder implements PromiseLike<CommandResult> {
  #state: Readonly<CommandBuilderState> = {
    command: undefined,
    combinedStdoutStderr: false,
    stdin: "inherit",
    stdout: {
      kind: "inherit",
    },
    stderr: {
      kind: "inherit",
    },
    noThrow: false,
    env: {},
    cwd: undefined,
    commands: { ...builtInCommands },
    exportEnv: false,
    printCommand: false,
    // deno-lint-ignore no-console
    printCommandLogger: new LoggerTreeBox(console.error),
    timeout: undefined,
    signal: undefined,
  };

  #getClonedState(): CommandBuilderState {
    const state = this.#state;
    return {
      // be explicit here in order to evaluate each property on a case by case basis
      command: state.command,
      combinedStdoutStderr: state.combinedStdoutStderr,
      stdin: state.stdin,
      stdout: {
        kind: state.stdout.kind,
        options: state.stdout.options,
      },
      stderr: {
        kind: state.stderr.kind,
        options: state.stderr.options,
      },
      noThrow: state.noThrow instanceof Array ? [...state.noThrow] : state.noThrow,
      env: { ...state.env },
      cwd: state.cwd,
      commands: { ...state.commands },
      exportEnv: state.exportEnv,
      printCommand: state.printCommand,
      printCommandLogger: state.printCommandLogger.createChild(),
      timeout: state.timeout,
      signal: state.signal,
    };
  }

  #newWithState(action: (state: CommandBuilderState) => void): CommandBuilder {
    const builder = new CommandBuilder();
    const state = this.#getClonedState();
    action(state);
    builder.#state = state;
    return builder;
  }

  then<TResult1 = CommandResult, TResult2 = never>(
    onfulfilled?: ((value: CommandResult) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this.spawn().then(onfulfilled).catch(onrejected);
  }

  /**
   * Explicit way to spawn a command.
   *
   * This is an alias for awaiting the command builder or calling `.then(...)`
   */
  spawn(): CommandChild {
    // store a snapshot of the current command
    // in case someone wants to spawn multiple
    // commands with different state
    return parseAndSpawnCommand(this.#getClonedState());
  }

  /**
   * Register a command.
   */
  registerCommand(command: string, handleFn: CommandHandler): CommandBuilder {
    validateCommandName(command);
    return this.#newWithState((state) => {
      state.commands[command] = handleFn;
    });
  }

  /**
   * Register multilple commands.
   */
  registerCommands(commands: Record<string, CommandHandler>): CommandBuilder {
    let command: CommandBuilder = this;
    for (const [key, value] of Object.entries(commands)) {
      command = command.registerCommand(key, value);
    }
    return command;
  }

  /**
   * Unregister a command.
   */
  unregisterCommand(command: string): CommandBuilder {
    return this.#newWithState((state) => {
      delete state.commands[command];
    });
  }

  /** Sets the raw command to execute. */
  command(command: string | string[]): CommandBuilder {
    return this.#newWithState((state) => {
      if (typeof command === "string") {
        state.command = command;
      } else {
        state.command = command.map(escapeArg).join(" ");
      }
    });
  }

  /** The command should not throw for the provided non-zero exit codes. */
  noThrow(exclusionExitCode: number, ...additional: number[]): CommandBuilder;
  /** The command should not throw when it fails or times out. */
  noThrow(value?: boolean): CommandBuilder;
  noThrow(value?: boolean | number, ...additional: number[]): CommandBuilder {
    return this.#newWithState((state) => {
      if (typeof value === "boolean" || value == null) {
        state.noThrow = value ?? true;
      } else {
        state.noThrow = [value, ...additional];
      }
    });
  }

  /** Sets the command signal that will be passed to all commands
   * created with this command builder.
   */
  signal(killSignal: KillSignal): CommandBuilder {
    return this.#newWithState((state) => {
      if (state.signal != null) {
        state.signal.linkChild(killSignal);
      }
      state.signal = killSignal;
    });
  }

  /**
   * Whether to capture a combined buffer of both stdout and stderr.
   *
   * This will set both stdout and stderr to "piped" if not already "piped"
   * or "inheritPiped".
   */
  captureCombined(value = true): CommandBuilder {
    return this.#newWithState((state) => {
      state.combinedStdoutStderr = value;
      if (value) {
        if (state.stdout.kind !== "piped" && state.stdout.kind !== "inheritPiped") {
          state.stdout.kind = "piped";
        }
        if (state.stderr.kind !== "piped" && state.stderr.kind !== "inheritPiped") {
          state.stderr.kind = "piped";
        }
      }
    });
  }

  /**
   * Sets the stdin to use for the command.
   *
   * @remarks If multiple launches of a command occurs, then stdin will only be
   * read from the first consumed reader or readable stream and error otherwise.
   * For this reason, if you are setting stdin to something other than "inherit" or
   * "null", then it's recommended to set this each time you spawn a command.
   */
  stdin(reader: ShellPipeReaderKind): CommandBuilder {
    return this.#newWithState((state) => {
      if (reader === "inherit" || reader === "null") {
        state.stdin = reader;
      } else if (reader instanceof Uint8Array) {
        state.stdin = new Deferred(() => new Buffer(reader));
      } else if (reader instanceof PathRef) {
        state.stdin = new Deferred(async () => {
          const file = await reader.open();
          return file.readable;
        });
      } else if (reader instanceof RequestBuilder) {
        state.stdin = new Deferred(async () => {
          const body = await reader;
          return body.readable;
        });
      } else {
        state.stdin = new Box(reader);
      }
    });
  }

  /**
   * Sets the stdin string to use for a command.
   *
   * @remarks See the remarks on stdin. The same applies here.
   */
  stdinText(text: string): CommandBuilder {
    return this.stdin(new TextEncoder().encode(text));
  }

  /** Set the stdout kind. */
  stdout(kind: ShellPipeWriterKind): CommandBuilder;
  stdout(kind: WritableStream<Uint8Array>, options?: PipeOptions): CommandBuilder;
  stdout(kind: ShellPipeWriterKind, options?: PipeOptions): CommandBuilder {
    return this.#newWithState((state) => {
      if (state.combinedStdoutStderr && kind !== "piped" && kind !== "inheritPiped") {
        throw new Error(
          "Cannot set stdout's kind to anything but 'piped' or 'inheritPiped' when combined is true.",
        );
      }
      if (options?.signal != null) {
        // not sure what this would mean
        throw new Error("Setting a signal for a stdout WritableStream is not yet supported.");
      }
      state.stdout = {
        kind,
        options,
      };
    });
  }

  /** Set the stderr kind. */
  stderr(kind: ShellPipeWriterKind): CommandBuilder;
  stderr(kind: WritableStream<Uint8Array>, options?: PipeOptions): CommandBuilder;
  stderr(kind: ShellPipeWriterKind, options?: PipeOptions): CommandBuilder {
    return this.#newWithState((state) => {
      if (state.combinedStdoutStderr && kind !== "piped" && kind !== "inheritPiped") {
        throw new Error(
          "Cannot set stderr's kind to anything but 'piped' or 'inheritPiped' when combined is true.",
        );
      }
      if (options?.signal != null) {
        // not sure what this would mean
        throw new Error("Setting a signal for a stderr WritableStream is not yet supported.");
      }
      state.stderr = {
        kind,
        options,
      };
    });
  }

  /** Sets multiple environment variables to use at the same time via an object literal. */
  env(items: Record<string, string | undefined>): CommandBuilder;
  /** Sets a single environment variable to use. */
  env(name: string, value: string | undefined): CommandBuilder;
  env(nameOrItems: string | Record<string, string | undefined>, value?: string) {
    return this.#newWithState((state) => {
      if (typeof nameOrItems === "string") {
        setEnv(state, nameOrItems, value);
      } else {
        for (const [key, value] of Object.entries(nameOrItems)) {
          setEnv(state, key, value);
        }
      }
    });

    function setEnv(state: CommandBuilderState, key: string, value: string | undefined) {
      if (Deno.build.os === "windows") {
        key = key.toUpperCase();
      }
      state.env[key] = value;
    }
  }

  /** Sets the current working directory to use when executing this command. */
  cwd(dirPath: string | URL | PathRef): CommandBuilder {
    return this.#newWithState((state) => {
      state.cwd = dirPath instanceof URL
        ? path.fromFileUrl(dirPath)
        : dirPath instanceof PathRef
        ? dirPath.resolve().toString()
        : path.resolve(dirPath);
    });
  }

  /**
   * Exports the environment of the command to the executing process.
   *
   * So for example, changing the directory in a command or exporting
   * an environment variable will actually change the environment
   * of the executing process.
   *
   * ```ts
   * await $`cd src && export SOME_VALUE=5`;
   * console.log(Deno.env.get("SOME_VALUE")); // 5
   * console.log(Deno.cwd()); // will be in the src directory
   * ```
   */
  exportEnv(value = true): CommandBuilder {
    return this.#newWithState((state) => {
      state.exportEnv = value;
    });
  }

  /**
   * Prints the command text before executing the command.
   *
   * For example:
   *
   * ```ts
   * const text = "example";
   * await $`echo ${text}`.printCommand();
   * ```
   *
   * Outputs:
   *
   * ```
   * > echo example
   * example
   * ```
   */
  printCommand(value = true): CommandBuilder {
    return this.#newWithState((state) => {
      state.printCommand = value;
    });
  }

  /**
   * Mutates the command builder to change the logger used
   * for `printCommand()`.
   */
  setPrintCommandLogger(logger: (...args: any[]) => void): void {
    this.#state.printCommandLogger.setValue(logger);
  }

  /**
   * Ensures stdout and stderr are piped if they have the default behaviour or are inherited.
   *
   * ```ts
   * // ensure both stdout and stderr is not logged to the console
   * await $`echo 1`.quiet();
   * // ensure stdout is not logged to the console
   * await $`echo 1`.quiet("stdout");
   * // ensure stderr is not logged to the console
   * await $`echo 1`.quiet("stderr");
   * ```
   */
  quiet(kind: "stdout" | "stderr" | "both" = "both"): CommandBuilder {
    return this.#newWithState((state) => {
      if (kind === "both" || kind === "stdout") {
        state.stdout.kind = getQuietKind(state.stdout.kind);
      }
      if (kind === "both" || kind === "stderr") {
        state.stderr.kind = getQuietKind(state.stderr.kind);
      }
    });

    function getQuietKind(kind: ShellPipeWriterKind): ShellPipeWriterKind {
      if (typeof kind === "object") {
        return kind;
      }
      switch (kind) {
        case "inheritPiped":
        case "inherit":
          return "piped";
        case "null":
        case "piped":
          return kind;
        default: {
          const _assertNever: never = kind;
          throw new Error(`Unhandled kind ${kind}.`);
        }
      }
    }
  }

  /**
   * Specifies a timeout for the command. The command will exit with
   * exit code `124` (timeout) if it times out.
   *
   * Note that when using `.noThrow()` this won't cause an error to
   * be thrown when timing out.
   */
  timeout(delay: Delay | undefined): CommandBuilder {
    return this.#newWithState((state) => {
      state.timeout = delay == null ? undefined : delayToMs(delay);
    });
  }

  /**
   * Sets stdout as quiet, spawns the command, and gets stdout as a Uint8Array.
   *
   * Shorthand for:
   *
   * ```ts
   * const data = (await $`command`.quiet("stdout")).stdoutBytes;
   * ```
   */
  async bytes(): Promise<Uint8Array> {
    return (await this.quiet("stdout")).stdoutBytes;
  }

  /**
   * Sets stdout as quiet, spawns the command, and gets stdout as a string without the last newline.
   *
   * Shorthand for:
   *
   * ```ts
   * const data = (await $`command`.quiet("stdout")).stdout.replace(/\r?\n$/, "");
   * ```
   */
  async text(): Promise<string> {
    return (await this.quiet("stdout")).stdout.replace(/\r?\n$/, "");
  }

  /** Gets the text as an array of lines. */
  async lines(): Promise<string[]> {
    const text = await this.text();
    return text.split(/\r?\n/g);
  }

  /**
   * Sets stdout as quiet, spawns the command, and gets stdout as JSON.
   *
   * Shorthand for:
   *
   * ```ts
   * const data = (await $`command`.quiet("stdout")).stdoutJson;
   * ```
   */
  async json<TResult = any>(): Promise<TResult> {
    return (await this.quiet("stdout")).stdoutJson;
  }

  /** @internal */
  [getRegisteredCommandNamesSymbol](): string[] {
    return Object.keys(this.#state.commands);
  }
}

export class CommandChild extends Promise<CommandResult> {
  #pipedStdoutBuffer: PipedBuffer | "consumed" | undefined;
  #pipedStderrBuffer: PipedBuffer | "consumed" | undefined;
  #killSignalController: KillSignalController | undefined;

  /** @internal */
  constructor(executor: (resolve: (value: CommandResult) => void, reject: (reason?: any) => void) => void, options: {
    pipedStdoutBuffer: PipedBuffer | undefined;
    pipedStderrBuffer: PipedBuffer | undefined;
    killSignalController: KillSignalController | undefined;
  } = { pipedStderrBuffer: undefined, pipedStdoutBuffer: undefined, killSignalController: undefined }) {
    super(executor);
    this.#pipedStdoutBuffer = options.pipedStdoutBuffer;
    this.#pipedStderrBuffer = options.pipedStderrBuffer;
    this.#killSignalController = options.killSignalController;
  }

  /** Send a signal to the executing command's child process. Note that SIGTERM,
   * SIGKILL, SIGABRT, SIGQUIT, SIGINT, or SIGSTOP will cause the entire command
   * to be considered "aborted" and if part of a command runs after this has occurred
   * it will return a 124 exit code. Other signals will just be forwarded to the command.
   *
   * Defaults to "SIGTERM".
   */
  kill(signal?: Deno.Signal): void {
    this.#killSignalController?.kill(signal);
  }

  stdout(): ReadableStream<Uint8Array> {
    const buffer = this.#pipedStdoutBuffer;
    this.#assertBufferStreamable("stdout", buffer);
    this.#pipedStdoutBuffer = "consumed";
    this.catch(() => {
      // observe and ignore
    });
    return this.#bufferToStream(buffer);
  }

  stderr(): ReadableStream<Uint8Array> {
    const buffer = this.#pipedStderrBuffer;
    this.#assertBufferStreamable("stderr", buffer);
    this.#pipedStderrBuffer = "consumed";
    this.catch(() => {
      // observe and ignore
    });
    return this.#bufferToStream(buffer);
  }

  #assertBufferStreamable(name: string, buffer: PipedBuffer | "consumed" | undefined): asserts buffer is PipedBuffer {
    if (buffer == null) {
      throw new Error(
        `No pipe available. Ensure ${name} is "piped" (not "inheritPiped") and combinedOutput is not enabled.`,
      );
    }
    if (buffer === "consumed") {
      throw new Error(`Streamable ${name} was already consumed. Use the previously acquired stream instead.`);
    }
  }

  #bufferToStream(buffer: PipedBuffer) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        buffer.setListener({
          writeSync(data) {
            controller.enqueue(data);
            return data.length;
          },
          setError(err: Error) {
            controller.error(err);
          },
          close() {
            controller.close();
          },
        });
      },
    });
  }
}

export function parseAndSpawnCommand(state: CommandBuilderState) {
  if (state.command == null) {
    throw new Error("A command must be set before it can be spawned.");
  }

  if (state.printCommand) {
    state.printCommandLogger.getValue()(colors.white(">"), colors.blue(state.command));
  }

  const disposables: Disposable[] = [];
  const asyncDisposables: AsyncDisposable[] = [];

  const parentSignal = state.signal;
  const killSignalController = new KillSignalController();
  if (parentSignal != null) {
    const parentSignalListener = (signal: Deno.Signal) => {
      killSignalController.kill(signal);
    };
    parentSignal.addListener(parentSignalListener);
    disposables.push({
      [Symbol.dispose]() {
        parentSignal.removeListener(parentSignalListener);
      },
    });
  }
  let timedOut = false;
  if (state.timeout != null) {
    const timeoutId = setTimeout(() => {
      timedOut = true;
      killSignalController.kill();
    }, state.timeout);
    disposables.push({
      [Symbol.dispose]() {
        clearTimeout(timeoutId);
      },
    });
  }
  const [stdoutBuffer, stderrBuffer, combinedBuffer] = getBuffers();
  const stdout = new ShellPipeWriter(
    state.stdout.kind,
    stdoutBuffer === "null" ? new NullPipeWriter() : stdoutBuffer === "inherit" ? Deno.stdout : stdoutBuffer,
  );
  const stderr = new ShellPipeWriter(
    state.stderr.kind,
    stderrBuffer === "null" ? new NullPipeWriter() : stderrBuffer === "inherit" ? Deno.stderr : stderrBuffer,
  );
  const command = state.command;
  const signal = killSignalController.signal;

  return new CommandChild(async (resolve, reject) => {
    try {
      const list = parseCommand(command);
      const stdin = await takeStdin();
      let code = await spawn(list, {
        stdin: stdin instanceof ReadableStream ? readerFromStreamReader(stdin.getReader()) : stdin,
        stdout,
        stderr,
        env: buildEnv(state.env),
        commands: state.commands,
        cwd: state.cwd ?? Deno.cwd(),
        exportEnv: state.exportEnv,
        signal,
      });
      if (code !== 0) {
        if (timedOut) {
          // override the code in the case of a timeout that resulted in a failure
          code = 124;
        }
        const noThrow = state.noThrow instanceof Array ? state.noThrow.includes(code) : state.noThrow;
        if (!noThrow) {
          if (stdin instanceof ReadableStream) {
            if (!stdin.locked) {
              stdin.cancel();
            }
          }
          if (timedOut) {
            throw new Error(`Timed out with exit code: ${code}`);
          } else if (signal.aborted) {
            throw new Error(`${timedOut ? "Timed out" : "Aborted"} with exit code: ${code}`);
          } else {
            throw new Error(`Exited with code: ${code}`);
          }
        }
      }
      const result = new CommandResult(
        code,
        finalizeCommandResultBuffer(stdoutBuffer),
        finalizeCommandResultBuffer(stderrBuffer),
        combinedBuffer instanceof Buffer ? combinedBuffer : undefined,
      );
      const maybeError = await cleanupDisposablesAndMaybeGetError(undefined);
      if (maybeError) {
        reject(maybeError);
      } else {
        resolve(result);
      }
    } catch (err) {
      finalizeCommandResultBufferForError(stdoutBuffer, err as Error);
      finalizeCommandResultBufferForError(stderrBuffer, err as Error);
      reject(await cleanupDisposablesAndMaybeGetError(err));
    }
  }, {
    pipedStdoutBuffer: stdoutBuffer instanceof PipedBuffer ? stdoutBuffer : undefined,
    pipedStderrBuffer: stderrBuffer instanceof PipedBuffer ? stderrBuffer : undefined,
    killSignalController,
  });

  async function cleanupDisposablesAndMaybeGetError(maybeError?: unknown) {
    const errors = [];
    if (maybeError) {
      errors.push(maybeError);
    }
    for (const disposable of disposables) {
      try {
        disposable[Symbol.dispose]();
      } catch (err) {
        errors.push(err);
      }
    }
    if (asyncDisposables.length > 0) {
      await Promise.all(asyncDisposables.map(async (d) => {
        try {
          await d[Symbol.asyncDispose]();
        } catch (err) {
          errors.push(err);
        }
      }));
    }
    if (errors.length === 1) {
      return errors[0];
    } else if (errors.length > 1) {
      return new AggregateError(errors);
    } else {
      return undefined;
    }
  }

  async function takeStdin() {
    if (state.stdin instanceof Box) {
      const stdin = state.stdin.value;
      if (stdin === "consumed") {
        throw new Error(
          "Cannot spawn command. Stdin was already consumed when a previous command using " +
            "the same stdin was spawned. You need to call `.stdin(...)` again with a new " +
            "value before spawning.",
        );
      }
      state.stdin.value = "consumed";
      return stdin;
    } else if (state.stdin instanceof Deferred) {
      const stdin = await state.stdin.create();
      if (stdin instanceof ReadableStream) {
        disposables.push({
          [Symbol.dispose]() {
            if (!stdin.locked) {
              stdin.cancel();
            }
          },
        });
      }
      return stdin;
    } else {
      return state.stdin;
    }
  }

  function getBuffers() {
    const hasProgressBars = isShowingProgressBars();
    const stdoutBuffer = getOutputBuffer(Deno.stdout, state.stdout);
    const stderrBuffer = getOutputBuffer(Deno.stderr, state.stderr);
    if (state.combinedStdoutStderr) {
      if (typeof stdoutBuffer === "string" || typeof stderrBuffer === "string") {
        throw new Error("Internal programming error. Expected writers for stdout and stderr.");
      }
      const combinedBuffer = new Buffer();
      return [
        new CapturingBufferWriter(stdoutBuffer, combinedBuffer),
        new CapturingBufferWriter(stderrBuffer, combinedBuffer),
        combinedBuffer,
      ] as const;
    }
    return [stdoutBuffer, stderrBuffer, undefined] as const;

    function getOutputBuffer(innerWriter: WriterSync, { kind, options }: ShellPipeWriterKindWithOptions) {
      if (typeof kind === "object") {
        if (kind instanceof PathRef) {
          const file = kind.openSync({ write: true, truncate: true, create: true });
          disposables.push(file);
          return file;
        } else if (kind instanceof WritableStream) {
          // this is sketch
          const writer = kind.getWriter();
          const promiseMap = new Map<number, Promise<void>>();
          let hadError = false;
          let foundErr: unknown = undefined;
          let index = 0;
          asyncDisposables.push({
            async [Symbol.asyncDispose]() {
              await Promise.all(promiseMap.values());
              if (foundErr) {
                throw foundErr;
              }
              if (!options?.preventClose && !hadError) {
                await writer.close();
              }
            },
          });
          return {
            writeSync(buffer: Uint8Array) {
              if (foundErr) {
                const errorToThrow = foundErr;
                foundErr = undefined;
                throw errorToThrow;
              }
              const newIndex = index++;
              promiseMap.set(
                newIndex,
                writer.write(buffer).catch((err) => {
                  if (err != null) {
                    foundErr = err;
                    hadError = true;
                  }
                }).finally(() => {
                  promiseMap.delete(newIndex);
                }),
              );
              return buffer.length;
            },
          };
        } else {
          return kind;
        }
      }
      switch (kind) {
        case "inherit":
          if (hasProgressBars) {
            return new InheritStaticTextBypassWriter(innerWriter);
          } else {
            return "inherit";
          }
        case "piped":
          return new PipedBuffer();
        case "inheritPiped":
          return new CapturingBufferWriter(innerWriter, new Buffer());
        case "null":
          return "null";
        default: {
          const _assertNever: never = kind;
          throw new Error("Unhandled.");
        }
      }
    }
  }

  function finalizeCommandResultBuffer(
    buffer: PipedBuffer | "inherit" | "null" | CapturingBufferWriter | InheritStaticTextBypassWriter | WriterSync,
  ): BufferStdio {
    if (buffer instanceof CapturingBufferWriter) {
      return buffer.getBuffer();
    } else if (buffer instanceof InheritStaticTextBypassWriter) {
      buffer.flush(); // this is line buffered, so flush anything left
      return "inherit";
    } else if (buffer instanceof PipedBuffer) {
      buffer.close();
      return buffer.getBuffer() ?? "streamed";
    } else if (typeof buffer === "object") {
      return "streamed";
    } else {
      return buffer;
    }
  }

  function finalizeCommandResultBufferForError(
    buffer: PipedBuffer | "inherit" | "null" | CapturingBufferWriter | InheritStaticTextBypassWriter | WriterSync,
    error: Error,
  ) {
    if (buffer instanceof InheritStaticTextBypassWriter) {
      buffer.flush(); // this is line buffered, so flush anything left
    } else if (buffer instanceof PipedBuffer) {
      buffer.setError(error);
    }
  }
}

/** Result of running a command. */
export class CommandResult {
  #stdout: BufferStdio;
  #stderr: BufferStdio;
  #combined: Buffer | undefined;

  /** The exit code. */
  readonly code: number;

  /** @internal */
  constructor(code: number, stdout: BufferStdio, stderr: BufferStdio, combined: Buffer | undefined) {
    this.code = code;
    this.#stdout = stdout;
    this.#stderr = stderr;
    this.#combined = combined;
  }

  #memoizedStdout: string | undefined;

  /** Raw decoded stdout text. */
  get stdout(): string {
    if (!this.#memoizedStdout) {
      this.#memoizedStdout = textDecoder.decode(this.stdoutBytes);
    }
    return this.#memoizedStdout;
  }

  #memoizedStdoutJson: any | undefined;

  /**
   * Stdout text as JSON.
   *
   * @remarks Will throw if it can't be parsed as JSON.
   */
  get stdoutJson(): any {
    if (this.#memoizedStdoutJson == null) {
      this.#memoizedStdoutJson = JSON.parse(this.stdout);
    }
    return this.#memoizedStdoutJson;
  }

  /** Raw stdout bytes. */
  get stdoutBytes(): Uint8Array {
    if (this.#stdout === "streamed") {
      throw new Error(
        `Stdout was streamed to another source and is no longer available.`,
      );
    }
    if (typeof this.#stdout === "string") {
      throw new Error(
        `Stdout was not piped (was ${this.#stdout}). Call .stdout("piped") or .stdout("inheritPiped") when building the command.`,
      );
    }
    return this.#stdout.bytes({ copy: false });
  }

  #memoizedStderr: string | undefined;

  /** Raw decoded stdout text. */
  get stderr(): string {
    if (!this.#memoizedStderr) {
      this.#memoizedStderr = textDecoder.decode(this.stderrBytes);
    }
    return this.#memoizedStderr;
  }

  #memoizedStderrJson: any | undefined;

  /**
   * Stderr text as JSON.
   *
   * @remarks Will throw if it can't be parsed as JSON.
   */
  get stderrJson(): any {
    if (this.#memoizedStderrJson == null) {
      this.#memoizedStderrJson = JSON.parse(this.stderr);
    }
    return this.#memoizedStderrJson;
  }

  /** Raw stderr bytes. */
  get stderrBytes(): Uint8Array {
    if (this.#stdout === "streamed") {
      throw new Error(
        `Stderr was streamed to another source and is no longer available.`,
      );
    }
    if (typeof this.#stderr === "string") {
      throw new Error(
        `Stderr was not piped (was ${this.#stderr}). Call .stderr("piped") or .stderr("inheritPiped") when building the command.`,
      );
    }
    return this.#stderr.bytes({ copy: false });
  }

  #memoizedCombined: string | undefined;

  /** Raw combined stdout and stderr text. */
  get combined(): string {
    if (!this.#memoizedCombined) {
      this.#memoizedCombined = textDecoder.decode(this.combinedBytes);
    }
    return this.#memoizedCombined;
  }

  /** Raw combined stdout and stderr bytes. */
  get combinedBytes(): Uint8Array {
    if (this.#combined == null) {
      throw new Error("Stdout and stderr were not combined. Call .captureCombined() when building the command.");
    }
    return this.#combined.bytes({ copy: false });
  }
}

function buildEnv(env: Record<string, string | undefined>) {
  const result = Deno.env.toObject();
  for (const [key, value] of Object.entries(env)) {
    if (value == null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function escapeArg(arg: string) {
  // very basic for now
  if (/^[A-Za-z0-9]+$/.test(arg)) {
    return arg;
  } else {
    return `'${arg.replaceAll("'", `'"'"'`)}'`;
  }
}

function validateCommandName(command: string) {
  if (command.match(/^[a-zA-Z0-9-_]+$/) == null) {
    throw new Error("Invalid command name");
  }
}

const SHELL_SIGNAL_CTOR_SYMBOL = Symbol();

interface KillSignalState {
  aborted: boolean;
  listeners: ((signal: Deno.Signal) => void)[];
}

/** Similar to an AbortController, but for sending signals to commands. */
export class KillSignalController {
  #state: KillSignalState;
  #killSignal: KillSignal;

  constructor() {
    this.#state = {
      aborted: false,
      listeners: [],
    };
    this.#killSignal = new KillSignal(SHELL_SIGNAL_CTOR_SYMBOL, this.#state);
  }

  get signal(): KillSignal {
    return this.#killSignal;
  }

  /** Send a signal to the downstream child process. Note that SIGTERM,
   * SIGKILL, SIGABRT, SIGQUIT, SIGINT, or SIGSTOP will cause all the commands
   * to be considered "aborted" and will return a 124 exit code, while other
   * signals will just be forwarded to the commands.
   */
  kill(signal: Deno.Signal = "SIGTERM") {
    sendSignalToState(this.#state, signal);
  }
}

/** Similar to `AbortSignal`, but for `Deno.Signal`.
 *
 * A `KillSignal` is considered aborted if its controller
 * receives SIGTERM, SIGKILL, SIGABRT, SIGQUIT, SIGINT, or SIGSTOP.
 *
 * These can be created via a `KillSignalController`.
 */
export class KillSignal {
  #state: KillSignalState;

  /** @internal */
  constructor(symbol: Symbol, state: KillSignalState) {
    if (symbol !== SHELL_SIGNAL_CTOR_SYMBOL) {
      throw new Error("Constructing instances of KillSignal is not permitted.");
    }
    this.#state = state;
  }

  /** Returns if the command signal has ever received a SIGTERM,
   * SIGKILL, SIGABRT, SIGQUIT, SIGINT, or SIGSTOP
   */
  get aborted(): boolean {
    return this.#state.aborted;
  }

  /**
   * Causes the provided kill signal to be triggered when this
   * signal receives a signal.
   */
  linkChild(killSignal: KillSignal): { unsubscribe(): void } {
    const listener = (signal: Deno.Signal) => {
      sendSignalToState(killSignal.#state, signal);
    };
    this.addListener(listener);
    return {
      unsubscribe: () => {
        this.removeListener(listener);
      },
    };
  }

  addListener(listener: (signal: Deno.Signal) => void) {
    this.#state.listeners.push(listener);
  }

  removeListener(listener: (signal: Deno.Signal) => void) {
    const index = this.#state.listeners.indexOf(listener);
    if (index >= 0) {
      this.#state.listeners.splice(index, 1);
    }
  }
}

function sendSignalToState(state: KillSignalState, signal: Deno.Signal) {
  if (signalCausesAbort(signal)) {
    state.aborted = true;
  }
  for (const listener of state.listeners) {
    listener(signal);
  }
}

function signalCausesAbort(signal: Deno.Signal) {
  // consider the command aborted if the signal is any one of these
  switch (signal) {
    case "SIGTERM":
    case "SIGKILL":
    case "SIGABRT":
    case "SIGQUIT":
    case "SIGINT":
    case "SIGSTOP":
      return true;
    default:
      return false;
  }
}
