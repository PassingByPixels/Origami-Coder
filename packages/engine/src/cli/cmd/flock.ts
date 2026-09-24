import { Effect } from "effect"
import type { Argv } from "yargs"
import { FlockDiagnose } from "@/flock/diagnose"
import { FlockStore } from "@/flock/store"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

/**
 * `origami flock invite | accept | list | revoke | doctor`.
 *
 * Every subcommand runs with `instance: false`: the contacts list is global by
 * design (`flock/store.ts` says why a project-local one would be a trust bug),
 * so none of these needs a loaded project and none should refuse to run outside
 * one.
 */

const store = (name?: string) => FlockStore.Store.open(name ? { name } : undefined)

const FlockInviteCommand = effectCmd({
  command: "invite",
  describe: "print an invite a contact can accept to add this Origami to their flock",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("relay", {
        describe: "relay URL to carry the invite, if this Origami is reachable through one",
        type: "string",
      })
      .option("name", {
        describe: "name for your handle, used only when this Origami has no identity yet (default: origami)",
        type: "string",
      }),
  handler: Effect.fn("Cli.flock.invite")(function* (args: { relay?: string; name?: string }) {
    const flock = store(args.name)
    const { invite } = flock.invite(args.relay)
    // Said out loud rather than silently ignored. `--name` SEEDS an identity and
    // never renames one: the handle is minted from the name in force at the
    // time and then frozen, so a rename here would change nothing anybody else
    // can see. Changing the display name is `flock_set_identity` (the FLO pane),
    // which moves the name and leaves the handle where every contact has it.
    if (args.name && flock.identity().name !== args.name) {
      UI.println(
        UI.Style.TEXT_WARNING_BOLD +
          `This Origami already has an identity, so --name was ignored. Change your display name in the Flock pane.` +
          UI.Style.TEXT_NORMAL,
      )
    }
    UI.println(UI.Style.TEXT_NORMAL + `Your handle: ${flock.identity().handle}`)
    UI.println("")
    UI.println(invite)
    UI.println("")
    UI.println(
      UI.Style.TEXT_DIM +
        "Send this to your contact. It carries your public keys only, never a secret." +
        UI.Style.TEXT_NORMAL,
    )
    // Stated because it is the one thing about the pairing that surprises
    // people: an invite is one-directional. They can now reach you; you cannot
    // reach them until you accept an invite of theirs.
    UI.println(
      UI.Style.TEXT_DIM +
        "To ask THEM questions too, accept their invite as well — a contact link is two invites." +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

const FlockAcceptCommand = effectCmd({
  command: "accept <invite>",
  describe: "add a contact from the invite they sent you",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("invite", { describe: "the origami://flock/invite#… string", type: "string", demandOption: true })
      .option("auto", { describe: "answer this contact's questions without asking you each time", type: "boolean" })
      .option("budget", { describe: "tokens per day this contact may spend of yours", type: "number" }),
  handler: Effect.fn("Cli.flock.accept")(function* (args: { invite: string; auto?: boolean; budget?: number }) {
    const overrides = {
      ...(args.auto === undefined ? {} : { autoAnswer: args.auto }),
      ...(args.budget === undefined ? {} : { dailyBudgetTokens: args.budget }),
    }
    const contact = yield* Effect.try({
      try: () => store().accept(args.invite, Object.keys(overrides).length ? overrides : undefined),
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Added ${contact.handle}` + UI.Style.TEXT_NORMAL)
    UI.println(UI.Style.TEXT_DIM + "Send them your own invite so they can ask you too." + UI.Style.TEXT_NORMAL)
  }),
})

const FlockListCommand = effectCmd({
  command: "list",
  describe: "list this Origami's flock",
  instance: false,
  handler: Effect.fn("Cli.flock.list")(function* () {
    const flock = store()
    UI.println(UI.Style.TEXT_NORMAL + `Your handle: ${flock.identity().handle}`)
    const friends = flock.friends()
    if (friends.length === 0) {
      UI.println(UI.Style.TEXT_DIM + "No contacts yet. `origami flock accept <invite>` adds one." + UI.Style.TEXT_NORMAL)
      return
    }
    for (const friend of friends) {
      const policy = friend.policy
      const bits = [
        policy?.autoAnswer ? "auto-answer" : "answers on approval",
        policy?.dailyBudgetTokens === undefined ? "no per-contact cap" : `${policy.dailyBudgetTokens} tokens/day`,
      ]
      UI.println(`${friend.handle}  ${UI.Style.TEXT_DIM}${bits.join(", ")}${UI.Style.TEXT_NORMAL}`)
    }
  }),
})

const FlockRevokeCommand = effectCmd({
  command: "revoke <handle>",
  describe: "remove a contact; their questions and answers are refused from then on",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("handle", { describe: "the contact's handle", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.flock.revoke")(function* (args: { handle: string }) {
    if (!store().revoke(args.handle)) return yield* fail(`${args.handle} is not in this flock`)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Revoked ${args.handle}` + UI.Style.TEXT_NORMAL)
  }),
})

/**
 * `origami flock doctor` — the whole state of the feature, in one command.
 *
 * IT IS THE CLI, so it reports what a SEPARATE process can see: the file, the
 * contacts, the lease and whether the engine holding it is still alive. The
 * `transport` and `route` lines will read `none`/`unrouted` here and that is
 * the truth, not a fault — this process holds no sockets. The same object read
 * over ACP (`flock_diagnose`) comes from an engine that does, which is why they
 * share one builder and one renderer rather than two spellings of "it is fine".
 *
 * NEVER creates `flock.json`: `diagnose` refuses to open a store that is not
 * there, because a doctor that minted an identity would be the worst possible
 * bug in the command people run when something is already wrong.
 */
const FlockDoctorCommand = effectCmd({
  command: "doctor",
  describe: "say why the flock is or is not working: identity, contacts, routes, the lease and the front desk",
  instance: false,
  handler: Effect.fn("Cli.flock.doctor")(function* () {
    for (const line of FlockDiagnose.render(FlockDiagnose.diagnose())) UI.println(line)
  }),
})

export const FlockCommand = effectCmd({
  command: "flock",
  describe: "manage the contacts whose Origami this one may ask",
  instance: false,
  builder: (yargs) =>
    yargs
      .command(FlockInviteCommand)
      .command(FlockAcceptCommand)
      .command(FlockListCommand)
      .command(FlockRevokeCommand)
      .command(FlockDoctorCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.flock")(function* () {}),
})
