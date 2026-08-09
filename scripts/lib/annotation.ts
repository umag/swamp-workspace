/**
 * Shared with every gate that formats a GitHub Actions `::error`/`::warning`
 * workflow-command annotation from repo-controlled (not CI-controlled)
 * text — a path, an identifier, a version string, anything a manifest or
 * source file can put words into. ONE definition, so the sanitisation rule
 * can never drift between gates the way this repo's own history shows it
 * did: `release_notes_gate.ts` grew this function first (PR A, closing a
 * real workflow-command-injection hole in manifest paths and versions),
 * and `check_upgrade_chain.ts` (PR B) initially emitted its own `::error`
 * line with none of it — the exact class of regression a shared module
 * exists to make impossible to reintroduce silently.
 */

/**
 * Escapes CR/LF (and other C0 control bytes) in a repo-controlled string
 * before it is embedded in a GitHub Actions workflow-command annotation
 * (`::error file=…::…`) — such a string may legally contain a raw newline
 * (a path can't, but the messages built around it can), and an unescaped
 * one would start a second physical line at column 0 of the annotation,
 * where GitHub Actions parses a leading `::` as a NEW workflow command
 * (e.g. `::stop-commands::deadbeef`, silencing every annotation that
 * follows).
 */
export function sanitizeForAnnotation(value: string): string {
  return value.replace(
    // deno-lint-ignore no-control-regex
    /[\x00-\x1f\x7f]/g,
    (c) => {
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      return "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
    },
  );
}
