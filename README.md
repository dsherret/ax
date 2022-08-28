# dax

[![deno doc](https://doc.deno.land/badge.svg)](https://doc.deno.land/https/deno.land/x/dax/mod.ts)

**Note:** This is very early stages. Just started working on it.

Cross platform shell tools for Deno inspired by [zx](https://github.com/google/zx).

Differences:

1. No globals or global configuration.
1. No custom CLI.
1. Cross platform shell to help the code work on Windows.
   - Uses [deno_task_shell](https://github.com/denoland/deno_task_shell)'s parser.
   - Allows exporting the shell's environment to the current process.
1. Good for application code in addition to use as a shell script replacement.
1. Named after my cat.

## Example

```ts
import $ from "https://deno.land/x/dax@VERSION_GOES_HERE/mod.ts";

// run a command with its output sent to stdout and stderr
await $`echo 5`;

// expressions provided to the template literal are escaped if necessary
const dirName = "Dir with spaces";
await $`mkdir ${dirName}`; // executes as: mkdir 'Dir with spaces'

// get the stdout of a command (makes stdout "quiet")
const result = await $`echo 1`.text();
console.log(result); // 1

// get the result of stdout as json (makes stdout "quiet")
const result = await $`echo '{ "prop": 5 }'`.json();
console.log(result.prop); // 5

// get the result of stdout as bytes (makes stdout "quiet")
const result = await $`echo 'test'`.bytes();
console.log(result); // Uint8Array(5) [ 116, 101, 115, 116, 10 ]

// get the result of stdout as a list of lines (makes stdout "quiet")
const result = await $`echo 1 && echo 2`.lines();
console.log(result); // ["1", "2"]

// working with a lower level result that provides more details
const result = await $`deno eval 'console.log(1); console.error(2);'`
  .stdout("piped")
  .stderr("piped");
console.log(result.code); // 0
console.log(result.stdoutBytes); // Uint8Array(2) [ 49, 10 ]
console.log(result.stdout); // 1\n
console.log(result.stderr); // 5\n
const output = await $`echo '{ "test": 5 }'`.stdout("piped");
console.log(output.stdoutJson);

// providing stdout of command to other command
// Note: This will read trim the last newline of the other command's stdout
const result = await $`echo 1`.stdout("piped"); // need to set stdout as piped for this to work
const result2 = await $`echo ${result}`.stdout("piped");
console.log(result2.stdout); // 1\n

// alternatively though, calling `.text()` like so is probably easier
const result = await $`echo 1`.text();
const result2 = await $`echo ${result}`.text();
console.log(result2.stdout); // 1\n

// providing stdin
await $`command`.stdin("some value");
await $`command`.stdin(bytes);
await $`command`.stdin(someReader);

// setting env variables (outputs: 1 2 3 4)
await $`echo $var1 $var2 $var3 $var4`
  .env("var1", "1")
  .env("var2", "2")
  // or use object syntax
  .env({
    var3: "3",
    var4: "4",
  });

// setting cwd for command
await $`deno eval 'console.log(Deno.cwd());'`.cwd("./someDir");

// makes a command not output anything to stdout and stderr
// if set to "inherit" or "inheritPiped"
await $`echo 5`.quiet();
await $`echo 5`.quiet("stdout"); // or just stdout
await $`echo 5`.quiet("stderr"); // or just stderr

// output the command before executing it
const text = "example";
await $`echo ${text}`.printCommand();
// outputs:
// > echo example
// example

// timeout a command after a specified time
await $`some_command`.timeout("1s");

// logs with potential indentation
// Note: everything is logged over stderr
$.log("Hello!");
// log with the first word as bold green
$.logStep("Fetching data from server...");
// or force multiple words to be green by using two arguments
$.logStep("Setting up", "local directory...");
// similar to $.logStep, but with red
$.logError("Error Some error message.");
// similar to $.logStep, but with yellow
$.logWarn("Warning Some warning message.");
// logs out text in gray
$.logLight("Some unimportant message.");

// log indented within (handles de-indenting when an error is thrown)
await $.logGroup(async () => {
  $.log("This will be indented.");
  await $.logGroup(async () => {
    $.log("This will indented even more.");
    // do maybe async stuff here
  });
});

// or use $.logGroup with $.logGroupEnd
$.logGroup();
$.log("Indented 1");
$.logGroup("Level 2");
$.log("Indented 2");
$.logGroupEnd();
$.logGroupEnd();

// change directory
$.cd("newDir");

// if the path exists
// Note: beware of "time of check to time of use" race conditions when using this
await $.exists("./file.txt");
$.existsSync("./file.txt");

// sleep
await $.sleep(100); // ms
await $.sleep("1.5s");
await $.sleep("100ms");

// download a file as JSON (this will throw on non-2xx status code)
const data = await $.request("https://plugins.dprint.dev/info.json").json();
// or text
const text = await $.request("https://example.com").text();
// or long form
const response = await $.request("https://plugins.dprint.dev/info.json");
console.log(response.code);
console.log(await response.json());

// get path to an executable
await $.which("deno"); // path to deno executable

// attempt doing an action until it succeeds
await $.withRetries({
  count: 5,
  // you may also specify an iterator here which is useful for exponential backoff
  delay: "5s",
  action: async () => {
    await $`cargo publish`;
  },
});

// re-export of deno_std's path
$.path.basename("./deno/std/path/mod.ts"); // mod.ts

// re-export of deno_std's fs
for await (const file of $.fs.expandGlob("**/*.ts")) {
  console.log(file);
}

// export the environment of a command to the executing process
await $`cd src && export MY_VALUE=5`.exportEnv();
// will output "5"
await $`echo $MY_VALUE`;
// will output it's in the src dir
await $`echo $PWD`;
// this will also output it's in the src dir
console.log(Deno.cwd());
```

## Shell

The shell is cross platform and uses the parser from [deno_task_shell](https://github.com/denoland/deno_task_shell).

Sequential lists:

```ts
// result will contain the directory in someDir
const result = await $`cd someDir ; deno eval 'console.log(Deno.cwd())'`;
```

Boolean lists:

```ts
// returns stdout with 1\n\2n
await $`echo 1 && echo 2`;
// returns stdout with 1\n
await $`echo 1 || echo 2`;
```

Setting env var for command in the shell (generally you can just use `.env(...)` though):

```ts
// result will contain the directory in someDir
const result = await $`test=123 deno eval 'console.log(Deno.env.get('test'))'`;
console.log(result.stdout); // 123
```

Shell variables (these aren't exported):

```ts
// the 'test' variable WON'T be exported to the sub processes, so
// that will print a blank line, but it will be used in the final echo command
await $`test=123 && deno eval 'console.log(Deno.env.get('test'))' && echo $test`;
```

Env variables (these are exported):

```ts
// the 'test' variable WILL be exported to the sub processes and
// it will be used in the final echo command
await $`export test=123 && deno eval 'console.log(Deno.env.get('test'))' && echo $test`;
```

Variable substitution:

```ts
const result = await $`echo $TEST`.env("TEST", "123").text();
console.log(result); // 123
```

### Custom Cross Platform Shell Commands

Currently implemented (though not every option is supported):

- [`cd`](https://man7.org/linux/man-pages/man1/cd.1p.html) - Change directory command.
  - Note that shells don't export their environment by default.
- [`echo`](https://man7.org/linux/man-pages/man1/echo.1.html) - Echo command.
- [`exit`](https://man7.org/linux/man-pages/man1/exit.1p.html) - Exit command.
- [`sleep`](https://man7.org/linux/man-pages/man1/sleep.1.html) - Sleep command.
- [`test`](https://man7.org/linux/man-pages/man1/test.1.html) - Test command.
- More to come. Will try to get a similar list as https://deno.land/manual/tools/task_runner#built-in-commands

You can also register your own commands with the shell parser (see below).

## Builder APIs

The builder APIs are what the library uses internally and they're useful for scenarios where you want to re-use some setup state. They're immutable so every function call returns a new object (which is the same thing that happens with the objects returned from `$` and `$.request`).

### `CommandBuilder`

`CommandBuilder` can be used for building up commands similar to what the tagged template `$` does:

```ts
import {
  CommandBuilder,
} from "https://deno.land/x/dax@VERSION_GOES_HERE/mod.ts";

const commandBuilder = new CommandBuilder()
  .cwd("./subDir")
  .stdout("inheritPiped") // output to stdout and pipe to a buffer
  .noThrow();

const otherBuilder = commandBuilder
  .stderr("null");

const result = await commandBuilder
  // won't have a null stderr
  .command("deno run my_script.ts")
  .spawn();

const result2 = await otherBuilder
  // will have a null stderr
  .command("deno run my_script.ts")
  .spawn();
```

You can also register your own custom commands using the `registerCommand` or `registerCommands` methods:

```ts
const commandBuilder = new CommandBuilder()
  .registerCommand(
    "true",
    () => Promise.resolve({ kind: "continue", code: 0 }),
  );

const result = await commandBuilder
  // now includes the 'true' command
  .command("true && echo yay")
  .spawn();
```

### `RequestBuilder`

`RequestBuilder` can be used for building up requests similar to `$.request`:

```ts
import {
  RequestBuilder,
} from "https://deno.land/x/dax@VERSION_GOES_HERE/mod.ts";

const requestBuilder = new RequestBuilder()
  .header("SOME_VALUE", "some value to send in a header");

const result = await requestBuilder
  .url("https://example.com")
  .text();
```

### Custom `$`

You may wish to create your own `$` function that has a certain setup context (for example, custom commands, a defined environment variable or cwd). You may do this by using the exported `build$` with `CommandBuilder` and/or `RequestBuilder`, which is what the main default exported `$` function uses internally to build itself:

```ts
import {
  build$,
  CommandBuilder,
  RequestBuilder,
} from "https://deno.land/x/dax@VERSION_GOES_HERE/mod.ts";

const commandBuilder = new CommandBuilder()
  .cwd("./subDir")
  .env("HTTPS_PROXY", "some_value");
const requestBuilder = new RequestBuilder()
  .header("SOME_NAME", "some value");

// creates a $ object with the starting environment as shown above
const $ = build$({ commandBuilder, requestBuilder });

// this command will use the env described above, but the main
// process won't have its environment changed
await $`deno run my_script.ts`;

const data = await $.request("https://plugins.dprint.dev/info.json").json();
```

This may be useful also if you want to change the default configuration. Another example:

```ts
const commandBuilder = new CommandBuilder()
  .exportEnv()
  .noThrow();

const $ = build$({ commandBuilder });

// since exportEnv() was set, this will now actually change
// the directory of the executing process
await $`cd test && export MY_VALUE=5`;
// will output "5"
await $`echo $MY_VALUE`;
// will output it's in the test dir
await $`echo $PWD`;
// won't throw even though this command fails (because of `.noThrow()`)
await $`deno eval 'Deno.exit(1);'`;
```
