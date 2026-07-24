export const AGENT_PROVIDER_STORAGE_KEY = "datasheet-agent-provider"

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">

function getPreferenceStorage(): PreferenceStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function getInitialUseOpenai(storage = getPreferenceStorage()): boolean {
  try {
    return storage?.getItem(AGENT_PROVIDER_STORAGE_KEY) === "openai"
  } catch {
    return false
  }
}

export function saveAgentProvider(use_openai: boolean, storage = getPreferenceStorage()): void {
  try {
    storage?.setItem(AGENT_PROVIDER_STORAGE_KEY, use_openai ? "openai" : "tscircuit")
  } catch {
    // The preference is optional when storage is unavailable.
  }
}
