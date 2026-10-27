import { emitKeypressEvents } from "node:readline";

/**
 * A terminal multi-select on stderr, so stdout stays JSON: ↑/↓ move, space
 * toggles, enter confirms, Ctrl-C or Esc cancels. Resolves the chosen
 * values, or null when cancelled.
 */
export function checkbox<T>(
  message: string,
  choices: Array<{ value: T; label: string; checked: boolean }>,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<T[] | null> {
  const checked = choices.map((choice) => choice.checked);
  let cursor = 0;
  let drawn = 0;
  const draw = () => {
    if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
    const lines = [
      `${message} (↑/↓ move, space toggles, enter confirms)`,
      ...choices.map(
        (choice, index) =>
          `${index === cursor ? "❯" : " "} ${checked[index] ? "◉" : "◯"} ${choice.label}`,
      ),
    ];
    output.write(`${lines.join("\n")}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    const finish = (value: T[] | null) => {
      input.off("keypress", onKey);
      input.setRawMode?.(wasRaw);
      input.pause();
      resolve(value);
    };
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if ((key.ctrl && key.name === "c") || key.name === "escape")
        return finish(null);
      if (key.name === "return")
        return finish(
          choices
            .filter((_, index) => checked[index])
            .map((choice) => choice.value),
        );
      if (key.name === "up" || key.name === "k")
        cursor = (cursor + choices.length - 1) % choices.length;
      else if (key.name === "down" || key.name === "j")
        cursor = (cursor + 1) % choices.length;
      else if (key.name === "space") checked[cursor] = !checked[cursor];
      else return;
      draw();
    };
    input.on("keypress", onKey);
    draw();
  });
}
