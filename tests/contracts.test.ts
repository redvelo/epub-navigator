import { expect, it } from "vitest";
import { NavigatorError, type NavigatorFailure } from "../src/index.js";

it("throws a normal Error while serializing only its failure record", () => {
  const failure = {
    code: "resource-read-failed",
    message: "resource read failed",
    path: "not a canonical path",
  } satisfies NavigatorFailure;
  const cause = new Error("provider failed");
  const error = new NavigatorError(failure, { cause });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("NavigatorError");
  expect(error.cause).toBe(cause);
  expect(JSON.parse(JSON.stringify(error))).toEqual(failure);
});
