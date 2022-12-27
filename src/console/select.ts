import { colors } from "../deps.ts";
import { createSelection, Keys, resultOrExit, TextItem } from "./utils.ts";

/** Options for showing a selection that only has one result. */
export interface SelectOptions {
  /** Prompt text to show the user. */
  message: string;
  /** Initial selected option index. Defaults to 0. */
  initialIndex?: number;
  /** Options to show the user. */
  options: string[];
  /**
   * Whether to not clear the selection text on selection.
   * @default `false`
   */
  noClear?: boolean;
}

export function select(opts: SelectOptions) {
  return maybeSelect(opts).then(resultOrExit);
}

export function maybeSelect(opts: SelectOptions) {
  if (opts.options.length <= 1) {
    throw new Error(`You must provide at least two options. (Prompt: '${opts.message}')`);
  }

  const drawState: DrawState = {
    title: opts.message,
    activeIndex: (opts.initialIndex ?? 0) % opts.options.length,
    items: opts.options,
  };

  return createSelection({
    message: opts.message,
    noClear: opts.noClear,
    render: () => render(drawState),
    onKey: (key) => {
      switch (key) {
        case Keys.Up:
          if (drawState.activeIndex === 0) {
            drawState.activeIndex = drawState.items.length - 1;
          } else {
            drawState.activeIndex--;
          }
          break;
        case Keys.Down:
          drawState.activeIndex = (drawState.activeIndex + 1) % drawState.items.length;
          break;
        case Keys.Enter:
          return drawState.activeIndex;
      }
    },
  });
}

interface DrawState {
  title: string;
  activeIndex: number;
  items: string[];
}

function render(state: DrawState): TextItem[] {
  const items = [];
  items.push(colors.bold(colors.blue(state.title)));
  for (const [i, text] of state.items.entries()) {
    const prefix = i === state.activeIndex ? "> " : "  ";
    items.push({
      text: `${prefix}${text}`,
      indent: 4,
    });
  }
  return items;
}
