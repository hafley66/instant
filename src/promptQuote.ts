// Writing a selection into an agent's input bar. Kept free of imports so the
// pty-facing byte rules are testable without a DOM.

/// A body written straight to a pty so an agent's input bar takes it as one
/// literal block. Newlines written bare are Enter presses and tmux squashes
/// \r/\n alike, so a multi-line write submits once per line; the paste markers
/// make the app insert the newlines as editable text instead. Same mechanism
/// the Shift+Enter binding uses (terminal.ts), and it survives tmux untouched.
///
/// Every other control byte goes, ESC included: an ESC inside the body could
/// close the paste early and let the remainder run as keystrokes.
export function bracketedPaste(body: string): string {
  const text = body
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, " ");
  return `\x1b[200~${text}\x1b[201~`;
}

/// The selected rows as a quote an agent reads as context, with the cursor left
/// on a blank line under it so the reader types their question there.
export function quoteForPrompt(text: string): string {
  const body = text.replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line}`.trimEnd());
  return `${body.join("\n")}\n\n`;
}
