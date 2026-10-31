// Spawns the stdio server WITHOUT EVM_PRIVATE_KEY, lists tools, calls api_info and a paid tool. Cannot pay.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const env = { ...process.env }; delete env.EVM_PRIVATE_KEY;
const c = new Client({ name: "smoke", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env }));
console.log("tools:", (await c.listTools()).tools.map((t) => t.name).join(", "));
const info = await c.callTool({ name: "api_info", arguments: {} });
console.log("api_info:", info.content[0].text.slice(0, 120));
for (const [name, args] of [["translate_ar", { text: "مرحبا" }], ["summarize_ar", { text: "hello world", length: "short" }]]) {
  const r = await c.callTool({ name, arguments: args });
  console.log(name, "isError=", r.isError, "->", r.content[0].text.slice(0, 160));
}
await c.close();
