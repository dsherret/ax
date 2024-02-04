import {
  build,
  emptyDir,
} from "https://raw.githubusercontent.com/denoland/dnt/2537df1c38851088bf1f504ae89dd7f037219f8b/mod.ts";

await emptyDir("./npm");

await build({
  entryPoints: ["./mod.ts"],
  outDir: "./npm",
  shims: {
    deno: true,
    undici: true,
    custom: [{
      package: {
        name: "node:stream/web",
      },
      globalNames: [
        "ReadableStream",
        "WritableStream",
        "TextDecoderStream",
        "TransformStream",
        {
          name: "ReadableStreamDefaultReader",
          typeOnly: true,
        },
        {
          name: "WritableStreamDefaultWriter",
          typeOnly: true,
        },
        {
          name: "PipeOptions",
          exportName: "StreamPipeOptions",
          typeOnly: true,
        },
        {
          name: "QueuingStrategy",
          typeOnly: true,
        },
      ],
    }],
  },
  compilerOptions: {
    target: "ES2022",
  },
  mappings: {
    "./src/runtimes/process.deno.ts": "./src/runtimes/process.node.ts",
    "./src/test/server.deno.ts": "./src/test/server.node.ts",
  },
  package: {
    name: "dax-sh",
    version: Deno.args[0],
    description: "Cross platform shell tools inspired by zx.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/dsherret/dax.git",
    },
    bugs: {
      url: "https://github.com/dsherret/dax/issues",
    },
    "dependencies": {
      "array-from-async": "3.0.0",
    },
    devDependencies: {
      "@types/node": "^20.11.9",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");
  },
});
