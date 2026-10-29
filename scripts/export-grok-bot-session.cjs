#!/usr/bin/env node
/**
 * Export the current user's Grok Bot desktop gateway descriptor on Windows.
 * Optional --include-backend exports only the active desktop account access token, never a refresh token.
 * Format reference: https://github.com/ScriptedAlchemy/grok-bot-cli
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

function decryptWindowsText(encrypted, key) {
  const bytes = Buffer.from(encrypted, "base64");
  if (bytes.length < 31 || bytes.subarray(0, 3).toString() !== "v10") {
    throw new Error("Unsupported desktop encryption format; no credentials were exported.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(3, 15));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(15, -16)), decipher.final()]).toString("utf8");
}

function decryptWindows(encrypted, key) { return JSON.parse(decryptWindowsText(encrypted, key)); }
function backendSession(saved, key, entry) {
  const accounts = saved["cursor-accounts"] ? JSON.parse(saved["cursor-accounts"]) : undefined;
  const scope = entry ?? accounts?.active;
  if (entry && accounts && !accounts.accounts?.[entry]) throw new Error("The selected account is not saved in sand-secrets.json.");
  const account = scope ? accounts?.accounts?.[scope] ?? saved : saved;
  const reveal = stored => {
    if (!stored) return undefined;
    if (stored.startsWith("plaintext:v1:")) return Buffer.from(stored.slice(13), "base64").toString("utf8");
    if (stored.startsWith("scoped:v1:")) stored = stored.slice(stored.indexOf(":", 10) + 1);
    return decryptWindowsText(stored, key);
  };
  const accessToken = reveal(account["cursor-access-token"]);
  if (!accessToken) throw new Error("No active desktop account access token. Open the signed-in Grok Bot app first.");
  const team = reveal(account["cursor-selected-team-id"]);
  const machineId = reveal(saved["cursor-machine-id"]);
  return { baseUrl: "https://api2.cursor.sh", accessToken, ...(machineId ? { machineId } : {}),
    ...(team && Number.isSafeInteger(Number(team)) && Number(team) > 0 ? { teamId: Number(team) } : {}), clientVersion: "0.77.0" };
}

function selectPayload(wrapped, entry) {
  if (wrapped.version === 2 || wrapped.version === 3) {
    const entries = wrapped.entries ?? {};
    const keys = Object.keys(entries);
    if (entry && !Object.hasOwn(entries, entry)) throw new Error("The selected gateway entry does not exist.");
    if (!entry && keys.length !== 1) throw new Error("Multiple or no saved gateways; select one with --entry ENTRY_KEY.");
    const selected = entries[entry ?? keys[0]];
    if (!selected || typeof selected.encrypted !== "string") {
      throw new Error("This gateway entry has a different payload format. Run --inspect and share only its field types.");
    }
    return selected.encrypted;
  }
  if (wrapped.version != null && wrapped.version !== 1) throw new Error("Unsupported gateway descriptor version.");
  return wrapped.encrypted;
}

// Search only likely application/profile folders; never traverse the whole user disk.
function findAppDir(preferred, roots, includeBackend, hasGatewayExport, explicit = false) {
  const usable = dir => fs.existsSync(path.join(dir, "Local State")) &&
    (hasGatewayExport || fs.existsSync(path.join(dir, "gateway-descriptor.json"))) &&
    (!includeBackend || fs.existsSync(path.join(dir, "sand-secrets.json")));
  if (usable(preferred)) return preferred;
  const children = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => path.join(dir, e.name)); } catch { return []; } };
  const candidates = new Set([preferred]);
  if (!explicit) for (const root of roots.filter(Boolean)) {
    for (const dir of children(root).filter(dir => /grok|cursor|sand/i.test(path.basename(dir)))) candidates.add(dir);
  }
  for (const dir of [...candidates]) for (const child of children(dir).slice(0, 100)) {
    candidates.add(child);
    if (/^profiles?$/i.test(path.basename(child))) for (const profile of children(child).slice(0, 100)) candidates.add(profile);
  }
  const found = [...candidates].filter(usable);
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new Error(`Multiple desktop data folders found. Select one with --app-dir: ${found.join("; ")}`);
  const present = [...candidates].filter(dir => ["Local State", "gateway-descriptor.json", "sand-secrets.json"].some(file => fs.existsSync(path.join(dir, file))));
  throw new Error(`Desktop credential files were not found together. Checked: ${present.length ? present.join("; ") : preferred}. Use --app-dir with the desktop data folder. If gateway-descriptor.json is absent but you have the previous export, add --gateway-session PATH_TO_OLD_EXPORT. Run --inspect to check file presence without exporting credentials.`);
}
function readGatewaySession(file) {
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const url = new URL(saved.gatewayUrl);
  if (url.protocol !== "https:" || url.username || url.password || typeof saved.gatewayToken !== "string" || !saved.gatewayToken) throw new Error("The previous gateway session export is invalid.");
  return { baseUrl: saved.gatewayUrl, token: saved.gatewayToken, headers: saved.headers ?? {} };
}

function main(args) {
  if (process.platform !== "win32") throw new Error("Run this exporter on your signed-in Windows desktop, as the same Windows user.");
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${flag}`);
    return args[index + 1];
  };
  const preferredDir = value("--app-dir", path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Grok Bot"));
  const gatewayExport = value("--gateway-session");
  const includeBackend = args.includes("--include-backend");
  const appDir = args.includes("--inspect") ? preferredDir : findAppDir(preferredDir,
    [process.env.APPDATA, process.env.LOCALAPPDATA], includeBackend, Boolean(gatewayExport), args.includes("--app-dir"));
  const descriptorFile = path.join(appDir, "gateway-descriptor.json");
  const stateFile = path.join(appDir, "Local State");
  if (args.includes("--inspect")) {
    const present = fs.existsSync(descriptorFile);
    const wrapped = present ? JSON.parse(fs.readFileSync(descriptorFile, "utf8")) : {};
    const fieldTypes = value => Object.fromEntries(Object.entries(value ?? {}).map(([k, v]) => [k, Array.isArray(v) ? "array" : v === null ? "null" : typeof v]));
    console.log(JSON.stringify({ appDir, gatewayDescriptorPresent: present, localStatePresent: fs.existsSync(stateFile), backendSecretsPresent: fs.existsSync(path.join(appDir, "sand-secrets.json")),
      version: wrapped.version ?? null, entryKeys: Object.keys(wrapped.entries ?? {}),
      descriptorFieldTypes: fieldTypes(wrapped),
      entryFieldTypes: Object.fromEntries(Object.entries(wrapped.entries ?? {}).map(([k,v]) => [k, fieldTypes(v)])) }, null, 2));
    return;
  }
  const output = path.resolve(value("--output", path.join(os.homedir(), "grok-bot-session.json")));
  if (fs.existsSync(output)) throw new Error("Output already exists; choose a new --output path or remove the old export first.");
  const wrapped = gatewayExport ? undefined : JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
  const encrypted = wrapped ? selectPayload(wrapped, value("--entry")) : undefined;
  if (!gatewayExport && (typeof encrypted !== "string" || !encrypted)) throw new Error("No saved gateway payload. Open Grok Bot and connect to your computer first.");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const blob = Buffer.from(state.os_crypt?.encrypted_key ?? "", "base64");
  if (blob.subarray(0, 5).toString() !== "DPAPI") throw new Error("Windows Safe Storage key is missing or has an unsupported format.");
  const script = "Add-Type -AssemblyName System.Security; " +
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const key = Buffer.from(execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: blob.subarray(5).toString("base64"), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000,
  }).trim(), "base64");
  let descriptor, backend;
  try {
    descriptor = gatewayExport ? readGatewaySession(gatewayExport) : decryptWindows(encrypted, key);
    if (args.includes("--include-backend")) {
      try { backend = backendSession(JSON.parse(fs.readFileSync(path.join(appDir, "sand-secrets.json"), "utf8")), key, value("--entry")); }
      catch { throw new Error("Could not export the active desktop account access token from sand-secrets.json. Open the signed-in app and select the matching account."); }
    }
  } finally { key.fill(0); }
  const url = new URL(descriptor.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Gateway URL must use HTTPS without embedded credentials.");
  if (typeof descriptor.token !== "string" || !descriptor.token) throw new Error("Gateway token is missing.");
  const session = { version: 1, gatewayUrl: descriptor.baseUrl, gatewayToken: descriptor.token,
    headers: descriptor.headers ?? {}, ...(backend ? { backend } : {}), exportedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(session, null, 2), { flag: "wx", mode: 0o600 });
  // Limit the plaintext export to the current Windows account.
  try {
    const identity = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync("icacls.exe", [output, "/inheritance:r", "/grant:r", `${identity}:(F)`], { stdio: "pipe" });
  } catch {
    fs.unlinkSync(output);
    throw new Error("Could not restrict export permissions; the export was removed.");
  }
  console.log(`Exported desktop gateway session to: ${output}`);
  console.log("Transfer this file privately to the server. Do not paste its content into chat or commit it.");
}

module.exports = { decryptWindows, decryptWindowsText, selectPayload, backendSession, findAppDir, readGatewaySession };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    // Child-process diagnostics can contain sensitive data; never print them.
    const message = error && !error.cmd && !error.stdout && !error.stderr ? error.message : "Windows credential export failed. Check that you are the signed-in Windows user.";
    console.error(message || "Credential export failed.");
    process.exitCode = 1;
  }
}
