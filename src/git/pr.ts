import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { UsageError } from "../util/errors";

export interface OpenPullRequestOptions {
  repoDir?: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface PullRequestInfo {
  provider: string;
  url: string;
  base: string;
  head: string;
  number?: number;
  title?: string;
}

export interface PullRequestProvider {
  openPullRequest(options: OpenPullRequestOptions): Promise<PullRequestInfo>;
}

export class GhPullRequestProvider implements PullRequestProvider {
  async openPullRequest(options: OpenPullRequestOptions): Promise<PullRequestInfo> {
    const repoDir = resolve(options.repoDir ?? process.cwd());
    const result = await runGh(repoDir, [
      "pr",
      "create",
      "--base",
      options.base,
      "--head",
      options.head,
      "--title",
      options.title,
      "--body",
      options.body
    ]);
    const url = firstUrl(result.stdout) ?? firstUrl(result.stderr);
    if (url === undefined) {
      throw new UsageError("gh pr create completed but did not return a pull request URL.");
    }

    const info: PullRequestInfo = {
      provider: "gh",
      url,
      base: options.base,
      head: options.head,
      title: options.title
    };
    const number = pullRequestNumber(url);
    if (number !== undefined) {
      info.number = number;
    }
    return info;
  }
}

export function createGhPullRequestProvider(): PullRequestProvider {
  return new GhPullRequestProvider();
}

async function runGh(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("gh", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(new UsageError(`Failed to run gh pr create: ${messageFor(error)}`, error));
    });
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code !== 0) {
        reject(
          new UsageError(
            `gh pr create failed${result.stderr.trim() === "" ? "." : `: ${result.stderr.trim()}`}`
          )
        );
        return;
      }
      resolvePromise(result);
    });
  });
}

function firstUrl(value: string): string | undefined {
  return value.match(/https?:\/\/\S+/)?.[0];
}

function pullRequestNumber(url: string): number | undefined {
  const match = url.match(/\/pull\/(\d+)(?:\D*)$/);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
