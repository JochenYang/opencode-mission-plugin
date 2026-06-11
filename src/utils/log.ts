import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import os from "node:os"

const LOG_FILE =
  process.env.OPENCODE_MISSION_DEBUG_FILE ??
  join(os.homedir(), ".config", "opencode", "missions", "debug.log")

let fileReady = false

function ensureFile() {
  if (fileReady) return
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    fileReady = true
  } catch {
    // best effort
  }
}

export function log(msg: string) {
  if (process.env.OPENCODE_MISSION_DEBUG !== "1") return
  ensureFile()
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // best effort
  }
}
