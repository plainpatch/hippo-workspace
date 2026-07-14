import fs from "node:fs";
import Ajv from "ajv";

export const AGENT_BLUEPRINT_SCHEMA_VERSION = 1;
export const AGENT_BLUEPRINT_SCHEMA_ID = "https://hippo.local/schemas/agent-blueprint-v1.schema.json";

const schemaUrl = new URL("../schemas/agent-blueprint-v1.schema.json", import.meta.url);
const schema = JSON.parse(fs.readFileSync(schemaUrl, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

export function getAgentBlueprintSchema() {
  return structuredClone(schema);
}

export function validateAgentBlueprintSchema(value) {
  const valid = validate(value);
  return {
    valid,
    errors: valid ? [] : (validate.errors || []).map((error) => ({
      path: error.instancePath || "/",
      keyword: error.keyword,
      message: error.message || "Schema validation failed.",
      params: error.params,
    })),
  };
}
