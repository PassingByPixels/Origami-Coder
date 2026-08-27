declare global {
  const ORIGAMI_VERSION: string
  const ORIGAMI_CHANNEL: string
}

export const InstallationVersion = typeof ORIGAMI_VERSION === "string" ? ORIGAMI_VERSION : "local"
export const InstallationChannel = typeof ORIGAMI_CHANNEL === "string" ? ORIGAMI_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
