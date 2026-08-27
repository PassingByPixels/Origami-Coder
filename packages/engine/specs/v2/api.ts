// @ts-nocheck

import { Origami } from "@origami/core"
import { ReadTool } from "@origami/core/tools"

const origami = Origami.make({})

origami.tool.add(ReadTool)

origami.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

origami.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

origami.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await origami.session.create({
  agent: "build",
})

origami.subscribe((event) => {
  console.log(event)
})

await origami.session.prompt({
  sessionID,
  text: "hey what is up",
})

await origami.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await origami.session.wait()

console.log(await origami.session.messages(sessionID))
