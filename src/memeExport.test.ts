import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  defaultExportFilename,
  defaultExportPath,
  isRealFolder,
  deriveOutputPath,
  isMagickMissingErrorMessage,
} from "./memeExport";

describe("memeExport.ts", () => {
  describe("formatTimestamp", () => {
    it("zero-pads month/day/hour/minute/second into yyyyMMdd-HHmmss", () => {
      const d = new Date(2026, 0, 3, 9, 5, 7); // Jan 3 2026, 09:05:07 local
      expect(formatTimestamp(d)).toBe("20260103-090507");
    });

    it("does not zero-pad the year", () => {
      const d = new Date(2026, 11, 31, 23, 59, 59);
      expect(formatTimestamp(d)).toBe("20261231-235959");
    });
  });

  describe("defaultExportFilename", () => {
    it("wraps the timestamp in meme-<ts>.png", () => {
      const d = new Date(2026, 6, 3, 12, 0, 0);
      expect(defaultExportFilename(d)).toBe("meme-20260703-120000.png");
    });
  });

  describe("defaultExportPath", () => {
    it("joins home + Desktop + the default filename", () => {
      const d = new Date(2026, 6, 3, 12, 0, 0);
      expect(defaultExportPath("/Users/chris", d)).toBe(
        "/Users/chris/Desktop/meme-20260703-120000.png",
      );
    });

    it("strips a trailing slash on home before joining", () => {
      const d = new Date(2026, 6, 3, 12, 0, 0);
      expect(defaultExportPath("/Users/chris/", d)).toBe(
        "/Users/chris/Desktop/meme-20260703-120000.png",
      );
    });

    it("falls back to /Users when home is empty", () => {
      const d = new Date(2026, 6, 3, 12, 0, 0);
      expect(defaultExportPath("", d)).toBe("/Users/Desktop/meme-20260703-120000.png");
    });
  });

  describe("isRealFolder", () => {
    it("rejects the empty string", () => {
      expect(isRealFolder("")).toBe(false);
    });

    it("rejects synthetic upload:// paths", () => {
      expect(isRealFolder("upload://folder/x")).toBe(false);
    });

    it("accepts a real absolute path", () => {
      expect(isRealFolder("/Users/chris/Pictures/memes")).toBe(true);
    });
  });

  describe("deriveOutputPath", () => {
    it("swaps the extension for the suffix next to a real file", () => {
      expect(deriveOutputPath("/a/b/cat.png", "/a/b", "/home", "-meme.png")).toBe(
        "/a/b/cat-meme.png",
      );
    });

    it("uses the source folder for an upload:// file when the folder is real", () => {
      expect(deriveOutputPath("upload://cat.png", "/a/b", "/home", "-meme.png")).toBe(
        "/a/b/cat-meme.png",
      );
    });

    it("falls back to home when the folder is itself a synthetic upload:// path", () => {
      // Regression: uploading a *folder* used to set state.folder to a
      // synthetic "upload://folder/<name>" path, which then got treated as a
      // real directory and produced a bogus, unwritable save path.
      expect(deriveOutputPath("upload://cat.png", "upload://folder/x", "/home", "-meme.png")).toBe(
        "/home/cat-meme.png",
      );
    });

    it("falls back to home when there is no folder at all", () => {
      expect(deriveOutputPath("upload://cat.png", "", "/home", "-meme.png")).toBe(
        "/home/cat-meme.png",
      );
    });

    it("returns a bare filename when the real path has no directory component", () => {
      expect(deriveOutputPath("cat.png", "", "/home", "-meme.png")).toBe("cat-meme.png");
    });
  });

  describe("isMagickMissingErrorMessage", () => {
    it("matches the exact os-error message reported by users", () => {
      expect(
        isMagickMissingErrorMessage(
          "[meme-emoji] cannot run 'magick': No such file or directory (os error 2). Is ImageMagick installed?",
        ),
      ).toBe(true);
    });

    it("matches the raw invoke-rejection string without the [meme-emoji] label", () => {
      expect(
        isMagickMissingErrorMessage(
          "cannot run 'convert': No such file or directory (os error 2). Is ImageMagick installed?",
        ),
      ).toBe(true);
    });

    it("matches the -version probe failure message", () => {
      expect(isMagickMissingErrorMessage("'magick' -version failed. Is ImageMagick installed?")).toBe(
        true,
      );
    });

    it("is case-insensitive", () => {
      expect(isMagickMissingErrorMessage("...is imagemagick installed?")).toBe(true);
    });

    it("rejects unrelated ImageMagick failures", () => {
      expect(isMagickMissingErrorMessage("input not found: /a/b/cat.png")).toBe(false);
      expect(isMagickMissingErrorMessage("")).toBe(false);
    });
  });
});
