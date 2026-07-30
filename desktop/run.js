// Launcher. If ELECTRON_RUN_AS_NODE leaks in from the ambient environment, the
// electron binary runs as plain Node and `require("electron")` returns a path
// string instead of the API (app/BrowserWindow become undefined). So we launch
// Electron from a clean env with that var stripped.
//
// Run under Node, `require("electron")` resolves to the electron executable path.
const { spawn } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [path.join(__dirname, "main.js")], {
  stdio: "inherit",
  env,
});
child.on("close", (code) => process.exit(code ?? 0));
