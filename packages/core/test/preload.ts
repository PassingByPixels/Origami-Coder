import path from "path"

process.env.ORIGAMI_DB = ":memory:"
process.env.ORIGAMI_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.ORIGAMI_DISABLE_MODELS_FETCH = "true"
