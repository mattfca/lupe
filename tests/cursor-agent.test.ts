import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createCursorAgentAdapter } from "../src/agent/cursor";
import { DEFAULT_CONFIG } from "../src/config/schema";
import { INPUT_DIR } from "../src/fs/contract";
import type { WorkItem } from "../src/queue/workItem";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Cursor agent adapter", () => {
  test("includes planning config flags in the prompt", async () => {
    const cwd = makeTempDir();
    const commandPath = join(cwd, "capture-plan-prompt.sh");
    const promptPath = join(cwd, "planning-prompt.txt");
    writeFileSync(
      commandPath,
      `#!/bin/sh
cat > "$LUPE_CAPTURE_PROMPT"
printf '{"phases":[{"id":"phase-001","title":"Captured"}]}'
`
    );
    chmodSync(commandPath, 0o755);

    const agent = createCursorAgentAdapter({
      command: commandPath,
      env: {
        ...process.env,
        LUPE_CAPTURE_PROMPT: promptPath
      }
    });

    await agent.plan(workItem("20260626T120000_plan_me", cwd), {
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        subagents: false,
        skills: true
      }
    });

    const prompt = readFileSync(promptPath, "utf8");
    expect(prompt).toContain("Configuration:");
    expect(prompt).toContain("- config.subagents: false");
    expect(prompt).toContain("- config.skills: true");
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupe-cursor-agent-"));
  tempDirs.push(dir);
  return dir;
}

function workItem(id: string, cwd: string): WorkItem {
  return {
    id,
    timestamp: id.slice(0, 15),
    description: id.slice(16),
    path: join(cwd, INPUT_DIR, `${id}.md`),
    contents: `# ${id}`,
    fileHash: `${id}-hash`
  };
}
