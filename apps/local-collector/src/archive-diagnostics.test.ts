import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { ArchiveCaptureError } from "@hhs/storage";
import { validateSafeMetadata } from "@hhs/capture-operations";
import { archiveFailureMetadata } from "./archive-diagnostics.js";
import { realisticCaptureBundle, realisticLargeCaptureBundle } from "../../../packages/storage/src/test-fixtures.js";

describe("archive failure diagnostics", () => {
  it("accepts the realistic normal and large fixtures under the canonical capture schema", async () => {
    const schema = JSON.parse(await readFile(path.join(process.cwd(), "packages", "canonical-schema", "schemas", "capture-bundle.schema.json"), "utf8")) as object;
    const validate = new Ajv2020Module.default({ allErrors: true, strict: true }).compile(schema);

    expect(validate(realisticCaptureBundle()), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(realisticLargeCaptureBundle()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("maps only pre-sanitized archive diagnostics into operation metadata", () => {
    const error = new ArchiveCaptureError({
      stage: "verify_hashes",
      code: "EIO",
      cleanup: "completed"
    });
    const metadata = archiveFailureMetadata(error);

    expect(metadata).toEqual({
      stage: "archive_failed_verify_hashes_EIO_cleanup_completed"
    });
    expect(validateSafeMetadata(metadata)).toEqual(metadata);
  });

  it("does not serialize arbitrary exceptions", () => {
    const error = new Error("raw-message-sentinel; authentication-data-sentinel; environment-value-sentinel");
    expect(archiveFailureMetadata(error)).toEqual({});
    expect(archiveFailureMetadata(error, false)).toEqual({ stage: "archive_failed_before_archive_started" });
  });
});
