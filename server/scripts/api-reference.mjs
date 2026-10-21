// Turns docs/api/openapi.yaml into docs/api/reference.md, a reference that reads well on GitHub with no tooling.
//
//   npm run docs:api --workspace server      # rewrites docs/api/reference.md
//
// The test suite renders it again and fails if the committed file differs, so the two cannot drift apart.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const METHODS = ["get", "post", "put", "patch", "delete"];

/** The anchor GitHub makes for a heading. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .trim()
    .replace(/ /g, "-");
}

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const cell = (text) => oneLine(text).replace(/\|/g, "\\|");

function typeOf(schema) {
  if (!schema) return "";
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop();
    return `[${name}](#${slug(`schema ${name}`)})`;
  }
  if (schema.oneOf) return schema.oneOf.map(typeOf).join(" or ");
  if (schema.allOf) return schema.allOf.map(typeOf).join(" + ");
  if (schema.enum) return schema.enum.map((v) => `\`${v}\``).join(" \\| ");
  const t = Array.isArray(schema.type) ? schema.type : [schema.type ?? "any"];
  const names = t.map((one) => {
    if (one === "array") return `array of ${typeOf(schema.items) || "any"}`;
    if (one === "null") return "null";
    if (schema.format === "binary") return "file";
    return one;
  });
  return names.join(" or ");
}

/** A table of the fields an object schema has. */
function fieldTable(schema, indent = "") {
  const lines = [];
  const parts = schema.allOf ?? [schema];
  for (const part of parts) {
    if (part.$ref) {
      lines.push(`${indent}Everything in ${typeOf(part)}, and:`, "");
      continue;
    }
    const props = part.properties ?? {};
    const required = new Set(part.required ?? []);
    if (Object.keys(props).length === 0) continue;
    lines.push(`${indent}| Field | Type | Description |`, `${indent}|---|---|---|`);
    for (const [name, prop] of Object.entries(props)) {
      const note = [required.has(name) ? "Required." : "", prop.description ?? "", constraints(prop)].filter(Boolean).join(" ");
      lines.push(`${indent}| \`${name}\` | ${cell(typeOf(prop))} | ${cell(note)} |`);
    }
    lines.push("");
  }
  return lines;
}

function constraints(prop) {
  const bits = [];
  if (prop.minLength !== undefined) bits.push(`at least ${prop.minLength} characters`);
  if (prop.maxLength !== undefined) bits.push(`at most ${prop.maxLength} characters`);
  if (prop.minimum !== undefined) bits.push(`at least ${prop.minimum}`);
  if (prop.maximum !== undefined) bits.push(`at most ${prop.maximum}`);
  if (prop.maxItems !== undefined) bits.push(`at most ${prop.maxItems} items`);
  if (prop.default !== undefined) bits.push(`default \`${prop.default}\``);
  return bits.length ? `(${bits.join(", ")})` : "";
}

function bodyLines(content, spec) {
  const lines = [];
  for (const [mediaType, media] of Object.entries(content ?? {})) {
    const schema = media.schema ?? {};
    lines.push(`Content type \`${mediaType}\`.`, "");
    if (schema.oneOf && !schema.$ref) {
      lines.push("One of:", "");
      schema.oneOf.forEach((alt, i) => {
        lines.push(`${i + 1}. ${alt.$ref ? typeOf(alt) : ""}`.trimEnd());
        if (!alt.$ref) lines.push("", ...fieldTable(alt, "   "));
      });
      lines.push("");
    } else if (schema.$ref) {
      lines.push(typeOf(schema), "");
    } else if (schema.type === "object" || schema.properties) {
      if (schema.description) lines.push(schema.description, "");
      lines.push(...fieldTable(schema));
    } else {
      lines.push(typeOf(schema), "");
    }
  }
  return lines;
}

export function renderReference(spec) {
  const out = [];
  const info = spec.info;
  out.push(
    `# ${info.title}`,
    "",
    "> **Generated** from [`openapi.yaml`](openapi.yaml) by `npm run docs:api --workspace server`; edit that file, not this one. The test suite checks this file is up to date, and that `openapi.yaml` matches the routes the server really has.",
    "",
    `Version ${info.version}. The machine-readable form is [\`openapi.yaml\`](openapi.yaml) (OpenAPI 3.1: import it into Swagger UI, Postman or a code generator).`,
    "",
    info.description.trim(),
    ""
  );

  const byTag = new Map(spec.tags.map((t) => [t.name, []]));
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (item[method]) byTag.get(item[method].tags[0]).push({ method: method.toUpperCase(), path, op: item[method] });
    }
  }

  out.push("## Contents", "");
  for (const tag of spec.tags) {
    out.push(`- [${tag.name}](#${slug(tag.name)}): ${tag.description}`);
    for (const { method, path, op } of byTag.get(tag.name)) out.push(`  - [\`${method} ${path}\`](#${slug(`${method} ${path}`)}): ${op.summary}`);
  }
  out.push("- [Schemas](#schemas): the shapes of the objects the operations take and return", "");

  const defaultSecurity = spec.security ?? [];
  for (const tag of spec.tags) {
    out.push(`## ${tag.name}`, "", tag.description, "");
    for (const { method, path, op } of byTag.get(tag.name)) {
      out.push(`### ${method} ${path}`, "", `**${op.summary}**`, "");
      if (op.description) out.push(op.description.trim(), "");
      const security = op.security ?? defaultSecurity;
      out.push(security.length > 0 ? "**Needs sign-in:** yes (`Authorization: Bearer <access token>`)." : "**Needs sign-in:** no.", "");

      const parameters = op.parameters ?? [];
      if (parameters.length > 0) {
        out.push("**Parameters**", "", "| Name | In | Type | Description |", "|---|---|---|---|");
        for (const p of parameters) {
          const note = [p.required ? "Required." : "", p.description ?? "", constraints(p.schema ?? {})].filter(Boolean).join(" ");
          out.push(`| \`${p.name}\` | ${p.in} | ${cell(typeOf(p.schema))} | ${cell(note)} |`);
        }
        out.push("");
      }

      if (op.requestBody) {
        out.push(`**Request body**${op.requestBody.required ? "" : " (optional)"}`, "", ...bodyLines(op.requestBody.content, spec));
      }

      out.push("**Responses**", "");
      for (const [status, answer] of Object.entries(op.responses)) {
        const resolved = answer.$ref ? spec.components.responses[answer.$ref.split("/").pop()] : answer;
        out.push(`- \`${status}\`: ${oneLine(resolved.description)}`);
        const schema = resolved.content?.["application/json"]?.schema;
        if (schema && !(status.startsWith("4") || status.startsWith("5"))) {
          out.push("", ...bodyLines(resolved.content, spec).map((l) => (l ? `  ${l}` : l)));
        }
      }
      out.push("");
    }
  }

  out.push("## Schemas", "");
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    out.push(`### Schema ${name}`, "");
    if (schema.description) out.push(schema.description.trim(), "");
    if (schema.type === "object" || schema.properties || schema.allOf) out.push(...fieldTable(schema));
    else out.push(`Type: ${typeOf(schema)}`, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function loadSpec(root) {
  return parse(readFileSync(join(root, "docs/api/openapi.yaml"), "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  writeFileSync(join(root, "docs/api/reference.md"), renderReference(loadSpec(root)));
  console.log("Wrote docs/api/reference.md");
}
