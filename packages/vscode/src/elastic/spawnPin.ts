// spawnPin.ts — t-w2u2ki (scope C N3/N4): the locale and time-zone values every engine spawn gets.
//
// "Today's date" in the system prompt uses the engine's local time zone, read ONCE at process start. A
// warm spare starts minutes or hours before a chat adopts it, so the zone is passed explicitly (the one
// this extension host resolves now) and is part of the spare's spawn digest: a spare and a fresh engine
// always agree. An explicit TZ in the host env already reaches the engine unchanged, so it is left alone.
//
// LANG / LC_ALL are NOT set here. Bun on Windows ignores LANG (measured 2026-09-25: LANG=sv_SE.UTF-8 left
// Intl at en-US), and setting it on macOS could change the ICU collation of every engine (localeCompare
// orders tools and skills) against today. They reach the engine unchanged from the host env and are part
// of the spare's digest, so a spare never differs from a fresh engine in them either.

/** An IANA zone name, or UTC. Anything else (an empty or "Etc/Unknown" zone) is not pinned. */
const ZONE = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;

function hostZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function pinnedSpawnEnv(env: Record<string, string | undefined> = process.env, zone: string | undefined = hostZone()): Record<string, string> {
  if (env['TZ']) return {};
  return zone && ZONE.test(zone) && zone !== 'Etc/Unknown' ? { TZ: zone } : {};
}
