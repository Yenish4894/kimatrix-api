import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBulkEmailJob } from "@/queues/bulkEmailJob";

const rendered = { subject: "Service update", html: "<p>Hi</p>", text: "Hi" };
const attachment = { path: "/srv/uploads/bulk-email/abc.pdf", filename: "report.pdf" };

describe("buildBulkEmailJob", () => {
  it("carries the attachment through to the worker", () => {
    // The regression this file exists for. Dropping this one field delivered every
    // attachment-bearing announcement with no attachment, and reported success.
    const job = buildBulkEmailJob({ to: "owner@example.com", rendered, attachment });
    assert.deepEqual(job.attachment, attachment);
  });

  it("sends the path, not the file's bytes", () => {
    // One job per recipient: a hundred recipients with a 10 MB file would push a
    // gigabyte through Redis, which holds it in memory.
    const job = buildBulkEmailJob({ to: "owner@example.com", rendered, attachment });
    assert.deepEqual(Object.keys(job.attachment ?? {}).sort(), ["filename", "path"]);
  });

  it("omits the key entirely when there is no attachment", () => {
    // Not `attachment: undefined` — BullMQ serialises to JSON, and the worker's
    // `if (data.attachment)` should see a payload with nothing to read.
    const job = buildBulkEmailJob({ to: "owner@example.com", rendered });
    assert.equal("attachment" in job, false);
  });

  it("keeps the rendered subject and both bodies", () => {
    const job = buildBulkEmailJob({ to: "owner@example.com", rendered });
    assert.equal(job.type, "generic");
    assert.equal(job.to, "owner@example.com");
    assert.equal(job.subject, rendered.subject);
    assert.equal(job.html, rendered.html);
    assert.equal(job.text, rendered.text);
  });
});
