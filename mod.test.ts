import $, { build$, CommandBuilder, CommandContext, CommandHandler } from "./mod.ts";
import { assertEquals, assertRejects, assertThrows } from "./src/deps.test.ts";
import { Buffer, colors, path } from "./src/deps.ts";

Deno.test("should get stdout when piped", async () => {
  const output = await $`echo 5`.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "5\n");
});

Deno.test("should escape arguments", async () => {
  const text = await $`echo ${"testing 'this $TEST \`out"}`.text();
  assertEquals(text, "testing 'this $TEST `out");
});

Deno.test("should not get stdout when inherited (default)", async () => {
  const output = await $`echo "should output"`;
  assertEquals(output.code, 0);
  assertThrows(() => output.stdout, Error, `Stdout was not piped (was inherit).`);
});

Deno.test("should not get stdout when null", async () => {
  const output = await $`echo 5`.stdout("null");
  assertEquals(output.code, 0);
  assertThrows(() => output.stdout, Error, `Stdout was not piped (was null).`);
});

Deno.test("should capture stdout when piped", async () => {
  const output = await $`deno eval 'console.log(5);'`.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "5\n");
});

Deno.test("should capture stdout when inherited and piped", async () => {
  const output = await $`deno eval 'console.log(5);'`.stdout("inheritPiped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "5\n");
});

Deno.test("should not get stderr when inherited only (default)", async () => {
  const output = await $`deno eval 'console.error("should output");'`;
  assertEquals(output.code, 0);
  assertThrows(
    () => output.stderr,
    Error,
    `Stderr was not piped (was inherit). Call .stderr("piped") or .stderr("capture") on the process.`,
  );
});

Deno.test("should not get stderr when null", async () => {
  const output = await $`deno eval 'console.error(5);'`.stderr("null");
  assertEquals(output.code, 0);
  assertThrows(
    () => output.stderr,
    Error,
    `Stderr was not piped (was null). Call .stderr("piped") or .stderr("capture") on the process.`,
  );
});

Deno.test("should capture stderr when piped", async () => {
  const output = await $`deno eval 'console.error(5);'`.stderr("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stderr, "5\n");
});

Deno.test("should capture stderr when inherited and piped", async () => {
  const output = await $`deno eval 'console.error(5);'`.stderr("inheritPiped");
  assertEquals(output.code, 0);
  assertEquals(output.stderr, "5\n");
});

Deno.test("should get combined stdout and stderr when both piped", async () => {
  const output = await $`echo 1 ; sleep 0.5 ; deno eval 'console.error(2);'`.stdout("piped").stderr("piped");
  assertEquals(output.code, 0);
  assertEquals(output.combined, "1\n2\n");
});

Deno.test("should not get combined stdout and stderr when stdout is inherited (default)", async () => {
  const output = await $`deno eval 'console.error("should output");'`;
  assertEquals(output.code, 0);
  assertThrows(
    () => output.combined,
    Error,
    `Stdout was not piped (was inherit). Call .stdout("piped") or .stdout("capture") on the process.`,
  );
});

Deno.test("should not get combined stdout and stderr when stderr is inherited", async () => {
  const output = await $`deno eval 'console.error("should output");'`.stdout("piped");
  assertEquals(output.code, 0);
  assertThrows(
    () => output.combined,
    Error,
    `Stderr was not piped (was inherit). Call .stderr("piped") or .stderr("capture") on the process.`,
  );
});

Deno.test("should throw when exit code is non-zero", async () => {
  await assertRejects(
    async () => {
      await $`deno eval 'Deno.exit(1);'`;
    },
    Error,
    "Exited with code: 1",
  );

  await assertRejects(
    async () => {
      await $`deno eval 'Deno.exit(2);'`;
    },
    Error,
    "Exited with code: 2",
  );
});

Deno.test("should change the cwd, but only in the shell", async () => {
  const output = await $`cd src ; deno eval 'console.log(Deno.cwd());'`.stdout("piped");
  const standardizedOutput = output.stdout.trim().replace(/\\/g, "/");
  assertEquals(standardizedOutput.endsWith("src"), true, standardizedOutput);
});

Deno.test("allow setting env", async () => {
  const output = await $`echo $test`.env("test", "123").text();
  assertEquals(output, "123");
});

Deno.test("allow setting multiple env", async () => {
  const output = await $`echo $test$other`.env({
    test: "123",
    other: "456",
  }).text();
  assertEquals(output, "123456");
});

Deno.test("set var for command", async () => {
  const output = await $`test=123 echo $test ; echo $test`
    .env("test", "456")
    .text();
  assertEquals(output, "123\n456");
});

Deno.test("variable substitution", async () => {
  const output = await $`deno eval "console.log($TEST);"`.env("TEST", "123").text();
  assertEquals(output.trim(), "123");
});

Deno.test("stdoutJson", async () => {
  const output = await $`deno eval "console.log(JSON.stringify({ test: 5 }));"`.stdout("piped");
  assertEquals(output.stdoutJson, { test: 5 });
  assertEquals(output.stdoutJson === output.stdoutJson, true); // should be memoized
});

Deno.test("CommandBuilder#json()", async () => {
  const output = await $`deno eval "console.log(JSON.stringify({ test: 5 }));"`.json();
  assertEquals(output, { test: 5 });
});

Deno.test("stderrJson", async () => {
  const output = await $`deno eval "console.error(JSON.stringify({ test: 5 }));"`.stderr("piped");
  assertEquals(output.stderrJson, { test: 5 });
  assertEquals(output.stderrJson === output.stderrJson, true); // should be memoized
});

Deno.test("should handle interpolation", async () => {
  const output = await $`deno eval 'console.log(${5});'`.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "5\n");
});

Deno.test("should handle interpolation beside args", async () => {
  const value = "a/b";
  const text = await $`echo ${value}/c`.text();
  assertEquals(text, "a/b/c");
});

Deno.test("should handle providing array of arguments", async () => {
  const args = [1, "2", "test   test"];
  const text = await $`deno eval 'console.log(Deno.args)' ${args}`.text();
  assertEquals(text, `[ "1", "2", "test   test" ]`);
});

Deno.test("raw should handle providing array of arguments", async () => {
  const args = [1, "2", "test   test"];
  const text = await $.raw`deno eval 'console.log(Deno.args)' ${args}`.text();
  assertEquals(text, `[ "1", "2", "test", "test" ]`);
});

Deno.test("raw should handle text provided", async () => {
  const text = await $.raw`deno eval 'console.log(Deno.args)' ${"testing this   out"}`.text();
  assertEquals(text, `[ "testing", "this", "out" ]`);
});

Deno.test("raw should handle command result", async () => {
  const result = await $`echo '1   2   3'`.stdout("piped");
  const text = await $.raw`deno eval 'console.log(Deno.args)' ${result}`.text();
  assertEquals(text, `[ "1", "2", "3" ]`);
});

Deno.test("command builder should build", async () => {
  const commandBuilder = new CommandBuilder()
    .env("TEST", "123");
  {
    const local$ = $.build$({ commandBuilder });
    // after creating a $, the environment should be set in stone, so changing
    // this environment variable should have no effect here. Additionally,
    // command builders are immutable and return a new builder each time
    commandBuilder.env("TEST", "456");
    const output = await local$`deno eval 'console.log(Deno.env.get("TEST"));'`.stdout("piped");
    assertEquals(output.code, 0);
    assertEquals(output.stdout, "123\n");
  }

  {
    // this one additionally won't be affected because command builders are immutable
    const local$ = $.build$({ commandBuilder });
    const output = await local$`deno eval 'console.log(Deno.env.get("TEST"));'`.stdout("piped");
    assertEquals(output.code, 0);
    assertEquals(output.stdout, "123\n");
  }
});

Deno.test("should handle boolean list 'or'", async () => {
  {
    const output = await $`deno eval 'Deno.exit(1)' || deno eval 'console.log(5)'`.text();
    assertEquals(output, "5");
  }
  {
    const output = await $`deno eval 'Deno.exit(1)' || deno eval 'Deno.exit(2)' || deno eval 'Deno.exit(3)'`
      .noThrow()
      .stdout("piped");
    assertEquals(output.stdout, "");
    assertEquals(output.code, 3);
  }
});

Deno.test("should handle boolean list 'and'", async () => {
  {
    const output = await $`deno eval 'Deno.exit(5)' && echo 2`.noThrow().stdout("piped");
    assertEquals(output.code, 5);
    assertEquals(output.stdout, "");
  }
  {
    const output = await $`deno eval 'Deno.exit(0)' && echo 5 && echo 6`.stdout("piped");
    assertEquals(output.code, 0);
    assertEquals(output.stdout.trim(), "5\n6");
  }
});

Deno.test("should support custom command handlers", async () => {
  const builder = new CommandBuilder()
    .registerCommand("zardoz-speaks", async (context) => {
      if (context.args.length != 1) {
        await context.stderr.writeLine("zardoz-speaks: expected 1 argument");
        return {
          kind: "continue",
          code: 1,
        };
      }
      await context.stdout.writeLine(`zardoz speaks to ${context.args[0]}`);
      return {
        kind: "continue",
        code: 0,
      };
    })
    .registerCommands({
      "true": () => Promise.resolve({ kind: "continue", code: 0 }),
      "false": () => Promise.resolve({ kind: "continue", code: 1 }),
    }).stderr("piped").stdout("piped");

  {
    const result = await builder.command("zardoz-speaks").noThrow();
    assertEquals(result.code, 1);
    assertEquals(result.stderr, "zardoz-speaks: expected 1 argument\n");
  }
  {
    const result = await builder.command("zardoz-speaks to you").noThrow();
    assertEquals(result.code, 1);
    assertEquals(result.stderr, "zardoz-speaks: expected 1 argument\n");
  }
  {
    const result = await builder.command("zardoz-speaks you").noThrow();
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "zardoz speaks to you\n");
  }
  {
    const result = await builder.command("true && echo yup").noThrow();
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "yup\n");
  }
  {
    const result = await builder.command("false && echo nope").noThrow();
    assertEquals(result.code, 1);
    assertEquals(result.stdout, "");
  }
});

Deno.test("should not allow invalid command names", async () => {
  const builder = new CommandBuilder();
  const hax: CommandHandler = async (context: CommandContext) => {
    context.stdout.writeLine("h4x!1!");
    return {
      kind: "continue",
      code: 0,
    };
  };

  assertThrows(
    () => builder.registerCommand("/dev/null", hax),
    Error,
    "Invalid command name",
  );
  assertThrows(
    () => builder.registerCommand("*", hax),
    Error,
    "Invalid command name",
  );
});

Deno.test("should unregister commands", async () => {
  const builder = new CommandBuilder().unregisterCommand("export").noThrow();
  await assertRejects(
    async () => await builder.command("export somewhere"),
    Error,
    "Command not found: export",
  );
});

Deno.test("sleep command", async () => {
  const start = performance.now();
  const result = await $`sleep 0.2 && echo 1`.text();
  const end = performance.now();
  assertEquals(result, "1");
  assertEquals(end - start > 190, true);
});

Deno.test("test command", async (t) => {
  await Deno.writeFile("zero.dat", new Uint8Array());
  await Deno.writeFile("non-zero.dat", new Uint8Array([242]));
  if (Deno.build.os !== "windows") {
    await Deno.symlink("zero.dat", "linked.dat");
  }

  await t.step("test -e", async () => {
    const result = await $`test -e zero.dat`.noThrow();
    assertEquals(result.code, 0);
  });
  await t.step("test -f", async () => {
    const result = await $`test -f zero.dat`.noThrow();
    assertEquals(result.code, 0, "should be a file");
  });
  await t.step("test -f on non-file", async () => {
    const result = await $`test -f ${Deno.cwd()}`.noThrow().stderr("piped");
    assertEquals(result.code, 1, "should not be a file");
    assertEquals(result.stderr, "");
  });
  await t.step("test -d", async () => {
    const result = await $`test -d ${Deno.cwd()}`.noThrow();
    assertEquals(result.code, 0, `${Deno.cwd()} should be a directory`);
  });
  await t.step("test -d on non-directory", async () => {
    const result = await $`test -d zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 1, "should not be a directory");
    assertEquals(result.stderr, "");
  });
  await t.step("test -s", async () => {
    const result = await $`test -s non-zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 0, "should be > 0");
    assertEquals(result.stderr, "");
  });
  await t.step("test -s on zero-length file", async () => {
    const result = await $`test -s zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 1, "should fail as file is zero-sized");
    assertEquals(result.stderr, "");
  });
  if (Deno.build.os !== "windows") {
    await t.step("test -L", async () => {
      const result = await $`test -L linked.dat`.noThrow();
      assertEquals(result.code, 0, "should be a symlink");
    });
  }
  await t.step("test -L on a non-symlink", async () => {
    const result = await $`test -L zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 1, "should fail as not a symlink");
    assertEquals(result.stderr, "");
  });
  await t.step("should error on unsupported test type", async () => {
    const result = await $`test -z zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 2, "should have exit code 2");
    assertEquals(result.stderr, "test: unsupported test type\n");
  });
  await t.step("should error with not enough arguments", async () => {
    const result = await $`test`.noThrow().stderr("piped");
    assertEquals(result.code, 2, "should have exit code 2");
    assertEquals(result.stderr, "test: expected 2 arguments\n");
  });
  await t.step("should error with too many arguments", async () => {
    const result = await $`test -f a b c`.noThrow().stderr("piped");
    assertEquals(result.code, 2, "should have exit code 2");
    assertEquals(result.stderr, "test: expected 2 arguments\n");
  });
  await t.step("should work with boolean: pass && ..", async () => {
    const result = await $`test -f zero.dat && echo yup`.noThrow().stdout("piped");
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "yup\n");
  });
  await t.step("should work with boolean: fail && ..", async () => {
    const result = await $`test -f ${Deno.cwd()} && echo nope`.noThrow().stdout("piped");
    assertEquals(result.code, 1), "should have exit code 1";
    assertEquals(result.stdout, "");
  });
  await t.step("should work with boolean: pass || ..", async () => {
    const result = await $`test -f zero.dat || echo nope`.noThrow().stdout("piped");
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "");
  });
  await t.step("should work with boolean: fail || ..", async () => {
    const result = await $`test -f ${Deno.cwd()} || echo yup`.noThrow().stdout("piped");
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "yup\n");
  });

  if (Deno.build.os !== "windows") {
    await Deno.remove("linked.dat");
  }
  await Deno.remove("zero.dat");
  await Deno.remove("non-zero.dat");
});

Deno.test("exit command", async () => {
  {
    const result = await $`exit`.noThrow();
    assertEquals(result.code, 1);
  }
  {
    const result = await $`exit 0`.noThrow();
    assertEquals(result.code, 0);
  }
  {
    const result = await $`exit 255`.noThrow();
    assertEquals(result.code, 255);
  }
  {
    const result = await $`exit 256`.noThrow();
    assertEquals(result.code, 0);
  }
  {
    const result = await $`exit 257`.noThrow();
    assertEquals(result.code, 1);
  }
  {
    const result = await $`exit -1`.noThrow();
    assertEquals(result.code, 255);
  }
  {
    const result = await $`exit zardoz`.noThrow().stderr("piped");
    assertEquals(result.code, 2);
    assertEquals(result.stderr, "exit: numeric argument required.\n");
  }
  {
    const result = await $`exit 1 1`.noThrow().stderr("piped");
    assertEquals(result.code, 2);
    assertEquals(result.stderr, "exit: too many arguments\n");
  }
});

Deno.test("should provide result from one command to another", async () => {
  const result = await $`echo 1`.stdout("piped");
  const result2 = await $`echo ${result}`.stdout("piped");
  assertEquals(result2.stdout, "1\n");
});

Deno.test("should actually change the environment when using .exportEnv()", async () => {
  const originalDir = Deno.cwd();
  try {
    const srcDir = path.resolve("./src");
    await $`cd src && export SOME_VALUE=5 && OTHER_VALUE=6`.exportEnv();
    assertEquals(Deno.cwd(), srcDir);
    assertEquals(Deno.env.get("SOME_VALUE"), "5");
    assertEquals(Deno.env.get("OTHER_VALUE"), undefined);
  } finally {
    Deno.chdir(originalDir);
  }
});

Deno.test("exporting env should modify real environment when something changed via the api", async () => {
  const previousCwd = Deno.cwd();
  const envName = "DAX_TEST_ENV_SET";
  try {
    await $`echo 2`
      .cwd("./src")
      .env(envName, "123")
      .exportEnv();
    assertEquals(Deno.env.get(envName), "123");
    assertEquals(Deno.cwd().slice(-3), "src");
  } finally {
    Deno.env.delete(envName);
    Deno.chdir(previousCwd);
  }
});

Deno.test("cwd should be resolved based on cwd at time of method call and not execution", async () => {
  const previousCwd = Deno.cwd();
  try {
    const command = $`echo $PWD`.cwd("./src");
    Deno.chdir("./src/rs_lib");
    const result = await command.text();
    assertEquals(result.slice(-3), "src");
  } finally {
    Deno.chdir(previousCwd);
  }
});

Deno.test("should handle the PWD variable", async () => {
  const srcDir = path.resolve("./src");
  {
    const output = await $`cd src && echo $PWD `.text();
    assertEquals(output, srcDir);
  }
  {
    // changing PWD should affect this
    const output = await $`PWD=$PWD/src && echo $PWD `.text();
    assertEquals(output, srcDir);
  }
});

Deno.test("timeout", async () => {
  const command = $`deno eval 'await new Promise(resolve => setTimeout(resolve, 1_000));'`
    .timeout(200);
  await assertRejects(async () => await command, Error, "Timed out with exit code: 124");

  const result = await command.noThrow();
  assertEquals(result.code, 124);
});

Deno.test("piping to stdin", async () => {
  // Deno.Reader
  {
    const bytes = new TextEncoder().encode("test\n");
    const result =
      await $`deno eval "const b = new Uint8Array(4); await Deno.stdin.read(b); await Deno.stdout.write(b);"`
        .stdin(new Buffer(bytes))
        .text();
    assertEquals(result, "test");
  }

  // string
  {
    const result =
      await $`deno eval "const b = new Uint8Array(4); await Deno.stdin.read(b); await Deno.stdout.write(b);"`
        .stdin("test\n")
        .text();
    assertEquals(result, "test");
  }

  // Uint8Array
  {
    const result =
      await $`deno eval "const b = new Uint8Array(4); await Deno.stdin.read(b); await Deno.stdout.write(b);"`
        .stdin(new TextEncoder().encode("test\n"))
        .text();
    assertEquals(result, "test");
  }
});

Deno.test("command args", async () => {
  const input = "testing   'this   out";
  const result = await new CommandBuilder()
    .command(["echo", input])
    .stdout("piped");
  assertEquals(result.stdout.trim(), input);
  // should be properly escaped here too
  assertEquals(await $`echo ${result}`.text(), input);
});

Deno.test("command .lines()", async () => {
  const result = await $`echo 1 && echo 2`.lines();
  assertEquals(result, ["1", "2"]);
});

Deno.test("basic logging test to ensure no errors", async () => {
  assertEquals($.logDepth, 0);
  $.logGroup();
  assertEquals($.logDepth, 1);
  $.logGroupEnd();
  assertEquals($.logDepth, 0);
  $.logGroupEnd(); // should not error
  assertEquals($.logDepth, 0);
  $.logGroup("Label1");
  let setCount = 0;
  assertEquals($.logDepth, 1);
  $.logGroup("Label2", () => {
    assertEquals($.logDepth, 2);
    setCount++;
  });
  assertEquals(setCount, 1);
  await $.logGroup("Label3", async () => {
    assertEquals($.logDepth, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    setCount++;
    $.log("Test");
    await $.logGroup(async () => {
      assertEquals($.logDepth, 3);
      await new Promise((resolve) => setTimeout(resolve, 0));
      setCount++;
      $.log("Test");
    });
    assertEquals($.logDepth, 2);
  });
  assertEquals($.logDepth, 1);
  $.log("Test");
  assertEquals(setCount, 3);
  $.logGroupEnd();
  assertEquals($.logDepth, 0);

  await $.logGroup("Label3", async () => {
    assertEquals($.logDepth, 1);
    $.logGroupEnd();
    assertEquals($.logDepth, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assertEquals($.logDepth, 0);

  $.logGroup("Label3", () => {
    assertEquals($.logDepth, 1);
    $.logGroupEnd();
    assertEquals($.logDepth, 0);
  });
  assertEquals($.logDepth, 0);

  $.logDepth = 5;
  assertEquals($.logDepth, 5);
  $.log("Test");
  $.logGroupEnd();
  assertEquals($.logDepth, 4);
  $.logDepth = 0;
});

Deno.test("setting logging", async () => {
  const test$ = $.build$();
  const infoLogs: any[] = [];
  const warnLogs: any[] = [];
  const errorLogs: any[] = [];
  test$.setInfoLogger((...args) => {
    infoLogs.push(args);
  });
  test$.setWarnLogger((...args) => {
    warnLogs.push(args);
  });
  test$.setErrorLogger((...args) => {
    errorLogs.push(args);
  });

  test$.log("Info");
  test$.logWarn("Warn");
  test$.logError("Error");

  assertEquals(infoLogs, [["Info"]]);
  assertEquals(warnLogs, [[colors.bold(colors.yellow("Warn"))]]);
  assertEquals(errorLogs, [[colors.bold(colors.red("Error"))]]);
});

Deno.test("printCommand", async () => {
  const $ = build$({});
  const errorLogs: any[] = [];
  $.setErrorLogger((...args) => {
    errorLogs.push(args);
  });

  $.setPrintCommand(true);
  await $`echo 1`;
  await $`echo 2`.printCommand(false);
  await $`echo 3`;
  $.setPrintCommand(false);
  await $`echo 4`;
  await $`echo 5`.printCommand(true);
  const command = $`echo 6`.printCommand(true);
  command.setPrintCommandLogger(() => {}); // no-op
  await command;
  await $`echo 7`.printCommand(true);

  assertEquals(errorLogs, [
    [colors.white(">"), colors.blue("echo 1")],
    [colors.white(">"), colors.blue("echo 3")],
    [colors.white(">"), colors.blue("echo 5")],
    [colors.white(">"), colors.blue("echo 7")],
  ]);
});

Deno.test("environment should be evaluated at command execution", async () => {
  const envName = "DAX_TEST_ENV_SET";
  Deno.env.set(envName, "1");
  try {
    const result = await $.raw`echo $${envName}`.text();
    assertEquals(result, "1");
  } finally {
    Deno.env.delete(envName);
  }
  const result = await $.raw`echo $${envName}`.text();
  assertEquals(result, "");

  // check cwd
  const previousCwd = Deno.cwd();
  try {
    Deno.chdir("./src");
    const result = await $`echo $PWD`.text();
    assertEquals(result.slice(-3), "src");
  } finally {
    Deno.chdir(previousCwd);
  }
});

Deno.test("test remove", async () => {
  const dir = Deno.makeTempDirSync();

  const emptyDir = dir + "/hello";
  const someFile = dir + "/a.txt";

  Deno.mkdirSync(emptyDir);
  Deno.writeTextFileSync(someFile, "");

  await $`rm ${emptyDir}`;
  await $`rm ${someFile}`;
  assertEquals($.fs.existsSync(dir + "/hello"), false);
  assertEquals($.fs.existsSync(dir + "/a.txt"), false);

  const nonEmptyDir = dir + "/a";
  Deno.mkdirSync(nonEmptyDir + "/b", { recursive: true });

  const error = await $`rm ${nonEmptyDir}`.noThrow().stderr("piped").spawn()
    .then((r) => r.stderr);
  const expectedText = Deno.build.os === "linux" || Deno.build.os === "darwin"
    ? "rm: Directory not empty"
    : "rm: The directory is not empty";
  assertEquals(error.substring(0, expectedText.length), expectedText);

  await $`rm -r ${nonEmptyDir}`;
  assertEquals($.fs.existsSync(nonEmptyDir), false);
});
