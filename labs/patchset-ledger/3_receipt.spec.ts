import { expect, test } from "@playwright/test";
import { runPatchsetLab, type PatchsetLabReceipt } from "./1_lab";
import { gitToGerritDiff, makeTranslationRepo } from "./7_git_to_gerrit";

function card(title: string, value: unknown): string {
  return `<section><h3>${title}</h3><pre>${JSON.stringify(value, null, 2)}</pre></section>`;
}

function transition(title: string, value: PatchsetLabReceipt["firstPush"]): string {
  return `<article><h2>${title}</h2><div class="flow">${card("BEFORE", value.before)}<b>→</b>${card("PRE-PUSH EVENT", value.event)}<b>→</b>${card("AFTER", value.after)}</div><footer>Commits inside patch set: ${value.commits.join(" · ")}</footer></article>`;
}

test("before, pre-push event, and after receipt", async ({ page }, testInfo) => {
  const receipt = runPatchsetLab();
  await testInfo.attach("patchset-ledger-receipt", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box} body{margin:0;padding:28px;background:#0b1020;color:#e5edf9;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
    h1{margin:0 0 20px;font:700 25px system-ui} article{margin:0 0 20px;padding:18px;border:1px solid #334155;border-radius:10px;background:#111827}
    h2{margin:0 0 14px;color:#93c5fd;font:700 18px system-ui}.flow{display:grid;grid-template-columns:1fr 28px 1fr 28px 1fr;align-items:stretch;gap:8px}
    section{min-width:0;padding:12px;border:1px solid #475569;border-radius:7px;background:#0f172a}h3{margin:0 0 8px;color:#a7f3d0;font:700 12px system-ui;letter-spacing:.08em}
    pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}b{display:grid;place-items:center;color:#fbbf24;font-size:22px}footer{margin-top:12px;color:#cbd5e1}
    .proof{padding:14px;border:1px solid #166534;border-radius:8px;background:#052e16;color:#bbf7d0} .proof strong{color:#4ade80}
  </style><body><h1>Git branch patch-set ledger</h1>${transition("1. Standard first push", receipt.firstPush)}${transition("2. Rebase onto main + force-with-lease", receipt.forceWithLeaseAfterRebase)}<div class="proof"><strong>GC proof:</strong> ${receipt.afterReflogExpiryAndGc.retainedObjects.join(" + ")} remain after reflog expiry and git gc --prune=now<br><pre>${receipt.afterReflogExpiryAndGc.diff}</pre></div></body>`);
  await expect(page).toHaveScreenshot("patchset-ledger.png", { fullPage: true });
});

test("real git output translated onto Gerrit DiffInfo shapes", async ({ page }, testInfo) => {
  const { repo, from, to } = makeTranslationRepo();
  const files = gitToGerritDiff(repo, from, to);
  await testInfo.attach("patchset-gerrit-diffinfo", {
    body: JSON.stringify(files, null, 2),
    contentType: "application/json",
  });
  const cards = files
    .map(
      (f) =>
        `<section><h3>${f.path} · ${f.type}</h3><pre>${JSON.stringify(f.info, null, 2)}</pre></section>`
    )
    .join("");
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box} body{margin:0;padding:28px;background:#0b1020;color:#e5edf9;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
    h1{margin:0 0 6px;font:700 24px system-ui} p.note{margin:0 0 20px;color:#93c5fd}
    section{margin-bottom:14px;padding:14px;border:1px solid #334155;border-radius:9px;background:#111827}
    h3{margin:0 0 10px;color:#a7f3d0;font:700 13px system-ui;letter-spacing:.06em}
    pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}
  </style><body><h1>Git patch set → Gerrit DiffInfo</h1><p class="note">Real git output mapped to polygerrit-ui DiffInfo (meta_a / meta_b / content).</p>${cards}</body>`);
  await expect(page).toHaveScreenshot("patchset-gerrit-translation.png", { fullPage: true });
});
