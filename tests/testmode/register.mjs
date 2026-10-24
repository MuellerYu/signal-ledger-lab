// TEST MODE ONLY. Registered with `node --import ./register.mjs`.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
