// FORK STRIP: automatic upgrade beacon neutered. This ran ~1s after every TUI
// launch, phoning home for a "latest version" and potentially reinstalling the
// upstream package over the fork. The whole body (version-check + auto-reinstall)
// is removed; the exported signature is kept so existing callers still compile.
export async function upgrade() {
  return
}
