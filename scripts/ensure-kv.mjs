// CI helper: find or create this Worker's KV namespaces by title, then write
// their ids into wrangler.toml (replacing the __BINDING_ID__ placeholders).
// Needed because automatic provisioning writes ids back to the config file,
// and CI checkouts are thrown away after each run.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BINDINGS = ["RISK_CACHE", "RATE_LIMIT"];
const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function list() {
  const out = wrangler("kv", "namespace", "list");
  return JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1));
}

let namespaces = list();
let toml = readFileSync("wrangler.toml", "utf8");
for (const binding of BINDINGS) {
  const title = `zackscan-${binding}`;
  const find = () => namespaces.find((n) => n.title === title || n.title.endsWith(title));
  if (!find()) {
    console.log(`Creating KV namespace ${title}`);
    wrangler("kv", "namespace", "create", title);
    namespaces = list();
  }
  const ns = find();
  if (!ns) throw new Error(`KV namespace ${title} not found after create`);
  toml = toml.replace(`__${binding}_ID__`, ns.id);
  console.log(`${binding} -> ${ns.id} (${ns.title})`);
}
if (/__[A-Z_]+_ID__/.test(toml)) throw new Error("Unfilled KV placeholder left in wrangler.toml");
writeFileSync("wrangler.toml", toml);
