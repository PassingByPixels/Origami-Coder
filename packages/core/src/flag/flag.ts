import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["ORIGAMI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["ORIGAMI_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("ORIGAMI_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  ORIGAMI_AUTO_HEAP_SNAPSHOT: truthy("ORIGAMI_AUTO_HEAP_SNAPSHOT"),
  ORIGAMI_GIT_BASH_PATH: process.env["ORIGAMI_GIT_BASH_PATH"],
  ORIGAMI_CONFIG: process.env["ORIGAMI_CONFIG"],
  ORIGAMI_CONFIG_CONTENT: process.env["ORIGAMI_CONFIG_CONTENT"],
  ORIGAMI_DISABLE_AUTOUPDATE: truthy("ORIGAMI_DISABLE_AUTOUPDATE"),
  ORIGAMI_ALWAYS_NOTIFY_UPDATE: truthy("ORIGAMI_ALWAYS_NOTIFY_UPDATE"),
  ORIGAMI_DISABLE_PRUNE: truthy("ORIGAMI_DISABLE_PRUNE"),
  ORIGAMI_DISABLE_TERMINAL_TITLE: truthy("ORIGAMI_DISABLE_TERMINAL_TITLE"),
  ORIGAMI_SHOW_TTFD: truthy("ORIGAMI_SHOW_TTFD"),
  ORIGAMI_DISABLE_AUTOCOMPACT: truthy("ORIGAMI_DISABLE_AUTOCOMPACT"),
  ORIGAMI_DISABLE_MODELS_FETCH: truthy("ORIGAMI_DISABLE_MODELS_FETCH"),
  ORIGAMI_DISABLE_MOUSE: truthy("ORIGAMI_DISABLE_MOUSE"),
  ORIGAMI_FAKE_VCS: process.env["ORIGAMI_FAKE_VCS"],
  ORIGAMI_SERVER_PASSWORD: process.env["ORIGAMI_SERVER_PASSWORD"],
  ORIGAMI_SERVER_USERNAME: process.env["ORIGAMI_SERVER_USERNAME"],
  ORIGAMI_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("ORIGAMI_DISABLE_FFF"),

  // Experimental
  ORIGAMI_EXPERIMENTAL_FILEWATCHER: Config.boolean("ORIGAMI_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  ORIGAMI_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("ORIGAMI_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  ORIGAMI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("ORIGAMI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  ORIGAMI_MODELS_URL: process.env["ORIGAMI_MODELS_URL"],
  ORIGAMI_MODELS_PATH: process.env["ORIGAMI_MODELS_PATH"],
  ORIGAMI_DB: process.env["ORIGAMI_DB"],
  /**
   * Import the per-channel `origami-<channel>.db` stores this installation
   * wrote before the filename was made stable, into `origami.db`. OFF by
   * default: it is a one-time, potentially multi-gigabyte copy, and the owner
   * should choose when to pay for it. The source files are only ever read.
   * Idempotent — each file is marked in `data_migration` once it lands, so a
   * second run is a no-op. Ignored when `ORIGAMI_DB` names a database, since
   * that is not the store the legacy files belong beside.
   */
  ORIGAMI_DB_IMPORT_LEGACY: truthy("ORIGAMI_DB_IMPORT_LEGACY"),

  ORIGAMI_WORKSPACE_ID: process.env["ORIGAMI_WORKSPACE_ID"],
  ORIGAMI_EXPERIMENTAL_WORKSPACES: enabledByExperimental("ORIGAMI_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get ORIGAMI_DISABLE_PROJECT_CONFIG() {
    return truthy("ORIGAMI_DISABLE_PROJECT_CONFIG")
  },
  get ORIGAMI_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("ORIGAMI_EXPERIMENTAL_REFERENCES")
  },
  get ORIGAMI_TUI_CONFIG() {
    return process.env["ORIGAMI_TUI_CONFIG"]
  },
  get ORIGAMI_CONFIG_DIR() {
    return process.env["ORIGAMI_CONFIG_DIR"]
  },
  get ORIGAMI_PURE() {
    return truthy("ORIGAMI_PURE")
  },
  get ORIGAMI_PERMISSION() {
    return process.env["ORIGAMI_PERMISSION"]
  },
  get ORIGAMI_PLUGIN_META_FILE() {
    return process.env["ORIGAMI_PLUGIN_META_FILE"]
  },
  get ORIGAMI_CLIENT() {
    return process.env["ORIGAMI_CLIENT"] ?? "cli"
  },
}
