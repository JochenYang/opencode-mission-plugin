// Postinstall: install the bundled plugin into the user's opencode config dir
// and register it in opencode.json so opencode loads it on next start.
//
// Idempotent: re-running postinstall (e.g. on `npm i -g --force`) is safe.
// Cross-platform: resolves the opencode config dir as ~/.config/opencode
// (XDG-style on every platform, overridable with $XDG_CONFIG_HOME).

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, "..")
const PLUGIN_FILENAME = "opencode-mission.js"
const PLUGIN_REF = `./plugins/${PLUGIN_FILENAME}`

const log = (msg) => console.log(`[opencode-mission] ${msg}`)
const warn = (msg) => console.warn(`[opencode-mission] ${msg}`)

function opencodeConfigDir() {
  // opencode is XDG-style on every platform: ~/.config/opencode
  // (overridable with $XDG_CONFIG_HOME)
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : os.homedir()
  return path.join(base, ".config", "opencode")
}

async function copyPlugin(targetDir) {
  const src = path.join(PACKAGE_ROOT, "dist", "index.js")
  const dst = path.join(targetDir, PLUGIN_FILENAME)
  await fs.mkdir(targetDir, { recursive: true })
  await fs.copyFile(src, dst)
  log(`copied bundle -> ${dst}`)
  return dst
}

async function registerInConfig(configFile) {
  let config = {}
  let existed = true
  try {
    const text = await fs.readFile(configFile, "utf8")
    config = text.trim() ? JSON.parse(text) : {}
  } catch (err) {
    if (err && err.code === "ENOENT") {
      existed = false
      config = {}
    } else {
      warn(`could not parse ${configFile} (${err.message}); skipping config registration`)
      return
    }
  }

  const list = Array.isArray(config.plugin) ? config.plugin.slice() : []
  if (list.includes(PLUGIN_REF)) {
    log(`opencode.json already lists "${PLUGIN_REF}"; no change`)
    return
  }

  list.push(PLUGIN_REF)
  config.plugin = list
  await fs.mkdir(path.dirname(configFile), { recursive: true })
  await fs.writeFile(configFile, JSON.stringify(config, null, 2) + "\n", "utf8")
  log(`${existed ? "updated" : "created"} ${configFile} with plugin entry`)
}

async function main() {
  const configDir = opencodeConfigDir()
  const pluginsDir = path.join(configDir, "plugins")
  const configFile = path.join(configDir, "opencode.json")

  log(`config dir: ${configDir}`)
  await copyPlugin(pluginsDir)
  try {
    await registerInConfig(configFile)
  } catch (err) {
    warn(`failed to update ${configFile}: ${err.message}`)
    warn(`you can still load the plugin manually by adding "${PLUGIN_REF}" to the plugin array`)
  }
  log("done. restart opencode to load the plugin.")
}

main().catch((err) => {
  console.error(`[opencode-mission] postinstall failed: ${err.message}`)
  process.exit(1)
})
