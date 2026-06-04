import { describe, expect, it } from "vitest";
import {
  attachmentSignature,
  captionPatchFromAttachments,
  classifyAttachmentChange,
  humanSize,
  kindFromMime,
} from "./attachments.js";

// Tiny builders so the intent of each case stays readable.
const existing = (id, caption = "") => ({ source: "existing", id, caption });
const fresh = (name, caption = "") => ({ source: "new", file: { name }, caption });

describe("kindFromMime", () => {
  it("maps the supported image/audio/video/pdf types", () => {
    expect(kindFromMime("image/png")).toBe("image");
    expect(kindFromMime("image/jpeg")).toBe("image");
    expect(kindFromMime("audio/mpeg")).toBe("audio");
    expect(kindFromMime("audio/wav")).toBe("audio");
    expect(kindFromMime("video/mp4")).toBe("video");
    expect(kindFromMime("video/quicktime")).toBe("video");
    expect(kindFromMime("application/pdf")).toBe("pdf");
  });

  it("is case-insensitive", () => {
    expect(kindFromMime("IMAGE/PNG")).toBe("image");
    expect(kindFromMime("Application/PDF")).toBe("pdf");
  });

  it("returns undefined for unknown or missing types", () => {
    expect(kindFromMime("text/plain")).toBeUndefined();
    expect(kindFromMime("")).toBeUndefined();
    expect(kindFromMime(undefined)).toBeUndefined();
    expect(kindFromMime(null)).toBeUndefined();
  });
});

describe("humanSize", () => {
  it("returns empty string for zero, negative, or missing input", () => {
    expect(humanSize(0)).toBe("");
    expect(humanSize(-1)).toBe("");
    expect(humanSize(-1024)).toBe("");
    expect(humanSize(undefined)).toBe("");
    expect(humanSize(null)).toBe("");
  });

  it("reports bytes below 1 KB without decimals", () => {
    expect(humanSize(1)).toBe("1 B");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1023)).toBe("1023 B");
  });

  it("crosses into KB at 1024 and keeps one decimal under 10", () => {
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(1536)).toBe("1.5 KB");
  });

  it("drops the decimal once the scaled value reaches 10", () => {
    expect(humanSize(10 * 1024)).toBe("10 KB");
    expect(humanSize(1023 * 1024)).toBe("1023 KB");
  });

  it("crosses into MB and GB at the right boundaries", () => {
    expect(humanSize(1024 * 1024)).toBe("1.0 MB");
    expect(humanSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
    expect(humanSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});

describe("attachmentSignature", () => {
  it("is stable for the same set", () => {
    const set = [existing("a1", "front"), fresh("photo.png", "back")];
    expect(attachmentSignature(set)).toBe(attachmentSignature(set));
    expect(attachmentSignature([existing("a1", "front")])).toBe("existing:a1:front");
  });

  it("changes when a caption changes", () => {
    expect(attachmentSignature([existing("a1", "x")])).not.toBe(
      attachmentSignature([existing("a1", "y")]),
    );
  });

  it("differs between an existing source and a new-file source", () => {
    expect(attachmentSignature([existing("a1")])).not.toBe(
      attachmentSignature([fresh("a1")]),
    );
  });

  it("keys new files by filename and existing by id", () => {
    expect(attachmentSignature([fresh("photo.png", "cap")])).toBe("new:photo.png:cap");
  });
});

describe("classifyAttachmentChange", () => {
  it("returns 'none' when the signature is unchanged", () => {
    const set = [existing("a1", "cap")];
    const sig = attachmentSignature(set);
    expect(classifyAttachmentChange(set, sig)).toBe("none");
  });

  it("treats an empty set matching an empty loaded signature as 'none'", () => {
    expect(classifyAttachmentChange([], "")).toBe("none");
    expect(classifyAttachmentChange([], undefined)).toBe("none");
  });

  it("returns 'caption-only' when only captions of existing items changed", () => {
    const loaded = [existing("a1", "old"), existing("a2", "")];
    const sig = attachmentSignature(loaded);
    const edited = [existing("a1", "new"), existing("a2", "added")];
    expect(classifyAttachmentChange(edited, sig)).toBe("caption-only");
  });

  it("detects clearing a caption as 'caption-only'", () => {
    const sig = attachmentSignature([existing("a1", "had-one")]);
    expect(classifyAttachmentChange([existing("a1", "")], sig)).toBe("caption-only");
  });

  it("returns 'structural' when a new file is added", () => {
    const sig = attachmentSignature([existing("a1", "cap")]);
    const edited = [existing("a1", "cap"), fresh("new.png")];
    expect(classifyAttachmentChange(edited, sig)).toBe("structural");
  });

  it("returns 'structural' when an existing attachment is removed", () => {
    const sig = attachmentSignature([existing("a1"), existing("a2")]);
    expect(classifyAttachmentChange([existing("a1")], sig)).toBe("structural");
  });

  it("returns 'structural' when attachments are reordered", () => {
    const sig = attachmentSignature([existing("a1"), existing("a2")]);
    expect(classifyAttachmentChange([existing("a2"), existing("a1")], sig)).toBe("structural");
  });

  it("returns 'structural' for an all-new set (create flow)", () => {
    expect(classifyAttachmentChange([fresh("a.png")], "")).toBe("structural");
  });
});

describe("captionPatchFromAttachments", () => {
  it("emits {id, caption} only for existing attachments, trimmed", () => {
    const set = [existing("a1", "  hello  "), fresh("x.png", "ignored"), existing("a2", "")];
    expect(captionPatchFromAttachments(set)).toEqual([
      { id: "a1", caption: "hello" },
      { id: "a2", caption: "" },
    ]);
  });

  it("clears a caption with an empty string", () => {
    expect(captionPatchFromAttachments([existing("a1", "   ")])).toEqual([
      { id: "a1", caption: "" },
    ]);
  });
});
