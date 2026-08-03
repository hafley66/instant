import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { setHomeDir } from "../src/core";
import { MailPreview } from "../src/plugins/harnessTrace/4_MailPreview";

// The mailbox itself is the spec's fixture (stubbed list_dir/read_text), so the
// render walks the real read path: MailboxReader -> MailStore fold -> rows.
setHomeDir("/Users/e2e");
createRoot(document.getElementById("app")!).render(
  createElement(MailPreview, { agentId: "lane-a", mailDir: "~/.agent/mail" }),
);
