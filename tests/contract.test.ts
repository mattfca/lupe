import { describe, expect, test } from "bun:test";

import {
  INPUT_DIR,
  INTERNAL_DIR,
  assertNoGeneratedArtifactsUnderInput,
  assertNoWorkItemsUnderInternal,
  validateDirectoryContract
} from "../src/fs/contract";
import { ContractError } from "../src/util/errors";

describe("directory contract validators", () => {
  test("accepts valid input and internal paths", () => {
    expect(() =>
      validateDirectoryContract([
        `${INPUT_DIR}/20260625T090000_initial_scope.md`,
        `${INTERNAL_DIR}/state.json`,
        `${INTERNAL_DIR}/work-items/20260625T090000_initial_scope/plan.json`
      ])
    ).not.toThrow();
  });

  test("rejects work item files under .lupe", () => {
    expect(() =>
      assertNoWorkItemsUnderInternal([
        `${INTERNAL_DIR}/work-items/20260625T090000_initial_scope.md`
      ])
    ).toThrow(ContractError);
    expect(() =>
      assertNoWorkItemsUnderInternal([
        `${INTERNAL_DIR}/work-items/20260625T090000_initial_scope.md`
      ])
    ).toThrow("User-authored work items must live in lupe-queue/");
  });

  test("rejects generated artifacts under lupe-queue", () => {
    expect(() => assertNoGeneratedArtifactsUnderInput([`${INPUT_DIR}/state.json`])).toThrow(
      ContractError
    );
    expect(() => assertNoGeneratedArtifactsUnderInput([`${INPUT_DIR}/state.json`])).toThrow(
      "Lupe-generated files must live under .lupe/"
    );
  });
});
