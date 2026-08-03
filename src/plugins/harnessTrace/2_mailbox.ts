// Frontend read side of the mailbox: the same list_dir/read_text seam the trace
// panel's ledger join uses, parsed into ruled envelopes. Read-only — a send or
// an ack appends to the log from out of process (scripts/bus.ts), because the
// tmux and cass legs have no native command on this seam.
import { invoke } from "../../generated/native";
import type { DirListing } from "../../state";
import { MailDirectory, MailStore } from "./0_bus";
import type { IMailbox, IMailboxReader, IMailDirectory, IMailMessage } from "./0_types";

export const MAIL_DIR = "~/.agent/mail";

export const MailboxReader: IMailboxReader = {
  // A missing mail dir reads as an empty mailbox, never an error: the bus is
  // opt-in per machine.
  read(dir) {
    return invoke<DirListing>("list_dir", { path: dir })
      .then((listing) => {
        const files = listing.entries.filter((entry) => !entry.is_dir);
        const reads = files.map((entry) =>
          invoke<string>("read_text", { path: entry.path })
            .catch(() => "")
            .then((text) => ({ name: entry.name, text })),
        );
        return Promise.all(reads);
      })
      .then((files) => {
        const messages: IMailMessage[] = [];
        let directory: IMailDirectory = {};
        for (const file of files) {
          if (file.name === "registry.json") directory = MailDirectory.parse(file.text);
          else if (file.name.endsWith(".ndjson")) messages.push(...MailStore.parse(file.text));
        }
        return { messages, directory } satisfies IMailbox;
      })
      .catch(() => ({ messages: [], directory: {} }));
  },
};
