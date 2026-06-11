// Postuninstall: remove the plugin entry from opencode.json.
// Does NOT delete the plugin file from ~/.config/opencode/plugins/ —
// the user may want to keep using a manually-built copy.

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

const PLUGIN_REF = "./plugins/opencode-mission.js"
const log = (msg) => console.log(`[opencode-mission] ${msg}`)

function opencodeConfigDir() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA
    if (appdata) return path.join(appdata, "opencode")
    return path.join(os.homedir(), "AppData", "Roaming", "opencode")
  }
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return path.join(xdg, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

async function main() {
  const configFile = path.join(opencodeConfigDir(), "opencode.json")
  let config
  try {
    const text = await fs.readFile(configFile, "utf8")
    config = JSON.parse(text)
  } catch (err) {
    if (err && err.code === "ENOENT") {
      log(`no ${configFile}; nothing to clean up`)
      return
    }
    log(`could not read ${configFile} (${err.message}); leaving it as-is`)
    return
  }

  const list = Array.isArray(config.plugin) ? config.plugin : []
  const next = list.filter((entry) => entry !== PLUGIN_REF)
  if (next.length === list.length) {
    log(`plugin entry not present in ${configFile}; no change`)
    return
  }

  config.plugin = next
  await fs.writeFile(configFile, JSON.stringify(config, null, 2) + "\n", "utf8")
  log(`removed "${PLUGIN_REF}" from ${configFile}`)
}

main().catch((err) => {
  console.error(`[opencode-mission] postuninstall failed: ${err.message}`)
  process.exit(1)
})
